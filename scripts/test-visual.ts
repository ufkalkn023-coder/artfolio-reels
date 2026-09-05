import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SAMPLE_REELS } from "../src/v2/samples";
import { VIDEO } from "../src/v2/design";
import { getDurationInFrames } from "../src/v2/timing";
import { createRemotionQcSession } from "./qc-rendering";

const FIXTURE_ID = "why-this-works";
const COMPOSITION_ID = "ArtfolioV2-why-this-works";
const EXPECTED_DURATION_IN_FRAMES = 747;
const GOLDEN_DIRECTORY = resolve("tests/visual/golden");

const GOLDEN_FRAMES = [
  { id: "intro-settled", filename: "intro-settled-f46.png", frame: 46, sceneKind: "intro" as const },
  { id: "observation-middle", filename: "observation-middle-f221.png", frame: 221, sceneKind: "observation" as const },
  { id: "overview-settled", filename: "overview-settled-f595.png", frame: 595, sceneKind: "overview" as const },
  { id: "outro-settled", filename: "outro-settled-f711.png", frame: 711, sceneKind: "outro" as const },
] as const;

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const update = args.length === 1 && args[0] === "--update";
  if (args.length > (update ? 1 : 0)) {
    throw new Error("Usage: npm run test:visual [-- --update]");
  }

  const fixture = SAMPLE_REELS[FIXTURE_ID];
  if (VIDEO.fps !== 30 || getDurationInFrames(fixture) !== EXPECTED_DURATION_IN_FRAMES) {
    throw new Error(
      `Golden fixture timing changed: expected ${EXPECTED_DURATION_IN_FRAMES} frames at 30 FPS, received ${getDurationInFrames(fixture)} frames at ${VIDEO.fps} FPS.`,
    );
  }

  const artworkSource = fixture.artworks[0]?.src;
  if (!artworkSource || /^https?:\/\//u.test(artworkSource)) {
    throw new Error("Golden fixture must use a local artwork asset.");
  }
  await access(resolve("public", artworkSource));

  if (update) await mkdir(GOLDEN_DIRECTORY, { recursive: true });
  const actualDirectory = await mkdtemp(join(tmpdir(), "artfolio-visual-"));
  let keepActualFrames = false;

  try {
    const session = await createRemotionQcSession({ compositionId: COMPOSITION_ID });
    try {
      for (const goldenFrame of GOLDEN_FRAMES) {
        await session.renderStill({
          checkpoint: {
            id: goldenFrame.id,
            filename: goldenFrame.filename,
            sceneId: goldenFrame.id,
            sceneKind: goldenFrame.sceneKind,
            absoluteFrame: goldenFrame.frame,
            localFrame: goldenFrame.frame,
            phase: "settled",
          },
          output: join(actualDirectory, goldenFrame.filename),
        });
      }
    } finally {
      await session.close();
    }

    if (update) {
      for (const goldenFrame of GOLDEN_FRAMES) {
        const contents = await readFile(join(actualDirectory, goldenFrame.filename));
        await writeFile(join(GOLDEN_DIRECTORY, goldenFrame.filename), contents);
        console.log(`Updated ${goldenFrame.id} (frame ${goldenFrame.frame})`);
      }
      return;
    }

    const failures: string[] = [];
    for (const goldenFrame of GOLDEN_FRAMES) {
      const expectedPath = join(GOLDEN_DIRECTORY, goldenFrame.filename);
      const actualPath = join(actualDirectory, goldenFrame.filename);
      let expected: Buffer;
      try {
        expected = await readFile(expectedPath);
      } catch {
        failures.push(`${goldenFrame.id} (frame ${goldenFrame.frame}): missing golden ${expectedPath}`);
        continue;
      }
      const actual = await readFile(actualPath);
      if (!actual.equals(expected)) {
        failures.push(`${goldenFrame.id} (frame ${goldenFrame.frame}): rendered PNG differs from ${expectedPath}`);
      } else {
        console.log(`Passed ${goldenFrame.id} (frame ${goldenFrame.frame})`);
      }
    }

    if (failures.length > 0) {
      keepActualFrames = true;
      throw new Error(`Visual regression failed:\n${failures.join("\n")}\nActual frames: ${actualDirectory}`);
    }
  } finally {
    if (!keepActualFrames) await rm(actualDirectory, { recursive: true, force: true });
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
