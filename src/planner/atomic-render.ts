import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { assertRenderDestinationWritable } from "./render-path";

export type AtomicRenderOptions = {
  destination: string;
  overwrite: boolean;
  render: (temporaryPath: string) => Promise<void> | void;
  validate: (temporaryPath: string) => Promise<void> | void;
  temporaryId?: string;
};

/** Create the render candidate beside its final destination so promotion is a same-filesystem rename. */
export const temporaryRenderPathFor = (destination: string, temporaryId: string = randomUUID()): string => {
  const extension = extname(destination) || ".mp4";
  return join(dirname(destination), `.tmp-${temporaryId}-${basename(destination, extension)}${extension}`);
};

export const STALE_RENDER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOGNIZED_RENDER_TEMP = /^\.tmp-[A-Za-z0-9-]+-.+\.mp4$/;

export const cleanupStaleRenderTemps = async (
  renderDirectory: string,
  options: { nowMs?: number; maxAgeMs?: number } = {},
): Promise<string[]> => {
  const directory = resolve(renderDirectory);
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_RENDER_TEMP_MAX_AGE_MS;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !RECOGNIZED_RENDER_TEMP.test(entry.name)) continue;
    const candidate = resolve(directory, entry.name);
    const contained = relative(directory, candidate);
    if (!contained || contained === ".." || contained.startsWith(`..${sep}`)) continue;
    const details = await stat(candidate);
    if (nowMs - details.mtimeMs <= maxAgeMs) continue;
    await unlink(candidate);
    removed.push(candidate);
  }
  return removed;
};

export const renderAtomically = async ({
  destination,
  overwrite,
  render,
  validate,
  temporaryId,
}: AtomicRenderOptions): Promise<string> => {
  assertRenderDestinationWritable(destination, overwrite);
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = temporaryRenderPathFor(destination, temporaryId);
  try {
    await render(temporaryPath);
    await validate(temporaryPath);
    // Preserve no-overwrite behavior if another process created the target while rendering.
    assertRenderDestinationWritable(destination, overwrite);
    await rename(temporaryPath, destination);
    return destination;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};
