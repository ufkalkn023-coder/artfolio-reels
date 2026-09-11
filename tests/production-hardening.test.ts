import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanCacheStatus, planCachePath, readCachedPlan, writeCachedPlan } from "../src/planner/cache";
import { assessEligibility } from "../src/planner/eligibility";
import { PlannerFailureCategory, classifyPlannerFailure } from "../src/planner/failure";
import { planWithGemini, readGeminiResponseText } from "../src/planner/gemini";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { planArtwork } from "../src/planner/service";
import { buildArtBotSubprocessEnvironment, sanitizeSubprocessStderr } from "../src/planner/subprocess-security";
import { PLANNER_TEST_IMAGE } from "./fixtures/planner-image";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<unknown> => {
  try { await operation(); } catch (error) { return error; }
  throw new Error(`${label}: expected rejection`);
};
const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`${label}: condition was not reached`);
};

const withEnvironment = async (values: Record<string, string>, operation: () => Promise<void>): Promise<void> => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, values);
    await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const run = async (): Promise<void> => {
const eligibility = assessEligibility(STARRY_NIGHT_HANDOFF);
const root = await mkdtemp(join(tmpdir(), "artfolio-production-hardening-"));

const hitDirectory = join(root, "hit");
await writeCachedPlan(hitDirectory, STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN);
equal((await readCachedPlan(hitDirectory, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.HIT, "valid cache is a hit");
equal((await readCachedPlan(join(root, "missing"), STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.MISS, "missing cache is a miss");

const malformedDirectory = join(root, "malformed");
await mkdir(malformedDirectory, { recursive: true });
await writeFile(planCachePath(malformedDirectory, STARRY_NIGHT_HANDOFF.canonicalId), "{");
equal((await readCachedPlan(malformedDirectory, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.INVALID, "malformed cache is invalid");
let plannerCalls = 0;
await rejects(() => planArtwork(STARRY_NIGHT_HANDOFF, {
  cacheDirectory: malformedDirectory,
  callPlanner: async () => { plannerCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
}), "unsafe cache failure");
equal(plannerCalls, 0, "invalid cache cannot trigger Gemini automatically");

const staleDirectory = join(root, "stale");
await mkdir(staleDirectory, { recursive: true });
await writeFile(planCachePath(staleDirectory, STARRY_NIGHT_HANDOFF.canonicalId), JSON.stringify({ plannerVersion: 999 }));
equal((await readCachedPlan(staleDirectory, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.SCHEMA_MISMATCH, "planner version mismatch is stale");

const ioDirectory = join(root, "io-error");
await mkdir(planCachePath(ioDirectory, STARRY_NIGHT_HANDOFF.canonicalId), { recursive: true });
equal((await readCachedPlan(ioDirectory, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.IO_ERROR, "read failure is an I/O error");

await withEnvironment({
  GEMINI_API_KEY: "test-api-key",
  ARTFOLIO_GEMINI_TIMEOUT_MS: "1000",
  ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES: "1024",
  ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES: "65536",
}, async () => {
  let requestedUrl = "";
  let requestedKey = "";
  const result = await planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
    stat: async () => ({ size: 4 }),
    readFile: async () => PLANNER_TEST_IMAGE,
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(STARRY_NIGHT_MOCK_PLAN) }] } }], usageMetadata: {} }), { status: 200 });
    },
    appendTelemetry: async () => undefined,
  });
  equal("plan" in result, true, "normal bounded Gemini response is accepted");
  truthy(!requestedUrl.includes("test-api-key") && !requestedUrl.includes("?key="), "Gemini URL contains no API key");
  equal(requestedKey, "test-api-key", "Gemini key uses x-goog-api-key header");
});

await withEnvironment({
  GEMINI_API_KEY: "test-api-key",
  ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES: "1024",
  ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES: "65536",
}, async () => {
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs = 0;
  let advanceTimeout = (elapsedMs: number): void => { void elapsedMs; };
  AbortSignal.timeout = (delay: number): AbortSignal => {
    const controller = new AbortController();
    timeoutMs = delay;
    advanceTimeout = (elapsedMs) => {
      if (elapsedMs >= delay && !controller.signal.aborted) controller.abort();
    };
    return controller.signal;
  };
  try {
    let resolveRequest: (response: Response) => void = () => undefined;
    let requestSignal: AbortSignal | undefined;
    const completesAfterSixtySeconds = planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
      stat: async () => ({ size: 4 }),
      readFile: async () => PLANNER_TEST_IMAGE,
      fetch: (_input, init) => new Promise((resolve) => {
        requestSignal = init?.signal ?? undefined;
        truthy(!requestSignal?.aborted, "planner request is not aborted at start");
        resolveRequest = resolve;
      }),
      appendTelemetry: async () => undefined,
    });
    await waitFor(() => requestSignal !== undefined, "successful Gemini request starts");
    equal(timeoutMs, 120_000, "Gemini timeout is 120 seconds");
    advanceTimeout(60_000);
    truthy(!requestSignal?.aborted, "request remains active after 60 seconds");
    resolveRequest(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(STARRY_NIGHT_MOCK_PLAN) }] } }], usageMetadata: {} }), { status: 200 }));
    await completesAfterSixtySeconds;

    const successfulRequestSignal = requestSignal;
    const timeoutOperation = planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
      stat: async () => ({ size: 4 }),
      readFile: async () => PLANNER_TEST_IMAGE,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        requestSignal = signal ?? undefined;
        const abort = (): void => reject(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
      appendTelemetry: async () => undefined,
    });
    await waitFor(() => requestSignal !== successfulRequestSignal, "timeout Gemini request starts");
    advanceTimeout(120_000);
    const timeoutError = await rejects(() => timeoutOperation, "Gemini timeout");
    const classifiedTimeout = await timeoutError;
    truthy(requestSignal?.aborted, "request is aborted after 120 seconds");
    equal(classifyPlannerFailure(classifiedTimeout), PlannerFailureCategory.TIMEOUT, "Gemini timeout has a distinct failure category");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

