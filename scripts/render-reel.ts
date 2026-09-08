import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRenderMedia } from "../src/media/render-verification";
import { cleanupStaleRenderTemps, renderAtomically } from "../src/planner/atomic-render";
import { resolveRenderOutputPath } from "../src/planner/render-path";
import {
  createRenderSession,
  withRenderSession,
  type RenderSession,
} from "../src/render/render-session";
import { VIDEO } from "../src/v2/design";
import { getDurationInFrames } from "../src/v2/timing";
import { resolveReel } from "./reel-data";

type RenderReelVideoOptions = {
  reelId: string;
  overwrite?: boolean;
  outputDirectory?: string;
  session?: RenderSession;
  createSession?: () => Promise<RenderSession>;
};

export const renderReelVideo = async ({
  reelId,
  overwrite = false,
  outputDirectory = resolve("output"),
  session,
  createSession = createRenderSession,
}: RenderReelVideoOptions): Promise<string> => {
  const { reel, compositionId, propsPath } = resolveReel(reelId);
  const artwork = reel.artworks[0];
  const destination = resolveRenderOutputPath(artwork.id, artwork.title, outputDirectory);
  const removedTemps = await cleanupStaleRenderTemps(dirname(destination));
  if (removedTemps.length > 0) console.log(`Cleaned ${removedTemps.length} stale render temp file(s).`);
  const inputProps = propsPath ? JSON.parse(await readFile(propsPath, "utf8")) as Record<string, unknown> : undefined;

  const render = async (activeSession: RenderSession): Promise<void> => {
    const selected = await activeSession.selectSource({ compositionId, inputProps });
    await renderAtomically({
      destination,
      overwrite,
      render: (temporaryPath) => selected.renderVideo({ output: temporaryPath, overwrite: false }),
      validate: async (temporaryPath) => {
        const validation = await verifyRenderMedia(temporaryPath, {
          durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
          requireAudio: Boolean(reel.music || reel.voiceover),
        }, { deep: true });
        if (validation.maxVolumeDb !== undefined) {
          console.log(`Validated audio stream: codec=${validation.audio?.codec} max_volume=${validation.maxVolumeDb.toFixed(1)} dB`);
        }
      },
    });
  };

  if (session) await render(session);
  else await withRenderSession(render, createSession);
  console.log(`Validated H.264 render: ${destination}`);
  return destination;
};

const main = async (): Promise<void> => {
  const [reelId = "why-this-works", overwrite] = process.argv.slice(2);
  await renderReelVideo({ reelId, overwrite: overwrite === "--overwrite" });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
