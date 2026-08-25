import { type ArtworkHandoff } from "./handoff";
import { assessEligibility, type ReelEligibility } from "./eligibility";
import { readCachedPlan, writeCachedPlan } from "./cache";
import { type ReelPlan, validateReelPlan } from "./reel-plan";
import { type PlannerUsageTelemetry } from "./telemetry";
import { EMPTY_RECENT_MUSIC_CONTEXT, findRecentMusicDuplicates, type RecentMusicContext } from "./music-history";

export type PlannerCallResult = ReelPlan | { plan: ReelPlan; telemetry?: PlannerUsageTelemetry; fallback?: boolean };
export type PlannerCall = (artwork: ArtworkHandoff, eligibility: ReelEligibility, recentMusic: RecentMusicContext) => Promise<PlannerCallResult>;

export type PlanArtworkOptions = {
  cacheDirectory: string;
  force?: boolean;
  callPlanner: PlannerCall;
  recentMusic?: RecentMusicContext;
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
  const recentMusic = options.recentMusic ?? EMPTY_RECENT_MUSIC_CONTEXT;
  const response = await options.callPlanner(artwork, eligibility, recentMusic);
  const plannerResult = "plan" in response ? response : { plan: response };
  const plan = validateReelPlan(plannerResult.plan, eligibility, 1, true);
  const recentDuplicates = findRecentMusicDuplicates(plan.musicSuggestions ?? [], recentMusic);
  if (recentDuplicates.length > 0) {
    throw new Error(`New Reel plan reused recent music: ${recentDuplicates.map(({ artist, title }) => `${artist} — ${title}`).join(", ")}`);
  }
  const fallback = "fallback" in plannerResult ? plannerResult.fallback : undefined;
  await writeCachedPlan(options.cacheDirectory, artwork, plan, fallback);
  return { plan, eligibility, cacheHit: false, fallback, telemetry: plannerResult.telemetry };
};
