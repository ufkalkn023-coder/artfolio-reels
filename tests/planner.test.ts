import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSingleArtworkPlan } from "../src/planner/compiler";
import { ArtworkHandoffSchema, TwoArtworkHandoffsSchema } from "../src/planner/handoff";
import { assessEligibility } from "../src/planner/eligibility";
import { ReelPlanSchema, validateReelPlan } from "../src/planner/reel-plan";
import { planArtwork } from "../src/planner/service";
import { writeCachedPlan } from "../src/planner/cache";
import { assessReelPlanAcceptance, PlanRejectionCode, PlanWarningCode } from "../src/planner/acceptance";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { buildGeminiPlannerPrompt } from "../src/planner/prompt";
import { assertValidReelData } from "../src/v2/templates";
import { getDurationInFrames } from "../src/v2/timing";
import { getGeminiConfig } from "../src/planner/config";
import { buildGeminiPlannerGenerationConfig, planWithGemini, summarizeGeminiApiError, summarizeInvalidReelPlanResponse } from "../src/planner/gemini";
import { appendPlannerUsageTelemetry, createPlannerUsageTelemetry, mapGeminiUsageMetadata } from "../src/planner/telemetry";
import { HOOK_TYPES, HookTypeSchema } from "../src/v2/schema";
import { PlannerFailureCategory, classifyPlannerFailure } from "../src/planner/failure";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const throws = (operation: () => unknown, label: string): void => {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
};
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<unknown> => {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error(`${label}: expected rejection`);
};

