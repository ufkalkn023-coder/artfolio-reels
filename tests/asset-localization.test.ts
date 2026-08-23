import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { localizeArtworkAsset } from "../src/planner/assets";
import { writeCachedPlan } from "../src/planner/cache";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { runHandoffPipeline } from "../src/planner/pipeline";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<void> => {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
};
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-localized-assets-"));
  const publicDirectory = join(root, "public");
  const assetDirectory = join(publicDirectory, "reel-assets");
  const externalDirectory = join(root, "external");
  await mkdir(externalDirectory, { recursive: true });
  const externalImage = join(externalDirectory, "source.jpg");
  await copyFile("public/artworks/starry-night.jpg", externalImage);
  const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId: "external-localization-test", imagePath: externalImage };
  const localize = () => localizeArtworkAsset(handoff, { publicDirectory, assetDirectory });

  const first = await localize();
  equal(first.renderablePath, "reel-assets/external-localization-test.jpg", "external image receives a staticFile-compatible path");
  equal(first.artwork.imagePath, "public/reel-assets/external-localization-test.jpg", "compiler input receives localized public path");
  equal(first.artwork.title, handoff.title, "verified metadata remains unchanged");
  equal(first.artwork.imageWidth, handoff.imageWidth, "verified width remains unchanged");
  equal(first.artwork.imageHeight, handoff.imageHeight, "verified height remains unchanged");
  equal(digest(await readFile(first.sourcePath)), digest(await readFile(first.destinationPath)), "localized asset preserves source bytes");

  const second = await localize();
  equal(second.destinationPath, first.destinationPath, "identical localized asset is reused");

  const conflictingHandoff = { ...handoff, canonicalId: "collision-test" };
  const conflictingDestination = join(assetDirectory, "collision-test.jpg");
  await writeFile(conflictingDestination, "different bytes");
  await rejects(() => localizeArtworkAsset(conflictingHandoff, { publicDirectory, assetDirectory }), "different destination is never overwritten");

  const traversal = await localizeArtworkAsset({ ...handoff, canonicalId: "../../outside" }, { publicDirectory, assetDirectory });
  equal(traversal.destinationPath.startsWith(`${assetDirectory}/`), true, "canonical IDs cannot escape asset directory");
  equal(traversal.destinationPath.includes(".."), false, "canonical ID path traversal is sanitized");

  const cacheDirectory = join(root, "plans");
  const reelDirectory = join(root, "reels");
  await writeCachedPlan(cacheDirectory, handoff, STARRY_NIGHT_MOCK_PLAN);
  let plannerCalls = 0;
  const cached = await runHandoffPipeline(handoff, {
    cacheDirectory,
    reelDirectory,
    localizeArtwork: (artwork) => localizeArtworkAsset(artwork, { publicDirectory, assetDirectory }),
    callPlanner: async () => { plannerCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  });
  equal(plannerCalls, 0, "cached ReelPlan localizes and compiles without Gemini");
  equal(cached.cacheHit, true, "cached plan remains usable after localization");
  equal(cached.handoff.imagePath, externalImage, "handoff source path remains unchanged");
  equal(cached.reel.artworks[0].src, "reel-assets/external-localization-test.jpg", "ReelData never receives external filesystem path");
  console.log("Asset localization tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
