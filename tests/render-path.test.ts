import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runReelBatch, type BatchCandidateQueue } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { loadReelProductionHistory } from "../src/planner/production-history";
import { assertRenderDestinationWritable, renderFilenameForArtwork, resolveRenderOutputPath, slugifyArtworkTitle } from "../src/planner/render-path";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const throws = (operation: () => unknown, label: string): void => {
  try { operation(); } catch { return; }
  throw new Error(`${label}: expected an error`);
};

const run = async (): Promise<void> => {
  equal(slugifyArtworkTitle("The Death of Cleopatra"), "the-death-of-cleopatra", "normal title becomes a slug");
  equal(slugifyArtworkTitle("L'Œuvre: A Study!"), "l-uvre-a-study", "punctuation and apostrophes are safe");
  equal(slugifyArtworkTitle("Café à l'été"), "cafe-a-lete", "accented Unicode is deterministic");
  equal(slugifyArtworkTitle("  Many   Spaces  "), "many-spaces", "repeated spaces collapse");
  equal(slugifyArtworkTitle("North / South\\East"), "north-south-east", "slashes and backslashes are safe");
  equal(slugifyArtworkTitle("../..//A Title"), "a-title", "path traversal-like title is safe");
  equal(renderFilenameForArtwork("met_670765", "The Death of Cleopatra"), "met_670765-the-death-of-cleopatra.mp4", "canonical ID is preserved before title slug");
  equal(renderFilenameForArtwork("met_670765", "***"), "met_670765.mp4", "empty title slug falls back to canonical ID");
  equal(renderFilenameForArtwork("met_670765", "The Death of Cleopatra"), renderFilenameForArtwork("met_670765", "The Death of Cleopatra"), "filename is deterministic");

  const root = await mkdtemp(join(tmpdir(), "artfolio-render-path-"));
  const destination = resolveRenderOutputPath("met_670765", "The Death of Cleopatra", join(root, "output"));
  truthy(!relative(join(root, "output", "renders"), destination).startsWith(".."), "destination remains inside output/renders");
  await mkdir(join(root, "output", "renders"), { recursive: true });
  await writeFile(destination, "placeholder");
  throws(() => assertRenderDestinationWritable(destination, false), "existing destination refuses overwrite");
  assertRenderDestinationWritable(destination, true);

  const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId: "batch-1", title: "Café / Night" };
  const handoffPath = join(root, "batch-1.json");
  await writeFile(handoffPath, JSON.stringify(handoff));
  const queue: BatchCandidateQueue = {
    target: 1, candidateLimit: 1, candidateCount: 1,
    candidates: [{ canonicalId: handoff.canonicalId, handoffPath, baseScore: 1, portfolioPriorityScore: 1 }],
  };
  const outputDirectory = join(root, "batch-output");
  const historyPath = join(root, "reel-production-history.json");
  const manifest = await runReelBatch({
    queue, render: true, cacheDirectory: join(root, "plans"), reelDirectory: join(root, "reels"), outputDirectory,
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN,
    localizeArtwork: async (artwork) => ({ artwork, sourcePath: artwork.imagePath, destinationPath: artwork.imagePath, renderablePath: artwork.imagePath }),
    runExistingCommand: () => undefined,
    productionHistory: await loadReelProductionHistory(historyPath), productionHistoryPath: historyPath, batchId: "render-path-test",
  });
  const batchDestination = resolveRenderOutputPath(handoff.canonicalId, handoff.title, outputDirectory);
  equal(manifest.candidates[0].renderPath, batchDestination, "batch uses the direct renderer path resolver");
  equal(manifest.candidates[0].renderPath, join(outputDirectory, "renders", "batch-1-cafe-night.mp4"), "batch manifest records actual filename");
  equal((await loadReelProductionHistory(historyPath)).entries[0].renderPath, batchDestination, "production history records actual filename");
  console.log("Render path tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
