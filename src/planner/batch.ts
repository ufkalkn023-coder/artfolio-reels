import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type MotionRepairDiagnostics, MotionRepairAttemptError, planArtwork, type PlannerCall } from "./service";
import { localizeArtworkAsset, type LocalizedArtworkAsset } from "./assets";
import { compileSingleArtworkPlan } from "./compiler";
import { ArtworkHandoffSchema, type ArtworkHandoff } from "./handoff";
import { planWithGemini } from "./gemini";
import { artifactIdFor, writeReelArtifact } from "./pipeline";
import { type PlannerUsageTelemetry } from "./telemetry";
import { PLANNER_VERSION } from "./config";
import { recentMusicContextFromProductionHistory, recordProductionHistory, type ProductionHistoryStatus, type ReelProductionHistory } from "./production-history";
import { resolveRenderOutputPath } from "./render-path";
import { PlannerFailureCategory, classifyPlannerFailure, type PlannerFailureCategory as PlannerFailureCategoryValue } from "./failure";
import { writeSocialCopy, type SocialCopyWriter } from "../social/social-copy";
import { type MusicSuggestions } from "./reel-plan";
import { enrichCompletedReelWithAfm, hasUsableAfmMusic, type CompletedReelMusicEnricher } from "../music/enrichment";
import { sanitizeDiagnostic } from "../security/redaction";

export const REEL_BATCH_VERSION = "reel-batch-v1" as const;

export type BatchCandidate = {
  canonicalId: string;
  artist?: string;
  museum?: string;
  handoffPath: string;
  baseScore: number;
  portfolioPriorityScore: number;
};

export type BatchCandidateQueue = {
  target: number;
  candidateLimit: number;
  candidateCount: number;
  candidates: BatchCandidate[];
  stageCounts?: {
    sourceHandoffs: number;
    historyExcludedAtBoundary: number;
    acquiredUsable: number;
    preselectorEligible: number;
    portfolioAvailable: number;
    queued: number;
    preselectorRejectionCounts: Record<string, number>;
  };
};

export type ExistingBatchCommandResult = {
  qcArtifactsRetained?: number;
  qcArtifactsCleaned?: number;
};
export type ExistingBatchCommand = (name: "qc" | "render", reelId: string) => Promise<ExistingBatchCommandResult | void> | ExistingBatchCommandResult | void;

export type BatchCandidateAttempt = {
  queueOrder: number;
  canonicalId: string;
  artist?: string;
  museum?: string;
  baseScore: number;
  portfolioPriorityScore: number;
  handoffStatus: "PENDING" | "OK" | "FAILED";
  plannerStatus: "PENDING" | "CACHE" | "LIVE" | "FAILED";
  cacheHit: boolean;
  acceptanceStatus: "PENDING" | "ACCEPTED" | "REJECTED";
  initialAcceptanceReasons: string[];
  acceptanceReasons: string[];
  acceptanceWarnings: string[];
  motionRepair?: MotionRepairDiagnostics;
  qcStatus: "PENDING" | "PASSED" | "FAILED" | "SKIPPED";
  renderStatus: "PENDING" | "PASSED" | "FAILED" | "SKIPPED";
  template?: string;
  duration?: number;
  planPath?: string;
  qcPath?: string;
  renderPath?: string;
  socialPath?: string;
  musicSuggestions?: MusicSuggestions;
  musicTrackId?: string;
  musicSubfamily?: string;
  musicWarning?: string;
  historyStatus?: ProductionHistoryStatus;
  plannerFailureCategory?: PlannerFailureCategoryValue;
  errorCode?: "HANDOFF_FAILED" | "ASSET_FAILED" | "PLANNER_FAILED" | "QC_FAILED" | "MUSIC_FAILED" | "RENDER_FAILED" | "SOCIAL_COPY_FAILED";
  errorMessageSafe?: string;
};

export type BatchTelemetry = {
  calls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  estimatedCostUsd: number;
  plannerDurationMs: number;
};

