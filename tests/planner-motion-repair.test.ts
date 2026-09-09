import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessReelPlanAcceptance,
  getCameraMotionDiagnostics,
  getCameraMotionLimits,
  PlanRejectionCode,
  PlanWarningCode,
} from "../src/planner/acceptance";
import { PlanCacheStatus, readCachedPlan, writeCachedPlan } from "../src/planner/cache";
import { assessEligibility } from "../src/planner/eligibility";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { planWithGemini } from "../src/planner/gemini";
import { buildGeminiMotionRepairPrompt, buildGeminiPlannerPrompt } from "../src/planner/prompt";
import { type ReelPlan } from "../src/planner/reel-plan";
import { planArtwork, type PlannerCallContext } from "../src/planner/service";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };

const withMovingSceneCount = (source: ReelPlan, count: number): ReelPlan => ({
  ...structuredClone(source),
  scenes: source.scenes.map((scene, index) => ({
    ...scene,
    camera: index < count
      ? { move: "zoom-in" as const, focalX: 0.5, focalY: 0.5, startScale: 1.05, endScale: 1.12 }
      : { move: index === source.scenes.length - 1 ? "none" as const : "detail-hold" as const },
  })),
});

const nonCameraProjection = (plan: ReelPlan): unknown => ({
  ...plan,
  scenes: plan.scenes.map((scene) => {
    const projection = { ...scene };
    delete projection.camera;
    return projection;
  }),
});

