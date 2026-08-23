import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileSingleArtworkPlan, type CompileResult } from "./compiler";
import { localizeArtworkAsset, type LocalizedArtworkAsset } from "./assets";
import { ArtworkHandoffSchema, type ArtworkHandoff } from "./handoff";
import { planArtwork, type PlannerCall } from "./service";
import { type ReelEligibility } from "./eligibility";
import { type PlannerUsageTelemetry } from "./telemetry";
import { assessReelPlanAcceptance, ReelPlanAcceptanceError, type ReelPlanAcceptance } from "./acceptance";

export type HandoffPipelineResult = CompileResult & {
  handoff: ArtworkHandoff;
  cacheHit: boolean;
  reelPath: string;
  telemetry?: PlannerUsageTelemetry;
  acceptance: ReelPlanAcceptance;
};

export type HandoffPipelineOptions = {
  cacheDirectory: string;
  reelDirectory: string;
  forcePlan?: boolean;
  callPlanner: PlannerCall;
  compile?: (artwork: ArtworkHandoff, plan: unknown, eligibility: ReelEligibility) => CompileResult;
  localizeArtwork?: (artwork: ArtworkHandoff) => Promise<LocalizedArtworkAsset>;
};

export const artifactIdFor = (canonicalId: string): string => canonicalId.replace(/[^A-Za-z0-9_-]/g, "_");

export const writeReelArtifact = async (destination: string, value: unknown): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporaryPath, destination);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/**
 * The deterministic pre-render boundary: validate handoff → plan/cache → V2 ReelData.
 * It intentionally has no knowledge of QC, rendering, or Gemini configuration.
 */
export const runHandoffPipeline = async (
  rawHandoff: unknown,
  options: HandoffPipelineOptions,
): Promise<HandoffPipelineResult> => {
  const handoff = ArtworkHandoffSchema.parse(rawHandoff);
  const localized = await (options.localizeArtwork ?? localizeArtworkAsset)(handoff);
  const planned = await planArtwork(handoff, {
    cacheDirectory: options.cacheDirectory,
    force: options.forcePlan,
    callPlanner: options.callPlanner,
  });
  const acceptance = assessReelPlanAcceptance(planned.plan, { artwork: localized.artwork, isFallback: planned.fallback });
  const acceptanceSummary = acceptance.accepted
    ? `[plan-gate] artwork=${handoff.canonicalId} accepted=true warnings=${acceptance.warnings.length}`
    : `[plan-gate] artwork=${handoff.canonicalId} accepted=false reason=${acceptance.rejectionReasons[0] ?? "UNKNOWN"}`;
  console.info(acceptanceSummary);
  if (!acceptance.accepted) throw new ReelPlanAcceptanceError(acceptance);
  const compiled = (options.compile ?? compileSingleArtworkPlan)(localized.artwork, planned.plan, planned.eligibility);
  const reelPath = join(options.reelDirectory, `${artifactIdFor(handoff.canonicalId)}.json`);
  await writeReelArtifact(reelPath, compiled.reel);
  return { ...compiled, handoff, cacheHit: planned.cacheHit, reelPath, telemetry: planned.telemetry, acceptance };
};
