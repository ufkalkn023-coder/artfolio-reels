import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyReelProductionHistory } from "../src/planner/production-history";
import { runMusicAnalyze, parseMusicAnalyzeArguments } from "../src/music/analyze-cli";
import { createMusicDiagnosticReport, formatMusicDiagnosticReport } from "../src/music/diagnostics";
import { type AfmCatalogScan } from "../src/music/afm";
import { createArchetypeReel } from "./fixtures/music-archetypes";
import { createSyntheticAfmCatalog } from "./fixtures/music-catalog";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const throws = (operation: () => unknown, label: string): void => {
  try { operation(); } catch { return; }
  throw new Error(`${label}: expected an error`);
};

const run = async (): Promise<void> => {
  equal(parseMusicAnalyzeArguments(["--reel", "met_123", "--json"]).reelId, "met_123", "CLI parses --reel");
  equal(parseMusicAnalyzeArguments(["--file", "fixture.json"]).file, "fixture.json", "CLI parses --file");
  throws(() => parseMusicAnalyzeArguments([]), "CLI requires one input");
  throws(() => parseMusicAnalyzeArguments(["--reel", "../unsafe"]), "CLI rejects unsafe reel IDs");

  const reel = createArchetypeReel({ id: "diagnostic-dark", words: "dark mysterious shadow chiaroscuro psychological tension intimate portrait", pace: "slow", visualTone: "dark moody" });
  const deOnlyCatalog: AfmCatalogScan = {
    root: "/synthetic-afm",
    available: true,
    tracks: createSyntheticAfmCatalog().filter((track) => track.familyCode === "DE"),
    warnings: [],
  };
  const history = emptyReelProductionHistory();
  const reelSnapshot = JSON.stringify(reel);
  const historySnapshot = JSON.stringify(history);
  const report = createMusicDiagnosticReport(reel, deOnlyCatalog, history);
  equal(report.familyRanking[0].code, "DM", "ideal diagnostic ranking is independent from DE-only catalog");
  equal(report.selection?.familyCode, "DE", "available ranking falls back to DE-only catalog");
  truthy(report.catalogAvailability.missingPreferredFamilies.includes("DM"), "catalog gap identifies preferred DM family");
  truthy(report.selection?.reason.includes("Ideal intent prefers DM"), "fallback explanation separates intent from availability");
  const human = formatMusicDiagnosticReport(report);
  truthy(human.includes("Ideal Family Ranking"), "human output includes ideal family ranking");
  truthy(human.includes("Available Track Ranking"), "human output includes available track ranking");
  truthy(human.includes("recentPenalty="), "human output explains score penalties");
  const json = JSON.parse(JSON.stringify(report)) as typeof report;
  equal(json.selection?.trackId, report.selection?.trackId, "JSON output preserves selection");
  equal(JSON.stringify(reel), reelSnapshot, "diagnostic does not mutate ReelData");
  equal(JSON.stringify(history), historySnapshot, "diagnostic does not mutate history");

  const directory = await mkdtemp(join(tmpdir(), "artfolio-music-analyze-"));
  const reelPath = join(directory, "reel.json");
  await writeFile(reelPath, `${JSON.stringify(reel)}\n`, "utf8");
  const originalAfmRoot = process.env.ARTFOLIO_AFM_ROOT;
  process.env.ARTFOLIO_AFM_ROOT = join(directory, "missing-afm");
  try {
    const cliHuman = await runMusicAnalyze(["--file", reelPath]);
    truthy(cliHuman.includes("Music Intent") && cliHuman.includes("Available production tracks: 0"), "CLI human output works without rendering or AFM availability");
    const cliJson = JSON.parse(await runMusicAnalyze(["--file", reelPath, "--json"])) as typeof report;
    equal(cliJson.reel.id, reel.id, "CLI JSON output is machine-readable");
    equal(await readFile(reelPath, "utf8"), `${reelSnapshot}\n`, "CLI analysis does not mutate its ReelData file");
  } finally {
    if (originalAfmRoot === undefined) delete process.env.ARTFOLIO_AFM_ROOT;
    else process.env.ARTFOLIO_AFM_ROOT = originalAfmRoot;
  }

  console.log("Music diagnostic human/JSON and mutation-safety tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
