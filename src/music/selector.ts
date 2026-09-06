import { type ReelProductionHistory } from "../planner/production-history";
import { type ReelData } from "../v2/schema";
import { type AfmTrack, parseAfmTrackId } from "./afm";
import { deriveMusicIntent, type MusicIntent } from "./intent";
import {
  AFM_FAMILY_PROFILES,
  AFM_FIRST_PASS_SUBFAMILIES,
  isAfmFamilyCode,
  type AfmFamilyCode,
} from "./taxonomy";

export const RECENT_AFM_REEL_LIMIT = 12;

export type MusicScore = {
  semantic: number;
  family: number;
  subfamily: number;
  pacing: number;
  energy: number;
  motion: number;
  duration: number;
  quality: number;
  recentPenalty: number;
  totalUsePenalty: number;
  total: number;
};

export type MusicFamilyRanking = {
  code: AfmFamilyCode;
  name: string;
  score: number;
  characterScore: number;
  semanticScore: number;
  matchedTokens: string[];
};

export type MusicSubfamilyRanking = {
  code: string;
  familyCode: AfmFamilyCode;
  name: string;
  score: number;
  familyScore: number;
  semanticScore: number;
  matchedTokens: string[];
};

export type RankedMusicTrack = {
  track: AfmTrack;
  score: MusicScore;
  recentIndex?: number;
  recentExcluded: boolean;
  eligible: boolean;
};

export type MusicSelection = {
  track: AfmTrack;
  intent: MusicIntent;
  score: MusicScore;
  recentExclusionFallback: boolean;
  forced: boolean;
};

export type CompletedReelMusicAnalysis = {
  intent: MusicIntent;
  familyRanking: MusicFamilyRanking[];
  subfamilyRanking: MusicSubfamilyRanking[];
  trackRanking: RankedMusicTrack[];
  recentExclusions: Array<{ trackId: string; recentIndex: number }>;
  recentExclusionFallback: boolean;
  selection?: MusicSelection;
  reason: string;
};

const normalize = (value: string): string => value
  .normalize("NFKD")
  .replace(/\p{Mark}/gu, "")
  .toLocaleLowerCase("en-US");
const tokens = (value: string): Set<string> => new Set(normalize(value).match(/[\p{Letter}\p{Number}]+/gu) ?? []);
const closeness = (left: number, right: number): number => 1 - Math.min(1, Math.abs(left - right));
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const roundedRecord = <T extends Record<string, number>>(value: T): T => Object.fromEntries(
  Object.entries(value).map(([key, score]) => [key, round(score)]),
) as T;

const familyCharacterFit = (family: AfmFamilyCode, intent: MusicIntent): number => {
  const calm = 1 - intent.energy;
  const still = 1 - intent.motionIntensity;
  const scores: Record<AfmFamilyCode, number> = {
    DE: calm * 2.6 + still * 0.85 + intent.intimacy * 0.7 + (1 - intent.darkness) * 0.35,
    NP: calm * 1.5 + intent.intimacy * 1.8 + intent.acousticPreference * 1.25 + intent.darkness * 0.35,
    PS: intent.acousticPreference * 1.4 + intent.intimacy * 0.8 + intent.grandeur * 1.25 + intent.darkness * 0.45,
    DM: intent.darkness * 2.8 + still * 0.65 + intent.abstraction * 0.45,
    BC: intent.historicalAffinity * 2.6 + intent.acousticPreference * 1.1 + intent.grandeur * 0.6,
    RC: intent.grandeur * 2.25 + intent.acousticPreference * 0.85 + intent.energy * 0.65,
    MA: calm * 2.75 + still * 1.05 + intent.abstraction * 0.65 + intent.electronicPreference * 0.35,
    AE: intent.abstraction * 2.25 + intent.electronicPreference * 1.65 + intent.motionIntensity * 1.15 + intent.energy * 0.8,
    SU: intent.abstraction * 1.55 + intent.darkness * 1.2 + intent.electronicPreference * 0.85 + intent.playfulness * 0.35,
    MM: intent.grandeur * 2.8 + intent.energy * 1.2 + intent.historicalAffinity * 0.45,
    ID: intent.intimacy * 2.75 + calm * 1.35 + intent.acousticPreference * 0.75,
    CP: intent.playfulness * 2.8 + intent.energy * 1.4 + intent.motionIntensity * 0.8 + intent.detailDensity * 0.45,
  };
  return scores[family];
};

