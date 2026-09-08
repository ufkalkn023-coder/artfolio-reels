import {
  createRenderSession,
  PRODUCTION_RENDER_OPTIONS,
  withRenderSession,
  type RenderSessionDependencies,
} from "../src/render/render-session";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<string> => {
  try { await operation(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error(`${label}: expected an error`);
};

type State = {
  bundles: number;
  browsers: number;
  selections: number;
  stills: number;
  videos: number;
  browserCloses: number;
  bundleRemovals: number;
  logs: string[];
  selectedEnvironments: Array<Record<string, string>>;
};

const newState = (): State => ({
  bundles: 0, browsers: 0, selections: 0, stills: 0, videos: 0,
  browserCloses: 0, bundleRemovals: 0, logs: [], selectedEnvironments: [],
});

const fakeDependencies = (state: State): RenderSessionDependencies => {
  let clock = 0;
  return {
    createBundle: async (onDirectoryCreated) => {
      state.bundles += 1;
      onDirectoryCreated("/tmp/render-session-bundle");
      return "/tmp/render-session-bundle";
    },
    openBrowser: async () => { state.browsers += 1; return { id: "browser" }; },
    selectComposition: async ({ compositionId, envVariables }) => {
      state.selections += 1;
      state.selectedEnvironments.push(envVariables);
      return { id: compositionId };
    },
    renderStill: async () => { state.stills += 1; },
    renderMedia: async () => { state.videos += 1; },
    closeBrowser: async () => { state.browserCloses += 1; },
    removeBundleDirectory: async () => { state.bundleRemovals += 1; },
    now: () => { clock += 100; return clock; },
    log: (message) => state.logs.push(message),
  };
};

const main = async (): Promise<void> => {
  process.env.REMOTION_RENDER_SESSION_TEST = "forwarded";
  const state = newState();
  const session = await createRenderSession({ dependencies: fakeDependencies(state) });
  const qcSource = await session.selectSource({ compositionId: "ArtfolioV2-PlannedReel", inputProps: { phase: "visual-qc" } });
  await qcSource.renderStill({ frame: 12, output: "/tmp/qc-1.png" });
  await qcSource.renderStill({ frame: 24, output: "/tmp/qc-2.png" });
  const renderSource = await session.selectSource({ compositionId: "ArtfolioV2-PlannedReel", inputProps: { phase: "post-qc-audio" } });
  await renderSource.renderVideo({ output: "/tmp/reel.mp4", overwrite: false });
  equal(state.bundles, 1, "session creates one bundle");
  equal(state.browsers, 1, "session opens one browser");
  equal(state.selections, 2, "QC and post-QC render select composition metadata independently");
  equal(state.stills, 2, "one QC selection serves multiple checkpoints");
  equal(state.videos, 1, "video renders in the shared session");
  equal(state.selectedEnvironments[0].REMOTION_RENDER_SESSION_TEST, "forwarded", "REMOTION environment reaches composition selection");
  await session.close();
  await session.close();
  equal(state.browserCloses, 1, "idempotent close closes the browser once");
  equal(state.bundleRemovals, 1, "idempotent close removes the bundle once");
  truthy(state.logs.some((message) => message.includes("bundle:")), "bundle timing is logged");
  truthy(state.logs.some((message) => message.includes("initialized:")), "initialization timing is logged");
  truthy(state.logs.some((message) => message.includes("total:")), "session lifetime is logged");
  delete process.env.REMOTION_RENDER_SESSION_TEST;

  equal(PRODUCTION_RENDER_OPTIONS.codec, "h264", "production codec remains H.264");
  equal(PRODUCTION_RENDER_OPTIONS.imageFormat, "jpeg", "video frame format preserves remotion.config.ts");
  equal(PRODUCTION_RENDER_OPTIONS.jpegQuality, 80, "JPEG quality preserves the CLI default");
  equal(PRODUCTION_RENDER_OPTIONS.pixelFormat, "yuv420p", "pixel format preserves the CLI default");
  equal(PRODUCTION_RENDER_OPTIONS.crf, 18, "CRF preserves the H.264 CLI default");
  equal(PRODUCTION_RENDER_OPTIONS.x264Preset, "medium", "encoding preset preserves the CLI default");
  equal(PRODUCTION_RENDER_OPTIONS.audioCodec, "aac", "audio codec preserves the H.264 CLI default");
  equal(PRODUCTION_RENDER_OPTIONS.colorSpace, "default", "Remotion v4 color space remains default");
  equal(PRODUCTION_RENDER_OPTIONS.scale, 1, "render scale remains one");
  equal(PRODUCTION_RENDER_OPTIONS.muted, false, "audio remains enabled");

  const managedState = newState();
  await withRenderSession(async (managed) => {
    await managed.selectSource({ compositionId: "managed" });
  }, () => createRenderSession({ dependencies: fakeDependencies(managedState) }));
  equal(managedState.browserCloses, 1, "managed session closes after success");

  let exceptionalCloseCount = 0;
  const failure = await rejects(() => withRenderSession(async () => {
    throw new Error("operation failed");
  }, async () => ({
    selectSource: async () => { throw new Error("unused"); },
    close: async () => { exceptionalCloseCount += 1; },
  })), "managed operation failure is surfaced");
  truthy(failure.includes("operation failed"), "operation error context is preserved");
  equal(exceptionalCloseCount, 1, "managed session closes after failure");

  const initializationState = newState();
  const initializationFailure = await rejects(() => createRenderSession({
    dependencies: {
      ...fakeDependencies(initializationState),
      openBrowser: async () => { throw new Error("browser failed"); },
    },
  }), "initialization failure is surfaced");
  truthy(initializationFailure.includes("browser failed"), "initialization error context is preserved");
  equal(initializationState.bundleRemovals, 1, "failed initialization removes its bundle");

  console.log("Render session lifecycle and contract tests passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
