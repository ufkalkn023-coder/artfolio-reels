import { readFile, readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { type ReelProductionHistory } from "../planner/production-history";
import { ReelDataSchema, type ReelData } from "../v2/schema";
import { type AfmCatalogScan } from "./afm";
import { analyzeMusicForCompletedReel, type CompletedReelMusicAnalysis } from "./selector";
import {
  AFM_FAMILY_CODES,
  AFM_FAMILY_PROFILES,
  AFM_FIRST_PASS_SUBFAMILIES,
  type AfmFamilyCode,
} from "./taxonomy";

type CorpusReelSource = { path: string; reel: ReelData };

export type CorpusReelIssue = {
  reelId: string;
  path: string;
  reason: string;
};

export type ReelCorpusDiscovery = {
  directory: string;
  totalFiles: number;
  reels: CorpusReelSource[];
  skipped: CorpusReelIssue[];
  warnings: string[];
};

export type DemandRow = {
  code: string;
  familyCode: AfmFamilyCode;
  name: string;
  top1Demand: number;
  top3Demand: number;
  averageScore: number;
  averageTop1Top2Margin: number | null;
};

export type CorpusMusicDiagnosticReport = {
  corpus: {
    directory: string;
    totalFiles: number;
    analyzedReels: number;
    skippedReels: number;
    skipped: CorpusReelIssue[];
    averageTop1Top2Margin: number;
    medianTop1Top2Margin: number;
  };
  familyDemand: DemandRow[];
  subfamilyDemand: Array<Omit<DemandRow, "averageTop1Top2Margin">>;
  catalogCoverage: {
    root: string;
    available: boolean;
    totalProductionReadyTracks: number;
    trackCountsByFamily: Record<string, number>;
    trackCountsBySubfamily: Record<string, number>;
    availableFamilyCount: number;
    missingFamilies: AfmFamilyCode[];
    idealTopFamilyAvailableReelCount: number;
    idealTopFamilyUnavailableReelCount: number;
    fallbackSelectionCount: number;
    exactIdealFamilySelectedCount: number;
    top3IdealFamilySelectedCount: number;
  };
  baselineMetrics: {
    denominatorReels: number;
    idealFamilyAvailableRate: number;
    exactIdealFamilySelectedRate: number;
    top3IdealFamilySelectedRate: number;
    fallbackRate: number;
    familyCoverageRate: number;
  };
  fallbackAnalysis: {
    count: number;
    cases: Array<{
      reelId: string;
      title: string;
      preferredFamily: AfmFamilyCode;
      selectedTrackId: string;
      selectedFamily: string;
      reason: string;
    }>;
  };
  hypotheticalSelection: {
    selectedTrackCount: number;
    selectedSubfamilyCount: number;
    selectedFamilyCount: number;
    uniqueSelectedTracks: number;
    trackCounts: Record<string, number>;
    subfamilyCounts: Record<string, number>;
    familyCounts: Record<string, number>;
    mostSelectedTrack: CountedValue | null;
    mostSelectedSubfamily: CountedValue | null;
    mostSelectedFamily: CountedValue | null;
    top5TracksShare: number;
  };
  concentration: {
    uniqueSelectedTracks: number;
    mostSelectedTrack: CountedValue | null;
    top5TracksShare: number;
    topSubfamilyShare: number;
    topFamilyShare: number;
  };
  pilotPriority: Array<{
    rank: number;
    subfamilyCode: string;
    familyCode: AfmFamilyCode;
    name: string;
    top1Demand: number;
    top3Demand: number;
    averageScore: number;
    rationale: string;
  }>;
  pilotListeningSet: ListeningReel[];
  ambiguousReels: Array<{
    reelId: string;
    title: string;
    top1Family: AfmFamilyCode;
    top1Score: number;
    top2Family: AfmFamilyCode;
    top2Score: number;
    margin: number;
  }>;
  outliers: Record<IntentOutlierMetric, IntentOutlier[]>;
  familyRepresentation: Array<{
    familyCode: AfmFamilyCode;
    familyName: string;
    strongRepresentativeCount: number;
    gap: boolean;
    note: string;
  }>;
  warnings: string[];
};

type CountedValue = { value: string; selections: number };
type IntentOutlierMetric = "highestEnergy" | "lowestEnergy" | "highestMotion" | "lowestMotion" | "highestDarkness" | "highestGrandeur" | "highestIntimacy" | "highestPlayfulness" | "highestAbstraction";
type IntentOutlier = { reelId: string; title: string; value: number };
type ListeningReel = {
  reelId: string;
  title: string;
  idealFamily: AfmFamilyCode;
  idealSubfamily: string;
  top1Score: number;
  margin: number;
  pacing: string;
  motionIntensity: number;
  reason: string;
};

type AnalyzedReel = CorpusReelSource & {
  analysis: CompletedReelMusicAnalysis;
  margin: number;
};

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const average = (values: readonly number[]): number => values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]);
};
const rate = (numerator: number, denominator: number): number => denominator === 0 ? 0 : round(numerator / denominator);
const countBy = (values: readonly string[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
};
const topCount = (counts: Readonly<Record<string, number>>): CountedValue | null => {
  const first = Object.entries(counts).sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || leftValue.localeCompare(rightValue))[0];
  return first ? { value: first[0], selections: first[1] } : null;
};
const issueReason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const displayTitle = (reel: ReelData): string => reel.artworks[0]?.title ?? reel.title;