const semanticProfileFit = (
  intentTokens: ReadonlySet<string>,
  keywords: readonly string[],
  maximum: number,
): { score: number; matchedTokens: string[] } => {
  const matchedTokens = [...new Set(keywords.filter((keyword) => intentTokens.has(normalize(keyword))))].sort();
  // Multiple independent words are required for full semantic weight; one token stays subordinate to Reel traits.
  const saturation = matchedTokens.length >= 3 ? 1 : matchedTokens.length === 2 ? 0.58 : matchedTokens.length === 1 ? 0.25 : 0;
  return { score: maximum * saturation, matchedTokens };
};

export const rankMusicFamilies = (intent: MusicIntent): MusicFamilyRanking[] => {
  const intentTokens = new Set(intent.semanticTokens);
  return AFM_FAMILY_PROFILES.map((profile) => {
    const characterScore = familyCharacterFit(profile.code, intent);
    const semantic = semanticProfileFit(intentTokens, profile.semanticKeywords, 2.4);
    return {
      code: profile.code,
      name: profile.name,
      score: round(characterScore + semantic.score),
      characterScore: round(characterScore),
      semanticScore: round(semantic.score),
      matchedTokens: semantic.matchedTokens,
    };
  }).sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
};

export const rankMusicSubfamilies = (
  intent: MusicIntent,
  familyRanking = rankMusicFamilies(intent),
): MusicSubfamilyRanking[] => {
  const intentTokens = new Set(intent.semanticTokens);
  const familyScores = new Map(familyRanking.map((family) => [family.code, family.score]));
  return AFM_FIRST_PASS_SUBFAMILIES.map((profile) => {
    const semantic = semanticProfileFit(intentTokens, profile.semanticKeywords, 1.2);
    const familyScore = familyScores.get(profile.familyCode) ?? 0;
    return {
      code: profile.code,
      familyCode: profile.familyCode,
      name: profile.name,
      score: round(familyScore + semantic.score),
      familyScore,
      semanticScore: round(semantic.score),
      matchedTokens: semantic.matchedTokens,
    };
  }).sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
};

const variationFit = (track: AfmTrack, intent: MusicIntent): number => {
  const name = normalize(track.variation);
  if (name.includes("rhythmic")) return intent.energy * 1.15 + intent.motionIntensity * 1.1;
  if (name.includes("ambient") || name.includes("atmospheric")) return (1 - intent.energy) * 1.25 + (1 - intent.motionIntensity) * 0.75;
  if (name.includes("minimal")) return (1 - intent.energy) * 1.1 + intent.intimacy * 0.65;
  if (name.includes("experimental")) return intent.abstraction * 1.1 + intent.electronicPreference * 0.8;
  if (name.includes("organic") || name.includes("acoustic")) return intent.acousticPreference * 1.45;
  if (name.includes("modern") || name.includes("hybrid")) return intent.electronicPreference * 1.1 + intent.energy * 0.55;
  if (name.includes("lead-instrument")) return intent.intimacy * 0.85 + intent.acousticPreference * 0.55;
  if (name.includes("signature")) return intent.grandeur * 0.8 + 0.35;
  return 0.35;
};

type HistoryUsage = { recent: Map<string, number>; total: Map<string, number> };

