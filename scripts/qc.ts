import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RenderSession } from "../src/render/render-session";
import { planQcCheckpoints } from "../src/v2/qc";
import { createScenePlan } from "../src/v2/timing";
import { beginQcRun, finalizeSuccessfulQcRun, preserveFailedQcRun, resolveQcRetention, type QcLifecycleResult, type QcRetention } from "../src/qc/lifecycle";
import { buildContactSheetFfmpegArgs } from "./qc-contact-sheet";
import { createQcRenderSession, createRemotionQcSession, renderQcCheckpoints } from "./qc-rendering";
import { resolveReel } from "./reel-data";

export type RunQcOptions = {
  debugTargets?: boolean;
  outputDirectory?: string;
  retention?: QcRetention;
  session?: RenderSession;
};

const runFfmpeg = async (args: readonly string[]): Promise<void> => new Promise((resolveProcess, reject) => {
  const child = spawn("ffmpeg", [...args], { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveProcess() : reject(new Error(`ffmpeg exited with status ${code ?? "unknown"}`)));
});

export const runQcForReel = async (reelId: string, options: RunQcOptions = {}): Promise<QcLifecycleResult> => {
  const debugTargets = options.debugTargets ?? false;
  const retention = options.retention ?? resolveQcRetention();
  const { reel, compositionId, propsPath } = resolveReel(reelId);
  const plan = createScenePlan(reel);
  const checkpoints = planQcCheckpoints(plan);
  const run = await beginQcRun(resolve(options.outputDirectory ?? "output", "qc"), reelId.replace(/[^A-Za-z0-9_-]/g, "_"));
  const directory = run.stagingDirectory;
  const debugPropsPath = resolve(directory, "debug-props.json");
  if (debugTargets) writeFileSync(debugPropsPath, JSON.stringify({ ...reel, debugTargetOverlay: true }, null, 2));
  const renderPropsPath = debugTargets ? debugPropsPath : propsPath;
  const inputProps = renderPropsPath
    ? JSON.parse(readFileSync(renderPropsPath, "utf8")) as Record<string, unknown>
    : undefined;

  try {
    await renderQcCheckpoints({
      checkpoints,
      directory,
      ...(options.session
        ? { session: await createQcRenderSession(options.session, { compositionId, inputProps }) }
        : { createSession: () => createRemotionQcSession({ compositionId, inputProps }) }),
    });

    const contactSheet = resolve(directory, "contact-sheet.png");
    const stills = checkpoints.map((checkpoint) => resolve(directory, checkpoint.filename));
    await runFfmpeg(buildContactSheetFfmpegArgs(stills, contactSheet, retention === "summary" ? { thumbnailWidth: 270 } : {}));
    if (!existsSync(contactSheet)) throw new Error("Could not create the QC contact sheet with ffmpeg.");
    return finalizeSuccessfulQcRun(run, retention, {
      version: "artfolio-qc-summary-v1",
      reelId,
      checkpointCount: checkpoints.length,
      checkpoints: checkpoints.map(({ id, sceneId, sceneKind, absoluteFrame, phase }) => ({ id, sceneId, sceneKind, absoluteFrame, phase })),
      contactSheet: "contact-sheet.png",
    });
  } catch (error) {
    const failureDirectory = await preserveFailedQcRun(run).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${failureDirectory ? ` QC failure evidence: ${failureDirectory}` : ""}`);
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const reelId = args.find((argument) => argument !== "--debug-targets") ?? "why-this-works";
  const result = await runQcForReel(reelId, { debugTargets: args.includes("--debug-targets") });
  console.log(`QC passed: retention=${result.retention} retained=${result.retainedCount} cleaned=${result.cleanedCount}${result.directory ? ` directory=${result.directory}` : ""}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
