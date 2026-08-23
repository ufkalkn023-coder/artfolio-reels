import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { PLANNER_VERSION } from "../src/planner/config";
import { ReelDataSchema } from "../src/v2/schema";
import { getDurationInFrames } from "../src/v2/timing";
import { VIDEO } from "../src/v2/design";
import { loadReelProductionHistory, recordProductionHistory } from "../src/planner/production-history";

const reelIds = process.argv.slice(2);
if (!reelIds.length || reelIds.some((id) => id.startsWith("-"))) {
  throw new Error("Usage: npm run reels:history:bootstrap -- <reel-id> [...reel-id]");
}

const inspectRender = async (reelId: string): Promise<{ renderedAt: string; renderPath: string }> => {
  const renderPath = resolve("output/renders", `${reelId}.mp4`);
  const metadata = await stat(renderPath);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Missing or empty render: ${renderPath}`);
  const reel = ReelDataSchema.parse(JSON.parse(await readFile(resolve("data/reels", `${reelId}.json`), "utf8")));
  if (reel.id !== reelId || reel.artworks.length !== 1 || reel.artworks[0].id !== reelId) throw new Error(`ReelData does not match ${reelId}`);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", renderPath], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`ffprobe could not read ${renderPath}`);
  const inspected = JSON.parse(probe.stdout) as { streams: Array<{ codec_name: string; width: number; height: number; r_frame_rate: string }>; format: { duration: string } };
  const video = inspected.streams[0];
  const expectedSeconds = getDurationInFrames(reel) / VIDEO.fps;
  if (video?.codec_name !== "h264" || video.width !== VIDEO.width || video.height !== VIDEO.height || video.r_frame_rate !== "30/1" || Math.abs(Number(inspected.format.duration) - expectedSeconds) > 0.1) {
    throw new Error(`Rendered MP4 validation failed for ${reelId}`);
  }
  return { renderedAt: metadata.mtime.toISOString(), renderPath };
};

const main = async (): Promise<void> => {
  const historyPath = resolve("data/reel-production-history.json");
  let history = await loadReelProductionHistory(historyPath);
  for (const reelId of reelIds) {
    const reel = ReelDataSchema.parse(JSON.parse(await readFile(resolve("data/reels", `${reelId}.json`), "utf8")));
    const render = await inspectRender(reelId);
    const artwork = reel.artworks[0];
    const result = await recordProductionHistory(historyPath, history, {
      canonicalId: artwork.id, artist: artwork.artist, museum: artwork.museum, source: artwork.id.split("_", 1)[0],
      template: reel.template, plannerVersion: PLANNER_VERSION, batchId: `bootstrap-${reelId}`, status: "RENDERED",
      completedAt: render.renderedAt, duration: getDurationInFrames(reel) / VIDEO.fps, renderPath: render.renderPath,
    });
    history = result.history;
    console.info(`[reel-history] ${reelId} ${result.transition ?? "RENDERED"} ${result.changed ? "recorded" : "already recorded"}`);
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Reel history bootstrap failed");
  process.exitCode = 1;
});