export type ReelBatchManifest = {
  batchVersion: typeof REEL_BATCH_VERSION;
  startedAt: string;
  finishedAt: string;
  target: number;
  candidateLimit: number;
  candidateCount: number;
  plannedCount: number;
  acceptedCount: number;
  qcPassedCount: number;
  renderedCount: number;
  completionBasis: "QC_PASSED" | "RENDERED";
  completionCount: number;
  historyLoadedCount: number;
  historyWrittenCount: number;
  rejectedCount: number;
  failedCount: number;
  plannerFailureCounts: Partial<Record<PlannerFailureCategoryValue, number>>;
  candidatesExhausted: boolean;
  outcome: "COMPLETE" | "SHORTFALL";
  operationalSummary: {
    target: number;
    accepted: number;
    qcPassed: number;
    rendered: number;
    released: number;
    failed: number;
    shortfall: number;
    qcArtifactsRetained: number;
    qcArtifactsCleaned: number;
    renderVerificationFailures: number;
    motionRepairAttempts: number;
    motionRepairsAccepted: number;
    motionRepairsRejected: number;
    repairGeminiCalls: number;
  };
  gemini: BatchTelemetry;
  timings: {
    selectionDurationMs: number;
    handoffDurationMs: number;
    plannerDurationMs: number;
    qcDurationMs: number;
    renderDurationMs: number;
    totalDurationMs: number;
  };
  candidates: BatchCandidateAttempt[];
};

export type RunReelBatchOptions = {
  queue: BatchCandidateQueue;
  render?: boolean;
  cacheDirectory?: string;
  reelDirectory?: string;
  outputDirectory?: string;
  callPlanner?: PlannerCall;
  forcePlan?: boolean;
  runExistingCommand?: ExistingBatchCommand;
  now?: () => Date;
  localizeArtwork?: (artwork: ArtworkHandoff) => Promise<LocalizedArtworkAsset>;
  productionHistory?: ReelProductionHistory;
  productionHistoryPath?: string;
  batchId?: string;
  writeSocialCopy?: SocialCopyWriter;
  enrichMusic?: CompletedReelMusicEnricher;
};