const eligibility = assessEligibility(STARRY_NIGHT_HANDOFF);
truthy(eligibility.eligible, "confirmed Starry Night handoff is eligible");
truthy(eligibility.eligibleTemplates.includes("why-this-works"), "high-resolution artwork supports why-this-works");
equal(eligibility.eligibleTemplates.includes("two-works-one-idea"), false, "single artwork cannot choose two works");
const productionPrompt = buildGeminiPlannerPrompt(STARRY_NIGHT_HANDOFF, eligibility);
const geminiGenerationConfig = buildGeminiPlannerGenerationConfig("high");
const schemaObject = (value: { type?: string; properties?: Record<string, unknown>; required?: string[] }, label: string): { properties: Record<string, unknown>; required: string[] } => {
  if (value.type !== "object" || !value.properties || !value.required) throw new Error(`${label} must be an object schema with properties and required fields`);
  return { properties: value.properties, required: value.required };
};
const schemaArray = (value: { type?: string; items?: unknown; minItems?: number; maxItems?: number }, label: string): { items: unknown; minItems?: number; maxItems?: number } => {
  if (value.type !== "array" || !value.items) throw new Error(`${label} must be a constrained array schema with item schema`);
  return { items: value.items, minItems: value.minItems, maxItems: value.maxItems };
};
const containsSchemaKeyword = (value: unknown, keyword: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => containsSchemaKeyword(item, keyword));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, keyword) || Object.values(record).some((item) => containsSchemaKeyword(item, keyword));
};
const geminiResponseSchema = schemaObject(geminiGenerationConfig.responseJsonSchema, "Gemini response");
const geminiHookSchema = schemaObject(geminiResponseSchema.properties.hook as { type?: string; properties?: Record<string, unknown>; required?: string[] }, "Gemini hook");
const geminiHookTypeSchema = geminiHookSchema.properties.type as { enum?: string[] };
const geminiHookTypeEnum = geminiHookTypeSchema.enum ?? [];
const geminiDetailsSchema = schemaArray(geminiResponseSchema.properties.details as { type?: string; items?: unknown; minItems?: number; maxItems?: number }, "Gemini details");
const geminiDetailItemSchema = schemaObject(geminiDetailsSchema.items as { type?: string; properties?: Record<string, unknown>; required?: string[] }, "Gemini details.items");
const geminiScenesSchema = schemaArray(geminiResponseSchema.properties.scenes as { type?: string; items?: unknown; minItems?: number; maxItems?: number }, "Gemini scenes");
const geminiSceneItemSchema = schemaObject(geminiScenesSchema.items as { type?: string; properties?: Record<string, unknown>; required?: string[] }, "Gemini scenes.items");
equal(HOOK_TYPES.join(","), ["VISUAL_DETAIL", "QUESTION", "OBSERVATION", "CONTRAST", "DISCOVERY"].join(","), "canonical hook type values are exact");
equal(productionPrompt.includes(`Set hook.type to exactly one of these uppercase enum values: ${HOOK_TYPES.join(", ")}.`), true, "prompt exposes every allowed hook type exactly");
equal(geminiHookTypeEnum.join(","), HOOK_TYPES.join(","), "Gemini structured contract exposes the canonical hook type values");
equal(Array.isArray(geminiHookTypeEnum), true, "Gemini enum serializes as a JSON array");
equal(geminiGenerationConfig.responseMimeType, "application/json", "Gemini structured contract requests JSON");
equal("responseSchema" in geminiGenerationConfig, false, "raw JSON Schema does not use the protobuf responseSchema field");
equal("responseFormat" in geminiGenerationConfig, false, "raw REST request does not use SDK responseFormat nesting");
equal(containsSchemaKeyword(geminiGenerationConfig.responseJsonSchema, "maxItems"), false, "Gemini responseJsonSchema omits all provider-side maxItems constraints");
equal(geminiDetailsSchema.maxItems, undefined, "Gemini details contract omits the local maximum detail count");
equal(Object.keys(geminiDetailItemSchema.properties).join(","), ["id", "label", "observation", "focalX", "focalY", "preferredScale", "targetType", "targetRegion"].join(","), "Gemini details contract contains every local detail property");
equal(geminiDetailItemSchema.required.join(","), ["id", "label", "observation", "focalX", "focalY", "preferredScale"].join(","), "Gemini details contract requires the local required detail fields");
const geminiTargetTypeSchema = geminiDetailItemSchema.properties.targetType as { type?: string; enum?: string[] };
equal(geminiTargetTypeSchema.type, "string", "Gemini detail target type is typed");
equal(geminiTargetTypeSchema.enum?.join(","), ["COMPACT", "REGION", "RELATION"].join(","), "Gemini detail target type keeps the local enum");
const geminiTargetRegionSchema = schemaObject(geminiDetailItemSchema.properties.targetRegion as { type?: string; properties?: Record<string, unknown>; required?: string[] }, "Gemini detail target region");
equal(Object.keys(geminiTargetRegionSchema.properties).join(","), ["x", "y", "width", "height"].join(","), "Gemini target region retains nested coordinates");
equal(geminiTargetRegionSchema.required.join(","), ["x", "y", "width", "height"].join(","), "Gemini target region requires complete bounds");
equal(geminiScenesSchema.minItems, 1, "Gemini scenes contract forbids an empty scene list");
equal(geminiScenesSchema.maxItems, undefined, "Gemini scenes contract omits the local maximum scene count");
equal(Object.keys(geminiSceneItemSchema.properties).join(","), ["id", "kind", "seconds", "detailId", "observationIndex", "camera"].join(","), "Gemini scenes contract contains every local scene property");
equal(geminiSceneItemSchema.required.join(","), ["id", "kind", "seconds"].join(","), "Gemini scenes contract requires the local required scene fields");
const geminiCameraSchema = schemaObject(geminiSceneItemSchema.properties.camera as { type?: string; properties?: Record<string, unknown>; required?: string[] }, "Gemini scene camera");
equal(geminiCameraSchema.required.join(","), ["move"].join(","), "Gemini camera contract requires its local move field");
truthy(productionPrompt.includes("short, direct, elegant, natural editorial language"), "prompt prefers simple natural hooks");
truthy(productionPrompt.includes("three genuinely separate details"), "prompt distinguishes three separate discoveries");
truthy(productionPrompt.includes("one shared visible mechanism"), "prompt defines why-this-works as a shared mechanism");
truthy(productionPrompt.includes("centralIdea must concisely name the visible mechanism"), "prompt requires a concrete why-this-works central idea");
truthy(productionPrompt.includes("stillness is preferred over unnecessary motion"), "prompt prefers stillness over unnecessary movement");
truthy(productionPrompt.includes("Use a pan only when directional travel reveals"), "prompt requires camera movement to serve the artwork");
truthy(productionPrompt.includes("What exact visible thing"), "prompt requires an explicit visual target without prose inference");
truthy(productionPrompt.includes("every observation scene must reference"), "prompt assigns observations to explicit detail targets");
truthy(productionPrompt.includes("planned detail observations must directly answer the question"), "question hooks must be answerable by planned observations");
truthy(productionPrompt.includes("rewrite the hook to match them"), "unaligned hooks must be rewritten");
truthy(productionPrompt.includes("Use \"Why...?\" only when"), "unsupported causal why questions are avoided");