export const discoverReelCorpus = async (directory = resolve("data/reels")): Promise<ReelCorpusDiscovery> => {
  const resolvedDirectory = resolve(directory);
  let entries;
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        directory: resolvedDirectory,
        totalFiles: 0,
        reels: [],
        skipped: [],
        warnings: [`ReelData corpus directory not found: ${resolvedDirectory}`],
      };
    }
    throw error;
  }

  const paths = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".json")
    .map((entry) => resolve(resolvedDirectory, entry.name))
    .sort();
  const reels: CorpusReelSource[] = [];
  const skipped: CorpusReelIssue[] = [];
  for (const path of paths) {
    const fallbackId = basename(path, extname(path));
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      const reel = ReelDataSchema.parse(raw);
      reels.push({ path, reel });
    } catch (error) {
      skipped.push({ reelId: fallbackId, path, reason: issueReason(error) });
    }
  }
  return { directory: resolvedDirectory, totalFiles: paths.length, reels, skipped, warnings: [] };
};

const aggregateDemand = (
  analyzed: readonly AnalyzedReel[],
  kind: "family" | "subfamily",
): DemandRow[] => {
  const profiles = kind === "family" ? AFM_FAMILY_PROFILES : AFM_FIRST_PASS_SUBFAMILIES;
  return profiles.map((profile) => {
    const rankings = analyzed.map(({ analysis }) => kind === "family" ? analysis.familyRanking : analysis.subfamilyRanking);
    const scores = rankings.map((ranking) => ranking.find(({ code }) => code === profile.code)?.score ?? 0);
    const wins = analyzed.filter(({ analysis }) => (kind === "family" ? analysis.familyRanking : analysis.subfamilyRanking)[0]?.code === profile.code);
    return {
      code: profile.code,
      familyCode: kind === "family" ? profile.code as AfmFamilyCode : (profile as (typeof AFM_FIRST_PASS_SUBFAMILIES)[number]).familyCode,
      name: profile.name,
      top1Demand: wins.length,
      top3Demand: rankings.filter((ranking) => ranking.slice(0, 3).some(({ code }) => code === profile.code)).length,
      averageScore: average(scores),
      averageTop1Top2Margin: kind === "family" && wins.length > 0 ? average(wins.map(({ margin }) => margin)) : null,
    };
  }).sort((left, right) => right.top1Demand - left.top1Demand || right.top3Demand - left.top3Demand || right.averageScore - left.averageScore || left.code.localeCompare(right.code));
};

const motionBucket = (motion: number): string => motion < 0.3 ? "low" : motion < 0.6 ? "medium" : "high";

