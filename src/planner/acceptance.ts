import { getTemplate } from "../v2/templates";
import { type ArtworkHandoff } from "./handoff";
import { DISTANCE_THRESHOLD, DURATION_TOLERANCE_SECONDS, type PlannedDetail, type ReelPlan } from "./reel-plan";

export const REEL_PLAN_ACCEPTANCE_VERSION = "reel-plan-acceptance-v1" as const;

export const PlanRejectionCode = {
  INVALID_DURATION: "INVALID_DURATION",
  HOOK_TOO_LONG: "HOOK_TOO_LONG",
  INVALID_HOOK: "INVALID_HOOK",
  CENTRAL_IDEA_MISSING: "CENTRAL_IDEA_MISSING",
  INSUFFICIENT_DETAILS: "INSUFFICIENT_DETAILS",
  DETAILS_TOO_CLOSE: "DETAILS_TOO_CLOSE",
  INVALID_FOCAL_POINT: "INVALID_FOCAL_POINT",
  INVALID_SCALE: "INVALID_SCALE",
  EXCESSIVE_CAMERA_MOTION: "EXCESSIVE_CAMERA_MOTION",
  TEMPLATE_STRUCTURE_MISMATCH: "TEMPLATE_STRUCTURE_MISMATCH",
  FALLBACK_PLAN: "FALLBACK_PLAN",
  METADATA_MISMATCH: "METADATA_MISMATCH",
} as const;
export type PlanRejectionCode = (typeof PlanRejectionCode)[keyof typeof PlanRejectionCode];

export const PlanWarningCode = {
  DURATION_NEAR_MAX: "DURATION_NEAR_MAX",
  DETAILS_CLOSE: "DETAILS_CLOSE",
  CAMERA_MOTION_NEAR_LIMIT: "CAMERA_MOTION_NEAR_LIMIT",
} as const;
export type PlanWarningCode = (typeof PlanWarningCode)[keyof typeof PlanWarningCode];

export type ProtectedArtworkMetadata = Pick<ArtworkHandoff, "canonicalId" | "title" | "artist" | "date" | "medium" | "museum">;

export type ReelPlanAcceptanceContext = {
  artwork?: ArtworkHandoff;
  /** Set only when an upstream planner explicitly identifies its result as a fallback. */
  isFallback?: boolean;
  /** Optional compiler-carried metadata, compared directly with the verified handoff when present. */
  metadata?: ProtectedArtworkMetadata;
};

export type ReelPlanAcceptance = {
  accepted: boolean;
  acceptanceVersion: typeof REEL_PLAN_ACCEPTANCE_VERSION;
  rejectionReasons: PlanRejectionCode[];
  warnings: PlanWarningCode[];
};

const MAX_HOOK_WORDS = 12;
const CLOSE_DETAIL_THRESHOLD = 0.2;
const isMotion = (move: string | undefined): boolean => move !== undefined && move !== "none" && move !== "detail-hold";
const wordCount = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;
const distance = (left: PlannedDetail, right: PlannedDetail): number => Math.hypot(left.focalX - right.focalX, left.focalY - right.focalY);

const maximumMotionScenes = (sceneCount: number): number => Math.max(2, Math.ceil(sceneCount / 2));

const protectedMetadataMatches = (artwork: ArtworkHandoff, metadata: ProtectedArtworkMetadata): boolean =>
  metadata.canonicalId === artwork.canonicalId &&
  metadata.title === artwork.title &&
  metadata.artist === artwork.artist &&
  metadata.date === artwork.date &&
  metadata.medium === artwork.medium &&
  metadata.museum === artwork.museum;

/**
 * Deterministic production-policy check for an already schema-valid ReelPlan.
 * It deliberately does not score copy or infer visual meaning.
 */
