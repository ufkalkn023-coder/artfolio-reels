import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { planWithGemini } from "../src/planner/gemini";
import { STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { PLANNER_VERSION } from "../src/planner/config";
import { runHandoffPipeline } from "../src/planner/pipeline";
import { formatPlannerUsageSummary } from "../src/planner/telemetry";
import { loadReelProductionHistory, recentMusicContextFromProductionHistory } from "../src/planner/production-history";

const args = process.argv.slice(2);
const handoffPath = args.find((arg) => !arg.startsWith("--"));
const force = args.includes("--force-plan");
const mock = args.includes("--mock");
if (!handoffPath) throw new Error("Usage: npm run plan -- <handoff-json> [--force-plan] [--mock]");

const main = async (): Promise<void> => {
  const rawHandoff = JSON.parse(await readFile(resolve(handoffPath), "utf8"));
  const productionHistory = await loadReelProductionHistory(resolve("data/reel-production-history.json"));
  const result = await runHandoffPipeline(rawHandoff, {
    cacheDirectory: resolve("data/plans"),
    reelDirectory: resolve("data/reels"),
    forcePlan: force,
    recentMusic: recentMusicContextFromProductionHistory(productionHistory, undefined, rawHandoff.canonicalId),
    callPlanner: mock
      ? async () => {
        if (rawHandoff.canonicalId !== "starry-night") throw new Error("--mock is available only for the bundled Starry Night fixture");
        return STARRY_NIGHT_MOCK_PLAN;
      }
      : planWithGemini,
  });

  if (result.cacheHit) {
    console.info(`[planner] artwork=${result.handoff.canonicalId} cache=hit gemini_calls=0 cost=$0`);
  } else if (result.telemetry) {
    console.info(formatPlannerUsageSummary(result.telemetry));
  } else {
    console.info(`[planner] artwork=${result.handoff.canonicalId} version=${PLANNER_VERSION} cache=miss gemini_calls=0 cost=$0`);
  }
  console.info(`[planner] selected=${result.plan.template}`);
  console.info(`[planner] reel=${result.reelPath}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Planner failed");
  process.exitCode = 1;
});
