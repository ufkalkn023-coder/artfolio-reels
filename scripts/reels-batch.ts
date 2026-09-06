import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReelBatch, writeBatchManifest, type BatchCandidateQueue, type ExistingBatchCommand } from "../src/planner/batch";
import { loadReelProductionHistory, productionHistoryExcludedCanonicalIds } from "../src/planner/production-history";
import { exitCodeForBatchOutcome, parseReelBatchCliArgs } from "../src/planner/reels-batch-cli";
import { buildArtBotSubprocessEnvironment, sanitizeSubprocessStderr } from "../src/planner/subprocess-security";
import { runQcForReel } from "./qc";
import { createRemotionQcResources, type QcRenderResources } from "./qc-rendering";
export { exitCodeForBatchOutcome, parseReelBatchCliArgs } from "../src/planner/reels-batch-cli";

type AcquisitionSource = { source: string; attempted: number; accepted: number; rejected: number; failed: number; rejectionReasons: Record<string, number> };
type AcquisitionManifest = {
  desiredPoolSize: number;
  attemptLimit: number;
  attemptedCount: number;
  safeCandidateCount: number;
  existingSafeCount: number;
  historyExcludedCount: number;
  usableExistingCount: number;
  newlyAcquiredCount: number;
  usableSafeCandidateCount: number;
  rejectedCount: number;
  sourceFailureCount: number;
  shortfall: number;
  acquisitionDurationMs: number;
  sources: AcquisitionSource[];
};

const { render, forcePlan, selectionOnly, target, candidateLimit } = parseReelBatchCliArgs(process.argv.slice(2));

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artBotRoot = resolve(process.env.ARTFOLIO_ART_BOT_ROOT ?? "../../instagram-art-bot-final");
const artBotEnvironment = buildArtBotSubprocessEnvironment(process.env, {
  REEL_SELECTION_TARGET: target,
  REEL_BATCH_CANDIDATE_LIMIT: candidateLimit,
});
const invokeCandidateAcquisition = async (excludedCanonicalIds: readonly string[]): Promise<AcquisitionManifest> => new Promise((resolveAcquisition, reject) => {
  const child = spawn("python3", ["-m", "src.reel_candidate_acquisition", ...excludedCanonicalIds.flatMap((canonicalId) => ["--excluded-canonical-id", canonicalId])], {
    cwd: artBotRoot, stdio: ["ignore", "pipe", "pipe"], env: artBotEnvironment,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) return reject(new Error(`Art Bot acquisition failed${stderr ? `: ${sanitizeSubprocessStderr(stderr)}` : ""}`));
    try { resolveAcquisition(JSON.parse(stdout) as AcquisitionManifest); } catch { reject(new Error("Art Bot acquisition returned invalid JSON")); }
  });
});
const invokeCandidateBoundary = async (historyPath: string): Promise<BatchCandidateQueue> => new Promise((resolveQueue, reject) => {
  const arguments_ = ["-m", "src.reel_batch_candidates", "--output-dir", resolve(artBotRoot, "output/reel-batches", runId), "--reel-history", historyPath];
  if (target) arguments_.push("--target", target);
  if (candidateLimit) arguments_.push("--candidate-limit", candidateLimit);
  const child = spawn("python3", arguments_, { cwd: artBotRoot, stdio: ["ignore", "pipe", "pipe"], env: artBotEnvironment });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) return reject(new Error(`Art Bot candidate boundary failed${stderr ? `: ${sanitizeSubprocessStderr(stderr)}` : ""}`));
    try { resolveQueue(JSON.parse(stdout) as BatchCandidateQueue); } catch { reject(new Error("Art Bot candidate boundary returned invalid JSON")); }
  });
});

