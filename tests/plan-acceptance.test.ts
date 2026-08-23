import { readFile } from "node:fs/promises";
import { assessReelPlanAcceptance, PlanRejectionCode } from "../src/planner/acceptance";
import { ReelPlanSchema } from "../src/planner/reel-plan";

const requiredPlanIds = [
  "met_853157", "met_437311", "met_436975", "met_438159",
  "met_436001", "met_437055", "met_437508", "met_437216", "met_437455",
];

const run = async (): Promise<void> => {
  for (const canonicalId of requiredPlanIds) {
    const cached = JSON.parse(await readFile(`data/plans/${canonicalId}.json`, "utf8"));
    const verdict = assessReelPlanAcceptance(ReelPlanSchema.parse(cached.plan));
    if (!verdict.accepted) throw new Error(`${canonicalId} should be accepted: ${verdict.rejectionReasons.join(", ")}`);
  }

  const fallback = assessReelPlanAcceptance(ReelPlanSchema.parse(JSON.parse(await readFile("data/plans/met_853157.json", "utf8")).plan), { isFallback: true });
  if (!fallback.rejectionReasons.includes(PlanRejectionCode.FALLBACK_PLAN)) throw new Error("explicit fallback must be rejected");

  const sourcePlan = ReelPlanSchema.parse(JSON.parse(await readFile("data/plans/met_853157.json", "utf8")).plan);
  const textlessDetail = assessReelPlanAcceptance({
    ...sourcePlan,
    details: sourcePlan.details.map((detail, index) => index === 0 ? { ...detail, observation: " " } : detail),
  });
  if (!textlessDetail.rejectionReasons.includes(PlanRejectionCode.INSUFFICIENT_EDITORIAL_COVERAGE)) {
    throw new Error("multi-second detail scenes without editorial copy must be rejected");
  }

  const shortTransition = assessReelPlanAcceptance({
    ...sourcePlan,
    details: sourcePlan.details.map((detail, index) => index === 0 ? { ...detail, observation: " " } : detail),
    scenes: sourcePlan.scenes.map((scene, index) => index === 1 ? { ...scene, seconds: 0.75 } : scene),
  });
  if (shortTransition.rejectionReasons.includes(PlanRejectionCode.INSUFFICIENT_EDITORIAL_COVERAGE)) {
    throw new Error("short transition-only detail intervals may remain textless");
  }

  const textlessOverview = assessReelPlanAcceptance({ ...sourcePlan, centralIdea: " " });
  if (!textlessOverview.rejectionReasons.includes(PlanRejectionCode.INSUFFICIENT_EDITORIAL_COVERAGE)) {
    throw new Error("multi-second overview scenes without synthesis copy must be rejected");
  }

  const exemptScenes = assessReelPlanAcceptance({
    ...sourcePlan,
    centralIdea: " ",
    scenes: sourcePlan.scenes.map((scene) => scene.kind === "overview" ? { ...scene, seconds: 0.75 } : scene),
  });
  if (exemptScenes.rejectionReasons.includes(PlanRejectionCode.INSUFFICIENT_EDITORIAL_COVERAGE)) {
    throw new Error("intro, outro, and short overview transitions remain editorially exempt");
  }
  console.log("Plan acceptance tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
