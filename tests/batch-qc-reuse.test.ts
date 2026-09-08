import { createBatchCommandRunner } from "../scripts/reels-batch";
import { type ExistingBatchCommand } from "../src/planner/batch";
import { type RenderSession } from "../src/render/render-session";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const main = async (): Promise<void> => {
  let setupCount = 0;
  let closeCount = 0;
  let qcCount = 0;
  let renderCount = 0;
  const sessions: RenderSession[] = [];
  const createCommand = (received: RenderSession): ExistingBatchCommand => async (name) => {
    const sessionIndex = sessions.indexOf(received);
    if (name === "qc") {
      equal(sessionIndex, 0, "all QC commands use the first shared session");
      qcCount += 1;
    } else {
      equal(sessionIndex, 1, "all final renders use the second shared session");
      renderCount += 1;
    }
  };
  const commands = createBatchCommandRunner({
    createSession: async () => {
      setupCount += 1;
      const session: RenderSession = {
        selectSource: async () => ({ renderStill: async () => undefined, renderVideo: async () => undefined }),
        close: async () => { closeCount += 1; },
      };
      sessions.push(session);
      return session;
    },
    createCommand,
  });
  await commands.run("qc", "reel-1");
  await commands.run("qc", "reel-2");
  await commands.run("render", "reel-1");
  await commands.close();
  equal(setupCount, 2, "a QC-and-render batch creates at most two bundle/browser sessions");
  equal(qcCount, 2, "N candidate QC runs share the first session");
  equal(renderCount, 1, "M final renders share the second session");
  equal(closeCount, 2, "both bounded sessions close exactly once");
  console.log("Batch QC/final-render session reuse test passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
