import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const QC_RETENTION_VALUES = ["all", "summary", "none"] as const;
export type QcRetention = (typeof QC_RETENTION_VALUES)[number];

export type QcRun = {
  qcRoot: string;
  reelId: string;
  runId: string;
  stagingDirectory: string;
  finalDirectory: string;
};

export type QcLifecycleResult = {
  retention: QcRetention;
  directory?: string;
  retainedCount: number;
  cleanedCount: number;
};

const SAFE_REEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const assertContained = (root: string, candidate: string): void => {
  const child = relative(root, candidate);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`QC artifact path must remain inside ${root}`);
  }
};

const countFiles = async (directory: string): Promise<number> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : entry.isFile() ? 1 : 0;
  }
  return count;
};

export const resolveQcRetention = (raw = process.env.ARTFOLIO_QC_RETENTION): QcRetention => {
  const value = raw?.trim().toLowerCase() || "all";
  if (!QC_RETENTION_VALUES.includes(value as QcRetention)) {
    throw new Error(`ARTFOLIO_QC_RETENTION must be one of: ${QC_RETENTION_VALUES.join(", ")}`);
  }
  return value as QcRetention;
};

export const beginQcRun = async (qcRoot: string, reelId: string, runId: string = randomUUID()): Promise<QcRun> => {
  if (!SAFE_REEL_ID.test(reelId)) throw new Error("Reel ID is not safe for QC artifacts");
  const root = resolve(qcRoot);
  const stagingDirectory = resolve(root, ".runs", `${reelId}-${runId}`);
  const finalDirectory = resolve(root, reelId);
  assertContained(root, stagingDirectory);
  assertContained(root, finalDirectory);
  await mkdir(resolve(root, ".runs"), { recursive: true });
  await mkdir(stagingDirectory, { recursive: false });
  return { qcRoot: root, reelId, runId, stagingDirectory, finalDirectory };
};

const replaceFinalDirectory = async (run: QcRun): Promise<number> => {
  const oldCount = await countFiles(run.finalDirectory);
  const backup = resolve(run.qcRoot, `.previous-${run.reelId}-${run.runId}`);
  assertContained(run.qcRoot, backup);
  let hasBackup = false;
  try {
    await stat(run.finalDirectory);
    await rename(run.finalDirectory, backup);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(run.stagingDirectory, run.finalDirectory);
  } catch (error) {
    if (hasBackup) await rename(backup, run.finalDirectory).catch(() => undefined);
    throw error;
  }
  if (hasBackup) await rm(backup, { recursive: true, force: true });
  return oldCount;
};

export const finalizeSuccessfulQcRun = async (
  run: QcRun,
  retention: QcRetention,
  summary: Record<string, unknown>,
): Promise<QcLifecycleResult> => {
  const generatedCount = await countFiles(run.stagingDirectory);
  if (retention === "none") {
    const oldCount = await countFiles(run.finalDirectory);
    await rm(run.stagingDirectory, { recursive: true, force: true });
    await rm(run.finalDirectory, { recursive: true, force: true });
    return { retention, retainedCount: 0, cleanedCount: generatedCount + oldCount };
  }

  await writeFile(join(run.stagingDirectory, "qc-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  let cleanedIntermediates = 0;
  if (retention === "summary") {
    const entries = await readdir(run.stagingDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "contact-sheet.png" || entry.name === "qc-summary.json") continue;
      const candidate = resolve(run.stagingDirectory, entry.name);
      assertContained(run.stagingDirectory, candidate);
      cleanedIntermediates += entry.isDirectory() ? await countFiles(candidate) : entry.isFile() ? 1 : 0;
      await rm(candidate, { recursive: true, force: true });
    }
  }
  const replacedCount = await replaceFinalDirectory(run);
  return {
    retention,
    directory: run.finalDirectory,
    retainedCount: await countFiles(run.finalDirectory),
    cleanedCount: cleanedIntermediates + replacedCount,
  };
};

export const preserveFailedQcRun = async (run: QcRun): Promise<string> => {
  const failureDirectory = resolve(run.qcRoot, ".failures", run.reelId, basename(run.stagingDirectory));
  assertContained(run.qcRoot, failureDirectory);
  await mkdir(resolve(run.qcRoot, ".failures", run.reelId), { recursive: true });
  await rename(run.stagingDirectory, failureDirectory);
  return failureDirectory;
};
