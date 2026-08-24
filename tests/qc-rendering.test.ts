import { renderQcCheckpoints, type QcRenderSession, type QcStillRequest } from "../scripts/qc-rendering";
import { type QcCheckpoint } from "../src/v2/qc";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};

const checkpoints: QcCheckpoint[] = [
  { id: "first", filename: "first.png", sceneId: "intro", sceneKind: "intro", absoluteFrame: 19, localFrame: 19, phase: "early" },
  { id: "second", filename: "second.png", sceneId: "intro", sceneKind: "intro", absoluteFrame: 44, localFrame: 44, phase: "settled" },
  { id: "third", filename: "third.png", sceneId: "detail", sceneKind: "detail", absoluteFrame: 76, localFrame: 11, phase: "early" },
];

const main = async (): Promise<void> => {
  let setupCount = 0;
  let closeCount = 0;
  const requests: QcStillRequest[] = [];
  const session: QcRenderSession = {
    renderStill: async (request) => {
      requests.push(request);
    },
    close: async () => {
      closeCount += 1;
    },
  };

  await renderQcCheckpoints({
    checkpoints,
    directory: "/tmp/qc-test",
    createSession: async () => {
      setupCount += 1;
      return session;
    },
  });

  equal(setupCount, 1, "renderer setup happens once");
  equal(closeCount, 1, "renderer resources close once");
  equal(requests.length, checkpoints.length, "every checkpoint is forwarded once");
  equal(requests.map(({ checkpoint }) => checkpoint.id).join(","), "first,second,third", "checkpoint order is preserved");
  equal(requests.map(({ checkpoint }) => checkpoint.absoluteFrame).join(","), "19,44,76", "checkpoint frames are preserved");
  truthy(requests[0].output.endsWith("/first.png"), "first checkpoint filename is preserved");
  truthy(requests[2].output.endsWith("/third.png"), "last checkpoint filename is preserved");

  let failedCloseCount = 0;
  let failedRenderCount = 0;
  let failureMessage = "";
  try {
    await renderQcCheckpoints({
      checkpoints,
      directory: "/tmp/qc-test",
      createSession: async () => ({
        renderStill: async ({ checkpoint }) => {
          failedRenderCount += 1;
          if (checkpoint.id === "second") throw new Error("synthetic renderer failure");
        },
        close: async () => {
          failedCloseCount += 1;
        },
      }),
    });
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  equal(failedRenderCount, 2, "rendering stops at the first failed checkpoint");
  equal(failedCloseCount, 1, "resources close after a render failure");
  truthy(failureMessage.includes("second"), "render failure identifies the checkpoint");
  truthy(failureMessage.includes("frame 44"), "render failure identifies the frame");
  truthy(failureMessage.includes("synthetic renderer failure"), "render failure preserves renderer context");

  console.log("QC rendering orchestration tests passed");
};

void main();