equal(ArtworkHandoffSchema.safeParse(STARRY_NIGHT_HANDOFF).success, true, "confirmed handoff is accepted");
equal(ArtworkHandoffSchema.safeParse({ ...STARRY_NIGHT_HANDOFF, canonicalId: "" }).success, false, "missing canonicalId is rejected");
equal(ArtworkHandoffSchema.safeParse({ ...STARRY_NIGHT_HANDOFF, imageWidth: 0 }).success, false, "invalid dimensions are rejected");
equal(ArtworkHandoffSchema.safeParse({ ...STARRY_NIGHT_HANDOFF, rightsStatus: "UNKNOWN" }).success, false, "unconfirmed rights are rejected");
equal(TwoArtworkHandoffsSchema.safeParse([STARRY_NIGHT_HANDOFF]).success, false, "two-works input requires exactly two handoffs");
equal(TwoArtworkHandoffsSchema.safeParse([STARRY_NIGHT_HANDOFF, STARRY_NIGHT_HANDOFF]).success, false, "two-works input requires distinct artworks");

const validPlan = validateReelPlan(STARRY_NIGHT_MOCK_PLAN, eligibility);
equal(validPlan.template, "why-this-works", "valid structured planner output is accepted");
for (const hookType of HOOK_TYPES) {
  equal(HookTypeSchema.safeParse(hookType).success, true, `${hookType} is an allowed hook type`);
  equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, hook: { ...STARRY_NIGHT_MOCK_PLAN.hook, type: hookType } }).success, true, `${hookType} passes ReelPlan validation`);
}
equal(HookTypeSchema.safeParse("VISUAL").success, false, "unproven hook type aliases remain invalid");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, hook: { ...STARRY_NIGHT_MOCK_PLAN.hook, type: "UNKNOWN" } }).success, false, "unknown hook types remain invalid");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, template: "not-a-template" }).success, false, "unknown template is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, hook: { type: "QUESTION", text: "one two three four five six seven eight nine ten eleven twelve thirteen" } }).success, false, "long hook is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, details: [{ ...STARRY_NIGHT_MOCK_PLAN.details[0], focalX: -0.1 }] }).success, false, "invalid focalX is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, details: [{ ...STARRY_NIGHT_MOCK_PLAN.details[0], focalY: 1.1 }] }).success, false, "invalid focalY is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, details: [{ ...STARRY_NIGHT_MOCK_PLAN.details[0], preferredScale: 3 }] }).success, false, "invalid scale is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, details: Array.from({ length: 7 }, (_, index) => ({ ...STARRY_NIGHT_MOCK_PLAN.details[0], id: `detail-${index}` })) }).success, false, "local ReelPlanSchema rejects more than six details");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, details: [{ targetType: "COMPACT" }] }).success, false, "malformed details without required local fields still fail validation");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, scenes: [{ ...STARRY_NIGHT_MOCK_PLAN.scenes[0], seconds: -1 }] }).success, false, "negative duration is rejected");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, scenes: Array.from({ length: 11 }, (_, index) => ({ ...STARRY_NIGHT_MOCK_PLAN.scenes[0], id: `scene-${index}` })) }).success, false, "local ReelPlanSchema rejects more than ten scenes");
throws(() => validateReelPlan({ ...STARRY_NIGHT_MOCK_PLAN, scenes: STARRY_NIGHT_MOCK_PLAN.scenes.map((scene) => scene.kind === "detail" ? { ...scene, detailId: "missing" } : scene) }, eligibility), "missing referenced detail is rejected");

const crowdedDetails = STARRY_NIGHT_MOCK_PLAN.details.map((detail) => ({ ...detail, focalX: 0.5, focalY: 0.5 }));
const threeDetailPlan = { ...STARRY_NIGHT_MOCK_PLAN, template: "three-details" as const, details: crowdedDetails, scenes: [
  { id: "intro", kind: "intro" as const, seconds: 2 },
  { id: "a", kind: "detail" as const, seconds: 3.8, detailId: "movement" },
  { id: "b", kind: "detail" as const, seconds: 3.8, detailId: "rhythm" },
  { id: "c", kind: "detail" as const, seconds: 3.8, detailId: "contrast" },
  { id: "overview", kind: "overview" as const, seconds: 3.6 },
  { id: "outro", kind: "outro" as const, seconds: 4 },
] };
throws(() => validateReelPlan(threeDetailPlan, eligibility), "three-details rejects non-distinct focal points");
throws(() => compileSingleArtworkPlan(STARRY_NIGHT_HANDOFF, threeDetailPlan, eligibility), "invalid three-details plan does not compile as a fallback");

