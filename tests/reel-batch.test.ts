import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReelBatch, writeBatchManifest, type BatchCandidate, type BatchCandidateQueue } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { createPlannerUsageTelemetry } from "../src/planner/telemetry";
import { writeCachedPlan } from "../src/planner/cache";
import { loadReelProductionHistory } from "../src/planner/production-history";
import { PlannerFailureCategory, PlannerFailureError } from "../src/planner/failure";
import { ReelDataSchema, type ReelData } from "../src/v2/schema";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const enrichWithAfmMusic = async (reel: ReelData) => ({
  reel: ReelDataSchema.parse({
    ...reel,
    music: { src: "reel-audio/AFM-DE03-07.wav", trackId: "AFM-DE03-07", subfamily: "DE03", volume: 0.18, start: 0, durationSeconds: 120, fadeIn: 0.6, fadeOut: 1.5 },
  }),
});

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-reel-batch-"));
  process.env.ARTFOLIO_AFM_ROOT = join(root, "missing-afm");
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
  equal(full.completionBasis, "QC_PASSED", "QC-only completion is based on QC passes");
  equal(full.completionCount, 4, "QC-only completion count is explicit");
  equal(plannerCalls, 4, "one live planner call per uncached candidate");
  equal(full.gemini.inputTokens, 40, "input telemetry aggregates");
  equal(full.gemini.outputTokens, 80, "output telemetry aggregates");
  equal(full.gemini.thinkingTokens, 120, "thinking telemetry aggregates");
  equal(full.operationalSummary.target, 4, "operational summary retains target");
  equal(full.operationalSummary.accepted, 4, "operational summary retains accepted count");
  equal(full.operationalSummary.qcPassed, 4, "operational summary retains QC passes");

  const retentionSummary = await runReelBatch({
    queue: queue([candidates[0]], 1), cacheDirectory: join(root, "plans-retention"), reelDirectory: join(root, "reels-retention"), outputDirectory: join(root, "output-retention"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    runExistingCommand: (name) => name === "qc" ? { qcArtifactsRetained: 2, qcArtifactsCleaned: 10 } : undefined,
  });
  equal(retentionSummary.operationalSummary.qcArtifactsRetained, 2, "batch summary aggregates retained QC artifacts");
  equal(retentionSummary.operationalSummary.qcArtifactsCleaned, 10, "batch summary aggregates cleaned QC artifacts");

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

  let forcedPlannerCalls = 0;
  const forced = await runReelBatch({
    queue: queue([candidates[0]], 1), forcePlan: true, cacheDirectory: cachedRoot, reelDirectory: join(root, "reels-forced"), outputDirectory: join(root, "output-forced"),
    callPlanner: async () => { forcedPlannerCalls += 1; return { plan: STARRY_NIGHT_MOCK_PLAN, telemetry }; }, localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(forced.gemini.calls, 1, "forced plan uses one Gemini call");
  equal(forced.gemini.cacheHits, 0, "forced plan bypasses cache");
  equal(forcedPlannerCalls, 1, "forced plan invokes planner once");

  const excessiveMotionPlan = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  excessiveMotionPlan.scenes = excessiveMotionPlan.scenes.map((scene, index) => ({
    ...scene,
    camera: index < 5 ? { move: "zoom-in" as const } : { move: index === 7 ? "none" as const : "detail-hold" as const },
  }));
  const repairedMotionPlan = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  repairedMotionPlan.scenes = repairedMotionPlan.scenes.map((scene, index) => ({
    ...scene,
    camera: index < 3 ? { move: "zoom-in" as const } : { move: index === 7 ? "none" as const : "detail-hold" as const },
  }));
  let motionPlannerCalls = 0;
  const motionRepaired = await runReelBatch({
    queue: queue([candidates[0]], 1), cacheDirectory: join(root, "plans-motion-repair"), reelDirectory: join(root, "reels-motion-repair"), outputDirectory: join(root, "output-motion-repair"),
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => {
      motionPlannerCalls += 1;
      return { plan: context ? repairedMotionPlan : excessiveMotionPlan, telemetry };
    },
    localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(motionPlannerCalls, 2, "batch uses exactly one additional planner call for motion repair");
  equal(motionRepaired.candidates[0].initialAcceptanceReasons.join(","), "EXCESSIVE_CAMERA_MOTION", "batch retains the initial rejection reason");
  equal(motionRepaired.candidates[0].motionRepair?.originalMovingSceneCount, 5, "batch diagnostics retain original moving-scene count");
  equal(motionRepaired.candidates[0].motionRepair?.allowedMaximum, 4, "batch diagnostics retain allowed maximum");
  equal(motionRepaired.candidates[0].motionRepair?.repairedMovingSceneCount, 3, "batch diagnostics retain repaired moving-scene count");
  equal(motionRepaired.candidates[0].motionRepair?.outcome, "ACCEPTED", "batch diagnostics retain repair outcome");
  equal(motionRepaired.gemini.calls, 2, "batch telemetry includes original and repair Gemini calls");
  equal(motionRepaired.operationalSummary.motionRepairAttempts, 1, "batch summary counts repair attempts");
  equal(motionRepaired.operationalSummary.motionRepairsAccepted, 1, "batch summary counts accepted repairs");
  equal(motionRepaired.operationalSummary.motionRepairsRejected, 0, "batch summary distinguishes rejected repairs");
  equal(motionRepaired.operationalSummary.repairGeminiCalls, 1, "batch summary counts Gemini calls attributable to repair");

  let failedMotionRepairCalls = 0;
  const failedMotionRepairCall = await runReelBatch({
    queue: queue([candidates[0]], 1), cacheDirectory: join(root, "plans-motion-repair-call-failed"), reelDirectory: join(root, "reels-motion-repair-call-failed"), outputDirectory: join(root, "output-motion-repair-call-failed"),
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => {
      failedMotionRepairCalls += 1;
      if (context) throw new PlannerFailureError(PlannerFailureCategory.API_ERROR, "Gemini repair request failed");
      return { plan: excessiveMotionPlan, telemetry };
    },
    localizeArtwork: localized, runExistingCommand: () => undefined,
  });
  equal(failedMotionRepairCalls, 2, "failed motion repair call is attempted exactly once");
  equal(failedMotionRepairCall.candidates[0].plannerFailureCategory, "API_ERROR", "failed repair preserves its planner failure category");
  equal(failedMotionRepairCall.candidates[0].motionRepair?.outcome, "REJECTED", "failed repair call records a rejected repair outcome");
  equal(failedMotionRepairCall.candidates[0].motionRepair?.originalMovingSceneCount, 5, "failed repair call retains original moving-scene count");
  equal(failedMotionRepairCall.candidates[0].motionRepair?.allowedMaximum, 4, "failed repair call retains allowed maximum");
  equal(failedMotionRepairCall.candidates[0].motionRepair?.repairedMovingSceneCount, undefined, "failed repair call has no invented repaired count");
  equal(failedMotionRepairCall.operationalSummary.motionRepairAttempts, 1, "failed repair call is included in attempt diagnostics");
  equal(failedMotionRepairCall.operationalSummary.motionRepairsRejected, 1, "failed repair call is included in rejected diagnostics");
  equal(failedMotionRepairCall.operationalSummary.repairGeminiCalls, 1, "failed repair call is counted as repair Gemini work");
  equal(failedMotionRepairCall.gemini.calls, 2, "failed repair call remains visible in aggregate Gemini call count");

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
    enrichMusic: enrichWithAfmMusic,
    runExistingCommand: (name, reelId) => { renders.push(`${name}:${reelId}`); if (name === "render" && reelId === "batch-1") throw new Error("render failure"); },
  });
  equal(rendered.qcPassedCount, 2, "render failures do not alter QC completion");
  equal(rendered.renderedCount, 1, "rendered count remains independent");
  equal(rendered.completionBasis, "RENDERED", "render mode completion is based on successful renders");
  equal(rendered.completionCount, 1, "render shortfall reports successful render count");
  equal(rendered.outcome, "SHORTFALL", "QC target cannot make a render-short batch complete");
  equal(rendered.candidates[0].errorCode, "RENDER_FAILED", "render failure is isolated");
  equal(rendered.operationalSummary.renderVerificationFailures, 1, "batch operational summary counts render-stage verification failures");
  equal(rendered.operationalSummary.shortfall, 1, "batch operational summary reports shortfall");
  truthy(renders.includes("qc:batch-1") && renders.includes("qc:batch-2") && renders.includes("render:batch-2"), "only QC-passed candidates render");

  const mixedRender = await runReelBatch({
    queue: queue(candidates.slice(0, 3), 2, 3), render: true, cacheDirectory: join(root, "plans-mixed-render"), reelDirectory: join(root, "reels-mixed-render"), outputDirectory: join(root, "output-mixed-render"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    enrichMusic: enrichWithAfmMusic,
    runExistingCommand: (name, reelId) => { if (name === "render" && reelId === "batch-1") throw new Error("render failure"); },
  });
  equal(mixedRender.qcPassedCount, 3, "render mode continues beyond the QC target after failure");
  equal(mixedRender.renderedCount, 2, "mixed render batch reaches the requested render target");
  equal(mixedRender.outcome, "COMPLETE", "render target completion is reported only after enough renders");

  const zeroRender = await runReelBatch({
    queue: queue(candidates.slice(0, 2), 1, 2), render: true, cacheDirectory: join(root, "plans-zero-render"), reelDirectory: join(root, "reels-zero-render"), outputDirectory: join(root, "output-zero-render"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    enrichMusic: enrichWithAfmMusic,
    runExistingCommand: (name) => { if (name === "render") throw new Error("render failure"); },
  });
  equal(zeroRender.qcPassedCount, 2, "zero-render batch may still contain QC passes");
  equal(zeroRender.renderedCount, 0, "zero successful renders are counted honestly");
  equal(zeroRender.outcome, "SHORTFALL", "zero successful renders cannot complete render mode");
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
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized, enrichMusic: enrichWithAfmMusic, runExistingCommand: () => undefined,
  });
  equal(renderHistory.candidates[0].historyStatus, "RENDERED", "render completion upgrades history");
  equal((await loadReelProductionHistory(historyPath)).entries[0].status, "RENDERED", "rendered status persists");
  const failedRenderHistory = await runReelBatch({
    queue: queue([candidates[1]], 1, 1), render: true, cacheDirectory: join(root, "plans-history-render-failure"), reelDirectory: join(root, "reels-history-render-failure"), outputDirectory: join(root, "output-history-render-failure"),
    productionHistory: await loadReelProductionHistory(historyPath), productionHistoryPath: historyPath, batchId: "history-render-failure",
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
    enrichMusic: enrichWithAfmMusic,
    runExistingCommand: (name) => { if (name === "render") throw new Error("Selected music audio is silent or inaudible"); },
  });
  equal(failedRenderHistory.historyWrittenCount, 0, "deep audio verification failure writes no production history");
  equal((await loadReelProductionHistory(historyPath)).entries.length, 1, "deep audio verification failure does not create a history entry");

  for (const [failure, warning] of [
    ["AFM library missing", "AFM library unavailable"],
    ["eligible AFM catalog empty", "AFM has no accepted production-ready WAV candidates"],
    ["selected AFM master missing", "AFM music unavailable: selected master missing"],
    ["audio localization failure", "AFM music unavailable: localization failed"],
  ]) {
    const musicFailureHistoryPath = join(root, `history-${failure.replace(/ /g, "-")}.json`);
    const musicFailureCommands: string[] = [];
    const musicFailure = await runReelBatch({
      queue: queue([candidates[0]], 1, 1), render: true, cacheDirectory: join(root, `plans-${failure}`), reelDirectory: join(root, `reels-${failure}`), outputDirectory: join(root, `output-${failure}`),
      productionHistory: await loadReelProductionHistory(musicFailureHistoryPath), productionHistoryPath: musicFailureHistoryPath, batchId: `music-${failure}`,
      callPlanner: async () => STARRY_NIGHT_MOCK_PLAN, localizeArtwork: localized,
      enrichMusic: async (reel) => ({ reel, warning }),
      runExistingCommand: (name) => { musicFailureCommands.push(name); },
    });
    equal(musicFailure.outcome, "SHORTFALL", `${failure}: render mode cannot complete without usable AFM audio`);
    equal(musicFailure.renderedCount, 0, `${failure}: candidate is not terminally rendered`);
    equal(musicFailure.candidates[0].renderStatus, "FAILED", `${failure}: candidate records a failed production render state`);
    equal(musicFailure.candidates[0].errorCode, "MUSIC_FAILED", `${failure}: failure is classified before final render`);
    truthy(!musicFailureCommands.includes("render"), `${failure}: final render is never invoked`);
    equal((await loadReelProductionHistory(musicFailureHistoryPath)).entries.filter((entry) => entry.status === "RENDERED").length, 0, `${failure}: no successful RENDERED history outcome is recorded`);
  }
  console.log("Reel batch tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
