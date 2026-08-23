import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ReelData } from "../src/v2/schema";
import { getSampleReel } from "../src/v2/samples";
import { assertValidReelData, templateIds } from "../src/v2/templates";

const safeReelId = (reelId: string): string => reelId.replace(/[^A-Za-z0-9_-]/g, "_");

export type ResolvedReel = {
  reel: ReelData;
  compositionId: string;
  propsPath?: string;
};

/** Rendering and QC load only saved deterministic ReelData; Gemini is never imported here. */
export const resolveReel = (reelId: string): ResolvedReel => {
  const plannedPath = resolve("data/reels", `${safeReelId(reelId)}.json`);
  if (existsSync(plannedPath)) {
    return {
      reel: assertValidReelData(JSON.parse(readFileSync(plannedPath, "utf8"))),
      compositionId: "ArtfolioV2-PlannedReel",
      propsPath: plannedPath,
    };
  }
  if (!templateIds.includes(reelId as (typeof templateIds)[number])) {
    throw new Error(`Unknown reel "${reelId}". Use a saved reel ID or: ${templateIds.join(", ")}`);
  }
  return { reel: getSampleReel(reelId), compositionId: `ArtfolioV2-${reelId}` };
};
