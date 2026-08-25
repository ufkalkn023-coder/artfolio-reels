import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assessReelPlanAcceptance, type ReelPlanAcceptance } from "./acceptance";
import { localizeArtworkAsset, type LocalizedArtworkAsset } from "./assets";
import { compileSingleArtworkPlan } from "./compiler";
import { ArtworkHandoffSchema, type ArtworkHandoff } from "./handoff";
import { planWithGemini } from "./gemini";
import { artifactIdFor, writeReelArtifact } from "./pipeline";
import { planArtwork, type PlannerCall } from "./service";
import { type PlannerUsageTelemetry } from "./telemetry";
import { PLANNER_VERSION } from "./config";
import { recordProductionHistory, type ProductionHistoryStatus, type ReelProductionHistory } from "./production-history";
import { resolveRenderOutputPath } from "./render-path";
import { PlannerFailureCategory, classifyPlannerFailure, type PlannerFailureCategory as PlannerFailureCategoryValue } from "./failure";
import { writeSocialCopy, type SocialCopyWriter } from "../social/social-copy";

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

export type ExistingBatchCommand = (name: "qc" | "render", reelId: string) => void;

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
  acceptanceReasons: string[];
  acceptanceWarnings: string[];
  qcStatus: "PENDING" | "PASSED" | "FAILED" | "SKIPPED";
  renderStatus: "PENDING" | "PASSED" | "FAILED" | "SKIPPED";
  template?: string;
  duration?: number;
  planPath?: string;
  qcPath?: string;
  renderPath?: string;
  socialPath?: string;
  historyStatus?: ProductionHistoryStatus;
  plannerFailureCategory?: PlannerFailureCategoryValue;
  errorCode?: "HANDOFF_FAILED" | "ASSET_FAILED" | "PLANNER_FAILED" | "QC_FAILED" | "RENDER_FAILED" | "SOCIAL_COPY_FAILED";
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
  historyLoadedCount: number;
  historyWrittenCount: number;
  rejectedCount: number;
  failedCount: number;
  plannerFailureCounts: Partial<Record<PlannerFailureCategoryValue, number>>;
  candidatesExhausted: boolean;
  outcome: "COMPLETE" | "SHORTFALL";
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
  runExistingCommand?: ExistingBatchCommand;
  now?: () => Date;
  localizeArtwork?: (artwork: ArtworkHandoff) => Promise<LocalizedArtworkAsset>;
  productionHistory?: ReelProductionHistory;
  productionHistoryPath?: string;
  batchId?: string;
  writeSocialCopy?: SocialCopyWriter;
};

