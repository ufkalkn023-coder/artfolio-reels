import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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
