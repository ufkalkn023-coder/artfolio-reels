import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { VIDEO } from "../src/v2/design";
import { getDurationInFrames } from "../src/v2/timing";
import { resolveRenderOutputPath } from "../src/planner/render-path";
import { cleanupStaleRenderTemps, renderAtomically } from "../src/planner/atomic-render";
import { verifyRenderMedia } from "../src/media/render-verification";
import { resolveReel } from "./reel-data";

const runInherited = async (command: string, args: readonly string[]): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code ?? "unknown"}`)));
});

const main = async (): Promise<void> => {
  const [reelId = "why-this-works", overwrite] = process.argv.slice(2);
  const { reel, compositionId, propsPath } = resolveReel(reelId);
  const artwork = reel.artworks[0];
  const destination = resolveRenderOutputPath(artwork.id, artwork.title);
  const removedTemps = await cleanupStaleRenderTemps(dirname(destination));
  if (removedTemps.length > 0) console.log(`Cleaned ${removedTemps.length} stale render temp file(s).`);
  await renderAtomically({
    destination,
    overwrite: overwrite === "--overwrite",
    render: (temporaryPath) => runInherited("npx", ["remotion", "render", compositionId, temporaryPath, "--codec=h264", ...(propsPath ? [`--props=${propsPath}`] : [])]),
    validate: async (temporaryPath) => {
      const validation = await verifyRenderMedia(temporaryPath, {
        durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
        requireAudio: Boolean(reel.music),
      }, { deep: true });
      if (validation.maxVolumeDb !== undefined) {
        console.log(`Validated audio stream: codec=${validation.audio?.codec} max_volume=${validation.maxVolumeDb.toFixed(1)} dB`);
      }
    },
  });
  console.log(`Validated H.264 render: ${destination}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
