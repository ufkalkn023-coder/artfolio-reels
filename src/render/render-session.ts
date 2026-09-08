import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type HeadlessBrowser,
} from "@remotion/renderer";
import { type VideoConfig } from "remotion/no-react";

const CHROMIUM_OPTIONS = {} as const;

export const PRODUCTION_RENDER_OPTIONS = {
  codec: "h264",
  imageFormat: "jpeg",
  jpegQuality: 80,
  pixelFormat: "yuv420p",
  crf: 18,
  x264Preset: "medium",
  audioCodec: "aac",
  colorSpace: "default",
  scale: 1,
  muted: false,
  enforceAudioTrack: false,
  preferLossless: false,
} as const;

export type RenderSource = {
  compositionId: string;
  inputProps?: Record<string, unknown>;
};

export type RenderStillRequest = {
  frame: number;
  output: string;
  imageFormat?: "jpeg" | "png";
  jpegQuality?: number;
  overwrite?: boolean;
};

export type RenderVideoRequest = {
  output: string;
  overwrite: boolean;
};

export type SelectedRenderSource = {
  renderStill: (request: RenderStillRequest) => Promise<void>;
  renderVideo: (request: RenderVideoRequest) => Promise<void>;
};

export type RenderSession = {
  selectSource: (source: RenderSource) => Promise<SelectedRenderSource>;
  close: () => Promise<void>;
};

type SelectCompositionRequest = RenderSource & {
  browser: unknown;
  serveUrl: string;
  envVariables: Record<string, string>;
};
type StillRendererRequest = RenderStillRequest & RenderSource & {
  browser: unknown;
  composition: unknown;
  serveUrl: string;
  envVariables: Record<string, string>;
};
type MediaRendererRequest = RenderVideoRequest & RenderSource & {
  browser: unknown;
  composition: unknown;
  serveUrl: string;
  envVariables: Record<string, string>;
};

export type RenderSessionDependencies = {
  createBundle: (onDirectoryCreated: (directory: string) => void) => Promise<string>;
  openBrowser: () => Promise<unknown>;
  selectComposition: (request: SelectCompositionRequest) => Promise<unknown>;
  renderStill: (request: StillRendererRequest) => Promise<void>;
  renderMedia: (request: MediaRendererRequest) => Promise<void>;
  closeBrowser: (browser: unknown) => Promise<void>;
  removeBundleDirectory: (directory: string) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
};

type CreateRenderSessionOptions = {
  dependencies?: Partial<RenderSessionDependencies>;
};

