import { readFile } from "node:fs/promises";
import { assessReelPlanAcceptance, PlanRejectionCode } from "../src/planner/acceptance";
import { ReelPlanSchema } from "../src/planner/reel-plan";

const requiredPlanIds = ["met_853157", "met_437311", "met_436975", "met_438159"];

const run = async (): Promise<void> => {
  for (const canonicalId of requiredPlanIds) {
    const cached = JSON.parse(await readFile(`data/plans/${canonicalId}.json`, "utf8"));
    const verdict = assessReelPlanAcceptance(ReelPlanSchema.parse(cached.plan));
    if (!verdict.accepted) throw new Error(`${canonicalId} should be accepted: ${verdict.rejectionReasons.join(", ")}`);
  }

  const fallback = assessReelPlanAcceptance(ReelPlanSchema.parse(JSON.parse(await readFile("data/plans/met_853157.json", "utf8")).plan), { isFallback: true });
  if (!fallback.rejectionReasons.includes(PlanRejectionCode.FALLBACK_PLAN)) throw new Error("explicit fallback must be rejected");
  console.log("Plan acceptance tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