export const assessReelPlanAcceptance = (
  plan: ReelPlan,
  context: ReelPlanAcceptanceContext = {},
): ReelPlanAcceptance => {
  const rejectionReasons: PlanRejectionCode[] = [];
  const warnings: PlanWarningCode[] = [];
  const reject = (code: PlanRejectionCode): void => {
    if (!rejectionReasons.includes(code)) rejectionReasons.push(code);
  };
  const warn = (code: PlanWarningCode): void => {
    if (!warnings.includes(code)) warnings.push(code);
  };
  const template = getTemplate(plan.template);

  if (context.isFallback) reject(PlanRejectionCode.FALLBACK_PLAN);
  if (context.artwork && context.metadata && !protectedMetadataMatches(context.artwork, context.metadata)) {
    reject(PlanRejectionCode.METADATA_MISMATCH);
  }

  const hook = plan.hook?.text;
  if (typeof hook !== "string" || hook.trim().length === 0 || hook !== hook.trim() || /\s{2,}/.test(hook)) {
    reject(PlanRejectionCode.INVALID_HOOK);
  } else if (wordCount(hook) > MAX_HOOK_WORDS) {
    reject(PlanRejectionCode.HOOK_TOO_LONG);
  }
  if (typeof plan.centralIdea !== "string" || plan.centralIdea.trim().length === 0) {
    reject(PlanRejectionCode.CENTRAL_IDEA_MISSING);
  }

  if (plan.details.length < template.requiredDetailCount) reject(PlanRejectionCode.INSUFFICIENT_DETAILS);
  const detailById = new Map(plan.details.map((detail) => [detail.id, detail]));
  const expectedScenes = template.defaultScenePlan;
  const structureMatches = plan.scenes.length === expectedScenes.length &&
    plan.scenes.every((scene, index) => scene.kind === expectedScenes[index]);
  if (!structureMatches || template.requiredArtworkCount !== 1) reject(PlanRejectionCode.TEMPLATE_STRUCTURE_MISMATCH);

  const selectedDetails = plan.scenes
    .filter((scene) => scene.kind === "detail")
    .map((scene) => scene.detailId ? detailById.get(scene.detailId) : undefined)
    .filter((detail): detail is PlannedDetail => detail !== undefined);
  const detailSceneIds = new Set(plan.scenes.filter((scene) => scene.kind === "detail").map((scene) => scene.detailId));
  if (selectedDetails.length !== plan.scenes.filter((scene) => scene.kind === "detail").length ||
    detailSceneIds.size < template.requiredDetailCount ||
    plan.scenes.some((scene) => scene.kind === "observation" && scene.observationIndex === undefined) ||
    plan.scenes.some((scene) => scene.observationIndex !== undefined && scene.observationIndex >= plan.details.length)) {
    reject(PlanRejectionCode.TEMPLATE_STRUCTURE_MISMATCH);
  }

  plan.details.forEach((detail) => {
    if (!Number.isFinite(detail.focalX) || !Number.isFinite(detail.focalY) || detail.focalX < 0 || detail.focalX > 1 || detail.focalY < 0 || detail.focalY > 1) {
      reject(PlanRejectionCode.INVALID_FOCAL_POINT);
    }
    if (!Number.isFinite(detail.preferredScale) || detail.preferredScale <= 0 || detail.preferredScale > 2.5) {
      reject(PlanRejectionCode.INVALID_SCALE);
    }
  });
  plan.scenes.forEach((scene) => {
    const camera = scene.camera;
    if (!camera) return;
    if ([camera.focalX, camera.focalY, camera.endFocalX, camera.endFocalY].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) {
      reject(PlanRejectionCode.INVALID_FOCAL_POINT);
    }
    if ([camera.startScale, camera.endScale].some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2.5))) {
      reject(PlanRejectionCode.INVALID_SCALE);
    }
  });

  if (selectedDetails.length >= 2) {
    const distances = selectedDetails.flatMap((detail, index) => selectedDetails.slice(index + 1).map((other) => distance(detail, other)));
    if (distances.some((value) => value < DISTANCE_THRESHOLD)) reject(PlanRejectionCode.DETAILS_TOO_CLOSE);
    else if (distances.some((value) => value < CLOSE_DETAIL_THRESHOLD)) warn(PlanWarningCode.DETAILS_CLOSE);
  }

  const duration = plan.scenes.reduce((total, scene) => total + scene.seconds, 0);
  if (duration < template.minDuration - DURATION_TOLERANCE_SECONDS || duration > template.maxDuration + DURATION_TOLERANCE_SECONDS) {
    reject(PlanRejectionCode.INVALID_DURATION);
  } else if (duration >= template.maxDuration - 1) {
    warn(PlanWarningCode.DURATION_NEAR_MAX);
  }

  const motionScenes = plan.scenes.filter((scene) => isMotion(scene.camera?.move)).length;
  const motionLimit = maximumMotionScenes(plan.scenes.length);
  if (motionScenes > motionLimit) reject(PlanRejectionCode.EXCESSIVE_CAMERA_MOTION);
  else if (motionScenes === motionLimit) warn(PlanWarningCode.CAMERA_MOTION_NEAR_LIMIT);

  return {
    accepted: rejectionReasons.length === 0,
    acceptanceVersion: REEL_PLAN_ACCEPTANCE_VERSION,
    rejectionReasons,
    warnings,
  };
};

export class ReelPlanAcceptanceError extends Error {
  public readonly acceptance: ReelPlanAcceptance;

  public constructor(acceptance: ReelPlanAcceptance) {
    super(`Reel plan rejected: ${acceptance.rejectionReasons.join(", ")}`);
    this.name = "ReelPlanAcceptanceError";
    this.acceptance = acceptance;
  }
}
