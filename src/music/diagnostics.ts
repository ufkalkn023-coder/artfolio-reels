import { type ReelProductionHistory } from "../planner/production-history";
import { type ReelData } from "../v2/schema";
import { VIDEO } from "../v2/design";
import { createScenePlan, getDurationInFrames } from "../v2/timing";
import { type AfmCatalogScan } from "./afm";
import { analyzeMusicForCompletedReel, catalogFamilyCodes, type CompletedReelMusicAnalysis, type MusicScore } from "./selector";

export type MusicDiagnosticReport = {
  reel: {
    id: string;
    title: string;
    template: string;
    durationSeconds: number;
    scenes: number;
  };
  intent: CompletedReelMusicAnalysis["intent"];
  familyRanking: CompletedReelMusicAnalysis["familyRanking"];
  subfamilyRanking: CompletedReelMusicAnalysis["subfamilyRanking"];
  catalogAvailability: {
    root: string;
    available: boolean;
    productionTrackCount: number;
    availableFamilies: string[];
    missingPreferredFamilies: string[];
    warnings: string[];
  };
  recentExclusions: CompletedReelMusicAnalysis["recentExclusions"];
  recentExclusionFallback: boolean;
  trackRanking: Array<{
    id: string;
    familyCode: string;
    subfamilyCode: string;
    subfamilyName: string;
    variation: string;
    rating: number;
    score: CompletedReelMusicAnalysis["trackRanking"][number]["score"];
    recentIndex?: number;
    recentExcluded: boolean;
    eligible: boolean;
  }>;
  selection?: {
    trackId: string;
    familyCode: string;
    subfamilyCode: string;
    score: MusicScore;
    forced: boolean;
    reason: string;
  };
};

const fixed = (value: number): string => value.toFixed(3);
const heading = (title: string): string => `${title}\n${"-".repeat(title.length)}`;

export const createMusicDiagnosticReport = (
  reel: ReelData,
  catalog: AfmCatalogScan,
  history: ReelProductionHistory,
): MusicDiagnosticReport => {
  const analysis = analyzeMusicForCompletedReel(reel, catalog.tracks, history);
  const availableFamilies = catalogFamilyCodes(catalog.tracks);
  const availableSet = new Set(availableFamilies);
  const missingPreferredFamilies = analysis.familyRanking
    .slice(0, 3)
    .map((family) => family.code)
    .filter((family) => !availableSet.has(family));
  return {
    reel: {
      id: reel.id,
      title: reel.title,
      template: reel.template,
      durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
      scenes: createScenePlan(reel).length,
    },
    intent: analysis.intent,
    familyRanking: analysis.familyRanking,
    subfamilyRanking: analysis.subfamilyRanking,
    catalogAvailability: {
      root: catalog.root,
      available: catalog.available,
      productionTrackCount: catalog.tracks.length,
      availableFamilies,
      missingPreferredFamilies,
      warnings: catalog.warnings,
    },
    recentExclusions: analysis.recentExclusions,
    recentExclusionFallback: analysis.recentExclusionFallback,
    trackRanking: analysis.trackRanking.map(({ track, score, recentIndex, recentExcluded, eligible }) => ({
      id: track.id,
      familyCode: track.familyCode,
      subfamilyCode: track.subfamilyCode,
      subfamilyName: track.subfamilyName,
      variation: track.variation,
      rating: track.rating,
      score,
      ...(recentIndex === undefined ? {} : { recentIndex }),
      recentExcluded,
      eligible,
    })),
    ...(analysis.selection ? {
      selection: {
        trackId: analysis.selection.track.id,
        familyCode: analysis.selection.track.familyCode,
        subfamilyCode: analysis.selection.track.subfamilyCode,
        score: analysis.selection.score,
        forced: analysis.selection.forced,
        reason: analysis.reason,
      },
    } : {}),
  };
};