const twoWorksPlan = { ...STARRY_NIGHT_MOCK_PLAN, template: "two-works-one-idea" as const };
throws(() => validateReelPlan(twoWorksPlan, { ...eligibility, eligibleTemplates: ["two-works-one-idea"] }, 1), "single artwork cannot choose two works");

const compiled = compileSingleArtworkPlan(STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN, eligibility);
const reel = assertValidReelData(compiled.reel);
equal(reel.artworks[0].title, STARRY_NIGHT_HANDOFF.title, "planner cannot overwrite verified title");
equal(reel.artworks[0].artist, STARRY_NIGHT_HANDOFF.artist, "planner cannot overwrite verified artist");
equal(reel.artworks[0].date, STARRY_NIGHT_HANDOFF.date, "planner cannot overwrite verified date");
equal(reel.artworks[0].museum, STARRY_NIGHT_HANDOFF.museum, "planner cannot overwrite verified museum");
equal(reel.artworks[0].id, STARRY_NIGHT_HANDOFF.canonicalId, "planner cannot overwrite canonicalId");
equal(reel.hookType, STARRY_NIGHT_MOCK_PLAN.hook.type, "compiler preserves hook type for template-aware rendering");
equal(reel.scenes?.find((scene) => scene.kind === "observation")?.detailId, "movement", "compiler upgrades legacy observation index to explicit detail target");
const explicitDetailWinsOverLegacyObservationIndex = compileSingleArtworkPlan(STARRY_NIGHT_HANDOFF, {
  ...STARRY_NIGHT_MOCK_PLAN,
  scenes: STARRY_NIGHT_MOCK_PLAN.scenes.map((scene) => scene.id === "observation-2"
    ? { ...scene, detailId: "rhythm", observationIndex: 0 }
    : scene),
}, eligibility);
equal(explicitDetailWinsOverLegacyObservationIndex.reel.scenes?.find((scene) => scene.id === "observation-2")?.observationIndex, 1, "compiler normalizes a stale observation index to the explicit detail target");
equal(reel.artworks[0].detailPoints[0].focalX, STARRY_NIGHT_MOCK_PLAN.details[0].focalX, "compiler preserves target focal x unchanged");
equal(reel.artworks[0].detailPoints[0].focalY, STARRY_NIGHT_MOCK_PLAN.details[0].focalY, "compiler preserves target focal y unchanged");
equal(reel.artworks[0].imageWidth, STARRY_NIGHT_HANDOFF.imageWidth, "compiler preserves artwork dimensions for aspect-aware framing");
truthy(getDurationInFrames(reel) > 0, "Starry Night mock compiles into valid V2 ReelData");
equal(ReelPlanSchema.safeParse({ ...STARRY_NIGHT_MOCK_PLAN, title: "Untrusted title" }).success, false, "planner schema excludes untrusted factual metadata");

const gemini400Reason = summarizeGeminiApiError(400, {
  error: {
    status: "INVALID_ARGUMENT",
    message: `Invalid JSON payload received at 'generation_config.response_format'; api_key=planner-secret ${"x".repeat(1_000)}`,
    details: [{ fieldViolations: [{ field: "generationConfig.responseFormat", description: "Unknown field" }] }],
  },
});
truthy(gemini400Reason.includes("INVALID_ARGUMENT"), "safe Gemini diagnostic retains Google status");
truthy(gemini400Reason.includes("generationConfig.responseFormat"), "safe Gemini diagnostic retains field violation");
truthy(!gemini400Reason.includes("planner-secret"), "safe Gemini diagnostic redacts secrets");
truthy(gemini400Reason.length <= 500, "safe Gemini diagnostic is bounded");
const invalidStructureDiagnostic = summarizeInvalidReelPlanResponse({
  details: [{ ignored: "editorial content must not appear in diagnostics", id: "detail-1" }],
  scenes: [],
  secret: "must not appear in diagnostics",
});
truthy(invalidStructureDiagnostic.includes("details.length=1"), "invalid response diagnostic reports detail count");
truthy(invalidStructureDiagnostic.includes("details[0] keys=[id,ignored]"), "invalid response diagnostic reports detail keys only");
truthy(invalidStructureDiagnostic.includes("scenes.length=0"), "invalid response diagnostic reports empty scenes");
truthy(!invalidStructureDiagnostic.includes("editorial content"), "invalid response diagnostic never includes editorial values");
truthy(!invalidStructureDiagnostic.includes("must not appear"), "invalid response diagnostic never includes secret values");

