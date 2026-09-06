import { spawnSync } from "node:child_process";
import { VIDEO } from "../src/v2/design";
import { getDurationInFrames } from "../src/v2/timing";
import { resolveRenderOutputPath } from "../src/planner/render-path";
import { renderAtomically } from "../src/planner/atomic-render";
import { resolveReel } from "./reel-data";

const main = async (): Promise<void> => {
  const [reelId = "why-this-works", overwrite] = process.argv.slice(2);
  const { reel, compositionId, propsPath } = resolveReel(reelId);
  const artwork = reel.artworks[0];
  const destination = resolveRenderOutputPath(artwork.id, artwork.title);
  await renderAtomically({
    destination,
    overwrite: overwrite === "--overwrite",
    render: (temporaryPath) => {
      const result = spawnSync("npx", ["remotion", "render", compositionId, temporaryPath, "--codec=h264", ...(propsPath ? [`--props=${propsPath}`] : [])], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Remotion render failed with status ${result.status ?? "unknown"}`);
    },
    validate: (temporaryPath) => {
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration", "-of", "json", temporaryPath], { encoding: "utf8" });
      if (probe.status !== 0) throw new Error("ffprobe could not read the rendered MP4");
      const inspected = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }>; format: { duration: string } };
      const video = inspected.streams.find((stream) => stream.codec_type === "video");
      const audio = inspected.streams.find((stream) => stream.codec_type === "audio");
      const expectedSeconds = getDurationInFrames(reel) / VIDEO.fps;
      if (video?.codec_name !== "h264" || video.width !== VIDEO.width || video.height !== VIDEO.height || video.r_frame_rate !== "30/1") {
        throw new Error("rendered MP4 failed codec, resolution, or FPS validation");
      }
      if (reel.music && !audio) throw new Error("rendered MP4 is missing the selected AFM audio stream");
      if (Math.abs(Number(inspected.format.duration) - expectedSeconds) > 0.1) {
        throw new Error("rendered MP4 duration does not match its scene plan");
      }
      const decode = spawnSync("ffmpeg", ["-v", "error", "-i", temporaryPath, "-f", "null", "-"], { stdio: "inherit" });
      if (decode.status !== 0) throw new Error("rendered MP4 failed decode validation");
      if (reel.music) {
        const volumeProbe = spawnSync("ffmpeg", ["-nostats", "-i", temporaryPath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
        if (volumeProbe.status !== 0) throw new Error("ffmpeg could not measure rendered audio loudness");
        const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(`${volumeProbe.stdout}\n${volumeProbe.stderr}`);
        const maxVolumeDb = match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
        if (!Number.isFinite(maxVolumeDb) || maxVolumeDb <= -90) throw new Error("rendered AFM audio is silent or inaudible");
        console.log(`Validated audio stream: codec=${audio?.codec_name} max_volume=${maxVolumeDb.toFixed(1)} dB`);
      }
    },
  });
  console.log(`Validated H.264 render: ${destination}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