export const formatMusicDiagnosticReport = (report: MusicDiagnosticReport): string => {
  const intent = report.intent;
  const lines = [
    heading("Reel"),
    `ID: ${report.reel.id}`,
    `Title: ${report.reel.title}`,
    `Template: ${report.reel.template}`,
    `Duration: ${report.reel.durationSeconds.toFixed(1)}s`,
    `Scenes: ${report.reel.scenes}`,
    "",
    heading("Music Intent"),
    `Pacing: ${intent.pacing.toUpperCase()}`,
    `Energy: ${fixed(intent.energy)}`,
    `Motion: ${fixed(intent.motionIntensity)}`,
    `Darkness: ${fixed(intent.darkness)}`,
    `Grandeur: ${fixed(intent.grandeur)}`,
    `Intimacy: ${fixed(intent.intimacy)}`,
    `Playfulness: ${fixed(intent.playfulness)}`,
    `Abstraction: ${fixed(intent.abstraction)}`,
    `Acoustic preference: ${fixed(intent.acousticPreference)}`,
    `Electronic preference: ${fixed(intent.electronicPreference)}`,
    `Historical affinity: ${fixed(intent.historicalAffinity)}`,
    `Scene change rate: ${fixed(intent.sceneChangeRate)}/s`,
    `Detail density: ${fixed(intent.detailDensity)}`,
    "",
    `Semantic tokens: ${intent.semanticTokens.join(", ") || "none"}`,
    "",
    heading("Ideal Family Ranking"),
    ...report.familyRanking.map((family, index) => `${index + 1}. ${family.code.padEnd(4)} ${fixed(family.score)}  character=${fixed(family.characterScore)} semantic=${fixed(family.semanticScore)}${family.matchedTokens.length ? ` [${family.matchedTokens.join(", ")}]` : ""}`),
    "",
    heading("Ideal Subfamily Ranking"),
    ...report.subfamilyRanking.map((subfamily, index) => `${index + 1}. ${subfamily.code} ${subfamily.name}  ${fixed(subfamily.score)}${subfamily.matchedTokens.length ? ` [${subfamily.matchedTokens.join(", ")}]` : ""}`),
    "",
    heading("Catalog"),
    `Available: ${report.catalogAvailability.available ? "yes" : "no"}`,
    `Root: ${report.catalogAvailability.root}`,
    `Available production tracks: ${report.catalogAvailability.productionTrackCount}`,
    `Available families: ${report.catalogAvailability.availableFamilies.join(", ") || "none"}`,
    `Missing preferred families: ${report.catalogAvailability.missingPreferredFamilies.join(", ") || "none"}`,
    ...(report.catalogAvailability.warnings.map((warning) => `Warning: ${warning}`)),
    "",
    heading("Recent Use"),
    ...(report.recentExclusions.length > 0
      ? report.recentExclusions.map(({ trackId, recentIndex }) => `${trackId}  reel-index=${recentIndex + 1}`)
      : ["No catalog tracks occur in the latest 12 Reel history entries."]),
    `Fallback penalties active: ${report.recentExclusionFallback ? "yes" : "no"}`,
    "",
    heading("Available Track Ranking"),
    ...(report.trackRanking.length > 0
      ? report.trackRanking.map((track, index) => `${index + 1}. ${track.id}  total=${fixed(track.score.total)} family=${fixed(track.score.family)} semantic=${fixed(track.score.semantic)} subfamily=${fixed(track.score.subfamily)} pacing=${fixed(track.score.pacing)} energy=${fixed(track.score.energy)} motion=${fixed(track.score.motion)} duration=${fixed(track.score.duration)} quality=${fixed(track.score.quality)} recentPenalty=${fixed(track.score.recentPenalty)} totalUsePenalty=${fixed(track.score.totalUsePenalty)}${track.recentExcluded ? " EXCLUDED_RECENT" : ""}`)
      : ["No accepted production-ready track candidates."]),
    "",
    heading("Selected"),
    report.selection?.trackId ?? "none",
    "",
    heading("Why"),
    report.selection?.reason ?? "No production-ready track could be selected; ideal rankings are still shown above.",
  ];
  return `${lines.join("\n")}\n`;
};
