import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCachedPlan } from "../src/planner/cache";
import { runReelIntegration } from "../src/planner/integration";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { resolveRenderOutputPath } from "../src/planner/render-path";
import { resolveSocialOutputPath } from "../src/social/social-copy";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<void> => {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
};

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-reel-integration-"));
  const cacheDirectory = join(root, "plans");
  const reelDirectory = join(root, "reels");
  const outputDirectory = join(root, "output");
  const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId: "integration-starry-night" };
  const commands: Array<[string, string]> = [];
  const recordCommand = (name: "qc" | "render", reelId: string): void => { commands.push([name, reelId]); };

  await writeCachedPlan(cacheDirectory, handoff, STARRY_NIGHT_MOCK_PLAN);
  let cachedCalls = 0;
  const cached = await runReelIntegration(handoff, {
    cacheDirectory, reelDirectory, outputDirectory, runExistingCommand: recordCommand,
    callPlanner: async () => { cachedCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  });
  equal(cachedCalls, 0, "cached handoff makes zero Gemini/planner calls");
  equal(cached.cacheHit, true, "cached handoff reports cache hit");
  equal(cached.qcDirectory, join(outputDirectory, "qc", "integration-starry-night"), "cached handoff selects canonical QC path");
  equal(commands.length, 1, "cached handoff runs QC only");
  equal(commands[0][0], "qc", "QC runs before any optional render");
  equal(cached.reel.artworks[0].title, handoff.title, "compiler preserves verified title");
  equal(cached.reel.artworks[0].artist, handoff.artist, "compiler preserves verified artist");
  equal(cached.reel.artworks[0].date, handoff.date, "compiler preserves verified date");
  equal(cached.reel.artworks[0].museum, handoff.museum, "compiler preserves verified museum");
  equal(cached.reel.artworks[0].src, handoff.imagePath.replace(/^public\//, ""), "compiler uses handoff local image path");

  const noCacheRoot = await mkdtemp(join(tmpdir(), "artfolio-reel-no-cache-"));
  let uncachedCalls = 0;
  await runReelIntegration(handoff, {
    cacheDirectory: join(noCacheRoot, "plans"), reelDirectory: join(noCacheRoot, "reels"), outputDirectory: join(noCacheRoot, "output"),
    runExistingCommand: recordCommand,
    callPlanner: async () => { uncachedCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  });
  equal(uncachedCalls, 1, "uncached handoff invokes planner exactly once");

  let forcedCalls = 0;
  await runReelIntegration(handoff, {
    cacheDirectory, reelDirectory, outputDirectory, forcePlan: true, runExistingCommand: recordCommand,
    callPlanner: async () => { forcedCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  });
  equal(forcedCalls, 1, "force plan invokes planner despite a cache entry");

  commands.length = 0;
  let renderCalls = 0;
  const rendered = await runReelIntegration(handoff, {
    cacheDirectory, reelDirectory, outputDirectory, render: true, runExistingCommand: recordCommand,
    callPlanner: async () => { renderCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  });
  equal(renderCalls, 0, "rendering a cached plan does not invoke planner");
  equal(commands.map(([name]) => name).join(","), "qc,render", "render follows successful QC");
  equal(rendered.renderPath, resolveRenderOutputPath(handoff.canonicalId, handoff.title, outputDirectory), "integration reports the actual title-based render path");
  equal(rendered.socialPath, resolveSocialOutputPath(handoff.canonicalId, handoff.title, outputDirectory), "integration reports the matching social-copy path");
  truthy((await readFile(rendered.socialPath!, "utf8")).includes(STARRY_NIGHT_MOCK_PLAN.centralIdea), "successful single-Reel render writes social copy from the accepted plan");

  let invalidCalls = 0;
  await rejects(() => runReelIntegration({ ...handoff, title: "" }, {
    cacheDirectory, reelDirectory, outputDirectory, runExistingCommand: recordCommand,
    callPlanner: async () => { invalidCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  }), "invalid handoff fails before planner");
  equal(invalidCalls, 0, "invalid handoff does not invoke planner");

  let ineligibleCalls = 0;
  await rejects(() => runReelIntegration({ ...handoff, imageWidth: 800, imageHeight: 800 }, {
    cacheDirectory, reelDirectory, outputDirectory, runExistingCommand: recordCommand,
    callPlanner: async () => { ineligibleCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
  }), "ineligible handoff fails before planner");
  equal(ineligibleCalls, 0, "ineligible handoff does not invoke planner");

  const fallbackRoot = await mkdtemp(join(tmpdir(), "artfolio-reel-fallback-"));
  let fallbackCompilerCalls = 0;
  let fallbackOutputCommands = 0;
  await rejects(() => runReelIntegration(handoff, {
    cacheDirectory: join(fallbackRoot, "plans"), reelDirectory: join(fallbackRoot, "reels"), outputDirectory: join(fallbackRoot, "output"),
    callPlanner: async () => ({ plan: STARRY_NIGHT_MOCK_PLAN, fallback: true }),
    compile: () => { fallbackCompilerCalls += 1; throw new Error("fallback should not compile"); },
    runExistingCommand: () => { fallbackOutputCommands += 1; },
  }), "explicit fallback plan stops before compilation");
  equal(fallbackCompilerCalls, 0, "fallback plan never reaches compiler");
  equal(fallbackOutputCommands, 0, "fallback plan never reaches QC/render");

  let cachedFallbackPlannerCalls = 0;
  await rejects(() => runReelIntegration(handoff, {
    cacheDirectory: join(fallbackRoot, "plans"), reelDirectory: join(fallbackRoot, "reels"), outputDirectory: join(fallbackRoot, "output"),
    callPlanner: async () => { cachedFallbackPlannerCalls += 1; return STARRY_NIGHT_MOCK_PLAN; },
    runExistingCommand: () => { fallbackOutputCommands += 1; },
  }), "cached explicit fallback remains rejected");
  equal(cachedFallbackPlannerCalls, 0, "cached fallback does not invoke the planner");

  let compilerCommands = 0;
  await rejects(() => runReelIntegration(handoff, {
    cacheDirectory, reelDirectory, outputDirectory, forcePlan: true,
    compile: () => { throw new Error("compiler failure"); },
    runExistingCommand: () => { compilerCommands += 1; },
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN,
  }), "compiler failure stops before QC/render");
  equal(compilerCommands, 0, "compiler failure does not invoke output commands");

  const failedCommands: string[] = [];
  await rejects(() => runReelIntegration(handoff, {
    cacheDirectory, reelDirectory, outputDirectory, render: true,
    runExistingCommand: (name) => { failedCommands.push(name); if (name === "qc") throw new Error("QC failure"); },
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN,
  }), "QC failure stops before render");
  equal(failedCommands.join(","), "qc", "QC failure does not invoke render");
  truthy(cached.reelPath.endsWith("integration-starry-night.json"), "canonical ID determines reel output path");
  console.log("Reel integration tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
