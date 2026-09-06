import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadReelProductionHistory } from "../planner/production-history";
import { ReelDataSchema, type ReelData } from "../v2/schema";
import { defaultAfmRoot, scanAfmCatalog } from "./afm";
import { createCorpusMusicDiagnosticReport, discoverReelCorpus, formatCorpusMusicDiagnosticReport } from "./corpus-diagnostics";
import { createMusicDiagnosticReport, formatMusicDiagnosticReport } from "./diagnostics";

export type MusicAnalyzeArguments = { reelId?: string; file?: string; all: boolean; json: boolean };

export const parseMusicAnalyzeArguments = (args: readonly string[]): MusicAnalyzeArguments => {
  let reelId: string | undefined;
  let file: string | undefined;
  let all = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--all") all = true;
    else if (argument === "--reel") {
      reelId = args[++index];
      if (!reelId) throw new Error("--reel requires an ID");
    } else if (argument === "--file") {
      file = args[++index];
      if (!file) throw new Error("--file requires a path");
    }
    else throw new Error(`Unknown music:analyze argument: ${argument}`);
  }
  if (Number(Boolean(reelId)) + Number(Boolean(file)) + Number(all) !== 1) throw new Error("Use exactly one of --reel <id>, --file <path>, or --all");
  if (reelId && !/^[A-Za-z0-9_-]+$/.test(reelId)) throw new Error("--reel must contain only letters, numbers, underscore, or hyphen");
  return { ...(reelId ? { reelId } : {}), ...(file ? { file } : {}), all, json };
};

const loadReel = async (input: MusicAnalyzeArguments): Promise<ReelData> => {
  const path = input.file ? resolve(input.file) : resolve("data/reels", `${input.reelId}.json`);
  try {
    return ReelDataSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot analyze ReelData at ${path}: ${detail}`);
  }
};

export const runMusicAnalyze = async (args: readonly string[]): Promise<string> => {
  const input = parseMusicAnalyzeArguments(args);
  if (input.all) {
    const [discovery, catalog, history] = await Promise.all([
      discoverReelCorpus(resolve("data/reels")),
      scanAfmCatalog(defaultAfmRoot()),
      loadReelProductionHistory(resolve("data/reel-production-history.json")),
    ]);
    const report = createCorpusMusicDiagnosticReport(discovery, catalog, history);
    return input.json ? `${JSON.stringify(report, null, 2)}\n` : formatCorpusMusicDiagnosticReport(report);
  }
  const [reel, catalog, history] = await Promise.all([
    loadReel(input),
    scanAfmCatalog(defaultAfmRoot()),
    loadReelProductionHistory(resolve("data/reel-production-history.json")),
  ]);
  const report = createMusicDiagnosticReport(reel, catalog, history);
  return input.json ? `${JSON.stringify(report, null, 2)}\n` : formatMusicDiagnosticReport(report);
};