const run = async (): Promise<void> => {
  const eligibility = assessEligibility(STARRY_NIGHT_HANDOFF);
  const sixSceneLimits = getCameraMotionLimits(6);
  equal(sixSceneLimits.allowedMaximum, 3, "six-scene hard motion limit remains three");
  equal(sixSceneLimits.safetyTarget, 2, "six-scene planner target stays one below the hard limit");
  equal(getCameraMotionLimits(7).allowedMaximum, 4, "seven-scene hard motion limit remains four");
  equal(getCameraMotionLimits(8).allowedMaximum, 4, "eight-scene hard motion limit remains four");
  equal(getCameraMotionLimits(8).safetyTarget, 3, "eight-scene planner target stays one below the hard limit");

  const sixScenePlan: ReelPlan = {
    ...structuredClone(STARRY_NIGHT_MOCK_PLAN),
    template: "three-details",
    scenes: [
      { id: "intro", kind: "intro", seconds: 2, camera: { move: "none" } },
      { id: "detail-1", kind: "detail", seconds: 4, detailId: "movement", camera: { move: "detail-hold" } },
      { id: "detail-2", kind: "detail", seconds: 4, detailId: "rhythm", camera: { move: "detail-hold" } },
      { id: "detail-3", kind: "detail", seconds: 4, detailId: "contrast", camera: { move: "detail-hold" } },
      { id: "overview", kind: "overview", seconds: 4, camera: { move: "none" } },
      { id: "outro", kind: "outro", seconds: 4, camera: { move: "none" } },
    ],
  };
  equal(assessReelPlanAcceptance(withMovingSceneCount(sixScenePlan, 3)).accepted, true, "a six-scene plan at three moving scenes remains accepted");
  truthy(assessReelPlanAcceptance(withMovingSceneCount(sixScenePlan, 4)).rejectionReasons.includes(PlanRejectionCode.EXCESSIVE_CAMERA_MOTION), "a six-scene plan at four moving scenes remains rejected");

  const atHardLimit = withMovingSceneCount(STARRY_NIGHT_MOCK_PLAN, 4);
  const atLimitAcceptance = assessReelPlanAcceptance(atHardLimit);
  equal(atLimitAcceptance.accepted, true, "a plan at the unchanged hard limit remains accepted");
  truthy(atLimitAcceptance.warnings.includes(PlanWarningCode.CAMERA_MOTION_NEAR_LIMIT), "a plan at the hard limit retains the near-limit warning");

  const excessivePlan = withMovingSceneCount(STARRY_NIGHT_MOCK_PLAN, 5);
  const excessiveAcceptance = assessReelPlanAcceptance(excessivePlan);
  equal(excessiveAcceptance.accepted, false, "a plan above the unchanged hard limit remains rejected");
  equal(excessiveAcceptance.rejectionReasons.join(","), PlanRejectionCode.EXCESSIVE_CAMERA_MOTION, "the excessive fixture is rejected only for camera motion");
  const originalMotion = getCameraMotionDiagnostics(excessivePlan);
  equal(originalMotion.movingSceneCount, 5, "motion diagnostics count the original moving scenes");
  equal(originalMotion.allowedMaximum, 4, "motion diagnostics expose the acceptance maximum");

  const productionPrompt = buildGeminiPlannerPrompt(STARRY_NIGHT_HANDOFF, eligibility);
  truthy(productionPrompt.includes("why-this-works: 8 scenes; hard maximum 4 moving scenes; safety target at most 3 moving scenes"), "planner prompt derives the template limit and safety target");
  truthy(productionPrompt.includes("none and detail-hold do not count"), "planner prompt identifies non-moving camera choices");

  const repairPlan = withMovingSceneCount(STARRY_NIGHT_MOCK_PLAN, 3);
  const repairContext: PlannerCallContext = {
    kind: "MOTION_REPAIR",
    rejectedPlan: excessivePlan,
    rejectionReason: PlanRejectionCode.EXCESSIVE_CAMERA_MOTION,
    originalMovingSceneCount: 5,
    allowedMaximum: 4,
    safetyTarget: 3,
  };
  const repairPrompt = buildGeminiMotionRepairPrompt(STARRY_NIGHT_HANDOFF, eligibility, repairContext);
  truthy(repairPrompt.includes("EXCESSIVE_CAMERA_MOTION: 5 moving scenes exceeds the hard maximum of 4"), "repair prompt contains the precise rejection reason");
  truthy(repairPrompt.includes("Preserve every non-camera field exactly"), "repair prompt requires non-camera preservation");
  truthy(repairPrompt.includes(JSON.stringify(excessivePlan)), "repair prompt supplies the rejected plan");

  const previousApiKey = process.env.GEMINI_API_KEY;
  let requestedPrompt = "";
  try {
    process.env.GEMINI_API_KEY = "test-api-key";
    await planWithGemini(STARRY_NIGHT_HANDOFF, eligibility, undefined, repairContext, {
      stat: async () => ({ size: 4 }),
      readFile: async () => Buffer.from("image"),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
        requestedPrompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(repairPlan) }] } }], usageMetadata: {} }), { status: 200 });
      },
      appendTelemetry: async () => undefined,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
  }
  truthy(requestedPrompt.includes("MOTION REPAIR"), "Gemini sends the targeted repair prompt for the repair call");

  const successCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-success-"));
  let successCalls = 0;
  let observedRepairContext: PlannerCallContext | undefined;
  const repaired = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: successCache,
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => {
      successCalls += 1;
      if (context) observedRepairContext = context;
      return context ? repairPlan : excessivePlan;
    },
  });
  equal(successCalls, 2, "an excessive live plan receives one repair call");
  equal(observedRepairContext?.kind, "MOTION_REPAIR", "the second call is explicitly motion repair");
  equal(repaired.motionRepair.outcome, "ACCEPTED", "successful repair outcome is explicit");
  equal(repaired.motionRepair.originalMovingSceneCount, 5, "successful diagnostics retain the original count");
  equal(repaired.motionRepair.allowedMaximum, 4, "successful diagnostics retain the allowed maximum");
  equal(repaired.motionRepair.repairedMovingSceneCount, 3, "successful diagnostics record the repaired count");
  equal(repaired.acceptance.accepted, true, "repaired output passes normal acceptance");
  equal(JSON.stringify(nonCameraProjection(repaired.plan)), JSON.stringify(nonCameraProjection(excessivePlan)), "successful repair preserves all non-camera fields");
  equal((await readCachedPlan(successCache, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.HIT, "only the accepted repaired plan is cached");

  const failedCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-failed-"));
  let failedCalls = 0;
  const failedRepair = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: failedCache,
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => {
      failedCalls += 1;
      return context ? withMovingSceneCount(STARRY_NIGHT_MOCK_PLAN, 5) : excessivePlan;
    },
  });
  equal(failedCalls, 2, "failed repair never creates a third planner call");
  equal(failedRepair.motionRepair.outcome, "REJECTED", "failed repair outcome is explicit");
  equal(failedRepair.motionRepair.repairedMovingSceneCount, 5, "failed diagnostics record the repaired count");
  equal(failedRepair.acceptance.accepted, false, "failed repair remains rejected by the normal gate");
  equal((await readCachedPlan(failedCache, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.MISS, "failed repaired plan is not cached");

  const preservedCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-preserved-cache-"));
  await writeCachedPlan(preservedCache, STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN);
  await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: preservedCache,
    force: true,
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => context ? excessivePlan : excessivePlan,
  });
  const preserved = await readCachedPlan(preservedCache, STARRY_NIGHT_HANDOFF, eligibility);
  equal(preserved.status, PlanCacheStatus.HIT, "failed forced repair preserves an existing valid cache entry");
  truthy(preserved.status === PlanCacheStatus.HIT && assessReelPlanAcceptance(preserved.value.plan).accepted, "preserved cache entry remains accepted");

  const preservationCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-preservation-"));
  const changedCopy = { ...repairPlan, hook: { ...repairPlan.hook, text: "Changed non-camera copy" } };
  const preservationFailure = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: preservationCache,
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => context ? changedCopy : excessivePlan,
  });
  equal(preservationFailure.motionRepair.outcome, "REJECTED", "a repair that changes copy is rejected");
  equal(preservationFailure.acceptance.accepted, false, "non-camera mutation cannot become an accepted plan");
  equal(JSON.stringify(preservationFailure.plan), JSON.stringify(excessivePlan), "non-camera mutation returns the original rejected plan");
  equal((await readCachedPlan(preservationCache, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.MISS, "non-camera mutation is not cached");

  const unrelatedCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-unrelated-"));
  const unrelatedPlan = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  unrelatedPlan.details[1].focalX = unrelatedPlan.details[0].focalX;
  unrelatedPlan.details[1].focalY = unrelatedPlan.details[0].focalY;
  let unrelatedCalls = 0;
  const unrelated = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: unrelatedCache,
    callPlanner: async () => { unrelatedCalls += 1; return unrelatedPlan; },
  });
  equal(unrelatedCalls, 1, "an unrelated rejection never triggers repair");
  truthy(unrelated.acceptance.rejectionReasons.includes(PlanRejectionCode.DETAILS_TOO_CLOSE), "unrelated rejection reason is retained");
  equal(unrelated.motionRepair.outcome, "NOT_ATTEMPTED", "unrelated rejection reports no repair attempt");
  equal((await readCachedPlan(unrelatedCache, STARRY_NIGHT_HANDOFF, eligibility)).status, PlanCacheStatus.MISS, "unaccepted live plan is not cached");

  const mixedCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-mixed-"));
  const mixedPlan = withMovingSceneCount(unrelatedPlan, 5);
  let mixedCalls = 0;
  const mixed = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: mixedCache,
    callPlanner: async () => { mixedCalls += 1; return mixedPlan; },
  });
  equal(mixedCalls, 1, "camera motion combined with another rejection does not trigger repair");
  truthy(mixed.acceptance.rejectionReasons.includes(PlanRejectionCode.EXCESSIVE_CAMERA_MOTION), "mixed rejection retains camera-motion reason");
  truthy(mixed.acceptance.rejectionReasons.includes(PlanRejectionCode.DETAILS_TOO_CLOSE), "mixed rejection retains the unrelated reason");
  equal(mixed.motionRepair.outcome, "NOT_ATTEMPTED", "mixed rejection explicitly reports no repair attempt");

  const historicalCache = await mkdtemp(join(tmpdir(), "artfolio-motion-repair-historical-"));
  await writeCachedPlan(historicalCache, STARRY_NIGHT_HANDOFF, excessivePlan);
  let historicalCalls = 0;
  let historicalRepairRequested = false;
  const historical = await planArtwork(STARRY_NIGHT_HANDOFF, {
    cacheDirectory: historicalCache,
    callPlanner: async (_artwork, _eligibility, _recentMusic, context) => {
      historicalCalls += 1;
      if (context) historicalRepairRequested = true;
      return STARRY_NIGHT_MOCK_PLAN;
    },
  });
  equal(historical.cacheHit, false, "motion-only rejected historical cache falls through to live planning");
  equal(historicalCalls, 1, "motion-only rejected historical cache makes one live planner call");
  equal(historicalRepairRequested, false, "historical cached rejection never receives motion repair");
  equal(historical.acceptance.accepted, true, "accepted live plan replaces the rejected historical result");
  equal(JSON.stringify(historical.plan), JSON.stringify(STARRY_NIGHT_MOCK_PLAN), "accepted live plan is returned");
  const refreshedHistorical = await readCachedPlan(historicalCache, STARRY_NIGHT_HANDOFF, eligibility);
  equal(refreshedHistorical.status, PlanCacheStatus.HIT, "accepted live plan is cached through normal cache semantics");
  truthy(refreshedHistorical.status === PlanCacheStatus.HIT && JSON.stringify(refreshedHistorical.value.plan) === JSON.stringify(STARRY_NIGHT_MOCK_PLAN), "cached historical entry is replaced by the accepted live plan");

  console.log("Planner motion contract and one-shot repair tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
