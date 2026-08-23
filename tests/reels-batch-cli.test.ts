import { parseReelBatchCliArgs } from "../scripts/reels-batch";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const throwsUsage = (args: string[], label: string): void => {
  try {
    parseReelBatchCliArgs(args);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Usage:")) return;
  }
  throw new Error(`${label}: expected usage error`);
};

const run = (): void => {
  const defaultOptions = parseReelBatchCliArgs([]);
  equal(defaultOptions.render, false, "default command does not render");
  equal(defaultOptions.selectionOnly, false, "default command runs the batch");

  const renderOptions = parseReelBatchCliArgs(["--", "--render"]);
  equal(renderOptions.render, true, "npm separator permits --render");

  const selectionOptions = parseReelBatchCliArgs(["--", "--selection-only"]);
  equal(selectionOptions.selectionOnly, true, "npm separator permits --selection-only");

  const targetOptions = parseReelBatchCliArgs(["--", "--target", "4"]);
  equal(targetOptions.target, "4", "npm separator permits target value");

  const candidateLimitOptions = parseReelBatchCliArgs(["--", "--candidate-limit", "8"]);
  equal(candidateLimitOptions.candidateLimit, "8", "npm separator permits candidate limit value");

  const combinedOptions = parseReelBatchCliArgs(["--", "--render", "--target", "4", "--candidate-limit", "8"]);
  equal(combinedOptions.render, true, "combined options retain render");
  equal(combinedOptions.target, "4", "combined options retain target");
  equal(combinedOptions.candidateLimit, "8", "combined options retain candidate limit");

  throwsUsage(["--unknown"], "unknown flags fail");
  throwsUsage(["--target"], "missing target value fails");
  throwsUsage(["--candidate-limit"], "missing candidate limit value fails");
  throwsUsage(["--render", "--selection-only"], "conflicting mode flags fail");
  console.log("Reel batch CLI tests passed");
};

run();
