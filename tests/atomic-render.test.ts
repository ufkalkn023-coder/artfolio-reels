import { access, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleRenderTemps, renderAtomically } from "../src/planner/atomic-render";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const rejects = async (operation: () => Promise<unknown>, label: string): Promise<void> => {
  try { await operation(); } catch { return; }
  throw new Error(`${label}: expected rejection`);
};
const missing = async (path: string, label: string): Promise<void> => {
  try { await access(path); } catch { return; }
  throw new Error(`${label}: expected no file`);
};

const run = async (): Promise<void> => {
const root = await mkdtemp(join(tmpdir(), "artfolio-atomic-render-"));
const destination = join(root, "renders", "reel.mp4");
await renderAtomically({
  destination,
  overwrite: false,
  temporaryId: "success",
  render: (temporaryPath) => writeFile(temporaryPath, "validated-render"),
  validate: async (temporaryPath) => equal(await readFile(temporaryPath, "utf8"), "validated-render", "validator reads temporary render"),
});
equal(await readFile(destination, "utf8"), "validated-render", "successful render is atomically promoted");

const failedDestination = join(root, "renders", "failed.mp4");
await rejects(() => renderAtomically({
  destination: failedDestination,
  overwrite: false,
  temporaryId: "fresh-render-failure",
  render: async (temporaryPath) => { await writeFile(temporaryPath, "broken"); throw new Error("render failed"); },
  validate: () => undefined,
}), "fresh render failure");
await missing(failedDestination, "failed render leaves no final artifact");

await writeFile(destination, "known-good");
await rejects(() => renderAtomically({
  destination,
  overwrite: true,
  temporaryId: "render-failure",
  render: async (temporaryPath) => { await writeFile(temporaryPath, "broken"); throw new Error("render failed"); },
  validate: () => undefined,
}), "render failure");
equal(await readFile(destination, "utf8"), "known-good", "render failure preserves existing final");

await rejects(() => renderAtomically({
  destination,
  overwrite: true,
  temporaryId: "validation-failure",
  render: (temporaryPath) => writeFile(temporaryPath, "invalid"),
  validate: () => { throw new Error("validation failed"); },
}), "validation failure");
equal(await readFile(destination, "utf8"), "known-good", "validation failure preserves existing final");

await renderAtomically({
  destination,
  overwrite: true,
  temporaryId: "replacement",
  render: (temporaryPath) => writeFile(temporaryPath, "replacement"),
  validate: () => undefined,
});
equal(await readFile(destination, "utf8"), "replacement", "overwrite promotes only the validated replacement");
equal((await readdir(join(root, "renders"))).some((name) => name.startsWith(".tmp-")), false, "temporary renders are cleaned up");

const rendersDirectory = join(root, "renders");
const oldTemp = join(rendersDirectory, ".tmp-deadbeef-orphan.mp4");
const freshTemp = join(rendersDirectory, ".tmp-fresh-active.mp4");
const unrelated = join(rendersDirectory, ".unrelated-hidden.mp4");
await Promise.all([writeFile(oldTemp, "old"), writeFile(freshTemp, "fresh"), writeFile(unrelated, "unrelated")]);
const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
await utimes(oldTemp, new Date(nowMs - 25 * 60 * 60 * 1000), new Date(nowMs - 25 * 60 * 60 * 1000));
await utimes(freshTemp, new Date(nowMs - 60 * 60 * 1000), new Date(nowMs - 60 * 60 * 1000));
await utimes(unrelated, new Date(nowMs - 48 * 60 * 60 * 1000), new Date(nowMs - 48 * 60 * 60 * 1000));
const cleaned = await cleanupStaleRenderTemps(rendersDirectory, { nowMs });
equal(cleaned.length, 1, "only old recognized render temp is removed");
equal(cleaned[0], oldTemp, "recognized orphan temp is reported");
await missing(oldTemp, "old recognized temp");
equal(await readFile(freshTemp, "utf8"), "fresh", "fresh render temp is preserved");
equal(await readFile(unrelated, "utf8"), "unrelated", "unrelated hidden file is preserved");
equal(await readFile(destination, "utf8"), "replacement", "final MP4 is preserved by stale cleanup");

console.log("Atomic render tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
