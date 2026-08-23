import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { planWithGemini } from "./gemini";
import { artifactIdFor, runHandoffPipeline, type HandoffPipelineResult } from "./pipeline";
import { type PlannerCall } from "./service";
import { type CompileResult } from "./compiler";
import { type ArtworkHandoff } from "./handoff";
import { type ReelEligibility } from "./eligibility";
import { resolveRenderOutputPath } from "./render-path";

export type ExistingCommand = (name: "qc" | "render", reelId: string) => void;

export type ReelIntegrationOptions = {
  forcePlan?: boolean;
  render?: boolean;
  callPlanner?: PlannerCall;
  runExistingCommand?: ExistingCommand;
  compile?: (artwork: ArtworkHandoff, plan: unknown, eligibility: ReelEligibility) => CompileResult;
  cacheDirectory?: string;
  reelDirectory?: string;
  outputDirectory?: string;
};

const runExistingCommand: ExistingCommand = (name, reelId) => {
  const result = spawnSync("npm", ["run", name, "--", reelId], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${name} failed for ${reelId}`);
};

export type ReelIntegrationResult = HandoffPipelineResult & {
  qcDirectory: string;
  renderPath?: string;
};

/** Run the existing cached-planning pipeline and existing QC/render CLIs in order. */
export const runReelIntegration = async (
  rawHandoff: unknown,
  options: ReelIntegrationOptions = {},
): Promise<ReelIntegrationResult> => {
  const outputDirectory = options.outputDirectory ?? resolve("output");
  const result = await runHandoffPipeline(rawHandoff, {
    cacheDirectory: options.cacheDirectory ?? resolve("data/plans"),
    reelDirectory: options.reelDirectory ?? resolve("data/reels"),
    forcePlan: options.forcePlan,
    callPlanner: options.callPlanner ?? planWithGemini,
    compile: options.compile,
  });
  const reelId = artifactIdFor(result.handoff.canonicalId);
  (options.runExistingCommand ?? runExistingCommand)("qc", reelId);
  if (options.render) (options.runExistingCommand ?? runExistingCommand)("render", reelId);
  return {
    ...result,
    qcDirectory: resolve(outputDirectory, "qc", reelId),
    ...(options.render ? { renderPath: resolveRenderOutputPath(result.reel.artworks[0].id, result.reel.artworks[0].title, outputDirectory) } : {}),
  };
};
