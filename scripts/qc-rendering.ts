import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderStill,
  selectComposition,
  type HeadlessBrowser,
} from "@remotion/renderer";
import { type VideoConfig } from "remotion/no-react";
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
  createSession: () => Promise<QcRenderSession>;
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
}: RenderQcCheckpointsOptions): Promise<void> => {
  const session = await createSession();
  let renderError: Error | undefined;

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
    try {
      await session.close();
    } catch (error) {
      const cleanupMessage = `Could not close QC rendering resources: ${errorMessage(error)}`;
      if (renderError) {
        throw new Error(`${renderError.message} Cleanup also failed: ${cleanupMessage}`);
      }
      throw new Error(cleanupMessage);
    }
  }

  if (renderError) throw renderError;
};

export const createRemotionQcSession = async ({
  compositionId,
  inputProps,
}: CreateRemotionQcSessionOptions): Promise<QcRenderSession> => {
  let bundleDirectory: string | undefined;
  let browser: HeadlessBrowser | undefined;

  const close = async (): Promise<void> => {
    const cleanupErrors: string[] = [];
    if (browser) {
      try {
        await browser.close({ silent: false });
      } catch (error) {
        cleanupErrors.push(`browser: ${errorMessage(error)}`);
      }
      browser = undefined;
    }
    if (bundleDirectory) {
      try {
        rmSync(bundleDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`bundle directory ${bundleDirectory}: ${errorMessage(error)}`);
      }
      bundleDirectory = undefined;
    }
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  };

  try {
    const serveUrl = await bundle({
      entryPoint: resolve("src/index.ts"),
      rspack: true,
      onDirectoryCreated: (directory) => {
        bundleDirectory = directory;
      },
    });
    bundleDirectory = serveUrl;
    browser = await openBrowser("chrome");
    const composition: VideoConfig = await selectComposition({
      serveUrl,
      id: compositionId,
      inputProps,
      puppeteerInstance: browser,
    });

    return {
      renderStill: async ({ checkpoint, output }) => {
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          puppeteerInstance: browser,
          frame: checkpoint.absoluteFrame,
          output,
          imageFormat: "png",
          overwrite: true,
        });
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new Error(
        `Could not initialize QC rendering: ${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`,
      );
    }
    throw new Error(`Could not initialize QC rendering: ${errorMessage(error)}`);
  }
};
