import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditProduction } from "../src/operations/production-audit";
import { getSampleReel } from "../src/v2/samples";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };

const snapshot = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await snapshot(path)).map((item) => `${entry.name}/${item}`));
    else if (entry.isFile()) output.push(`${entry.name}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return output;
};

const historyEntry = (canonicalId: string, renderPath: string) => ({
  canonicalId,
  artist: "Fixture Artist",
  museum: "Fixture Museum",
  source: "fixture",
  template: "inside-the-painting",
  batchId: `batch-${canonicalId}`,
  status: "RENDERED",
  qcPassedAt: "2026-09-07T00:00:00.000Z",
  renderedAt: "2026-09-07T00:00:00.000Z",
  renderPath,
  duration: 25,
});

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-production-audit-"));
  const reelDirectory = join(root, "data", "reels");
  const renderDirectory = join(root, "output", "renders");
  const socialDirectory = join(root, "output", "social");
  const qcDirectory = join(root, "output", "qc");
  await Promise.all([mkdir(reelDirectory, { recursive: true }), mkdir(renderDirectory, { recursive: true }), mkdir(socialDirectory, { recursive: true }), mkdir(qcDirectory, { recursive: true })]);
  const ids = ["audit-ok", "audit-missing", "audit-invalid", "audit-no-reel", "audit-no-social"];
  for (const id of ids.filter((candidate) => candidate !== "audit-no-reel")) {
    const reel = structuredClone(getSampleReel("inside-the-painting"));
    reel.id = id;
    reel.artworks[0].id = id;
    reel.artworks[0].title = `Artwork ${id}`;
    await writeFile(join(reelDirectory, `${id}.json`), JSON.stringify(reel));
  }
  for (const id of ["audit-ok", "audit-invalid", "audit-no-reel", "audit-no-social"]) {
    await writeFile(join(renderDirectory, `${id}-artwork.mp4`), id === "audit-invalid" ? "invalid" : "valid");
  }
  await writeFile(join(renderDirectory, "orphan-artwork.mp4"), "orphan");
  for (const id of ["audit-ok", "audit-missing", "audit-invalid", "audit-no-reel"]) {
    await writeFile(join(socialDirectory, `${id}-artwork.txt`), "caption");
  }
  for (const id of ids) {
    await mkdir(join(qcDirectory, id), { recursive: true });
    await writeFile(join(qcDirectory, id, "contact-sheet.png"), "qc");
  }

  const untrackedId = "audit-untracked-fixture";
  await mkdir(join(qcDirectory, untrackedId), { recursive: true });
  await writeFile(join(qcDirectory, untrackedId, "contact-sheet.png"), "qc");

  const historyPath = join(root, "data", "reel-production-history.json");
  const history = {
    version: "reel-production-history-v1",
    entries: ids.map((id) => historyEntry(id, join(renderDirectory, `${id}-historical.mp4`))),
  };
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  const verifyMedia = async (path: string, expectations: { durationSeconds?: number; requireAudio?: boolean } = {}, options: { deep?: boolean } = {}) => {
    if ((await readFile(path, "utf8")) === "invalid") throw new Error("mocked invalid metadata");
    return {
      path,
      sizeBytes: (await stat(path)).size,
      durationSeconds: expectations.durationSeconds ?? 25,
      video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
      deep: options.deep ?? false,
    };
  };
  const before = await snapshot(root);
  const historyBefore = await readFile(historyPath, "utf8");
  const report = await auditProduction({ rootDirectory: root, verifyMedia });
  const byId = new Map(report.items.map((item) => [item.reelId, item]));
  truthy(!byId.get("audit-ok")?.states.includes("MISSING_RENDER"), "history rendered plus real MP4 is filesystem-consistent");
  truthy(byId.get("audit-missing")?.states.includes("MISSING_RENDER"), "history rendered plus missing MP4 reports MISSING_RENDER");
  truthy(byId.get("audit-invalid")?.states.includes("INVALID_RENDER"), "invalid MP4 metadata is reported from the shared verifier");
  truthy(byId.get("audit-no-reel")?.states.includes("MISSING_REELDATA"), "missing ReelData is reported");
  truthy(byId.get("audit-no-social")?.states.includes("MISSING_SOCIAL_COPY"), "missing social copy is reported");
  truthy(byId.get(untrackedId)?.states.includes("UNTRACKED_PARTIAL"), "untracked fixture artifacts are classified separately from production failures");
  truthy(!byId.get(untrackedId)?.states.includes("MISSING_REELDATA"), "untracked fixture artifacts do not report production ReelData failures");
  equal(report.orphans.renders.length, 1, "orphan MP4 is detected");
  truthy(report.orphans.renders[0].endsWith("orphan-artwork.mp4"), "orphan MP4 path is preserved");
  JSON.parse(JSON.stringify(report));
  equal(JSON.stringify(await snapshot(root)), JSON.stringify(before), "audit leaves the filesystem snapshot unchanged");
  equal(await readFile(historyPath, "utf8"), historyBefore, "audit never mutates production history");

  const cli = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/reels-audit.ts"), "--json", "--root", root], { encoding: "utf8" });
  equal(cli.status, 0, `audit JSON CLI exits successfully: ${cli.stderr}`);
  const parsed = JSON.parse(cli.stdout) as { summary: { historyEntries: number } };
  equal(parsed.summary.historyEntries, ids.length, "audit CLI stdout is pure parseable JSON");

  console.log("Production reconciliation, JSON, and read-only tests passed");
};

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
