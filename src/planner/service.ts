import { isDeepStrictEqual } from "node:util";
import { type ArtworkHandoff } from "./handoff";
import { assessEligibility, type ReelEligibility } from "./eligibility";
import { PlanCacheReadError, PlanCacheStatus, readCachedPlan, writeCachedPlan } from "./cache";
import { type ReelPlan, validateReelPlan } from "./reel-plan";
import { type PlannerUsageTelemetry } from "./telemetry";
import { EMPTY_RECENT_MUSIC_CONTEXT, findRecentMusicDuplicates, type RecentMusicContext } from "./music-history";
import { assessReelPlanAcceptance, getCameraMotionDiagnostics, PlanRejectionCode, type ReelPlanAcceptance } from "./acceptance";

export type PlannerCallResult = ReelPlan | { plan: ReelPlan; telemetry?: PlannerUsageTelemetry; fallback?: boolean };
export type PlannerCallContext = {
  kind: "MOTION_REPAIR";
  rejectedPlan: ReelPlan;
  rejectionReason: typeof PlanRejectionCode.EXCESSIVE_CAMERA_MOTION;
  originalMovingSceneCount: number;
  allowedMaximum: number;
  safetyTarget: number;
};
export type PlannerCall = (
  artwork: ArtworkHandoff,
  eligibility: ReelEligibility,
  recentMusic: RecentMusicContext,
  context?: PlannerCallContext,
) => Promise<PlannerCallResult>;

export type MotionRepairDiagnostics = {
  outcome: "NOT_ATTEMPTED" | "ACCEPTED" | "REJECTED";
  originalMovingSceneCount: number;
  allowedMaximum: number;
  repairedMovingSceneCount?: number;
};

export class MotionRepairAttemptError extends Error {
  public constructor(
    readonly initialAcceptance: ReelPlanAcceptance,
    readonly motionRepair: MotionRepairDiagnostics,
    readonly initialTelemetry: PlannerUsageTelemetry | undefined,
    readonly originalError: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : "Motion repair planner call failed");
    this.name = "MotionRepairAttemptError";
  }
}

export type PlanArtworkOptions = {
  cacheDirectory: string;
  force?: boolean;
  callPlanner: PlannerCall;
  recentMusic?: RecentMusicContext;
};

const validatePlannerResult = (
  response: PlannerCallResult,
  eligibility: ReelEligibility,
  recentMusic: RecentMusicContext,
): { plan: ReelPlan; fallback?: boolean; telemetry?: PlannerUsageTelemetry } => {
  const plannerResult = "plan" in response ? response : { plan: response };
  const plan = validateReelPlan(plannerResult.plan, eligibility, 1, true);
  const recentDuplicates = findRecentMusicDuplicates(plan.musicSuggestions ?? [], recentMusic);
  if (recentDuplicates.length > 0) {
    throw new Error(`New Reel plan reused recent music: ${recentDuplicates.map(({ artist, title }) => `${artist} — ${title}`).join(", ")}`);
  }
  return {
    plan,
    ...(plannerResult.fallback !== undefined ? { fallback: plannerResult.fallback } : {}),
    ...(plannerResult.telemetry ? { telemetry: plannerResult.telemetry } : {}),
  };
};

const nonCameraProjection = (plan: ReelPlan): unknown => ({
  ...plan,
  scenes: plan.scenes.map((scene) => {
    const projection = { ...scene };
    delete projection.camera;
    return projection;
  }),
});

const isMotionOnlyRejection = (acceptance: ReelPlanAcceptance): boolean =>
  acceptance.rejectionReasons.length === 1 && acceptance.rejectionReasons[0] === PlanRejectionCode.EXCESSIVE_CAMERA_MOTION;

const logMotionDiagnostics = (
  artwork: ArtworkHandoff,
  acceptance: ReelPlanAcceptance,
  diagnostics: MotionRepairDiagnostics,
): void => {
  const initial = acceptance.accepted ? "accepted" : `rejected:${acceptance.rejectionReasons.join(",")}`;
  console.info(
    `[planner-motion] artwork=${artwork.canonicalId} initial=${initial} original_moving=${diagnostics.originalMovingSceneCount} `
    + `allowed=${diagnostics.allowedMaximum} repaired_moving=${diagnostics.repairedMovingSceneCount ?? "n/a"} repair=${diagnostics.outcome.toLowerCase()}`,
  );
};

