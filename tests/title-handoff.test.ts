import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReelBatch } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-title-handoff-"));
  const sourceTitle = "The Grand Historical Allegory of a Monumental Scene with Many Figures and Symbols";
  const handoffPath = join(root, "overlong-title.json");
  await writeFile(handoffPath, JSON.stringify({ ...STARRY_NIGHT_HANDOFF, canonicalId: "overlong-title", title: sourceTitle }));

  let plannerTitle: string | undefined;
  const result = await runReelBatch({
    queue: {
      target: 1,
      candidateLimit: 1,
      candidateCount: 1,
      candidates: [{ canonicalId: "overlong-title", handoffPath, baseScore: 1, portfolioPriorityScore: 1 }],
    },
    cacheDirectory: join(root, "plans"),
    reelDirectory: join(root, "reels"),
    outputDirectory: join(root, "output"),
    callPlanner: async (artwork) => {
      plannerTitle = artwork.title;
      return STARRY_NIGHT_MOCK_PLAN;
    },
    localizeArtwork: async (artwork) => ({ artwork, sourcePath: artwork.imagePath, destinationPath: artwork.imagePath, renderablePath: artwork.imagePath }),
    runExistingCommand: () => undefined,
  });

  equal(result.candidates[0].handoffStatus, "OK", "overlong source title crosses the handoff boundary");
  equal(plannerTitle, "The Grand Historical Allegory of a Monumental Scene with Many Figures a…", "planner receives a deterministic 72-character display title");
  equal(JSON.parse(await readFile(handoffPath, "utf8")).title, sourceTitle, "source handoff metadata retains the original title");
  console.log("Title handoff test passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
