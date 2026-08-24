import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { planQcCheckpoints } from "../src/v2/qc";
import { createScenePlan } from "../src/v2/timing";
import { buildContactSheetFfmpegArgs } from "./qc-contact-sheet";
import { createRemotionQcSession, renderQcCheckpoints } from "./qc-rendering";
import { resolveReel } from "./reel-data";

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const reelId = args.find((argument) => argument !== "--debug-targets") ?? "why-this-works";
  const debugTargets = args.includes("--debug-targets");
  const { reel, compositionId, propsPath } = resolveReel(reelId);
  const plan = createScenePlan(reel);
  const checkpoints = planQcCheckpoints(plan);
  const directory = resolve("output/qc", reelId.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(directory, { recursive: true });
  const debugPropsPath = resolve(directory, "debug-props.json");
  if (debugTargets) writeFileSync(debugPropsPath, JSON.stringify({ ...reel, debugTargetOverlay: true }, null, 2));
  const renderPropsPath = debugTargets ? debugPropsPath : propsPath;
  const inputProps = renderPropsPath
    ? JSON.parse(readFileSync(renderPropsPath, "utf8")) as Record<string, unknown>
    : undefined;

  await renderQcCheckpoints({
    checkpoints,
    directory,
    createSession: () => createRemotionQcSession({ compositionId, inputProps }),
  });

  const contactSheet = resolve(directory, "contact-sheet.png");
  const stills = checkpoints.map((checkpoint) => resolve(directory, checkpoint.filename));
  const ffmpeg = spawnSync(
    "ffmpeg",
    buildContactSheetFfmpegArgs(stills, contactSheet),
    { stdio: "inherit" },
  );
  if (ffmpeg.status !== 0 || !existsSync(contactSheet)) {
    throw new Error("Could not create the QC contact sheet with ffmpeg.");
  }
  console.log(`QC stills and contact sheet: ${directory}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