export const planArtwork = async (artwork: ArtworkHandoff, options: PlanArtworkOptions): Promise<{
  plan: ReelPlan;
  eligibility: ReelEligibility;
  cacheHit: boolean;
  fallback?: boolean;
  telemetry?: PlannerUsageTelemetry;
  repairTelemetry?: PlannerUsageTelemetry;
  initialAcceptance: ReelPlanAcceptance;
  acceptance: ReelPlanAcceptance;
  motionRepair: MotionRepairDiagnostics;
}> => {
  const eligibility = assessEligibility(artwork);
  if (!eligibility.eligible) throw new Error(`Artwork ${artwork.canonicalId} is not eligible: ${eligibility.reasons.join("; ")}`);
  if (!options.force) {
    const cached = await readCachedPlan(options.cacheDirectory, artwork, eligibility);
    if (cached.status === PlanCacheStatus.HIT) {
      const acceptance = assessReelPlanAcceptance(cached.value.plan, { artwork, isFallback: cached.value.fallback });
      const motion = getCameraMotionDiagnostics(cached.value.plan);
      const motionRepair: MotionRepairDiagnostics = {
        outcome: "NOT_ATTEMPTED",
        originalMovingSceneCount: motion.movingSceneCount,
        allowedMaximum: motion.allowedMaximum,
      };
      if (!isMotionOnlyRejection(acceptance)) {
        logMotionDiagnostics(artwork, acceptance, motionRepair);
        return { plan: cached.value.plan, eligibility, cacheHit: true, fallback: cached.value.fallback, initialAcceptance: acceptance, acceptance, motionRepair };
      }
    }
    if (cached.status !== PlanCacheStatus.MISS && cached.status !== PlanCacheStatus.HIT) {
      throw new PlanCacheReadError(cached.status, cached.path, cached.reason);
    }
  }
  const recentMusic = options.recentMusic ?? EMPTY_RECENT_MUSIC_CONTEXT;
  const plannerResult = validatePlannerResult(await options.callPlanner(artwork, eligibility, recentMusic), eligibility, recentMusic);
  const initialAcceptance = assessReelPlanAcceptance(plannerResult.plan, { artwork, isFallback: plannerResult.fallback });
  const originalMotion = getCameraMotionDiagnostics(plannerResult.plan);
  if (initialAcceptance.accepted) {
    await writeCachedPlan(options.cacheDirectory, artwork, plannerResult.plan, plannerResult.fallback);
    const motionRepair: MotionRepairDiagnostics = {
      outcome: "NOT_ATTEMPTED",
      originalMovingSceneCount: originalMotion.movingSceneCount,
      allowedMaximum: originalMotion.allowedMaximum,
    };
    logMotionDiagnostics(artwork, initialAcceptance, motionRepair);
    return { ...plannerResult, eligibility, cacheHit: false, initialAcceptance, acceptance: initialAcceptance, motionRepair };
  }

  if (!isMotionOnlyRejection(initialAcceptance)) {
    const motionRepair: MotionRepairDiagnostics = {
      outcome: "NOT_ATTEMPTED",
      originalMovingSceneCount: originalMotion.movingSceneCount,
      allowedMaximum: originalMotion.allowedMaximum,
    };
    logMotionDiagnostics(artwork, initialAcceptance, motionRepair);
    return { ...plannerResult, eligibility, cacheHit: false, initialAcceptance, acceptance: initialAcceptance, motionRepair };
  }

  const repairContext: PlannerCallContext = {
    kind: "MOTION_REPAIR",
    rejectedPlan: plannerResult.plan,
    rejectionReason: PlanRejectionCode.EXCESSIVE_CAMERA_MOTION,
    originalMovingSceneCount: originalMotion.movingSceneCount,
    allowedMaximum: originalMotion.allowedMaximum,
    safetyTarget: originalMotion.safetyTarget,
  };
  let repairResult: ReturnType<typeof validatePlannerResult>;
  try {
    repairResult = validatePlannerResult(
      await options.callPlanner(artwork, eligibility, recentMusic, repairContext),
      eligibility,
      recentMusic,
    );
  } catch (error) {
    const motionRepair: MotionRepairDiagnostics = {
      outcome: "REJECTED",
      originalMovingSceneCount: originalMotion.movingSceneCount,
      allowedMaximum: originalMotion.allowedMaximum,
    };
    logMotionDiagnostics(artwork, initialAcceptance, motionRepair);
    throw new MotionRepairAttemptError(initialAcceptance, motionRepair, plannerResult.telemetry, error);
  }
  const repairedMotion = getCameraMotionDiagnostics(repairResult.plan);
  const repairedAcceptance = assessReelPlanAcceptance(repairResult.plan, { artwork, isFallback: repairResult.fallback });
  const preservesNonCameraFields = isDeepStrictEqual(nonCameraProjection(plannerResult.plan), nonCameraProjection(repairResult.plan));
  const repairAccepted = preservesNonCameraFields && repairedAcceptance.accepted;
  const motionRepair: MotionRepairDiagnostics = {
    outcome: repairAccepted ? "ACCEPTED" : "REJECTED",
    originalMovingSceneCount: originalMotion.movingSceneCount,
    allowedMaximum: originalMotion.allowedMaximum,
    repairedMovingSceneCount: repairedMotion.movingSceneCount,
  };
  logMotionDiagnostics(artwork, initialAcceptance, motionRepair);
  if (!repairAccepted) {
    return {
      ...plannerResult,
      eligibility,
      cacheHit: false,
      initialAcceptance,
      acceptance: preservesNonCameraFields ? repairedAcceptance : initialAcceptance,
      motionRepair,
      ...(repairResult.telemetry ? { repairTelemetry: repairResult.telemetry } : {}),
      ...(preservesNonCameraFields ? { plan: repairResult.plan, fallback: repairResult.fallback } : {}),
    };
  }

  await writeCachedPlan(options.cacheDirectory, artwork, repairResult.plan, repairResult.fallback);
  return {
    ...plannerResult,
    plan: repairResult.plan,
    fallback: repairResult.fallback,
    eligibility,
    cacheHit: false,
    initialAcceptance,
    acceptance: repairedAcceptance,
    motionRepair,
    ...(repairResult.telemetry ? { repairTelemetry: repairResult.telemetry } : {}),
  };
};