const listeningSet = (analyzed: readonly AnalyzedReel[]): ListeningReel[] => {
  const candidates = analyzed.map((item) => {
    const idealFamily = item.analysis.familyRanking[0];
    const idealSubfamily = item.analysis.subfamilyRanking.find(({ familyCode }) => familyCode === idealFamily.code);
    return { item, idealFamily, idealSubfamily };
  });
  const selected: typeof candidates = [];
  for (const familyCode of AFM_FAMILY_CODES) {
    const candidate = candidates
      .filter(({ idealFamily }) => idealFamily.code === familyCode)
      .sort((left, right) => right.idealFamily.score - left.idealFamily.score || right.item.margin - left.item.margin || left.item.reel.id.localeCompare(right.item.reel.id))[0];
    if (candidate) selected.push(candidate);
  }

  const target = Math.min(12, candidates.length);
  const selectedIds = new Set(selected.map(({ item }) => item.path));
  while (selected.length < target) {
    const pacing = new Set(selected.map(({ item }) => item.analysis.intent.pacing));
    const motion = new Set(selected.map(({ item }) => motionBucket(item.analysis.intent.motionIntensity)));
    const familyCounts = countBy(selected.map(({ idealFamily }) => idealFamily.code));
    const next = candidates
      .filter(({ item }) => !selectedIds.has(item.path))
      .sort((left, right) => {
        const leftPacingNovel = pacing.has(left.item.analysis.intent.pacing) ? 0 : 1;
        const rightPacingNovel = pacing.has(right.item.analysis.intent.pacing) ? 0 : 1;
        if (leftPacingNovel !== rightPacingNovel) return rightPacingNovel - leftPacingNovel;
        const leftMotionNovel = motion.has(motionBucket(left.item.analysis.intent.motionIntensity)) ? 0 : 1;
        const rightMotionNovel = motion.has(motionBucket(right.item.analysis.intent.motionIntensity)) ? 0 : 1;
        if (leftMotionNovel !== rightMotionNovel) return rightMotionNovel - leftMotionNovel;
        const familyBalance = (familyCounts[left.idealFamily.code] ?? 0) - (familyCounts[right.idealFamily.code] ?? 0);
        return familyBalance || right.idealFamily.score - left.idealFamily.score || right.item.margin - left.item.margin || left.item.reel.id.localeCompare(right.item.reel.id);
      })[0];
    if (!next) break;
    selected.push(next);
    selectedIds.add(next.item.path);
  }

  return selected.slice(0, 18).map(({ item, idealFamily, idealSubfamily }) => ({
    reelId: item.reel.id,
    title: displayTitle(item.reel),
    idealFamily: idealFamily.code,
    idealSubfamily: idealSubfamily?.code ?? "none",
    top1Score: idealFamily.score,
    margin: item.margin,
    pacing: item.analysis.intent.pacing,
    motionIntensity: round(item.analysis.intent.motionIntensity),
    reason: `High ${idealFamily.code} fit (${idealFamily.score.toFixed(3)}), margin ${item.margin.toFixed(3)}, ${item.analysis.intent.pacing} pacing, ${motionBucket(item.analysis.intent.motionIntensity)} motion.`,
  }));
};

const selectOutliers = (analyzed: readonly AnalyzedReel[]): CorpusMusicDiagnosticReport["outliers"] => {
  const ranked = (value: (item: AnalyzedReel) => number, ascending = false): IntentOutlier[] => analyzed
    .map((item) => ({ reelId: item.reel.id, title: displayTitle(item.reel), value: round(value(item)) }))
    .sort((left, right) => (ascending ? left.value - right.value : right.value - left.value) || left.reelId.localeCompare(right.reelId))
    .slice(0, 3);
  return {
    highestEnergy: ranked(({ analysis }) => analysis.intent.energy),
    lowestEnergy: ranked(({ analysis }) => analysis.intent.energy, true),
    highestMotion: ranked(({ analysis }) => analysis.intent.motionIntensity),
    lowestMotion: ranked(({ analysis }) => analysis.intent.motionIntensity, true),
    highestDarkness: ranked(({ analysis }) => analysis.intent.darkness),
    highestGrandeur: ranked(({ analysis }) => analysis.intent.grandeur),
    highestIntimacy: ranked(({ analysis }) => analysis.intent.intimacy),
    highestPlayfulness: ranked(({ analysis }) => analysis.intent.playfulness),
    highestAbstraction: ranked(({ analysis }) => analysis.intent.abstraction),
  };
};

