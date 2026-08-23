import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { VIDEO } from "../src/v2/design";
import { getDurationInFrames } from "../src/v2/timing";
import { assertRenderDestinationWritable, resolveRenderOutputPath } from "../src/planner/render-path";
import { resolveReel } from "./reel-data";

const [reelId = "why-this-works", overwrite] = process.argv.slice(2);
const { reel, compositionId, propsPath } = resolveReel(reelId);
const artwork = reel.artworks[0];
const destination = resolveRenderOutputPath(artwork.id, artwork.title);
assertRenderDestinationWritable(destination, overwrite === "--overwrite");
mkdirSync(resolve("output/renders"), { recursive: true });
const result = spawnSync("npx", ["remotion", "render", compositionId, destination, "--codec=h264", ...(propsPath ? [`--props=${propsPath}`] : []), ...(overwrite === "--overwrite" ? ["--overwrite"] : [])], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", destination], { encoding: "utf8" });
if (probe.status !== 0) throw new Error("ffprobe could not read the rendered MP4");
const inspected = JSON.parse(probe.stdout) as { streams: Array<{ codec_name: string; width: number; height: number; r_frame_rate: string }>; format: { duration: string } };
const video = inspected.streams[0];
const expectedSeconds = getDurationInFrames(reel) / VIDEO.fps;
if (video?.codec_name !== "h264" || video.width !== VIDEO.width || video.height !== VIDEO.height || video.r_frame_rate !== "30/1") {
  throw new Error("rendered MP4 failed codec, resolution, or FPS validation");
}
if (Math.abs(Number(inspected.format.duration) - expectedSeconds) > 0.1) {
  throw new Error("rendered MP4 duration does not match its scene plan");
}
const decode = spawnSync("ffmpeg", ["-v", "error", "-i", destination, "-f", "null", "-"], { stdio: "inherit" });
if (decode.status !== 0) throw new Error("rendered MP4 failed decode validation");
console.log(`Validated H.264 render: ${destination}`);
