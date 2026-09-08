import { resolve } from "node:path";
import { type ExistingBatchCommand } from "../src/planner/batch";
import { createRenderSession, type RenderSession } from "../src/render/render-session";
import { runQcForReel } from "./qc";
import { renderReelVideo } from "./render-reel";

export const createReelOutputCommand = (
  session: RenderSession,
  outputDirectory = resolve("output"),
): ExistingBatchCommand => async (name, reelId) => {
  if (name === "qc") {
    const result = await runQcForReel(reelId, { outputDirectory, session });
    return { qcArtifactsRetained: result.retainedCount, qcArtifactsCleaned: result.cleanedCount };
  }
  await renderReelVideo({ reelId, outputDirectory, session });
};

export const createReelOutputRunner = (dependencies: {
  createSession?: () => Promise<RenderSession>;
  createCommand?: (session: RenderSession) => ExistingBatchCommand;
  outputDirectory?: string;
} = {}): { run: ExistingBatchCommand; close: () => Promise<void> } => {
  let qcSession: RenderSession | undefined;
  let qcCommand: ExistingBatchCommand | undefined;
  let renderSession: RenderSession | undefined;
  let renderCommand: ExistingBatchCommand | undefined;
  let renderPhaseStarted = false;
  const createSession = dependencies.createSession ?? createRenderSession;
  const createCommand = dependencies.createCommand ?? ((active: RenderSession) => createReelOutputCommand(active, dependencies.outputDirectory));
  const initializeQc = async (): Promise<ExistingBatchCommand> => {
    if (renderPhaseStarted) throw new Error("QC cannot run after the final-render session has started");
    if (qcCommand) return qcCommand;
    qcSession = await createSession();
    qcCommand = createCommand(qcSession);
    return qcCommand;
  };
  const initializeRender = async (): Promise<ExistingBatchCommand> => {
    if (renderCommand) return renderCommand;
    renderPhaseStarted = true;
    if (qcSession) {
      await qcSession.close();
      qcSession = undefined;
      qcCommand = undefined;
    }
    renderSession = await createSession();
    renderCommand = createCommand(renderSession);
    return renderCommand;
  };
  return {
    run: async (name, reelId) => (name === "qc" ? await initializeQc() : await initializeRender())(name, reelId),
    close: async () => {
      const errors: unknown[] = [];
      for (const session of [qcSession, renderSession]) {
        if (!session) continue;
        try { await session.close(); } catch (error) { errors.push(error); }
      }
      qcSession = undefined;
      renderSession = undefined;
      qcCommand = undefined;
      renderCommand = undefined;
      if (errors.length > 0) throw errors[0];
    },
  };
};