export const createCorpusMusicDiagnosticReport = (
  discovery: ReelCorpusDiscovery,
  catalog: AfmCatalogScan,
  history: ReelProductionHistory,
): CorpusMusicDiagnosticReport => {
  const analyzed: AnalyzedReel[] = [];
  const skipped = [...discovery.skipped];
  for (const source of discovery.reels) {
    try {
      const analysis = analyzeMusicForCompletedReel(source.reel, catalog.tracks, history);
      const margin = round((analysis.familyRanking[0]?.score ?? 0) - (analysis.familyRanking[1]?.score ?? 0));
      analyzed.push({ ...source, analysis, margin });
    } catch (error) {
      skipped.push({ reelId: source.reel.id, path: source.path, reason: issueReason(error) });
    }
  }
  analyzed.sort((left, right) => left.reel.id.localeCompare(right.reel.id) || left.path.localeCompare(right.path));
  skipped.sort((left, right) => left.reelId.localeCompare(right.reelId) || left.path.localeCompare(right.path));

  const familyDemand = aggregateDemand(analyzed, "family");
  const subfamilyDemandWithMargin = aggregateDemand(analyzed, "subfamily");
  const subfamilyDemand = subfamilyDemandWithMargin.map((row) => ({
    code: row.code,
    familyCode: row.familyCode,
    name: row.name,
    top1Demand: row.top1Demand,
    top3Demand: row.top3Demand,
    averageScore: row.averageScore,
  }));
  const availableFamilies = new Set(catalog.tracks.map(({ familyCode }) => familyCode));
  const trackCountsByFamily = Object.fromEntries(AFM_FAMILY_CODES.map((code) => [code, catalog.tracks.filter((track) => track.familyCode === code).length]));
  const catalogSubfamilies = new Set([...AFM_FIRST_PASS_SUBFAMILIES.map(({ code }) => code), ...catalog.tracks.map(({ subfamilyCode }) => subfamilyCode)]);
  const trackCountsBySubfamily = Object.fromEntries([...catalogSubfamilies].sort().map((code) => [code, catalog.tracks.filter((track) => track.subfamilyCode === code).length]));
  const selections = analyzed.flatMap((item) => item.analysis.selection ? [{ item, selection: item.analysis.selection }] : []);
  const exactSelections = selections.filter(({ item, selection }) => selection.track.familyCode === item.analysis.familyRanking[0].code);
  const top3Selections = selections.filter(({ item, selection }) => item.analysis.familyRanking.slice(0, 3).some(({ code }) => code === selection.track.familyCode));
  const fallbackSelections = selections.filter(({ item, selection }) => selection.track.familyCode !== item.analysis.familyRanking[0].code);
  const idealAvailable = analyzed.filter(({ analysis }) => availableFamilies.has(analysis.familyRanking[0].code)).length;
  const trackCounts = countBy(selections.map(({ selection }) => selection.track.id));
  const subfamilyCounts = countBy(selections.map(({ selection }) => selection.track.subfamilyCode));
  const familyCounts = countBy(selections.map(({ selection }) => selection.track.familyCode));
  const topFiveCount = Object.values(trackCounts).sort((left, right) => right - left).slice(0, 5).reduce((sum, count) => sum + count, 0);
  const mostSelectedTrack = topCount(trackCounts);
  const mostSelectedSubfamily = topCount(subfamilyCounts);
  const mostSelectedFamily = topCount(familyCounts);
  const denominator = analyzed.length;
  const availableFamilyCount = AFM_FAMILY_CODES.filter((code) => availableFamilies.has(code)).length;
  const demandBySubfamily = new Map(subfamilyDemand.map((row) => [row.code, row]));
  const pilotPriority = AFM_FIRST_PASS_SUBFAMILIES
    .filter(({ familyCode }) => familyCode !== "DE")
    .map((profile) => ({ profile, demand: demandBySubfamily.get(profile.code)! }))
    .sort((left, right) => right.demand.top1Demand - left.demand.top1Demand || right.demand.top3Demand - left.demand.top3Demand || right.demand.averageScore - left.demand.averageScore || left.profile.code.localeCompare(right.profile.code))
    .map(({ profile, demand }, index) => ({
      rank: index + 1,
      subfamilyCode: profile.code,
      familyCode: profile.familyCode,
      name: profile.name,
      top1Demand: demand.top1Demand,
      top3Demand: demand.top3Demand,
      averageScore: demand.averageScore,
      rationale: `Top1 demand: ${demand.top1Demand}; Top3 demand: ${demand.top3Demand}; Average score: ${demand.averageScore.toFixed(3)}.`,
    }));
  const ambiguousReels = analyzed
    .map(({ reel, analysis, margin }) => ({
      reelId: reel.id,
      title: displayTitle(reel),
      top1Family: analysis.familyRanking[0].code,
      top1Score: analysis.familyRanking[0].score,
      top2Family: analysis.familyRanking[1].code,
      top2Score: analysis.familyRanking[1].score,
      margin,
    }))
    .sort((left, right) => left.margin - right.margin || left.reelId.localeCompare(right.reelId))
    .slice(0, Math.min(10, analyzed.length));
  const familyRepresentation = AFM_FAMILY_PROFILES.map((family) => {
    const count = analyzed.filter(({ analysis }) => analysis.familyRanking[0].code === family.code).length;
    return {
      familyCode: family.code,
      familyName: family.name,
      strongRepresentativeCount: count,
      gap: count === 0,
      note: count === 0 ? "No strong representative found; no Reel has this family as ideal Top-1." : `${count} Reel(s) rank this family ideal Top-1.`,
    };
  });
  const warnings = [
    ...discovery.warnings,
    ...catalog.warnings,
    ...skipped.map((issue) => `Skipped ${issue.reelId} (${issue.path}): ${issue.reason}`),
    ...familyRepresentation.filter(({ gap }) => gap).map(({ familyCode }) => `No strong representative found for ${familyCode}; this is a Reel corpus gap, not a catalog gap.`),
  ];

  return {
    corpus: {
      directory: discovery.directory,
      totalFiles: discovery.totalFiles,
      analyzedReels: analyzed.length,
      skippedReels: skipped.length,
      skipped,
      averageTop1Top2Margin: average(analyzed.map(({ margin }) => margin)),
      medianTop1Top2Margin: median(analyzed.map(({ margin }) => margin)),
    },
    familyDemand,
    subfamilyDemand,
    catalogCoverage: {
      root: catalog.root,
      available: catalog.available,
      totalProductionReadyTracks: catalog.tracks.length,
      trackCountsByFamily,
      trackCountsBySubfamily,
      availableFamilyCount,
      missingFamilies: AFM_FAMILY_CODES.filter((code) => !availableFamilies.has(code)),
      idealTopFamilyAvailableReelCount: idealAvailable,
      idealTopFamilyUnavailableReelCount: denominator - idealAvailable,
      fallbackSelectionCount: fallbackSelections.length,
      exactIdealFamilySelectedCount: exactSelections.length,
      top3IdealFamilySelectedCount: top3Selections.length,
    },
    baselineMetrics: {
      denominatorReels: denominator,
      idealFamilyAvailableRate: rate(idealAvailable, denominator),
      exactIdealFamilySelectedRate: rate(exactSelections.length, denominator),
      top3IdealFamilySelectedRate: rate(top3Selections.length, denominator),
      fallbackRate: rate(fallbackSelections.length, denominator),
      familyCoverageRate: rate(availableFamilyCount, AFM_FAMILY_CODES.length),
    },
    fallbackAnalysis: {
      count: fallbackSelections.length,
      cases: fallbackSelections.map(({ item, selection }) => ({
        reelId: item.reel.id,
        title: displayTitle(item.reel),
        preferredFamily: item.analysis.familyRanking[0].code,
        selectedTrackId: selection.track.id,
        selectedFamily: selection.track.familyCode,
        reason: `Preferred family ${item.analysis.familyRanking[0].code} is ${availableFamilies.has(item.analysis.familyRanking[0].code) ? "available but was not selected" : "unavailable"}; ${selection.track.id} (${selection.track.familyCode}) is a catalog-constrained fallback.`,
      })),
    },
    hypotheticalSelection: {
      selectedTrackCount: selections.length,
      selectedSubfamilyCount: Object.keys(subfamilyCounts).length,
      selectedFamilyCount: Object.keys(familyCounts).length,
      uniqueSelectedTracks: Object.keys(trackCounts).length,
      trackCounts,
      subfamilyCounts,
      familyCounts,
      mostSelectedTrack,
      mostSelectedSubfamily,
      mostSelectedFamily,
      top5TracksShare: rate(topFiveCount, selections.length),
    },
    concentration: {
      uniqueSelectedTracks: Object.keys(trackCounts).length,
      mostSelectedTrack,
      top5TracksShare: rate(topFiveCount, selections.length),
      topSubfamilyShare: rate(mostSelectedSubfamily?.selections ?? 0, selections.length),
      topFamilyShare: rate(mostSelectedFamily?.selections ?? 0, selections.length),
    },
    pilotPriority,
    pilotListeningSet: listeningSet(analyzed),
    ambiguousReels,
    outliers: selectOutliers(analyzed),
    familyRepresentation,
    warnings,
  };
};

