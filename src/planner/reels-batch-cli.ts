export const REEL_BATCH_USAGE = "Usage: npm run reels:batch -- [--render] [--force-plan] [--selection-only] [--target <n>] [--candidate-limit <n>]";

export type ReelBatchCliOptions = {
  render: boolean;
  forcePlan: boolean;
  selectionOnly: boolean;
  target?: string;
  candidateLimit?: string;
};

export const parseReelBatchCliArgs = (rawArgs: string[]): ReelBatchCliOptions => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  let render = false;
  let forcePlan = false;
  let selectionOnly = false;
  let target: string | undefined;
  let candidateLimit: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--render") {
      render = true;
      continue;
    }
    if (arg === "--force-plan") {
      forcePlan = true;
      continue;
    }
    if (arg === "--selection-only") {
      selectionOnly = true;
      continue;
    }
    if (arg === "--target" || arg === "--candidate-limit") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !/^\d+$/.test(value)) throw new Error(REEL_BATCH_USAGE);
      if (arg === "--target" && target === undefined) target = value;
      if (arg === "--candidate-limit" && candidateLimit === undefined) candidateLimit = value;
      index += 1;
      continue;
    }
    throw new Error(REEL_BATCH_USAGE);
  }

  if (render && selectionOnly) throw new Error(REEL_BATCH_USAGE);
  return { render, forcePlan, selectionOnly, target, candidateLimit };
};