const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)}s`;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const remotionEnvironment = (): Record<string, string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith("REMOTION_") && entry[1] !== undefined),
  );
  const envPath = [resolve(".env"), resolve(".env.local")].find(existsSync);
  if (!envPath) return environment;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
    if (name.startsWith("REMOTION_") && value !== undefined) environment[name] = value;
  }
  return environment;
};

const defaultDependencies: RenderSessionDependencies = {
  createBundle: (onDirectoryCreated) => bundle({
    entryPoint: resolve("src/index.ts"),
    rspack: true,
    onDirectoryCreated,
  }),
  openBrowser: () => openBrowser("chrome", { chromiumOptions: CHROMIUM_OPTIONS, chromeMode: "headless-shell" }),
  selectComposition: async ({ browser, serveUrl, compositionId, inputProps, envVariables }) => selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
    envVariables,
    puppeteerInstance: browser as HeadlessBrowser,
    chromiumOptions: CHROMIUM_OPTIONS,
    chromeMode: "headless-shell",
  }),
  renderStill: async ({ browser, composition, serveUrl, inputProps, envVariables, frame, output, imageFormat = "png", jpegQuality, overwrite = true }) => {
    await renderStill({
      serveUrl,
      composition: composition as VideoConfig,
      inputProps,
      envVariables,
      puppeteerInstance: browser as HeadlessBrowser,
      chromiumOptions: CHROMIUM_OPTIONS,
      chromeMode: "headless-shell",
      frame,
      output,
      imageFormat,
      jpegQuality,
      overwrite,
      scale: 1,
    });
  },
  renderMedia: async ({ browser, composition, serveUrl, inputProps, envVariables, output, overwrite }) => {
    await renderMedia({
      serveUrl,
      composition: composition as VideoConfig,
      inputProps,
      envVariables,
      puppeteerInstance: browser as HeadlessBrowser,
      chromiumOptions: CHROMIUM_OPTIONS,
      chromeMode: "headless-shell",
      outputLocation: output,
      overwrite,
      ...PRODUCTION_RENDER_OPTIONS,
    });
  },
  closeBrowser: async (browser) => {
    await (browser as HeadlessBrowser).close({ silent: false });
  },
  removeBundleDirectory: async (directory) => {
    await rm(directory, { recursive: true, force: true });
  },
  now: () => performance.now(),
  log: (message) => console.info(message),
};

const mergeDependencies = (overrides: Partial<RenderSessionDependencies> | undefined): RenderSessionDependencies => ({
  ...defaultDependencies,
  ...overrides,
});

export const createRenderSession = async (options: CreateRenderSessionOptions = {}): Promise<RenderSession> => {
  const dependencies = mergeDependencies(options.dependencies);
  const envVariables = remotionEnvironment();
  const sessionStarted = dependencies.now();
  let bundleDirectory: string | undefined;
  let browser: unknown;
  let closed = false;

  const cleanup = async (): Promise<void> => {
    const cleanupErrors: string[] = [];
    if (browser) {
      try {
        await dependencies.closeBrowser(browser);
      } catch (error) {
        cleanupErrors.push(`browser: ${errorMessage(error)}`);
      }
      browser = undefined;
    }
    if (bundleDirectory) {
      try {
        await dependencies.removeBundleDirectory(bundleDirectory);
      } catch (error) {
        cleanupErrors.push(`bundle directory ${bundleDirectory}: ${errorMessage(error)}`);
      }
      bundleDirectory = undefined;
    }
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  };

  try {
    const bundleStarted = dependencies.now();
    const serveUrl = await dependencies.createBundle((directory) => {
      bundleDirectory = directory;
    });
    bundleDirectory ??= serveUrl;
    dependencies.log(`[render-session] bundle: ${seconds(dependencies.now() - bundleStarted)}`);
    browser = await dependencies.openBrowser();
    dependencies.log(`[render-session] initialized: ${seconds(dependencies.now() - sessionStarted)}`);

    const assertOpen = (): { browser: unknown; bundleDirectory: string } => {
      if (closed || !browser || !bundleDirectory) throw new Error("Render session is closed");
      return { browser, bundleDirectory };
    };

    return {
      selectSource: async ({ compositionId, inputProps }) => {
        const active = assertOpen();
        const composition = await dependencies.selectComposition({
          compositionId,
          inputProps,
          browser: active.browser,
          serveUrl,
          envVariables,
        });
        return {
          renderStill: async (request) => {
            const current = assertOpen();
            await dependencies.renderStill({
              ...request,
              compositionId,
              inputProps,
              browser: current.browser,
              composition,
              serveUrl,
              envVariables,
            });
          },
          renderVideo: async (request) => {
            const current = assertOpen();
            await dependencies.renderMedia({
              ...request,
              compositionId,
              inputProps,
              browser: current.browser,
              composition,
              serveUrl,
              envVariables,
            });
          },
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        let cleanupError: unknown;
        try {
          await cleanup();
        } catch (error) {
          cleanupError = error;
        }
        dependencies.log(`[render-session] total: ${seconds(dependencies.now() - sessionStarted)}`);
        if (cleanupError) throw cleanupError;
      },
    };
  } catch (error) {
    closed = true;
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new Error(`Could not initialize render session: ${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`);
    }
    throw new Error(`Could not initialize render session: ${errorMessage(error)}`);
  }
};

export const withRenderSession = async <T>(
  operation: (session: RenderSession) => Promise<T>,
  createSession: () => Promise<RenderSession> = createRenderSession,
): Promise<T> => {
  const session = await createSession();
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation(session);
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await session.close();
  } catch (error) {
    cleanupError = error;
  }

  if (operationError && cleanupError) throw new Error(`${errorMessage(operationError)} Cleanup also failed: ${errorMessage(cleanupError)}`);
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result as T;
};