const historyUsage = (history: ReelProductionHistory, excludeCanonicalId?: string): HistoryUsage => {
  const entries = history.entries
    .filter((entry) => entry.canonicalId !== excludeCanonicalId)
    .sort((left, right) => right.qcPassedAt.localeCompare(left.qcPassedAt) || left.canonicalId.localeCompare(right.canonicalId));
  const recent = new Map<string, number>();
  entries.slice(0, RECENT_AFM_REEL_LIMIT).forEach((entry, index) => {
    if (entry.musicTrackId && !recent.has(entry.musicTrackId)) recent.set(entry.musicTrackId, index);
  });
  const total = new Map<string, number>();
  entries.forEach((entry) => {
    if (entry.musicTrackId) total.set(entry.musicTrackId, (total.get(entry.musicTrackId) ?? 0) + 1);
  });
  return { recent, total };
};

const scoreTrack = (
  track: AfmTrack,
  intent: MusicIntent,
  familyScores: ReadonlyMap<string, number>,
  recentIndex: number | undefined,
  totalUses: number,
  applyRecentPenalty: boolean,
): MusicScore => {
  const intentTokens = new Set(intent.semanticTokens);
  const trackTokens = tokens(`${track.subfamilyName} ${track.variation}`);
  const overlap = [...trackTokens].filter((token) => intentTokens.has(token)).length;
  const subfamilyOverlap = [...tokens(track.subfamilyName)].filter((token) => intentTokens.has(token)).length;
  const semantic = Math.min(0.9, overlap * 0.3);
  const family = familyScores.get(track.familyCode) ?? 0;
  const subfamily = Math.min(2, variationFit(track, intent) + Math.min(0.8, subfamilyOverlap * 0.3));
  const targetEnergy = /rhythmic|modern|experimental/i.test(track.variation) ? 0.76 : /ambient|minimal/i.test(track.variation) ? 0.24 : 0.48;
  const pacing = intent.pacing === "fast"
    ? (/rhythmic|modern|experimental/i.test(track.variation) ? 1 : 0.25)
    : intent.pacing === "slow"
      ? (/ambient|minimal|organic/i.test(track.variation) ? 1 : 0.3)
      : 0.65;
  const energy = closeness(intent.energy, targetEnergy);
  const motion = closeness(intent.motionIntensity, targetEnergy);
  const duration = track.durationSeconds >= intent.durationSeconds
    ? 1
    : -Math.min(3, (intent.durationSeconds - track.durationSeconds) / intent.durationSeconds * 4);
  // Quality is a bounded refinement signal; it cannot outweigh a meaningful family mismatch.
  const quality = Math.max(0, Math.min(5, track.rating)) * 0.12;
  const recentPenalty = applyRecentPenalty && recentIndex !== undefined
    ? 2.4 + (RECENT_AFM_REEL_LIMIT - recentIndex) * 0.16
    : 0;
  const totalUsePenalty = Math.min(2.5, totalUses * 0.28);
  return roundedRecord({
    semantic,
    family,
    subfamily,
    pacing,
    energy,
    motion,
    duration,
    quality,
    recentPenalty,
    totalUsePenalty,
    total: semantic + family + subfamily + pacing + energy + motion + duration + quality - recentPenalty - totalUsePenalty,
  });
};

const buildReason = (
  familyRanking: readonly MusicFamilyRanking[],
  selection: MusicSelection | undefined,
  catalog: readonly AfmTrack[],
  recentExclusionFallback: boolean,
  recentCatalogUseCount: number,
): string => {
  const preferred = familyRanking[0];
  if (!selection) return "No accepted production-ready AFM tracks are available; ideal intent ranking remains catalog-independent.";
  if (selection.forced) return `${selection.track.id} was explicitly forced after Reel completion; its score is diagnostic only.`;
  const availableFamilies = new Set(catalog.map((track) => track.familyCode));
  const constraint = preferred && !availableFamilies.has(preferred.code)
    ? `Ideal intent prefers ${preferred.code}, but that family is absent from the production catalog. `
    : "";
  const diversity = recentExclusionFallback
    ? "Every candidate was recently used, so the selector applied bounded recent-use penalties instead of failing. "
    : recentCatalogUseCount > 0
      ? "Recently used tracks were excluded while fresh candidates remained. "
      : "No catalog candidate occurs in the recent-use window. ";
  return `${constraint}${diversity}${selection.track.id} is the highest-scoring eligible production-ready track after family, semantic, pacing, energy, motion, duration, quality, and diversity scoring.`;
};

