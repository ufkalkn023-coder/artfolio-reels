import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { VIDEO } from "../v2/design";

export type RenderProbe = {
  durationSeconds: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
  };
  audio?: {
    codec: string;
  };
};

export type RenderExpectations = {
  durationSeconds?: number;
  requireAudio?: boolean;
  durationToleranceSeconds?: number;
};

export type RenderVerification = RenderProbe & {
  path: string;
  sizeBytes: number;
  deep: boolean;
  maxVolumeDb?: number;
};

export type RenderVerificationDependencies = {
  probe?: (path: string) => Promise<RenderProbe>;
  decode?: (path: string) => Promise<void>;
  measureAudio?: (path: string) => Promise<number>;
};

type ProcessOutput = { stdout: string; stderr: string };

const runProcess = async (command: string, args: readonly string[]): Promise<ProcessOutput> => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString();
    if (next.length > 2 * 1024 * 1024) {
      child.kill();
      reject(new Error(`${command} output exceeded 2 MiB`));
    }
    return next;
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} exited with status ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
  });
});

const parseFps = (value: string | undefined): number => {
  if (!value) return Number.NaN;
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
};

export const probeRenderMedia = async (path: string): Promise<RenderProbe> => {
  const { stdout } = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration",
    "-of", "json",
    path,
  ]);
  const inspected = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const video = inspected.streams?.find((stream) => stream.codec_type === "video");
  const audio = inspected.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("MP4 has no video stream");
  const durationSeconds = Number(inspected.format?.duration);
  return {
    durationSeconds,
    video: {
      codec: video.codec_name ?? "",
      width: video.width ?? 0,
      height: video.height ?? 0,
      fps: parseFps(video.r_frame_rate),
    },
    ...(audio ? { audio: { codec: audio.codec_name ?? "" } } : {}),
  };
};

const decodeRenderMedia = async (path: string): Promise<void> => {
  await runProcess("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"]);
};

const measureAudio = async (path: string): Promise<number> => {
  const { stdout, stderr } = await runProcess("ffmpeg", [
    "-nostats", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
  ]);
  const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(`${stdout}\n${stderr}`);
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
};

export const verifyRenderMedia = async (
  path: string,
  expectations: RenderExpectations = {},
  options: { deep?: boolean; dependencies?: RenderVerificationDependencies } = {},
): Promise<RenderVerification> => {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0) throw new Error("MP4 is empty or not a regular file");
  const dependencies = options.dependencies ?? {};
  const inspected = await (dependencies.probe ?? probeRenderMedia)(path);
  if (inspected.video.codec !== "h264") throw new Error(`Expected H.264 video, received ${inspected.video.codec || "unknown"}`);
  if (inspected.video.width !== VIDEO.width || inspected.video.height !== VIDEO.height) {
    throw new Error(`Expected ${VIDEO.width}x${VIDEO.height}, received ${inspected.video.width}x${inspected.video.height}`);
  }
  if (!Number.isFinite(inspected.video.fps) || Math.abs(inspected.video.fps - VIDEO.fps) > 0.01) {
    throw new Error(`Expected ${VIDEO.fps} FPS, received ${String(inspected.video.fps)}`);
  }
  if (!Number.isFinite(inspected.durationSeconds) || inspected.durationSeconds <= 0 || inspected.durationSeconds > 60.5) {
    throw new Error(`MP4 duration is not sane: ${String(inspected.durationSeconds)}`);
  }
  if (expectations.durationSeconds !== undefined) {
    const tolerance = expectations.durationToleranceSeconds ?? 0.1;
    if (Math.abs(inspected.durationSeconds - expectations.durationSeconds) > tolerance) {
      throw new Error(`Expected duration ${expectations.durationSeconds.toFixed(3)}s, received ${inspected.durationSeconds.toFixed(3)}s`);
    }
  }
  if (expectations.requireAudio && !inspected.audio) throw new Error("Selected music requires an audio stream");

  let maxVolumeDb: number | undefined;
  if (options.deep) {
    await (dependencies.decode ?? decodeRenderMedia)(path);
    if (expectations.requireAudio) {
      maxVolumeDb = await (dependencies.measureAudio ?? measureAudio)(path);
      if (!Number.isFinite(maxVolumeDb) || maxVolumeDb <= -90) throw new Error("Selected music audio is silent or inaudible");
    }
  }
  return {
    path,
    sizeBytes: file.size,
    ...inspected,
    deep: options.deep ?? false,
    ...(maxVolumeDb !== undefined ? { maxVolumeDb } : {}),
  };
};