const heading = (title: string): string => `${title}\n${"-".repeat(title.length)}`;
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const counted = (value: CountedValue | null): string => value ? `${value.value} (${value.selections})` : "none";

export const formatCorpusMusicDiagnosticReport = (report: CorpusMusicDiagnosticReport): string => {
  const fallbackPreview = report.fallbackAnalysis.cases.slice(0, 10);
  const lines = [
    heading("Corpus Summary"),
    `Directory: ${report.corpus.directory}`,
    `Files: ${report.corpus.totalFiles}`,
    `Analyzed: ${report.corpus.analyzedReels}`,
    `Skipped/invalid: ${report.corpus.skippedReels}`,
    `Average top1-top2 margin: ${report.corpus.averageTop1Top2Margin.toFixed(3)}`,
    `Median top1-top2 margin: ${report.corpus.medianTop1Top2Margin.toFixed(3)}`,
    "",
    heading("Ideal Family Demand"),
    "Family  Top1  Top3  AvgScore  AvgWinMargin",
    ...report.familyDemand.map((row) => `${row.code.padEnd(7)} ${String(row.top1Demand).padStart(4)}  ${String(row.top3Demand).padStart(4)}  ${row.averageScore.toFixed(3).padStart(8)}  ${(row.averageTop1Top2Margin === null ? "n/a" : row.averageTop1Top2Margin.toFixed(3)).padStart(12)}`),
    "",
    heading("Ideal Subfamily Demand"),
    "Subfamily  Top1  Top3  AvgScore",
    ...report.subfamilyDemand.map((row) => `${row.code.padEnd(11)} ${String(row.top1Demand).padStart(4)}  ${String(row.top3Demand).padStart(4)}  ${row.averageScore.toFixed(3).padStart(8)}  ${row.name}`),
    "",
    heading("Catalog Coverage"),
    `Root: ${report.catalogCoverage.root}`,
    `Available: ${report.catalogCoverage.available ? "yes" : "no"}`,
    `Production-ready tracks: ${report.catalogCoverage.totalProductionReadyTracks}`,
    `Available families: ${report.catalogCoverage.availableFamilyCount}/${AFM_FAMILY_CODES.length}`,
    `Missing families: ${report.catalogCoverage.missingFamilies.join(", ") || "none"}`,
    `Family track counts: ${Object.entries(report.catalogCoverage.trackCountsByFamily).map(([code, count]) => `${code}=${count}`).join(" ")}`,
    `Subfamily track counts: ${Object.entries(report.catalogCoverage.trackCountsBySubfamily).map(([code, count]) => `${code}=${count}`).join(" ")}`,
    "",
    heading("Baseline Coverage Metrics"),
    `Ideal family available: ${report.catalogCoverage.idealTopFamilyAvailableReelCount}/${report.baselineMetrics.denominatorReels} (${percent(report.baselineMetrics.idealFamilyAvailableRate)})`,
    `Exact ideal family selected: ${report.catalogCoverage.exactIdealFamilySelectedCount}/${report.baselineMetrics.denominatorReels} (${percent(report.baselineMetrics.exactIdealFamilySelectedRate)})`,
    `Selected family in ideal Top-3: ${report.catalogCoverage.top3IdealFamilySelectedCount}/${report.baselineMetrics.denominatorReels} (${percent(report.baselineMetrics.top3IdealFamilySelectedRate)})`,
    `Fallback rate: ${report.catalogCoverage.fallbackSelectionCount}/${report.baselineMetrics.denominatorReels} (${percent(report.baselineMetrics.fallbackRate)})`,
    `Family coverage: ${report.catalogCoverage.availableFamilyCount}/${AFM_FAMILY_CODES.length} (${percent(report.baselineMetrics.familyCoverageRate)})`,
    "",
    heading("Fallback Analysis"),
    `Fallback selections: ${report.fallbackAnalysis.count}`,
    ...fallbackPreview.map(({ reelId, reason }) => `${reelId}: ${reason}`),
    ...(report.fallbackAnalysis.count > fallbackPreview.length ? [`... ${report.fallbackAnalysis.count - fallbackPreview.length} more fallback cases in JSON output.`] : []),
    "",
    heading("Hypothetical Selection"),
    "Read-only hypothetical corpus selection; this is not production usage history.",
    `Selected tracks: ${report.hypotheticalSelection.selectedTrackCount}`,
    `Unique selected tracks: ${report.hypotheticalSelection.uniqueSelectedTracks}`,
    `Most-selected track: ${counted(report.hypotheticalSelection.mostSelectedTrack)}`,
    `Most-selected subfamily: ${counted(report.hypotheticalSelection.mostSelectedSubfamily)}`,
    `Most-selected family: ${counted(report.hypotheticalSelection.mostSelectedFamily)}`,
    "",
    heading("Concentration"),
    `Unique selected tracks: ${report.concentration.uniqueSelectedTracks}`,
    `Most-selected track: ${counted(report.concentration.mostSelectedTrack)}`,
    `Top 5 tracks share: ${percent(report.concentration.top5TracksShare)}`,
    `Top subfamily share: ${percent(report.concentration.topSubfamilyShare)}`,
    `Top family share: ${percent(report.concentration.topFamilyShare)}`,
    "",
    heading("22-Track Pilot Priority"),
    ...report.pilotPriority.map((item) => `${item.rank}. ${item.subfamilyCode} ${item.name} — ${item.rationale}`),
    "",
    heading("Pilot Listening Set"),
    ...report.pilotListeningSet.map((item) => `${item.reelId} | ${item.title} | ${item.idealFamily}/${item.idealSubfamily} | score=${item.top1Score.toFixed(3)} margin=${item.margin.toFixed(3)} | ${item.reason}`),
    "",
    heading("Ambiguous Reels"),
    ...report.ambiguousReels.map((item) => `${item.reelId} | ${item.title} | ${item.top1Family} ${item.top1Score.toFixed(3)} vs ${item.top2Family} ${item.top2Score.toFixed(3)} | margin=${item.margin.toFixed(3)}`),
    "",
    heading("Intent Outliers"),
    ...Object.entries(report.outliers).map(([metric, values]) => `${metric}: ${values.map(({ reelId, value }) => `${reelId}=${value.toFixed(3)}`).join(", ") || "none"}`),
    "",
    heading("Family Representation Gaps"),
    `Strong representatives: ${report.familyRepresentation.filter(({ gap }) => !gap).map(({ familyCode, strongRepresentativeCount }) => `${familyCode}=${strongRepresentativeCount}`).join(" ") || "none"}`,
    `Corpus gaps: ${report.familyRepresentation.filter(({ gap }) => gap).map(({ familyCode }) => familyCode).join(", ") || "none"}`,
    "",
    heading("Warnings"),
    ...(report.warnings.length > 0 ? report.warnings : ["none"]),
  ];
  return `${lines.join("\n")}\n`;
};
