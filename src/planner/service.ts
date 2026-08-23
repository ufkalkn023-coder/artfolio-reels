import { type ArtworkHandoff } from "./handoff";
import { assessEligibility, type ReelEligibility } from "./eligibility";
import { readCachedPlan, writeCachedPlan } from "./cache";
import { type ReelPlan, validateReelPlan } from "./reel-plan";
import { type PlannerUsageTelemetry } from "./telemetry";

export type PlannerCallResult = ReelPlan | { plan: ReelPlan; telemetry?: PlannerUsageTelemetry; fallback?: boolean };
export type PlannerCall = (artwork: ArtworkHandoff, eligibility: ReelEligibility) => Promise<PlannerCallResult>;

export type PlanArtworkOptions = {
  cacheDirectory: string;
  force?: boolean;
  callPlanner: PlannerCall;
};

export const planArtwork = async (artwork: ArtworkHandoff, options: PlanArtworkOptions): Promise<{
  plan: ReelPlan;
  eligibility: ReelEligibility;
  cacheHit: boolean;
  fallback?: boolean;
  telemetry?: PlannerUsageTelemetry;
}> => {
  const eligibility = assessEligibility(artwork);
  if (!eligibility.eligible) throw new Error(`Artwork ${artwork.canonicalId} is not eligible: ${eligibility.reasons.join("; ")}`);
  if (!options.force) {
    const cached = await readCachedPlan(options.cacheDirectory, artwork, eligibility);
    if (cached) return { plan: cached.plan, eligibility, cacheHit: true, fallback: cached.fallback };
  }
  const response = await options.callPlanner(artwork, eligibility);
  const plannerResult = "plan" in response ? response : { plan: response };
  const plan = validateReelPlan(plannerResult.plan, eligibility, 1);
  const fallback = "fallback" in plannerResult ? plannerResult.fallback : undefined;
  await writeCachedPlan(options.cacheDirectory, artwork, plan, fallback);
  return { plan, eligibility, cacheHit: false, fallback, telemetry: plannerResult.telemetry };
};