/** Full read-only selector trace used by production selection and diagnostics. */
export const analyzeMusicForCompletedReel = (
  reel: ReelData,
  catalog: readonly AfmTrack[],
  history: ReelProductionHistory,
  options: { forcedTrackId?: string; excludeCanonicalId?: string } = {},
): CompletedReelMusicAnalysis => {
  const intent = deriveMusicIntent(reel);
  const familyRanking = rankMusicFamilies(intent);
  const subfamilyRanking = rankMusicSubfamilies(intent, familyRanking);
  const familyScores = new Map(familyRanking.map((family) => [family.code, family.score]));
  const usage = historyUsage(history, options.excludeCanonicalId ?? reel.id);
  const recentExclusionFallback = catalog.length > 0 && catalog.every((track) => usage.recent.has(track.id));

  let forcedId: string | undefined;
  if (options.forcedTrackId) forcedId = parseAfmTrackId(options.forcedTrackId).id;
  const forcedTrack = forcedId ? catalog.find((candidate) => candidate.id === forcedId) : undefined;
  if (forcedId && !forcedTrack) throw new Error(`Forced AFM track is not an accepted production-ready catalog entry: ${forcedId}`);

  const trackRanking = catalog.map((track): RankedMusicTrack => {
    const recentIndex = usage.recent.get(track.id);
    const recentExcluded = forcedId === undefined && !recentExclusionFallback && recentIndex !== undefined;
    return {
      track,
      score: scoreTrack(
        track,
        intent,
        familyScores,
        forcedId ? undefined : recentIndex,
        forcedId ? 0 : usage.total.get(track.id) ?? 0,
        !forcedId && recentExclusionFallback,
      ),
      ...(recentIndex === undefined ? {} : { recentIndex }),
      recentExcluded,
      eligible: forcedId ? track.id === forcedId : !recentExcluded,
    };
  }).sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    return right.score.total - left.score.total || left.track.id.localeCompare(right.track.id);
  });

  const selectedRank = forcedTrack
    ? trackRanking.find((candidate) => candidate.track.id === forcedTrack.id)
    : trackRanking.find((candidate) => candidate.eligible);
  const selection = selectedRank ? {
    track: selectedRank.track,
    intent,
    score: selectedRank.score,
    recentExclusionFallback: forcedId ? false : recentExclusionFallback,
    forced: forcedId !== undefined,
  } : undefined;
  const recentExclusions = [...usage.recent.entries()]
    .filter(([trackId]) => catalog.some((track) => track.id === trackId))
    .map(([trackId, recentIndex]) => ({ trackId, recentIndex }))
    .sort((left, right) => left.recentIndex - right.recentIndex || left.trackId.localeCompare(right.trackId));

  return {
    intent,
    familyRanking,
    subfamilyRanking,
    trackRanking,
    recentExclusions,
    recentExclusionFallback: forcedId ? false : recentExclusionFallback,
    selection,
    reason: buildReason(familyRanking, selection, catalog, forcedId ? false : recentExclusionFallback, recentExclusions.length),
  };
};

export const selectMusicForCompletedReel = (
  reel: ReelData,
  catalog: readonly AfmTrack[],
  history: ReelProductionHistory,
  options: { forcedTrackId?: string; excludeCanonicalId?: string } = {},
): MusicSelection | undefined => analyzeMusicForCompletedReel(reel, catalog, history, options).selection;

export const catalogFamilyCodes = (catalog: readonly AfmTrack[]): AfmFamilyCode[] => [...new Set(
  catalog.map((track) => track.familyCode).filter(isAfmFamilyCode),
)].sort();
