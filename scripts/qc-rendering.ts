import { resolve } from "node:path";
import {
  createRenderSession,
  type RenderSession,
  type SelectedRenderSource,
} from "../src/render/render-session";
import { type QcCheckpoint } from "../src/v2/qc";

export type QcStillRequest = {
  checkpoint: QcCheckpoint;
  output: string;
};

export type QcRenderSession = {
  renderStill: (request: QcStillRequest) => Promise<void>;
  close: () => Promise<void>;
};

type RenderQcCheckpointsOptions = {
  checkpoints: readonly QcCheckpoint[];
  directory: string;
  createSession?: () => Promise<QcRenderSession>;
  session?: QcRenderSession;
};

type CreateRemotionQcSessionOptions = {
  compositionId: string;
  inputProps?: Record<string, unknown>;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const renderQcCheckpoints = async ({
  checkpoints,
  directory,
  createSession,
  session: providedSession,
}: RenderQcCheckpointsOptions): Promise<void> => {
  if (providedSession && createSession) throw new Error("Provide either a QC render session or a session factory, not both");
  if (!providedSession && !createSession) throw new Error("A QC render session or session factory is required");
  const session = providedSession ?? await createSession!();
  const ownsSession = !providedSession;
  let renderError: Error | undefined;
  let cleanupError: Error | undefined;

  try {
    for (const checkpoint of checkpoints) {
      const output = resolve(directory, checkpoint.filename);
      try {
        await session.renderStill({ checkpoint, output });
      } catch (error) {
        renderError = new Error(
          `Could not render QC checkpoint "${checkpoint.id}" at frame ${checkpoint.absoluteFrame} to ${output}: ${errorMessage(error)}`,
        );
        break;
      }
    }
  } finally {
    if (ownsSession) {
      try {
        await session.close();
      } catch (error) {
        cleanupError = new Error(`Could not close QC rendering resources: ${errorMessage(error)}`);
      }
    }
  }

  if (renderError && cleanupError) throw new Error(`${renderError.message} Cleanup also failed: ${cleanupError.message}`);
  if (cleanupError) throw cleanupError;
  if (renderError) throw renderError;
};

const qcSessionFromSource = (
  source: SelectedRenderSource,
  close: () => Promise<void> = async () => undefined,
): QcRenderSession => ({
  renderStill: async ({ checkpoint, output }) => {
    await source.renderStill({
      frame: checkpoint.absoluteFrame,
      output,
      imageFormat: "png",
      overwrite: true,
    });
  },
  close,
});

export const createQcRenderSession = async (
  renderSession: RenderSession,
  options: CreateRemotionQcSessionOptions,
): Promise<QcRenderSession> => qcSessionFromSource(await renderSession.selectSource(options));

export const createRemotionQcSession = async (
  options: CreateRemotionQcSessionOptions,
): Promise<QcRenderSession> => {
  const renderSession = await createRenderSession();
  try {
    const source = await renderSession.selectSource(options);
    return qcSessionFromSource(source, () => renderSession.close());
  } catch (error) {
    await renderSession.close().catch(() => undefined);
    throw error;
  }
};
