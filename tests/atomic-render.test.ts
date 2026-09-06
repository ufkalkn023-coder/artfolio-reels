import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAtomically } from "../src/planner/atomic-render";

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

console.log("Atomic render tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