const runNpmCommand = async (name: string, reelId: string): Promise<void> => new Promise((resolveCommand, reject) => {
  const child = spawn("npm", ["run", name, "--", reelId], { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveCommand() : reject(new Error(`${name} failed for ${reelId}`)));
});

export const createBatchCommandRunner = (dependencies: {
  createResources?: () => Promise<QcRenderResources>;
  runQc?: typeof runQcForReel;
  runNpm?: (name: string, reelId: string) => Promise<void>;
} = {}): { run: ExistingBatchCommand; close: () => Promise<void> } => {
  let qcResources: QcRenderResources | undefined;
  const createResources = dependencies.createResources ?? createRemotionQcResources;
  const runQc = dependencies.runQc ?? runQcForReel;
  const runNpm = dependencies.runNpm ?? runNpmCommand;
  return {
    run: async (name, reelId) => {
      if (name === "render") return runNpm(name, reelId);
      qcResources ??= await createResources();
      const result = await runQc(reelId, { resources: qcResources });
      return { qcArtifactsRetained: result.retainedCount, qcArtifactsCleaned: result.cleanedCount };
    },
    close: async () => qcResources?.close(),
  };
};

const main = async (): Promise<void> => {
  const historyPath = resolve("data/reel-production-history.json");
  let acquisitionSources: AcquisitionSource[] = [];
  const productionHistory = await loadReelProductionHistory(historyPath);
  const excludedCanonicalIds = productionHistoryExcludedCanonicalIds(productionHistory);
  const rendered = productionHistory.entries.filter((entry) => entry.status === "RENDERED").length;
  console.info(`[reel-history] loaded=${productionHistory.entries.length} rendered=${rendered} qc_only=${productionHistory.entries.length - rendered}`);
  if (!selectionOnly) {
    const acquisition = await invokeCandidateAcquisition(excludedCanonicalIds);
    acquisitionSources = acquisition.sources;
    console.info(`[reel-acquire] existing_safe=${acquisition.existingSafeCount} history_excluded=${acquisition.historyExcludedCount} usable_existing=${acquisition.usableExistingCount}`);
    console.info(`[reel-acquire] target_pool=${acquisition.desiredPoolSize} missing=${Math.max(0, acquisition.desiredPoolSize - acquisition.usableExistingCount)} attempt_limit=${acquisition.attemptLimit}`);
    for (const source of acquisition.sources) {
      console.info(`[reel-acquire] ${source.source} accepted=${source.accepted} rejected=${source.rejected} failed=${source.failed}`);
      console.info(`[reel-acquire] ${source.source} rejection_reasons=${JSON.stringify(source.rejectionReasons)}`);
    }
    console.info(`[reel-acquire] ${acquisition.shortfall ? "SHORTFALL" : "COMPLETE"} usable_safe=${acquisition.usableSafeCandidateCount} newly_acquired=${acquisition.newlyAcquiredCount} attempted=${acquisition.attemptedCount} rejected=${acquisition.rejectedCount} source_failures=${acquisition.sourceFailureCount} time=${acquisition.acquisitionDurationMs}ms`);
  }
  const selectionStarted = performance.now();
  const queue = await invokeCandidateBoundary(historyPath);
  if (queue.stageCounts) {
    const stages = queue.stageCounts;
    console.info(`[reel-queue] acquired_usable=${stages.acquiredUsable} preselector_eligible=${stages.preselectorEligible} portfolio_available=${stages.portfolioAvailable} queued=${stages.queued}`);
    console.info(`[reel-queue] source_handoffs=${stages.sourceHandoffs} history_excluded_at_boundary=${stages.historyExcludedAtBoundary} preselector_rejections=${JSON.stringify(stages.preselectorRejectionCounts)}`);
  }
  if (selectionOnly) {
    console.info(`[reel-selection] target=${queue.target} candidates=${queue.candidateCount} ids=${queue.candidates.map((candidate) => candidate.canonicalId).join(",")}`);
    return;
  }
  const commands = createBatchCommandRunner();
  let manifest;
  try {
    manifest = await runReelBatch({ queue, render, forcePlan, productionHistory, productionHistoryPath: historyPath, batchId: runId, runExistingCommand: commands.run });
  } finally {
    await commands.close();
  }
  manifest.timings.selectionDurationMs = Math.round(performance.now() - selectionStarted) - manifest.timings.totalDurationMs;
  const manifestPath = resolve("output/reel-batches", `${runId}.json`);
  await writeBatchManifest(manifestPath, manifest);
  console.info(`[reel-batch] target=${manifest.target} candidates=${manifest.candidateCount}`);
  for (const attempt of manifest.candidates) {
    const plannerFailed = attempt.plannerFailureCategory !== undefined;
    const result = attempt.plannerFailureCategory
      ? `reason=${attempt.plannerFailureCategory}`
      : attempt.errorCode ?? (attempt.acceptanceStatus === "REJECTED" ? attempt.acceptanceReasons[0] ?? "REJECTED" : `qc=${attempt.qcStatus.toLowerCase()}`);
    console.info(`[${attempt.queueOrder}/${manifest.candidateCount}] ${attempt.canonicalId} plan=${plannerFailed ? "failed" : attempt.plannerStatus.toLowerCase()} accepted=${attempt.acceptanceStatus === "ACCEPTED"} ${result}${attempt.musicTrackId ? ` music=${attempt.musicTrackId}` : ""}`);
  }
  console.info(`[reel-batch] planner_failures=${JSON.stringify(manifest.plannerFailureCounts)}`);
  const acquisitionRejections = Object.fromEntries(acquisitionSources.map((source) => [source.source, source.rejectionReasons]));
  console.info(`[reel-batch] acquisition_rejections=${JSON.stringify(acquisitionRejections)}`);
  console.info(`[reel-batch] ${manifest.outcome}`);
  console.info(`target=${manifest.target} accepted=${manifest.acceptedCount} qc=${manifest.qcPassedCount} rendered=${manifest.renderedCount} completion=${manifest.completionBasis.toLowerCase()}:${manifest.completionCount} history_written=${manifest.historyWrittenCount} gemini_calls=${manifest.gemini.calls} cache_hits=${manifest.gemini.cacheHits} cost=$${manifest.gemini.estimatedCostUsd.toFixed(4)} time=${manifest.timings.totalDurationMs}ms`);
  console.info(`[reel-batch] operations=${JSON.stringify(manifest.operationalSummary)}`);
  console.info(`[reel-batch] manifest=${manifestPath}`);
  process.exitCode = exitCodeForBatchOutcome(manifest.outcome);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Reel batch failed");
    process.exitCode = 1;
  });
}
