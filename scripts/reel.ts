import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runReelIntegration } from "../src/planner/integration";

const args = process.argv.slice(2);
const handoffPath = args.find((arg) => !arg.startsWith("--"));
const forcePlan = args.includes("--force-plan");
const render = args.includes("--render");
const unsupported = args.filter((arg) => arg.startsWith("--") && arg !== "--force-plan" && arg !== "--render");
if (!handoffPath || unsupported.length > 0) {
  throw new Error("Usage: npm run reel -- <handoff-json> [--force-plan] [--render]");
}

const main = async (): Promise<void> => {
  const rawHandoff = JSON.parse(await readFile(resolve(handoffPath), "utf8"));
  const result = await runReelIntegration(rawHandoff, { forcePlan, render });
  console.info(`[reel] artwork=${result.handoff.canonicalId} cache=${result.cacheHit ? "hit" : "miss"} reel=${result.reelPath}`);
  console.info(`[reel] qc=${result.qcDirectory}${result.renderPath ? ` render=${result.renderPath}` : ""}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Reel pipeline failed");
  process.exitCode = 1;
});
