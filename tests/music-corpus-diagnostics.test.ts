import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyReelProductionHistory } from "../src/planner/production-history";
import { runMusicAnalyze, parseMusicAnalyzeArguments } from "../src/music/analyze-cli";
import { scanAfmCatalog, type AfmCatalogScan } from "../src/music/afm";
import { createCorpusMusicDiagnosticReport, discoverReelCorpus } from "../src/music/corpus-diagnostics";
import { analyzeMusicForCompletedReel } from "../src/music/selector";
import { MUSIC_ARCHETYPES, createArchetypeReel } from "./fixtures/music-archetypes";
import { createSyntheticAfmCatalog } from "./fixtures/music-catalog";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const throws = (operation: () => unknown, label: string): void => {
  try { operation(); } catch { return; }
  throw new Error(`${label}: expected an error`);
};

const writeReel = async (directory: string, name: string, reel: unknown): Promise<string> => {
  const path = join(directory, `${name}.json`);
  await writeFile(path, `${JSON.stringify(reel, null, 2)}\n`, "utf8");
  return path;
};

const directorySnapshot = async (directory: string): Promise<string> => {
  const visit = async (path: string): Promise<unknown> => {
    const entries = await readdir(path, { withFileTypes: true });
    return Promise.all(entries.sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory()
        ? { name: entry.name, children: await visit(child) }
        : { name: entry.name, content: (await readFile(child)).toString("base64") };
    }));
  };
  return JSON.stringify(await visit(directory));
};

const createFilesystemAfm = async (root: string): Promise<void> => {
  const trackId = "AFM-DE01-01";
  const trackDirectory = join(root, "01-Dreamy-Ethereal", "DE01-Impressionist-Mist", trackId);
  await mkdir(join(root, "00-admin"), { recursive: true });
  await mkdir(join(trackDirectory, "metadata"), { recursive: true });
  await mkdir(join(trackDirectory, "accepted"), { recursive: true });
  await writeFile(join(root, "00-admin", "catalog.json"), JSON.stringify({
    DE: { name: "Dreamy / Ethereal", folder: "01-Dreamy-Ethereal", subfamilies: { "01": "Impressionist Mist" } },
  }), "utf8");
  await writeFile(join(trackDirectory, "metadata", "track.json"), JSON.stringify({
    id: trackId,
    familyCode: "DE",
    subfamilyCode: "DE01",
    variation: "Ambient / Atmospheric Variation",
    variationSlot: 1,
    status: "ACCEPTED",
    tier: "PRODUCTION_READY",
    rating: 4,
    audio: { durationSeconds: 90 },
  }), "utf8");
  await writeFile(join(trackDirectory, "accepted", `${trackId}.wav`), "metadata-only test master", "utf8");
};

const EXPECTED_PILOT = [
  "NP01", "NP02", "PS01", "PS02", "DM01", "DM02", "BC01", "BC02", "RC01", "RC02", "MA01",
  "MA02", "AE01", "AE02", "SU01", "SU02", "MM01", "MM02", "ID01", "ID02", "CP01", "CP02",
].sort();

