import { createBatchCommandRunner } from "../scripts/reels-batch";
import { type QcRenderResources } from "../scripts/qc-rendering";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const main = async (): Promise<void> => {
  let bundleBrowserSetupCount = 0;
  let closeCount = 0;
  let qcCount = 0;
  let renderCount = 0;
  const resources: QcRenderResources = {
    createSession: async () => ({ renderStill: async () => undefined, close: async () => undefined }),
    close: async () => { closeCount += 1; },
  };
  const commands = createBatchCommandRunner({
    createResources: async () => { bundleBrowserSetupCount += 1; return resources; },
    runQc: async (_reelId, options = {}) => {
      if (options.resources !== resources) throw new Error("shared resources were not forwarded");
      qcCount += 1;
      return { retention: "summary", retainedCount: 2, cleanedCount: 10 };
    },
    runNpm: async () => { renderCount += 1; },
  });
  await commands.run("qc", "reel-1");
  await commands.run("qc", "reel-2");
  await commands.run("render", "reel-1");
  await commands.close();
  equal(bundleBrowserSetupCount, 1, "N batch candidates create one Remotion bundle/browser resource set");
  equal(qcCount, 2, "both candidate QC runs use the shared resource set");
  equal(renderCount, 1, "render remains isolated in its existing command");
  equal(closeCount, 1, "shared batch QC resources close once");
  console.log("Batch QC bundle/browser reuse test passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