const elapsed = (started: number): number => Math.round(performance.now() - started);
const durationFor = (plan: { scenes: Array<{ seconds: number }> }): number => plan.scenes.reduce((total, scene) => total + scene.seconds, 0);
const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/(?:https?|wss?):\/\/[^\s'"<>]+/gi, "[redacted-url]")
    .replace(/([?&](?:key|token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(\b(?:[A-Z][A-Z0-9_]*?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|token|secret|password)\b\s*(?:=|:)\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 300);
};
const defaultExistingCommand: ExistingBatchCommand = (name, reelId) => {
  const result = spawnSync("npm", ["run", name, "--", reelId], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${name} failed for ${reelId}`);
};
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
  let historyWrittenCount = 0;
  let productionHistory = options.productionHistory;
  const recordHistory = async (handoff: ArtworkHandoff, attempt: BatchCandidateAttempt, status: ProductionHistoryStatus): Promise<void> => {
    if (!productionHistory || !options.productionHistoryPath || !options.batchId || !attempt.template) return;
    const result = await recordProductionHistory(options.productionHistoryPath, productionHistory, {
      canonicalId: handoff.canonicalId, artist: handoff.artist, museum: handoff.museum, source: handoff.source,
      template: attempt.template, plannerVersion: PLANNER_VERSION, batchId: options.batchId, status,
      completedAt: (options.now ?? (() => new Date()))().toISOString(), duration: attempt.duration,
      warnings: attempt.acceptanceWarnings, ...(status === "RENDERED" ? { renderPath: attempt.renderPath } : {}),
    });
    productionHistory = result.history;
    attempt.historyStatus = result.entry.status;
    if (result.changed) historyWrittenCount += 1;
    console.info(`[reel-history] ${handoff.canonicalId} ${result.transition ?? `status=${result.entry.status}`} ${result.changed ? "recorded" : "already recorded"}`);
  };

  for (const [index, candidate] of queue.candidates.slice(0, queue.candidateLimit).entries()) {
    if (qcPassedCount >= queue.target) break;
    const attempt: BatchCandidateAttempt = {
      queueOrder: index + 1, canonicalId: candidate.canonicalId, artist: candidate.artist, museum: candidate.museum,
      baseScore: candidate.baseScore, portfolioPriorityScore: candidate.portfolioPriorityScore,
      handoffStatus: "PENDING", plannerStatus: "PENDING", cacheHit: false, acceptanceStatus: "PENDING",
      acceptanceReasons: [], acceptanceWarnings: [], qcStatus: "SKIPPED", renderStatus: "SKIPPED",
    };
    attempts.push(attempt);
    let handoff: ArtworkHandoff;
    const handoffStarted = performance.now();
    try {
      handoff = ArtworkHandoffSchema.parse(JSON.parse(await readFile(candidate.handoffPath, "utf8")));
      if (handoff.canonicalId !== candidate.canonicalId) throw new Error("Handoff canonical ID does not match candidate queue");
      attempt.handoffStatus = "OK";
    } catch (error) {
      attempt.handoffStatus = "FAILED";
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = "HANDOFF_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
      timings.handoffDurationMs += elapsed(handoffStarted);
      continue;
    }
    timings.handoffDurationMs += elapsed(handoffStarted);

    let localized: LocalizedArtworkAsset;
    try {
      localized = await localize(handoff);
    } catch (error) {
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = "ASSET_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }

    const plannerStarted = performance.now();
    let planned;
    try {
      planned = await planArtwork(handoff, { cacheDirectory, callPlanner });
      attempt.plannerStatus = planned.cacheHit ? "CACHE" : "LIVE";
      attempt.cacheHit = planned.cacheHit;
      addTelemetry(telemetry, planned.telemetry, planned.cacheHit);
      plannedCount += 1;
      timings.plannerDurationMs += elapsed(plannerStarted);
    } catch (error) {
      timings.plannerDurationMs += elapsed(plannerStarted);
      attempt.plannerStatus = "FAILED";
      attempt.errorCode = "PLANNER_FAILED";
      attempt.plannerFailureCategory = classifyPlannerFailure(error);
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }

    const acceptance: ReelPlanAcceptance = assessReelPlanAcceptance(planned.plan, { artwork: localized.artwork, isFallback: planned.fallback });
    attempt.acceptanceReasons = acceptance.rejectionReasons;
    attempt.acceptanceWarnings = acceptance.warnings;
    attempt.template = planned.plan.template;
    attempt.duration = durationFor(planned.plan);
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
      runCommand("qc", reelId);
      timings.qcDurationMs += elapsed(qcStarted);
      attempt.qcStatus = "PASSED";
      qcPassedCount += 1;
    } catch (error) {
      attempt.qcStatus = "FAILED";
      attempt.errorCode = "QC_FAILED";
      attempt.errorMessageSafe = safeErrorMessage(error);
      continue;
    }
    if (!options.render) {
      await recordHistory(handoff, attempt, "QC_PASSED");
      continue;
    }
    const renderStarted = performance.now();
    try {
      const reelId = artifactIdFor(handoff.canonicalId);
      attempt.renderPath = resolveRenderOutputPath(handoff.canonicalId, handoff.title, outputDirectory);
      runCommand("render", reelId);
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
  const candidatesExhausted = qcPassedCount < queue.target && attempts.length >= Math.min(queue.candidateCount, queue.candidateLimit);
  return {
    batchVersion: REEL_BATCH_VERSION, startedAt, finishedAt: (options.now ?? (() => new Date()))().toISOString(),
    target: queue.target, candidateLimit: queue.candidateLimit, candidateCount: queue.candidateCount,
    plannedCount, acceptedCount, qcPassedCount, renderedCount, historyLoadedCount: options.productionHistory?.entries.length ?? 0, historyWrittenCount, rejectedCount, failedCount, plannerFailureCounts, candidatesExhausted,
    outcome: qcPassedCount === queue.target ? "COMPLETE" : "SHORTFALL", gemini: telemetry, timings, candidates: attempts,
  };
};
