import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReelOutputRunner } from "../scripts/reel-output";
import { localizeArtworkAsset } from "../src/planner/assets";
import { runReelBatch, type BatchCandidate, type ExistingBatchCommand } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { type RenderSession } from "../src/render/render-session";
import { ReelDataSchema, type ReelData } from "../src/v2/schema";
import { type MusicEnrichmentResult } from "../src/music/enrichment";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const exists = async (path: string): Promise<boolean> => stat(path).then((value) => value.isFile(), () => false);

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-render-audio-lifecycle-"));
  const sourceDirectory = join(root, "external");
  const publicDirectory = join(root, "public");
  const assetDirectory = join(publicDirectory, "reel-assets");
  const audioDirectory = join(publicDirectory, "reel-audio");
  const reelDirectory = join(root, "reels");
  await mkdir(sourceDirectory, { recursive: true });

  const candidates: BatchCandidate[] = [];
  const trackIds = ["AFM-DE08-04", "AFM-DE08-05"];
  for (const [index, suffix] of ["first", "second"].entries()) {
    const canonicalId = `audio-lifecycle-${suffix}`;
    const imagePath = join(sourceDirectory, `${canonicalId}.jpg`);
    await copyFile("public/artworks/starry-night.jpg", imagePath);
    const handoffPath = join(root, `${canonicalId}.json`);
    await writeFile(handoffPath, JSON.stringify({ ...STARRY_NIGHT_HANDOFF, canonicalId, imagePath }));
    candidates.push({ canonicalId, handoffPath, baseScore: 2 - index, portfolioPriorityScore: 2 - index });
  }

  let sessionInitializationCount = 0;
  let closeCount = 0;
  let qcCount = 0;
  let renderCount = 0;
  let audioLocalizationCount = 0;
  const createCommand = (session: RenderSession): ExistingBatchCommand => async (name, reelId) => {
    const reel = JSON.parse(await readFile(join(reelDirectory, `${reelId}.json`), "utf8")) as ReelData;
    const source = await session.selectSource({ compositionId: "ArtfolioV2-PlannedReel", inputProps: reel as unknown as Record<string, unknown> });
    if (name === "qc") {
      await source.renderStill({ frame: 0, output: join(root, `${reelId}.png`) });
      qcCount += 1;
    } else {
      await source.renderVideo({ output: join(root, `${reelId}.mp4`), overwrite: false });
      renderCount += 1;
    }
  };
  const runner = createReelOutputRunner({
    createSession: async () => {
      sessionInitializationCount += 1;
      const bundledAssets = new Set<string>();
      for (const candidate of candidates) {
        const publicPath = `reel-assets/${candidate.canonicalId}.jpg`;
        if (await exists(join(publicDirectory, publicPath))) bundledAssets.add(publicPath);
      }
      for (const trackId of trackIds) {
        const publicPath = `reel-audio/${trackId}.wav`;
        if (await exists(join(publicDirectory, publicPath))) bundledAssets.add(publicPath);
      }
      return {
        selectSource: async ({ inputProps }) => {
          const reel = inputProps as ReelData;
          return {
            renderStill: async () => {
              if (!bundledAssets.has(reel.artworks[0].src)) throw new Error(`404 ${reel.artworks[0].src}`);
            },
            renderVideo: async () => {
              if (!bundledAssets.has(reel.artworks[0].src)) throw new Error(`404 ${reel.artworks[0].src}`);
              if (reel.music && !bundledAssets.has(reel.music.src)) throw new Error(`404 ${reel.music.src}`);
            },
          };
        },
        close: async () => { closeCount += 1; },
      };
    },
    createCommand,
  });

  try {
    const manifest = await runReelBatch({
      queue: { target: 2, candidateLimit: 2, candidateCount: 2, candidates },
      render: true,
      cacheDirectory: join(root, "plans"),
      reelDirectory,
      outputDirectory: join(root, "output"),
      callPlanner: async () => STARRY_NIGHT_MOCK_PLAN,
      localizeArtwork: (artwork) => localizeArtworkAsset(artwork, { publicDirectory, assetDirectory }),
      runExistingCommand: runner.run,
      enrichMusic: async (reel): Promise<MusicEnrichmentResult> => {
        equal(qcCount, candidates.length, "AFM work starts only after bounded QC completes");
        const trackId = trackIds[audioLocalizationCount];
        await mkdir(audioDirectory, { recursive: true });
        await writeFile(join(audioDirectory, `${trackId}.wav`), "test-audio");
        audioLocalizationCount += 1;
        const enriched = ReelDataSchema.parse({
          ...reel,
          music: { src: `reel-audio/${trackId}.wav`, trackId, subfamily: "DE08", volume: 0.18, start: 0, durationSeconds: 120, fadeIn: 0.6, fadeOut: 1.5 },
        });
        return {
          reel: enriched,
          selection: {
            track: { id: trackId, subfamilyCode: "DE08" },
            score: { total: 1 },
          } as MusicEnrichmentResult["selection"],
        };
      },
      writeSocialCopy: async (_handoff, _plan, outputDirectory = join(root, "output")) => join(outputDirectory, "social.txt"),
    });
    equal(manifest.renderedCount, 2, "both post-QC audio reels render without a reel-audio 404");
    equal(manifest.candidates.some((attempt) => attempt.errorMessageSafe?.includes("404")), false, "manifest contains no asset 404");
  } finally {
    await runner.close();
  }

  equal(audioLocalizationCount, 2, "audio localizes only for QC-passed candidates");
  equal(sessionInitializationCount, 2, "one QC session and one post-audio final-render session are created");
  equal(qcCount, 2, "N candidates share the QC session");
  equal(renderCount, 2, "M candidates share the final-render session");
  equal(closeCount, 2, "both sessions close successfully");
  console.log("Render session AFM audio lifecycle regression test passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