const verifyThinkingConfiguration = (): void => {
  const previous = process.env.GEMINI_THINKING_LEVEL;
  try {
    delete process.env.GEMINI_THINKING_LEVEL;
    equal(getGeminiConfig().thinkingLevel, "high", "thinking defaults to high");
    process.env.GEMINI_THINKING_LEVEL = "medium";
    equal(getGeminiConfig().thinkingLevel, "medium", "medium thinking override is accepted");
    process.env.GEMINI_THINKING_LEVEL = "low";
    equal(getGeminiConfig().thinkingLevel, "low", "low thinking override is accepted");
    process.env.GEMINI_THINKING_LEVEL = "invalid";
    throws(() => getGeminiConfig(), "invalid thinking level is rejected before Gemini can be called");
  } finally {
    if (previous === undefined) delete process.env.GEMINI_THINKING_LEVEL;
    else process.env.GEMINI_THINKING_LEVEL = previous;
  }
};

verifyThinkingConfiguration();

const fakeUsage = {
  promptTokenCount: 1_000_000,
  candidatesTokenCount: 100_000,
  thoughtsTokenCount: 200_000,
  totalTokenCount: 1_300_000,
};
const mappedUsage = mapGeminiUsageMetadata(fakeUsage);
equal(mappedUsage.promptTokenCount, 1_000_000, "usage maps prompt token count");
equal(mappedUsage.candidatesTokenCount, 100_000, "usage maps candidate token count");
equal(mappedUsage.thoughtsTokenCount, 200_000, "usage maps thinking token count");
equal(mappedUsage.totalTokenCount, 1_300_000, "usage maps total token count");
equal(mapGeminiUsageMetadata({}).thoughtsTokenCount, null, "missing optional thinking count is safe");

const fakeTelemetry = createPlannerUsageTelemetry({
  canonicalArtworkId: STARRY_NIGHT_HANDOFF.canonicalId,
  model: "gemini-3.7-flash",
  thinkingLevel: "high",
  requestDurationMs: 5_420,
  usage: fakeUsage,
  timestamp: "2026-08-22T00:00:00.000Z",
});
equal(fakeTelemetry.inputCostUsd, 0.75, "input tokens use the input price");
equal(fakeTelemetry.outputAndThinkingCostUsd, 1.125, "output and thinking tokens use the output price");
equal(fakeTelemetry.estimatedCostUsd, 1.875, "cost combines input and output-thinking pricing");
equal(fakeTelemetry.pricingVersion, "gemini-3.7-flash-standard-2026", "telemetry records pricing version");
equal(JSON.stringify(STARRY_NIGHT_MOCK_PLAN), JSON.stringify(STARRY_NIGHT_MOCK_PLAN), "telemetry does not alter ReelPlan data");

