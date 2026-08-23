import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyReelProductionHistory,
  loadReelProductionHistory,
  productionHistoryExcludedCanonicalIds,
  productionHistoryForPortfolio,
  recordProductionHistory,
  writeReelProductionHistory,
} from "../src/planner/production-history";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-reel-history-"));
  const path = join(root, "reel-production-history.json");
  const empty = await loadReelProductionHistory(path);
  equal(empty.entries.length, 0, "missing history loads as empty");

  const input = {
    canonicalId: "met_history", artist: "History Artist", museum: "History Museum", source: "met",
    template: "one-artwork", plannerVersion: 1, batchId: "batch-history", completedAt: "2026-08-23T00:00:00.000Z", duration: 24,
  };
  const qc = await recordProductionHistory(path, empty, { ...input, status: "QC_PASSED" });
  equal(qc.entry.status, "QC_PASSED", "QC success is recorded");
  equal((await loadReelProductionHistory(path)).entries.length, 1, "valid history reloads");
  truthy(!JSON.stringify(qc.history).includes("GEMINI_API_KEY"), "ledger has no secrets");

  const rerun = await recordProductionHistory(path, qc.history, { ...input, status: "QC_PASSED" });
  equal(rerun.history.entries.length, 1, "same production event is idempotent");
  equal(rerun.changed, false, "same QC production event does not rewrite history");
  const rendered = await recordProductionHistory(path, rerun.history, {
    ...input, status: "RENDERED", completedAt: "2026-08-23T00:01:00.000Z", renderPath: "/safe/output/met_history.mp4",
  });
  equal(rendered.entry.status, "RENDERED", "successful render upgrades QC entry");
  equal(rendered.transition, "QC_PASSED→RENDERED", "upgrade is explicit");
  const noDowngrade = await recordProductionHistory(path, rendered.history, { ...input, status: "QC_PASSED" });
  equal(noDowngrade.entry.status, "RENDERED", "rendered entry never downgrades");
  equal(noDowngrade.changed, false, "downgrade does not rewrite ledger");
  equal(productionHistoryForPortfolio(rendered.history)[0].canonicalId, "met_history", "portfolio receives canonical history");
  equal(productionHistoryExcludedCanonicalIds(rendered.history).join(","), "met_history", "successful production history exports canonical exclusion IDs");

  await writeReelProductionHistory(path, emptyReelProductionHistory());
  truthy((await readdir(root)).every((name) => !name.endsWith(".tmp")), "atomic write leaves no temporary file");
  await writeFile(path, "{not json", "utf8");
  let corruptFailed = false;
  try { await loadReelProductionHistory(path); } catch { corruptFailed = true; }
  truthy(corruptFailed, "corrupt history fails closed");
  equal((await readFile(path, "utf8")), "{not json", "corrupt history is never overwritten");
  console.log("Production history tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
