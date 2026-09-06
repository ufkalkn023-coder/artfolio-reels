import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginQcRun, finalizeSuccessfulQcRun, preserveFailedQcRun, resolveQcRetention } from "../src/qc/lifecycle";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };

const fillRun = async (root: string, id: string, runId: string) => {
  const run = await beginQcRun(root, id, runId);
  await Promise.all([
    writeFile(join(run.stagingDirectory, "scene-1.png"), "full still 1"),
    writeFile(join(run.stagingDirectory, "scene-2.png"), "full still 2"),
    writeFile(join(run.stagingDirectory, "contact-sheet.png"), "summary"),
  ]);
  return run;
};

const main = async (): Promise<void> => {
  equal(resolveQcRetention(undefined), "all", "retention defaults to backward-compatible all");
  equal(resolveQcRetention("SUMMARY"), "summary", "retention is normalized");

  const root = await mkdtemp(join(tmpdir(), "artfolio-qc-lifecycle-"));
  const all = await finalizeSuccessfulQcRun(await fillRun(root, "all-reel", "run-1"), "all", { reelId: "all-reel" });
  equal(all.retainedCount, 4, "all retention keeps stills, contact sheet, and metadata");
  equal(all.cleanedCount, 0, "all retention cleans no current artifacts");

  const summary = await finalizeSuccessfulQcRun(await fillRun(root, "summary-reel", "run-1"), "summary", { reelId: "summary-reel" });
  equal(summary.retainedCount, 2, "summary retention keeps contact sheet and metadata only");
  equal(summary.cleanedCount, 2, "summary retention removes full-resolution intermediates");
  equal((await readdir(join(root, "summary-reel"))).sort().join(","), "contact-sheet.png,qc-summary.json", "summary output is minimal and deterministic");

  await finalizeSuccessfulQcRun(await fillRun(root, "none-reel", "run-1"), "all", { reelId: "none-reel" });
  const none = await finalizeSuccessfulQcRun(await fillRun(root, "none-reel", "run-2"), "none", { reelId: "none-reel" });
  equal(none.retainedCount, 0, "none retention keeps no durable QC artifact");
  truthy(!existsSync(join(root, "none-reel")), "none retention removes an older successful QC directory");

  const failedRun = await fillRun(root, "failed-reel", "run-failed");
  const failureDirectory = await preserveFailedQcRun(failedRun);
  equal(await readFile(join(failureDirectory, "scene-1.png"), "utf8"), "full still 1", "failed QC preserves partial evidence");

  const first = await finalizeSuccessfulQcRun(await fillRun(root, "repeat-reel", "run-old"), "all", { reelId: "repeat-reel" });
  truthy(Boolean(first.directory), "first QC run is promoted");
  await writeFile(join(root, "repeat-reel", "stale-scene.png"), "stale");
  await finalizeSuccessfulQcRun(await fillRun(root, "repeat-reel", "run-new"), "summary", { reelId: "repeat-reel" });
  truthy(!existsSync(join(root, "repeat-reel", "stale-scene.png")), "stale Reel QC files cannot contaminate a new run");

  console.log("QC lifecycle and retention tests passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