await withEnvironment({
  GEMINI_API_KEY: "test-api-key",
  ARTFOLIO_GEMINI_TIMEOUT_MS: "1000",
  ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES: "1024",
  ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES: "65536",
}, async () => {
  const networkError = await rejects(() => planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
    stat: async () => ({ size: 4 }),
    readFile: async () => PLANNER_TEST_IMAGE,
    fetch: async () => { throw new Error("https://example.test?key=network-secret"); },
  }), "Gemini network failure");
  equal(classifyPlannerFailure(networkError), PlannerFailureCategory.API_ERROR, "network failure has the API error category");
  truthy(networkError instanceof Error && !networkError.message.includes("network-secret"), "network errors never serialize request secrets");
});

await withEnvironment({
  GEMINI_API_KEY: "test-api-key",
  ARTFOLIO_GEMINI_TIMEOUT_MS: "1000",
  ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES: "4",
  ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES: "65536",
}, async () => {
  let fetchCalls = 0;
  await rejects(() => planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
    stat: async () => ({ size: 5 }),
    readFile: async () => Buffer.from("large"),
    fetch: async () => { fetchCalls += 1; return new Response("{}"); },
  }), "oversized artwork");
  equal(fetchCalls, 0, "oversized artwork is rejected before fetch");
});

await withEnvironment({
  GEMINI_API_KEY: "test-api-key",
  ARTFOLIO_GEMINI_TIMEOUT_MS: "0",
  ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES: "1024",
  ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES: "65536",
}, async () => {
  await rejects(() => planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, {
    stat: async () => ({ size: 4 }),
    readFile: async () => Buffer.from("image"),
    fetch: async () => new Response("{}"),
  }), "invalid timeout configuration");
});

equal(await readGeminiResponseText(new Response("ok"), 2), "ok", "normal response respects body limit");
await rejects(() => readGeminiResponseText(new Response("x", { headers: { "content-length": "11" } }), 10), "declared oversized response");
await rejects(() => readGeminiResponseText(new Response("12345678901"), 10), "actual oversized response");

const childEnvironment = buildArtBotSubprocessEnvironment({
  PATH: "/usr/bin",
  HOME: "/tmp/user",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  GEMINI_API_KEY: "SECRET",
  SOME_SECRET: "SECRET2",
}, { REEL_SELECTION_TARGET: "4" });
equal(childEnvironment.PATH, "/usr/bin", "child keeps PATH");
equal(childEnvironment.HOME, "/tmp/user", "child keeps HOME");
equal(childEnvironment.LC_ALL, "en_US.UTF-8", "child keeps locale variables");
equal(childEnvironment.REEL_SELECTION_TARGET, "4", "child receives explicit batch override");
equal(childEnvironment.GEMINI_API_KEY, undefined, "child excludes Gemini credentials");
equal(childEnvironment.SOME_SECRET, undefined, "child excludes unrelated secrets");

const sanitized = sanitizeSubprocessStderr("worker failed GEMINI_API_KEY=SECRET Authorization: Bearer TOKEN https://example.test/run?key=URLSECRET AIza012345678901234567890123456789");
truthy(sanitized.includes("worker failed"), "stderr keeps useful debugging context");
truthy(!sanitized.includes("SECRET") && !sanitized.includes("TOKEN") && !sanitized.includes("AIza"), "stderr removes obvious secrets");

console.log("Production hardening tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
