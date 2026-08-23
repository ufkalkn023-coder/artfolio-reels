import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReelBatch, writeBatchManifest, type BatchCandidate, type BatchCandidateQueue } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { createPlannerUsageTelemetry } from "../src/planner/telemetry";
import { writeCachedPlan } from "../src/planner/cache";
import { loadReelProductionHistory } from "../src/planner/production-history";
import { PlannerFailureCategory, PlannerFailureError } from "../src/planner/failure";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-reel-batch-"));
  const localized = async (artwork: typeof STARRY_NIGHT_HANDOFF) => ({ artwork, sourcePath: artwork.imagePath, destinationPath: artwork.imagePath, renderablePath: artwork.imagePath });
  const candidates: BatchCandidate[] = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const canonicalId = `batch-${index + 1}`;
    const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId };
    const handoffPath = join(root, `${canonicalId}.json`);
    await writeFile(handoffPath, JSON.stringify(handoff));
    return { canonicalId, artist: handoff.artist, museum: handoff.museum, handoffPath, baseScore: 90 - index, portfolioPriorityScore: 90 - index };
  }));
  const queue = (items = candidates, target = 4, candidateLimit = items.length): BatchCandidateQueue => ({ target, candidateLimit, candidateCount: items.length, candidates: items });
  const telemetry = createPlannerUsageTelemetry({
    canonicalArtworkId: "batch", model: "gemini-3.7-flash", thinkingLevel: "high", requestDurationMs: 17,
    usage: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 30 }, timestamp: "2026-08-23T00:00:00.000Z",
  });

  let plannerCalls = 0;
  const full = await runReelBatch({
    queue: queue(candidates.slice(0, 4)), cacheDirectory: join(root, "plans-full"), reelDirectory: join(root, "reels-full"), outputDirectory: join(root, "output-full"),
    callPlanner: async () => { plannerCalls += 1; return { plan: STARRY_NIGHT_MOCK_PLAN, telemetry }; },
    localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(full.outcome, "COMPLETE", "four accepted candidates fill target");
  equal(full.qcPassedCount, 4, "all accepted candidates pass QC");
  equal(plannerCalls, 4, "one live planner call per uncached candidate");
  equal(full.gemini.inputTokens, 40, "input telemetry aggregates");
  equal(full.gemini.outputTokens, 80, "output telemetry aggregates");
  equal(full.gemini.thinkingTokens, 120, "thinking telemetry aggregates");

  const rejectedPlan = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  rejectedPlan.details[1].focalX = rejectedPlan.details[0].focalX;
  rejectedPlan.details[1].focalY = rejectedPlan.details[0].focalY;
  const fallback = await runReelBatch({
    queue: queue(candidates.slice(0, 5), 4), cacheDirectory: join(root, "plans-fallback"), reelDirectory: join(root, "reels-fallback"), outputDirectory: join(root, "output-fallback"),
    callPlanner: async (artwork) => artwork.canonicalId === "batch-2" ? { plan: rejectedPlan } : STARRY_NIGHT_MOCK_PLAN,
    localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(fallback.qcPassedCount, 4, "rejected candidate is replaced from queue");
  equal(fallback.candidates[1].acceptanceStatus, "REJECTED", "rejected plan is recorded");
  equal(fallback.candidates[1].acceptanceReasons[0], "DETAILS_TOO_CLOSE", "gate reason is preserved");

  const cachedRoot = join(root, "plans-cached");
  const cachedHandoff = { ...STARRY_NIGHT_HANDOFF, canonicalId: "batch-1" };
  await writeCachedPlan(cachedRoot, cachedHandoff, STARRY_NIGHT_MOCK_PLAN);
  const cached = await runReelBatch({
    queue: queue([candidates[0]], 1), cacheDirectory: cachedRoot, reelDirectory: join(root, "reels-cached"), outputDirectory: join(root, "output-cached"),
    callPlanner: async () => { throw new Error("cached plan must not call Gemini"); }, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(cached.gemini.calls, 0, "cached plan uses zero Gemini calls");
  equal(cached.gemini.cacheHits, 1, "cached plan is counted");

  const commands: string[] = [];
  const missingHandoff: BatchCandidate = {
    canonicalId: "batch-missing", handoffPath: join(root, "does-not-exist.json"), baseScore: 99, portfolioPriorityScore: 99,
  };
  const failures = await runReelBatch({
    queue: queue([missingHandoff, candidates[0], candidates[1], candidates[2], candidates[3]], 1, 5), cacheDirectory: join(root, "plans-failures"), reelDirectory: join(root, "reels-failures"), outputDirectory: join(root, "output-failures"),
    callPlanner: async (artwork) => artwork.canonicalId === "batch-2" ? Promise.reject(new Error("planner outage")) : STARRY_NIGHT_MOCK_PLAN,
    localizeArtwork: async (artwork) => artwork.canonicalId === "batch-1" ? Promise.reject(new Error("asset missing")) : localized(artwork),
    runExistingCommand: (name, reelId) => { commands.push(`${name}:${reelId}`); if (name === "qc" && reelId === "batch-3") throw new Error("QC failure"); },
  });
  equal(failures.qcPassedCount, 1, "asset/planner/QC failures do not prevent a later candidate");
  equal(failures.candidates[0].errorCode, "HANDOFF_FAILED", "handoff failure isolated");
  equal(failures.candidates[1].errorCode, "ASSET_FAILED", "asset failure isolated");
  equal(failures.candidates[2].errorCode, "PLANNER_FAILED", "planner failure isolated");
  equal(failures.candidates[3].errorCode, "QC_FAILED", "QC failure isolated");
  truthy(!commands.some((command) => command.startsWith("render:")), "render never runs without --render");

  const rejectedForAcceptance = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  rejectedForAcceptance.details[1].focalX = rejectedForAcceptance.details[0].focalX;
  rejectedForAcceptance.details[1].focalY = rejectedForAcceptance.details[0].focalY;
  const rawFailure = `GEMINI_API_KEY=planner-secret https://example.invalid/plan?token=url-secret ${"x".repeat(1_000)}`;
  const categorized = await runReelBatch({
    queue: queue(candidates.slice(0, 6), 1, 6), cacheDirectory: join(root, "plans-categorized"), reelDirectory: join(root, "reels-categorized"), outputDirectory: join(root, "output-categorized"),
    callPlanner: async (artwork) => {
      switch (artwork.canonicalId) {
        case "batch-1": throw new PlannerFailureError(PlannerFailureCategory.API_ERROR, "Gemini request returned 500");
        case "batch-2": throw Object.assign(new Error("planner request timed out"), { name: "TimeoutError" });
        case "batch-3": return JSON.parse("{") as typeof STARRY_NIGHT_MOCK_PLAN;
        case "batch-4": return JSON.parse("{}") as typeof STARRY_NIGHT_MOCK_PLAN;
        case "batch-5": return rejectedForAcceptance;
        default: return STARRY_NIGHT_MOCK_PLAN;
      }
    },
    localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(categorized.qcPassedCount, 1, "planner failures and rejected plans retain fallback queue behavior");
  equal(categorized.candidates[0].plannerFailureCategory, "API_ERROR", "API failure category is retained");
  equal(categorized.candidates[1].plannerFailureCategory, "TIMEOUT", "timeout category is retained");
  equal(categorized.candidates[2].plannerFailureCategory, "INVALID_JSON", "invalid JSON category is retained");
  equal(categorized.candidates[3].plannerFailureCategory, "SCHEMA_INVALID", "schema failure category is retained");
  equal(categorized.candidates[4].plannerFailureCategory, "ACCEPTANCE_REJECTED", "acceptance rejection category is retained");
  equal(categorized.plannerFailureCounts.UNKNOWN, undefined, "known planner failures do not become UNKNOWN");
  equal(categorized.plannerFailureCounts.SCHEMA_INVALID, 1, "planner failure aggregates are retained");
  const unknown = await runReelBatch({
    queue: queue([candidates[0]], 1, 1), cacheDirectory: join(root, "plans-unknown"), reelDirectory: join(root, "reels-unknown"), outputDirectory: join(root, "output-unknown"),
    callPlanner: async () => { throw new Error(rawFailure); }, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(unknown.candidates[0].plannerFailureCategory, "UNKNOWN", "unexpected planner errors safely become UNKNOWN");
  truthy((unknown.candidates[0].errorMessageSafe?.length ?? 0) <= 300, "raw planner errors are bounded");
  const categorizedManifestPath = join(root, "categorized-manifest.json");
  await writeBatchManifest(categorizedManifestPath, categorized);
  const manifestText = await readFile(categorizedManifestPath, "utf8");
  truthy(manifestText.includes('"plannerFailureCounts"'), "planner failure aggregates reach the manifest");
  truthy(!JSON.stringify(unknown).includes("planner-secret") && !JSON.stringify(unknown).includes("url-secret"), "planner errors redact secrets and URLs");

  const shortfall = await runReelBatch({
    queue: queue(candidates.slice(0, 2), 4, 2), cacheDirectory: join(root, "plans-shortfall"), reelDirectory: join(root, "reels-shortfall"), outputDirectory: join(root, "output-shortfall"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(shortfall.outcome, "SHORTFALL", "candidate limit prevents infinite search");
  equal(shortfall.candidatesExhausted, true, "shortfall reports exhausted queue");

  const renders: string[] = [];
  const rendered = await runReelBatch({
    queue: queue(candidates.slice(0, 2), 2, 2), render: true, cacheDirectory: join(root, "plans-render"), reelDirectory: join(root, "reels-render"), outputDirectory: join(root, "output-render"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    runExistingCommand: (name, reelId) => { renders.push(`${name}:${reelId}`); if (name === "render" && reelId === "batch-1") throw new Error("render failure"); },
  });
  equal(rendered.qcPassedCount, 2, "render failures do not alter QC completion");
  equal(rendered.renderedCount, 1, "rendered count remains independent");
  equal(rendered.candidates[0].errorCode, "RENDER_FAILED", "render failure is isolated");
  truthy(renders.includes("qc:batch-1") && renders.includes("qc:batch-2") && renders.includes("render:batch-2"), "only QC-passed candidates render");
  truthy(!JSON.stringify(full).includes("GEMINI_API_KEY"), "batch manifest excludes secrets");

  const historyPath = join(root, "reel-production-history.json");
  const historyBatch = await runReelBatch({
    queue: queue([candidates[0]], 1, 1), cacheDirectory: join(root, "plans-history"), reelDirectory: join(root, "reels-history"), outputDirectory: join(root, "output-history"),
    productionHistory: await loadReelProductionHistory(historyPath), productionHistoryPath: historyPath, batchId: "history-batch",
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(historyBatch.candidates[0].historyStatus, "QC_PASSED", "QC batch writes QC_PASSED history");
  equal(historyBatch.historyWrittenCount, 1, "QC history write is counted");
  const renderHistory = await runReelBatch({
    queue: queue([candidates[0]], 1, 1), render: true, cacheDirectory: join(root, "plans-history-render"), reelDirectory: join(root, "reels-history-render"), outputDirectory: join(root, "output-history-render"),
    productionHistory: await loadReelProductionHistory(historyPath), productionHistoryPath: historyPath, batchId: "history-render-batch",
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(renderHistory.candidates[0].historyStatus, "RENDERED", "render completion upgrades history");
  equal((await loadReelProductionHistory(historyPath)).entries[0].status, "RENDERED", "rendered status persists");
  const failedRenderHistory = await runReelBatch({
    queue: queue([candidates[1]], 1, 1), render: true, cacheDirectory: join(root, "plans-history-render-failure"), reelDirectory: join(root, "reels-history-render-failure"), outputDirectory: join(root, "output-history-render-failure"),
    productionHistory: await loadReelProductionHistory(historyPath), productionHistoryPath: historyPath, batchId: "history-render-failure",
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    runExistingCommand: (name) => { if (name === "render") throw new Error("render failed"); },
  });
  equal(failedRenderHistory.historyWrittenCount, 0, "render failure writes no production history");
  equal((await loadReelProductionHistory(historyPath)).entries.length, 1, "render failure does not create a history entry");
  console.log("Reel batch tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
