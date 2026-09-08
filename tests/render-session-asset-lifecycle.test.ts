import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReelOutputRunner } from "../scripts/reel-output";
import { localizeArtworkAsset } from "../src/planner/assets";
import { runReelBatch, type BatchCandidate, type ExistingBatchCommand } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { type ReelData } from "../src/v2/schema";
import { type RenderSession } from "../src/render/render-session";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-render-asset-lifecycle-"));
  const sourceDirectory = join(root, "external");
  const publicDirectory = join(root, "public");
  const assetDirectory = join(publicDirectory, "reel-assets");
  const reelDirectory = join(root, "reels");
  await mkdir(sourceDirectory, { recursive: true });

  const candidates: BatchCandidate[] = [];
  for (const suffix of ["first", "second"]) {
    const canonicalId = `asset-lifecycle-${suffix}`;
    const imagePath = join(sourceDirectory, `${canonicalId}.jpg`);
    await copyFile("public/artworks/starry-night.jpg", imagePath);
    const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId, imagePath };
    const handoffPath = join(root, `${canonicalId}.json`);
    await writeFile(handoffPath, JSON.stringify(handoff));
    candidates.push({ canonicalId, handoffPath, baseScore: 1, portfolioPriorityScore: 1 });
  }

  let sessionInitializationCount = 0;
  let resolvedArtworkCount = 0;
  let closeCount = 0;
  const createCommand = (session: RenderSession): ExistingBatchCommand => async (name, reelId) => {
    const reel = JSON.parse(await readFile(join(reelDirectory, `${reelId}.json`), "utf8")) as ReelData;
    const source = await session.selectSource({ compositionId: "ArtfolioV2-PlannedReel", inputProps: reel as unknown as Record<string, unknown> });
    if (name === "qc") await source.renderStill({ frame: 0, output: join(root, `${reelId}.png`) });
    else await source.renderVideo({ output: join(root, `${reelId}.mp4`), overwrite: false });
  };
  const runner = createReelOutputRunner({
    createSession: async () => {
      sessionInitializationCount += 1;
      const bundledAssets = new Set<string>();
      for (const candidate of candidates) {
        const path = join(assetDirectory, `${candidate.canonicalId}.jpg`);
        if (!(await stat(path)).isFile()) throw new Error(`bundle initialized before ${candidate.canonicalId} was localized`);
        bundledAssets.add(`reel-assets/${candidate.canonicalId}.jpg`);
      }
      return {
        selectSource: async ({ inputProps }) => {
          const reel = inputProps as ReelData;
          const artworkUrl = reel.artworks[0].src;
          return {
            renderStill: async () => {
              if (!bundledAssets.has(artworkUrl)) throw new Error(`404 ${artworkUrl}`);
              resolvedArtworkCount += 1;
            },
            renderVideo: async () => {
              if (!bundledAssets.has(artworkUrl)) throw new Error(`404 ${artworkUrl}`);
              resolvedArtworkCount += 1;
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
      enrichMusic: async (reel) => ({ reel }),
      writeSocialCopy: async (_handoff, _plan, outputDirectory = join(root, "output")) => join(outputDirectory, "social.txt"),
    });
    equal(manifest.renderedCount, 2, "both localized candidates render through the shared session");
  } finally {
    await runner.close();
  }

  equal(sessionInitializationCount, 2, "QC and final-render sessions both initialize after artwork localization");
  equal(resolvedArtworkCount, 4, "both QC and final render resolve both bundled artwork URLs");
  equal(closeCount, 2, "both shared lifecycle sessions close once");
  console.log("Render session asset lifecycle regression test passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