const run = async (): Promise<void> => {
  equal(parseMusicAnalyzeArguments(["--all", "--json"]).all, true, "CLI parses --all");
  throws(() => parseMusicAnalyzeArguments(["--all", "--reel", "one"]), "CLI modes are mutually exclusive");
  throws(() => parseMusicAnalyzeArguments(["--file"]), "CLI rejects a missing file value");

  const root = await mkdtemp(join(tmpdir(), "artfolio-corpus-diagnostics-"));
  const reelDirectory = join(root, "data", "reels");
  await mkdir(reelDirectory, { recursive: true });
  const reels = [
    createArchetypeReel({ id: "dark-one", words: "dark mysterious shadow chiaroscuro tension", pace: "slow", visualTone: "dark moody" }),
    createArchetypeReel({ id: "abstract-one", words: "abstract electronic geometric modular pulse repetition", pace: "fast" }),
    createArchetypeReel({ id: "intimate-one", words: "intimate delicate fragile tender quiet portrait", pace: "slow" }),
  ];
  const reelPaths = await Promise.all(reels.map((reel) => writeReel(reelDirectory, reel.id, reel)));
  const invalidPath = join(reelDirectory, "invalid-reel.json");
  await writeFile(invalidPath, "{not-json", "utf8");

  const discovery = await discoverReelCorpus(reelDirectory);
  equal(discovery.totalFiles, 4, "corpus discovery counts JSON files");
  equal(discovery.reels.length, 3, "corpus discovery validates ReelData");
  equal(discovery.skipped.length, 1, "invalid ReelData is skipped");
  equal(discovery.skipped[0].reelId, "invalid-reel", "invalid ReelData reports path-derived ID");
  equal(discovery.skipped[0].path, invalidPath, "invalid ReelData reports path");
  truthy(discovery.skipped[0].reason.length > 0, "invalid ReelData reports a reason");

  const history = emptyReelProductionHistory();
  const fullCatalog: AfmCatalogScan = { root: "/synthetic", available: true, tracks: createSyntheticAfmCatalog(), warnings: [] };
  const report = createCorpusMusicDiagnosticReport(discovery, fullCatalog, history);
  equal(report.corpus.analyzedReels, 3, "analysis includes valid ReelData only");
  equal(report.corpus.skippedReels, 1, "analysis preserves invalid ReelData report");
  equal(report.familyDemand.reduce((sum, row) => sum + row.top1Demand, 0), 3, "family Top-1 demand aggregates once per Reel");
  equal(report.familyDemand.reduce((sum, row) => sum + row.top3Demand, 0), 9, "family Top-3 demand aggregates three appearances per Reel");
  equal(report.subfamilyDemand.reduce((sum, row) => sum + row.top1Demand, 0), 3, "subfamily Top-1 demand aggregates once per Reel");
  equal(report.subfamilyDemand.reduce((sum, row) => sum + row.top3Demand, 0), 9, "subfamily Top-3 demand aggregates three appearances per Reel");
  const analyses = reels.map((reel) => analyzeMusicForCompletedReel(reel, fullCatalog.tracks, history));
  const expectedAverageMargin = analyses.reduce((sum, analysis) => sum + analysis.familyRanking[0].score - analysis.familyRanking[1].score, 0) / analyses.length;
  truthy(Math.abs(report.corpus.averageTop1Top2Margin - expectedAverageMargin) < 0.000001, "average margin uses selector score distribution");
  const expectedIdAverage = analyses.reduce((sum, analysis) => sum + (analysis.familyRanking.find(({ code }) => code === "ID")?.score ?? 0), 0) / analyses.length;
  truthy(Math.abs((report.familyDemand.find(({ code }) => code === "ID")?.averageScore ?? 0) - expectedIdAverage) < 0.000001, "average family score uses every analyzed Reel");
  truthy(report.familyDemand.every(({ averageScore }) => Number.isFinite(averageScore)), "family average scores are finite");
  truthy(report.subfamilyDemand.every(({ averageScore }) => Number.isFinite(averageScore)), "subfamily average scores are finite");

  const deOnlyCatalog: AfmCatalogScan = { ...fullCatalog, tracks: fullCatalog.tracks.filter(({ familyCode }) => familyCode === "DE") };
  const fallbackReport = createCorpusMusicDiagnosticReport(discovery, deOnlyCatalog, history);
  equal(fallbackReport.catalogCoverage.totalProductionReadyTracks, 4, "catalog coverage counts production-ready tracks");
  equal(fallbackReport.catalogCoverage.availableFamilyCount, 1, "catalog coverage counts available families");
  equal(fallbackReport.catalogCoverage.missingFamilies.length, 11, "catalog coverage reports missing families");
  equal(fallbackReport.catalogCoverage.idealTopFamilyUnavailableReelCount, 3, "preferred-family unavailable count");
  equal(fallbackReport.catalogCoverage.fallbackSelectionCount, 3, "fallback count");
  equal(fallbackReport.catalogCoverage.exactIdealFamilySelectedCount, 0, "exact ideal-family selection count");
  truthy(fallbackReport.catalogCoverage.top3IdealFamilySelectedCount >= 0, "Top-3 ideal-family selection count is present");
  truthy(fallbackReport.fallbackAnalysis.cases.every(({ reason }) => reason.includes("catalog-constrained fallback")), "fallback reason distinguishes intent from catalog selection");
  const concentratedReport = createCorpusMusicDiagnosticReport(discovery, { ...deOnlyCatalog, tracks: deOnlyCatalog.tracks.slice(0, 1) }, history);
  equal(concentratedReport.concentration.uniqueSelectedTracks, 1, "concentration counts unique selected tracks");
  equal(concentratedReport.concentration.top5TracksShare, 1, "top-five share uses all hypothetical selections");
  equal(concentratedReport.concentration.topSubfamilyShare, 1, "top subfamily share");

  const exactCatalog: AfmCatalogScan = {
    ...fullCatalog,
    tracks: fullCatalog.tracks.filter(({ familyCode }) => analyses.some(({ familyRanking }) => familyRanking[0].code === familyCode)),
  };
  const exactReport = createCorpusMusicDiagnosticReport(discovery, exactCatalog, history);
  equal(exactReport.catalogCoverage.exactIdealFamilySelectedCount, 3, "matching catalog selects exact ideal family");
  equal(exactReport.catalogCoverage.top3IdealFamilySelectedCount, 3, "exact ideal selections are also Top-3 selections");

  equal(report.pilotPriority.length, 22, "pilot priority always contains 22 subfamilies");
  equal(JSON.stringify(report.pilotPriority.map(({ subfamilyCode }) => subfamilyCode).sort()), JSON.stringify(EXPECTED_PILOT), "pilot priority contains the fixed 22-subfamily set");
  for (let index = 1; index < report.pilotPriority.length; index += 1) {
    truthy(report.pilotPriority[index - 1].top1Demand >= report.pilotPriority[index].top1Demand, "Top-1 demand affects pilot priority");
  }
  equal(JSON.stringify(createCorpusMusicDiagnosticReport(discovery, fullCatalog, history).pilotPriority), JSON.stringify(report.pilotPriority), "pilot priority is deterministic");

  const archetypeDiscovery = {
    directory: "/synthetic-reels",
    totalFiles: MUSIC_ARCHETYPES.length,
    reels: MUSIC_ARCHETYPES.map(({ reel }) => ({ path: `/synthetic-reels/${reel.id}.json`, reel })),
    skipped: [],
    warnings: [],
  };
  const archetypeReport = createCorpusMusicDiagnosticReport(archetypeDiscovery, fullCatalog, history);
  equal(archetypeReport.pilotListeningSet.length, 12, "listening set selects the deterministic target size");
  equal(JSON.stringify(createCorpusMusicDiagnosticReport(archetypeDiscovery, fullCatalog, history).pilotListeningSet), JSON.stringify(archetypeReport.pilotListeningSet), "listening set is deterministic");
  for (let index = 1; index < archetypeReport.ambiguousReels.length; index += 1) {
    truthy(archetypeReport.ambiguousReels[index - 1].margin <= archetypeReport.ambiguousReels[index].margin, "ambiguous set is sorted by ascending margin");
  }
  equal(JSON.stringify(createCorpusMusicDiagnosticReport(archetypeDiscovery, fullCatalog, history).outliers), JSON.stringify(archetypeReport.outliers), "outlier selection is deterministic");
  truthy(archetypeReport.outliers.highestEnergy[0].value >= archetypeReport.outliers.highestEnergy[1].value, "highest outliers are sorted descending");
  truthy(archetypeReport.outliers.lowestMotion[0].value <= archetypeReport.outliers.lowestMotion[1].value, "lowest outliers are sorted ascending");

  const afmRoot = join(root, "afm");
  await createFilesystemAfm(afmRoot);
  const scanned = await scanAfmCatalog(afmRoot);
  equal(scanned.tracks.length, 1, "filesystem AFM fixture is production-ready");
  const historyPath = join(root, "data", "reel-production-history.json");
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  const reelBefore = await Promise.all(reelPaths.map((path) => readFile(path, "utf8")));
  const historyBefore = await readFile(historyPath, "utf8");
  const afmBefore = await directorySnapshot(afmRoot);
  const originalCwd = process.cwd();
  const originalAfmRoot = process.env.ARTFOLIO_AFM_ROOT;
  process.chdir(root);
  process.env.ARTFOLIO_AFM_ROOT = afmRoot;
  try {
    const firstJson = await runMusicAnalyze(["--all", "--json"]);
    truthy(firstJson.startsWith("{"), "JSON output starts with JSON and has no stdout preamble");
    const parsed = JSON.parse(firstJson) as typeof report;
    equal(parsed.corpus.analyzedReels, 3, "CLI JSON output is parseable");
    equal(await runMusicAnalyze(["--all", "--json"]), firstJson, "repeated --all analysis is deterministic");

    const tsxCli = require.resolve("tsx/cli");
    const script = resolve(originalCwd, "scripts/music-analyze.ts");
    const child = spawnSync(process.execPath, [tsxCli, script, "--all", "--json"], {
      cwd: root,
      env: { ...process.env, ARTFOLIO_AFM_ROOT: afmRoot },
      encoding: "utf8",
    });
    equal(child.status, 0, "music:analyze subprocess exits successfully");
    truthy(child.stdout.startsWith("{"), "subprocess JSON stdout is not polluted");
    JSON.parse(child.stdout);
  } finally {
    process.chdir(originalCwd);
    if (originalAfmRoot === undefined) delete process.env.ARTFOLIO_AFM_ROOT;
    else process.env.ARTFOLIO_AFM_ROOT = originalAfmRoot;
  }
  equal(JSON.stringify(await Promise.all(reelPaths.map((path) => readFile(path, "utf8")))), JSON.stringify(reelBefore), "ReelData files remain unchanged");
  equal(await readFile(historyPath, "utf8"), historyBefore, "production history remains unchanged");
  equal(await directorySnapshot(afmRoot), afmBefore, "AFM filesystem remains unchanged");

  console.log("Corpus soundtrack diagnostics, determinism, CLI JSON, and mutation-safety tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