const elapsed = (started: number): number => Math.round(performance.now() - started);
const durationFor = (plan: { scenes: Array<{ seconds: number }> }): number => plan.scenes.reduce((total, scene) => total + scene.seconds, 0);
const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Unknown error";
  return sanitizeDiagnostic(message, 300);
};
const defaultExistingCommand: ExistingBatchCommand = (name, reelId) => new Promise((resolveCommand, reject) => {
  const child = spawn("npm", ["run", name, "--", reelId], { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveCommand() : reject(new Error(`${name} failed for ${reelId}`)));
});
const emptyTelemetry = (): BatchTelemetry => ({ calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, estimatedCostUsd: 0, plannerDurationMs: 0 });
const addTelemetry = (total: BatchTelemetry, telemetry: PlannerUsageTelemetry | undefined, cacheHit: boolean): void => {
  if (cacheHit) total.cacheHits += 1;
  if (!telemetry) return;
  total.calls += telemetry.geminiCalls;
  total.inputTokens += telemetry.promptTokenCount ?? 0;
  total.outputTokens += telemetry.candidatesTokenCount ?? 0;
  total.thinkingTokens += telemetry.thoughtsTokenCount ?? 0;
  total.estimatedCostUsd += telemetry.estimatedCostUsd;
  total.plannerDurationMs += telemetry.requestDurationMs;
};

export const writeBatchManifest = async (path: string, manifest: ReelBatchManifest): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

/**
 * Orchestrates approved stages serially so rejected/failed artwork never
 * aborts the remaining deterministic queue. It deliberately does not write
 * publishing or Reel-history state.
 */
export const runReelBatch = async (options: RunReelBatchOptions): Promise<ReelBatchManifest> => {
  const started = performance.now();
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const queue = options.queue;
  const outputDirectory = options.outputDirectory ?? resolve("output");
  const cacheDirectory = options.cacheDirectory ?? resolve("data/plans");
  const reelDirectory = options.reelDirectory ?? resolve("data/reels");
  const callPlanner = options.callPlanner ?? planWithGemini;
  const runCommand = options.runExistingCommand ?? defaultExistingCommand;
  const localize = options.localizeArtwork ?? localizeArtworkAsset;
  const writeSocial = options.writeSocialCopy ?? writeSocialCopy;
  const telemetry = emptyTelemetry();
  const timings = { selectionDurationMs: 0, handoffDurationMs: 0, plannerDurationMs: 0, qcDurationMs: 0, renderDurationMs: 0, totalDurationMs: 0 };
  const attempts: BatchCandidateAttempt[] = [];
  let plannedCount = 0;
  let acceptedCount = 0;
  let qcPassedCount = 0;
  let renderedCount = 0;
  let qcArtifactsRetained = 0;
  let qcArtifactsCleaned = 0;
  let repairGeminiCalls = 0;
  const completionCount = (): number => options.render ? renderedCount : qcPassedCount;
  let historyWrittenCount = 0;
  let productionHistory = options.productionHistory;
  const recordHistory = async (handoff: ArtworkHandoff, attempt: BatchCandidateAttempt, status: ProductionHistoryStatus): Promise<void> => {
    if (!productionHistory || !options.productionHistoryPath || !options.batchId || !attempt.template) return;
    const result = await recordProductionHistory(options.productionHistoryPath, productionHistory, {
      canonicalId: handoff.canonicalId, artist: handoff.artist, museum: handoff.museum, source: handoff.source,
      template: attempt.template, plannerVersion: PLANNER_VERSION, batchId: options.batchId, status,
      completedAt: (options.now ?? (() => new Date()))().toISOString(), duration: attempt.duration,
      warnings: attempt.acceptanceWarnings, ...(status === "RENDERED" ? { renderPath: attempt.renderPath } : {}),
      ...(attempt.musicTrackId ? { musicTrackId: attempt.musicTrackId, musicSubfamily: attempt.musicSubfamily } : {}),
      musicSuggestions: attempt.musicSuggestions,
    });
    productionHistory = result.history;
    attempt.historyStatus = result.entry.status;
    if (result.changed) historyWrittenCount += 1;
    console.info(`[reel-history] ${handoff.canonicalId} ${result.transition ?? `status=${result.entry.status}`} ${result.changed ? "recorded" : "already recorded"}`);
  };

  type PreparedCandidate = {
    candidate: BatchCandidate;
    handoff?: ArtworkHandoff;
    localized?: LocalizedArtworkAsset;
    errorCode?: "HANDOFF_FAILED" | "ASSET_FAILED";
    errorMessageSafe?: string;
  };
  type RenderReadyCandidate = {
    handoff: ArtworkHandoff;
    attempt: BatchCandidateAttempt;
    planned: Awaited<ReturnType<typeof planArtwork>>;
    compiled: ReturnType<typeof compileSingleArtworkPlan>;
  };
  const preparedCandidates: PreparedCandidate[] = [];
  const renderReadyCandidates: RenderReadyCandidate[] = [];
  // The Remotion bundle snapshots public/. Localize every bounded queue asset
  // serially before the first QC command may initialize shared resources.
  for (const candidate of queue.candidates.slice(0, queue.candidateLimit)) {
    const prepared: PreparedCandidate = { candidate };
    const handoffStarted = performance.now();
    try {
      prepared.handoff = ArtworkHandoffSchema.parse(JSON.parse(await readFile(candidate.handoffPath, "utf8")));
      if (prepared.handoff.canonicalId !== candidate.canonicalId) throw new Error("Handoff canonical ID does not match candidate queue");
    } catch (error) {
      prepared.errorCode = "HANDOFF_FAILED";
      prepared.errorMessageSafe = safeErrorMessage(error);
    }
    timings.handoffDurationMs += elapsed(handoffStarted);
    if (prepared.handoff) {
      try {
        prepared.localized = await localize(prepared.handoff);
      } catch (error) {
        prepared.errorCode = "ASSET_FAILED";
        prepared.errorMessageSafe = safeErrorMessage(error);
      }
    }
    preparedCandidates.push(prepared);
  }

  for (const [index, prepared] of preparedCandidates.entries()) {
    if (completionCount() >= queue.target) break;
    const { candidate } = prepared;
    const attempt: BatchCandidateAttempt = {
      queueOrder: index + 1, canonicalId: candidate.canonicalId, artist: candidate.artist, museum: candidate.museum,
      baseScore: candidate.baseScore, portfolioPriorityScore: candidate.portfolioPriorityScore,
      handoffStatus: "PENDING", plannerStatus: "PENDING", cacheHit: false, acceptanceStatus: "PENDING",
      initialAcceptanceReasons: [], acceptanceReasons: [], acceptanceWarnings: [], qcStatus: "SKIPPED", renderStatus: "SKIPPED",
    };
    attempts.push(attempt);
    if (!prepared.handoff) {
      attempt.handoffStatus = "FAILED";
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = prepared.errorCode ?? "HANDOFF_FAILED";
      attempt.errorMessageSafe = prepared.errorMessageSafe;
      continue;
    }
    const handoff = prepared.handoff;
    attempt.handoffStatus = "OK";
    if (!prepared.localized) {
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = prepared.errorCode ?? "ASSET_FAILED";
      attempt.errorMessageSafe = prepared.errorMessageSafe;
      continue;
    }
    const localized = prepared.localized;

    const plannerStarted = performance.now();
    let planned;
    try {
      planned = await planArtwork(handoff, {
        cacheDirectory,
        callPlanner,
        force: options.forcePlan,
        recentMusic: productionHistory ? recentMusicContextFromProductionHistory(productionHistory, undefined, handoff.canonicalId) : undefined,
      });
      attempt.plannerStatus = planned.cacheHit ? "CACHE" : "LIVE";
      attempt.cacheHit = planned.cacheHit;
      addTelemetry(telemetry, planned.telemetry, planned.cacheHit);
      addTelemetry(telemetry, planned.repairTelemetry, false);
      repairGeminiCalls += planned.repairTelemetry?.geminiCalls ?? 0;
      plannedCount += 1;
      timings.plannerDurationMs += elapsed(plannerStarted);
    } catch (error) {
      timings.plannerDurationMs += elapsed(plannerStarted);
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = "PLANNER_FAILED";
      if (error instanceof MotionRepairAttemptError) {
        attempt.initialAcceptanceReasons = error.initialAcceptance.rejectionReasons;
        attempt.motionRepair = error.motionRepair;
        addTelemetry(telemetry, error.initialTelemetry, false);
        telemetry.calls += 1;
        repairGeminiCalls += 1;
      }
      attempt.plannerFailureCategory = classifyPlannerFailure(error);
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }

    const acceptance = planned.acceptance;
    attempt.initialAcceptanceReasons = planned.initialAcceptance.rejectionReasons;
    attempt.acceptanceReasons = acceptance.rejectionReasons;
    attempt.acceptanceWarnings = acceptance.warnings;
    attempt.motionRepair = planned.motionRepair;
    attempt.template = planned.plan.template;
    attempt.duration = durationFor(planned.plan);
    attempt.musicSuggestions = planned.plan.musicSuggestions;
    if (!acceptance.accepted) {
      attempt.acceptanceStatus = "REJECTED";
      attempt.plannerFailureCategory = PlannerFailureCategory.ACCEPTANCE_REJECTED;
      continue;
    }
    attempt.acceptanceStatus = "ACCEPTED";
    acceptedCount += 1;
    let compiled;
    try {
      compiled = compileSingleArtworkPlan(localized.artwork, planned.plan, planned.eligibility);
    } catch (error) {
      attempt.plannerFailureCategory = PlannerFailureCategory.COMPILER_ERROR;
      attempt.qcStatus = "FAILED";
      attempt.errorCode = "QC_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }
    try {
      const reelId = artifactIdFor(handoff.canonicalId);
      attempt.planPath = resolve(reelDirectory, `${reelId}.json`);
      await writeReelArtifact(attempt.planPath, compiled.reel);
      const qcStarted = performance.now();
      attempt.qcPath = resolve(outputDirectory, "qc", reelId);
      const qcResult = await runCommand("qc", reelId);
      qcArtifactsRetained += qcResult?.qcArtifactsRetained ?? 0;
      qcArtifactsCleaned += qcResult?.qcArtifactsCleaned ?? 0;
      timings.qcDurationMs += elapsed(qcStarted);
      attempt.qcStatus = "PASSED";
      qcPassedCount += 1;
    } catch (error) {
      attempt.qcStatus = "FAILED";
      attempt.errorCode = "QC_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }
    if (options.render) {
      renderReadyCandidates.push({ handoff, attempt, planned, compiled });
      continue;
    }
    const music = await (options.enrichMusic ?? enrichCompletedReelWithAfm)(
      compiled.reel,
      productionHistory ?? { version: "reel-production-history-v1", entries: [] },
    );
    if (music.warning) {
      attempt.musicWarning = music.warning;
      console.warn(`[afm] artwork=${handoff.canonicalId} warning=${music.warning}`);
    }
    if (music.selection) {
      attempt.musicTrackId = music.selection.track.id;
      attempt.musicSubfamily = music.selection.track.subfamilyCode;
      await writeReelArtifact(attempt.planPath!, music.reel);
      console.info(`[afm] artwork=${handoff.canonicalId} track=${attempt.musicTrackId} subfamily=${attempt.musicSubfamily} score=${music.selection.score.total}`);
    }
    await recordHistory(handoff, attempt, "QC_PASSED");
  }

  // AFM selection intentionally remains post-QC. Complete every localization
  // before the first final-render command creates a bundle that snapshots public/.
  for (const { handoff, attempt, compiled } of renderReadyCandidates) {
    const music = await (options.enrichMusic ?? enrichCompletedReelWithAfm)(
      compiled.reel,
      productionHistory ?? { version: "reel-production-history-v1", entries: [] },
    );
    if (music.warning) {
      attempt.musicWarning = music.warning;
      console.warn(`[afm] artwork=${handoff.canonicalId} warning=${music.warning}`);
    }
    if (!hasUsableAfmMusic(music.reel)) {
      attempt.renderStatus = "FAILED";
      attempt.errorCode = "MUSIC_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(new Error(`Production render requires usable AFM music identity${music.warning ? `: ${music.warning}` : ""}`));
      continue;
    }
    if (music.selection) {
      attempt.musicTrackId = music.selection.track.id;
      attempt.musicSubfamily = music.selection.track.subfamilyCode;
      await writeReelArtifact(attempt.planPath!, music.reel);
      console.info(`[afm] artwork=${handoff.canonicalId} track=${attempt.musicTrackId} subfamily=${attempt.musicSubfamily} score=${music.selection.score.total}`);
    }
  }

  for (const { handoff, attempt, planned } of renderReadyCandidates) {
    if (renderedCount >= queue.target) break;
    if (attempt.renderStatus === "FAILED") continue;
    const renderStarted = performance.now();
    try {
      const reelId = artifactIdFor(handoff.canonicalId);
      attempt.renderPath = resolveRenderOutputPath(handoff.canonicalId, handoff.title, outputDirectory);
      await runCommand("render", reelId);
      timings.renderDurationMs += elapsed(renderStarted);
      attempt.renderStatus = "PASSED";
      renderedCount += 1;
      try {
        attempt.socialPath = await writeSocial(handoff, planned.plan, outputDirectory);
      } catch (error) {
        attempt.errorCode = "SOCIAL_COPY_FAILED";
        attempt.errorMessageSafe = safeErrorMessage(error);
      }
      await recordHistory(handoff, attempt, "RENDERED");
    } catch (error) {
      timings.renderDurationMs += elapsed(renderStarted);
      attempt.renderStatus = "FAILED";
      attempt.errorCode = "RENDER_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
    }
  }

  timings.totalDurationMs = elapsed(started);
  const rejectedCount = attempts.filter((attempt) => attempt.acceptanceStatus === "REJECTED").length;
  const failedCount = attempts.filter((attempt) => attempt.errorCode !== undefined).length;
  const plannerFailureCounts = attempts.reduce<Partial<Record<PlannerFailureCategoryValue, number>>>((counts, attempt) => {
    if (attempt.plannerFailureCategory) counts[attempt.plannerFailureCategory] = (counts[attempt.plannerFailureCategory] ?? 0) + 1;
    return counts;
  }, {});
  const finalCompletionCount = completionCount();
  const completionBasis = options.render ? "RENDERED" : "QC_PASSED";
  const candidatesExhausted = finalCompletionCount < queue.target && attempts.length >= Math.min(queue.candidateCount, queue.candidateLimit);
  const shortfall = Math.max(0, queue.target - finalCompletionCount);
  const renderVerificationFailures = attempts.filter((attempt) => attempt.errorCode === "RENDER_FAILED").length;
  const motionRepairAttempts = attempts.filter((attempt) => attempt.motionRepair?.outcome !== undefined && attempt.motionRepair.outcome !== "NOT_ATTEMPTED").length;
  const motionRepairsAccepted = attempts.filter((attempt) => attempt.motionRepair?.outcome === "ACCEPTED").length;
  const motionRepairsRejected = attempts.filter((attempt) => attempt.motionRepair?.outcome === "REJECTED").length;
  return {
    batchVersion: REEL_BATCH_VERSION, startedAt, finishedAt: (options.now ?? (() => new Date()))().toISOString(),
    target: queue.target, candidateLimit: queue.candidateLimit, candidateCount: queue.candidateCount,
    plannedCount, acceptedCount, qcPassedCount, renderedCount, completionBasis, completionCount: finalCompletionCount,
    historyLoadedCount: options.productionHistory?.entries.length ?? 0, historyWrittenCount, rejectedCount, failedCount, plannerFailureCounts, candidatesExhausted,
    outcome: finalCompletionCount >= queue.target ? "COMPLETE" : "SHORTFALL",
    operationalSummary: {
      target: queue.target,
      accepted: acceptedCount,
      qcPassed: qcPassedCount,
      rendered: renderedCount,
      released: 0,
      failed: failedCount,
      shortfall,
      qcArtifactsRetained,
      qcArtifactsCleaned,
      renderVerificationFailures,
      motionRepairAttempts,
      motionRepairsAccepted,
      motionRepairsRejected,
      repairGeminiCalls,
    },
    gemini: telemetry, timings, candidates: attempts,
  };
};