const verifyAsyncPlannerBehavior = async (): Promise<void> => {
  const previousApiKeyFor400 = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  let permanent400Calls = 0;
  try {
    process.env.GEMINI_API_KEY = "test-api-key";
    globalThis.fetch = async () => {
      permanent400Calls += 1;
      return new Response(JSON.stringify({
        error: {
          status: "INVALID_ARGUMENT",
          message: "responseJsonSchema must be valid",
          details: [{ fieldViolations: [{ field: "generationConfig.responseJsonSchema", description: "invalid schema" }] }],
        },
      }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const error = await rejects(() => planWithGemini(STARRY_NIGHT_HANDOFF, eligibility), "permanent Gemini 400");
    equal(classifyPlannerFailure(error), PlannerFailureCategory.API_ERROR, "Gemini 400 is categorized as API_ERROR");
    equal(permanent400Calls, 1, "permanent Gemini 400 is not retried");
    truthy(error instanceof Error && error.message.includes("INVALID_ARGUMENT"), "Gemini 400 retains its bounded Google reason");
    truthy(error instanceof Error && error.message.includes("generationConfig.responseJsonSchema"), "Gemini 400 retains its field violation");
    truthy(!(error instanceof Error && error.message.includes("test-api-key")), "Gemini 400 does not disclose API keys");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKeyFor400 === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKeyFor400;
  }

  const cacheDirectory = await mkdtemp(join(tmpdir(), "artfolio-planner-test-"));
  let calls = 0;
  const testPlanner = async () => {
    calls += 1;
    return STARRY_NIGHT_MOCK_PLAN;
  };
  await planArtwork(STARRY_NIGHT_HANDOFF, { cacheDirectory, callPlanner: testPlanner });
  await planArtwork(STARRY_NIGHT_HANDOFF, { cacheDirectory, callPlanner: testPlanner });
  equal(calls, 1, "valid cached plan does not call Gemini planner");
  await planArtwork(STARRY_NIGHT_HANDOFF, { cacheDirectory, force: true, callPlanner: testPlanner });
  equal(calls, 2, "force regeneration calls planner once");

  const telemetryCacheDirectory = await mkdtemp(join(tmpdir(), "artfolio-planner-telemetry-cache-"));
  let telemetryCalls = 0;
  const plannerWithTelemetry = async () => {
    telemetryCalls += 1;
    return { plan: STARRY_NIGHT_MOCK_PLAN, telemetry: fakeTelemetry };
  };
  const fresh = await planArtwork(STARRY_NIGHT_HANDOFF, { cacheDirectory: telemetryCacheDirectory, callPlanner: plannerWithTelemetry });
  const cached = await planArtwork(STARRY_NIGHT_HANDOFF, { cacheDirectory: telemetryCacheDirectory, callPlanner: plannerWithTelemetry });
  equal(fresh.telemetry?.estimatedCostUsd, 1.875, "new Gemini plan exposes its recorded cost");
  equal(cached.cacheHit, true, "second plan reads the cache");
  equal(cached.telemetry, undefined, "cached plan creates no new Gemini charge");
  equal(telemetryCalls, 1, "cached plan makes zero additional Gemini calls");
  equal(JSON.stringify(fresh.plan), JSON.stringify(STARRY_NIGHT_MOCK_PLAN), "telemetry leaves ReelPlan semantics unchanged");

  const telemetryDirectory = await mkdtemp(join(tmpdir(), "artfolio-planner-telemetry-"));
  const telemetryPath = join(telemetryDirectory, "planner-usage.jsonl");
  const previousApiKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "test-api-key";
    await appendPlannerUsageTelemetry(fakeTelemetry, telemetryPath);
  } finally {
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
  }
  const telemetryLine = await readFile(telemetryPath, "utf8");
  truthy(!telemetryLine.includes("test-api-key"), "telemetry never contains an API key");
  truthy(!telemetryLine.includes("thought summary"), "telemetry never contains thought content");

  // This test deliberately does not import the Gemini client: saved plans compile without credentials.
  const savedPlanWithoutGemini = compileSingleArtworkPlan(STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN, eligibility);
  equal(savedPlanWithoutGemini.reel.id, "starry-night", "saved plan render boundary needs no GEMINI_API_KEY");

  const acceptance = assessReelPlanAcceptance(validPlan, { artwork: STARRY_NIGHT_HANDOFF });
  equal(acceptance.accepted, true, "approved valid plan is accepted");
  equal(acceptance.acceptanceVersion, "reel-plan-acceptance-v1", "acceptance exposes its stable version");
  truthy(acceptance.warnings.includes(PlanWarningCode.DETAILS_CLOSE), "non-fatal close detail warning is reported");

  const blankHook = assessReelPlanAcceptance({ ...validPlan, hook: { ...validPlan.hook, text: " " } });
  equal(blankHook.accepted, false, "blank hook is rejected");
  truthy(blankHook.rejectionReasons.includes(PlanRejectionCode.INVALID_HOOK), "blank hook has a structured reason");

  const longHook = assessReelPlanAcceptance({ ...validPlan, hook: { ...validPlan.hook, text: "one two three four five six seven eight nine ten eleven twelve thirteen" } });
  truthy(longHook.rejectionReasons.includes(PlanRejectionCode.HOOK_TOO_LONG), "overlong hook is rejected by approved policy");
  truthy(assessReelPlanAcceptance(validPlan, { isFallback: true }).rejectionReasons.includes(PlanRejectionCode.FALLBACK_PLAN), "explicit fallback plan is rejected");

  const insufficientDetails = assessReelPlanAcceptance({ ...validPlan, details: validPlan.details.slice(0, 2) });
  truthy(insufficientDetails.rejectionReasons.includes(PlanRejectionCode.INSUFFICIENT_DETAILS), "template requires its expected detail count");

  const collapsedDetails = assessReelPlanAcceptance({
    ...validPlan,
    details: validPlan.details.map((detail) => ({ ...detail, focalX: 0.5, focalY: 0.5 })),
  });
  truthy(collapsedDetails.rejectionReasons.includes(PlanRejectionCode.DETAILS_TOO_CLOSE), "collapsed multi-detail focal points are rejected");
  equal(assessReelPlanAcceptance(validPlan).accepted, true, "separated focal points are accepted");

  const excessiveMotion = assessReelPlanAcceptance({
    ...validPlan,
    scenes: validPlan.scenes.map((scene) => ({ ...scene, camera: { move: "pan-left" as const } })),
  });
  truthy(excessiveMotion.rejectionReasons.includes(PlanRejectionCode.EXCESSIVE_CAMERA_MOTION), "excessive camera motion is rejected");
  equal(assessReelPlanAcceptance(validPlan).accepted, true, "restrained camera plan is accepted");

  const invalidDuration = assessReelPlanAcceptance({
    ...validPlan,
    scenes: validPlan.scenes.map((scene, index) => index === 0 ? { ...scene, seconds: 20 } : scene),
  });
  truthy(invalidDuration.rejectionReasons.includes(PlanRejectionCode.INVALID_DURATION), "invalid duration is rejected");

  const mismatchedMetadata = assessReelPlanAcceptance(validPlan, {
    artwork: STARRY_NIGHT_HANDOFF,
    metadata: { ...STARRY_NIGHT_HANDOFF, title: "Changed title" },
  });
  truthy(mismatchedMetadata.rejectionReasons.includes(PlanRejectionCode.METADATA_MISMATCH), "protected metadata mismatch is rejected");

  const nearMotionLimit = assessReelPlanAcceptance({
    ...validPlan,
    scenes: validPlan.scenes.map((scene, index) => index < 3 ? { ...scene, camera: { move: "zoom-in" as const } } : scene),
  });
  equal(nearMotionLimit.accepted, true, "warnings do not reject a plan");
  truthy(nearMotionLimit.warnings.includes(PlanWarningCode.CAMERA_MOTION_NEAR_LIMIT), "near-limit camera plan is warned");
  equal(JSON.stringify(assessReelPlanAcceptance(validPlan)), JSON.stringify(assessReelPlanAcceptance(validPlan)), "acceptance is deterministic across repeated evaluation");

  const gateCacheDirectory = await mkdtemp(join(tmpdir(), "artfolio-plan-gate-cache-"));
  await writeCachedPlan(gateCacheDirectory, STARRY_NIGHT_HANDOFF, validPlan);
  let unexpectedGeminiCalls = 0;
  const cachedForGate = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: gateCacheDirectory,
    callPlanner: async () => {
      unexpectedGeminiCalls += 1;
      return STARRY_NIGHT_MOCK_PLAN;
    },
  });
  equal(unexpectedGeminiCalls, 0, "cached plan reaches the gate without a Gemini/client call");
  equal(assessReelPlanAcceptance(cachedForGate.plan, { artwork: STARRY_NIGHT_HANDOFF }).accepted, true, "cached plan passes the gate");

  const realPlanIds = ["met_853157", "met_437311", "met_436975", "met_438159"];
  for (const canonicalId of realPlanIds) {
    const cachedPlan = JSON.parse(await readFile(`data/plans/${canonicalId}.json`, "utf8"));
    const realPlan = ReelPlanSchema.parse(cachedPlan.plan);
    const result = assessReelPlanAcceptance(realPlan);
    equal(result.accepted, true, `${canonicalId} approved cached plan is accepted`);
    console.log(`[plan-gate-test] artwork=${canonicalId} accepted=${result.accepted} warnings=${result.warnings.join(",") || "0"}`);
  }
  const cachedPlanFiles = (await readdir("data/plans")).filter((file) => file.endsWith(".json"));
  for (const file of cachedPlanFiles) {
    const cachedPlan = JSON.parse(await readFile(`data/plans/${file}`, "utf8"));
    equal(ReelPlanSchema.safeParse(cachedPlan.plan).success, true, `${file} cached valid plan remains valid`);
  }
  console.log("Planner tests passed");
};

void verifyAsyncPlannerBehavior().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
