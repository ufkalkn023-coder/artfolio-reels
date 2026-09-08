import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { verifyRenderMedia, type RenderVerification } from "../media/render-verification";
import { loadReelProductionHistory, type ReelProductionHistoryEntry } from "../planner/production-history";
import { verifyReleasePackage, type ReleaseVerification } from "../release/package";
import { VIDEO } from "../v2/design";
import { type ReelData } from "../v2/schema";
import { getDurationInFrames } from "../v2/timing";
import { validateRenderableReelData } from "../v2/validation";

export type ProductionAuditState =
  | "HISTORY_ONLY"
  | "REELDATA_ONLY"
  | "RENDER_ONLY"
  | "HISTORY_AND_RENDER"
  | "COMPLETE"
  | "MISSING_RENDER"
  | "INVALID_RENDER"
  | "MISSING_REELDATA"
  | "INVALID_REELDATA"
  | "MISSING_SOCIAL_COPY"
  | "MISSING_QC"
  | "RELEASE_MISSING"
  | "RELEASE_INVALID"
  | "UNTRACKED_PARTIAL";

export type ProductionAuditItem = {
  reelId: string;
  states: ProductionAuditState[];
  historyStatus?: ReelProductionHistoryEntry["status"];
  paths: {
    reelData?: string;
    historyRender?: string;
    render?: string;
    socialCopy?: string;
    qc?: string;
    release?: string;
  };
  render?: RenderVerification;
  release?: ReleaseVerification;
  errors: string[];
};

export type ProductionAuditReport = {
  generatedAt: string;
  deep: boolean;
  summary: {
    historyEntries: number;
    reelData: number;
    renders: number;
    validRenders: number;
    missingRenders: number;
    invalidRenders: number;
    socialCopies: number;
    qcArtifacts: number;
    releases: number;
    validReleases: number;
    complete: number;
  };
  items: ProductionAuditItem[];
  orphans: {
    renders: string[];
    socialCopies: string[];
    qcDirectories: string[];
    releases: string[];
  };
  warnings: string[];
};

export type ProductionAuditOptions = {
  rootDirectory?: string;
  historyPath?: string;
  reelDirectory?: string;
  outputDirectory?: string;
  deep?: boolean;
  reelIds?: readonly string[];
  verifyMedia?: typeof verifyRenderMedia;
  verifyRelease?: typeof verifyReleasePackage;
  now?: () => Date;
};

const listEntries = async (directory: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> => {
  try {
    return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const findOwner = (name: string, knownIds: readonly string[]): string | undefined => knownIds
  .filter((id) => name === `${id}${extname(name)}` || name.startsWith(`${id}-`))
  .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];

const fileExists = async (path: string): Promise<boolean> => stat(path).then((entry) => entry.isFile()).catch(() => false);

export const auditProduction = async (options: ProductionAuditOptions = {}): Promise<ProductionAuditReport> => {
  const root = resolve(options.rootDirectory ?? ".");
  const historyPath = resolve(options.historyPath ?? join(root, "data/reel-production-history.json"));
  const reelDirectory = resolve(options.reelDirectory ?? join(root, "data/reels"));
  const outputDirectory = resolve(options.outputDirectory ?? join(root, "output"));
  const renderDirectory = join(outputDirectory, "renders");
  const socialDirectory = join(outputDirectory, "social");
  const qcDirectory = join(outputDirectory, "qc");
  const releaseDirectory = join(outputDirectory, "releases");
  const warnings: string[] = [];
  let historyEntries: ReelProductionHistoryEntry[] = [];
  try {
    historyEntries = (await loadReelProductionHistory(historyPath)).entries;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const reelFiles = (await listEntries(reelDirectory)).filter((entry) => entry.isFile && extname(entry.name) === ".json" && !entry.name.startsWith("."));
  const reels = new Map<string, { path: string; reel?: ReelData; error?: string }>();
  for (const entry of reelFiles) {
    const path = join(reelDirectory, entry.name);
    const fileId = basename(entry.name, ".json");
    try {
      const reel = validateRenderableReelData(JSON.parse(await readFile(path, "utf8")));
      reels.set(reel.id, { path, reel });
      if (reel.id !== fileId) warnings.push(`ReelData filename ${entry.name} contains reel ID ${reel.id}`);
    } catch (error) {
      reels.set(fileId, { path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const qcEntries = (await listEntries(qcDirectory)).filter((entry) => entry.isDirectory && !entry.name.startsWith("."));
  const releaseEntries = (await listEntries(releaseDirectory)).filter((entry) => entry.isDirectory && !entry.name.startsWith("."));
  const trackedIds = new Set([
    ...historyEntries.map((entry) => entry.canonicalId),
    ...reels.keys(),
  ]);
  const knownIds = [...new Set([
    ...trackedIds,
    ...qcEntries.map((entry) => entry.name),
    ...releaseEntries.map((entry) => entry.name),
  ])].sort();
  const renderEntries = (await listEntries(renderDirectory)).filter((entry) => entry.isFile && extname(entry.name).toLowerCase() === ".mp4");
  const socialEntries = (await listEntries(socialDirectory)).filter((entry) => entry.isFile && extname(entry.name).toLowerCase() === ".txt");
  const renders = new Map<string, string[]>();
  const socialCopies = new Map<string, string[]>();
  const orphanRenders: string[] = [];
  const orphanSocial: string[] = [];
  for (const entry of renderEntries) {
    const path = join(renderDirectory, entry.name);
    const owner = findOwner(entry.name, knownIds);
    if (!owner) orphanRenders.push(path);
    else renders.set(owner, [...(renders.get(owner) ?? []), path]);
  }
  for (const entry of socialEntries) {
    const path = join(socialDirectory, entry.name);
    const owner = findOwner(entry.name, knownIds);
    if (!owner) orphanSocial.push(path);
    else socialCopies.set(owner, [...(socialCopies.get(owner) ?? []), path]);
  }

  const historyById = new Map(historyEntries.map((entry) => [entry.canonicalId, entry]));
  const selectedIds = options.reelIds?.length ? knownIds.filter((id) => options.reelIds?.includes(id)) : knownIds;
  const verifyMedia = options.verifyMedia ?? verifyRenderMedia;
  const verifyRelease = options.verifyRelease ?? verifyReleasePackage;
  const items: ProductionAuditItem[] = [];
  for (const reelId of selectedIds) {
    const history = historyById.get(reelId);
    const reelRecord = reels.get(reelId);
    const discoveredRenderPath = renders.get(reelId)?.sort()[0];
    const historyRenderExists = history?.renderPath ? await fileExists(history.renderPath) : false;
    const renderPath = discoveredRenderPath ?? (historyRenderExists ? history?.renderPath : undefined);
    const socialPath = socialCopies.get(reelId)?.sort()[0];
    const qcPath = qcEntries.some((entry) => entry.name === reelId) ? join(qcDirectory, reelId) : undefined;
    const releasePath = releaseEntries.some((entry) => entry.name === reelId) ? join(releaseDirectory, reelId) : undefined;
    const states: ProductionAuditState[] = [];
    const errors: string[] = [];
    let render: RenderVerification | undefined;
    let release: ReleaseVerification | undefined;
    if (renderPath) {
      try {
        render = await verifyMedia(renderPath, {
          ...(reelRecord?.reel ? { durationSeconds: getDurationInFrames(reelRecord.reel) / VIDEO.fps } : history?.duration ? { durationSeconds: history.duration } : {}),
          requireAudio: Boolean(reelRecord?.reel?.music ?? history?.musicTrackId),
        }, { deep: options.deep ?? false });
      } catch (error) {
        states.push("INVALID_RENDER");
        errors.push(`Render: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (releasePath) {
      release = await verifyRelease({ releaseDirectory: releasePath, reelDirectory, verifyMedia, deep: options.deep ?? false });
      if (!release.valid) {
        states.push("RELEASE_INVALID");
        errors.push(...release.errors.map((error) => `Release: ${error}`));
      }
    }

    const hasOnlyHistory = Boolean(history) && !reelRecord && !renderPath && !socialPath && !qcPath && !releasePath;
    const hasOnlyReel = !history && Boolean(reelRecord) && !renderPath && !socialPath && !qcPath && !releasePath;
    const hasOnlyRender = !history && !reelRecord && Boolean(renderPath) && !socialPath && !qcPath && !releasePath;
    const hasHistoryAndRender = Boolean(history && renderPath) && !reelRecord && !socialPath && !qcPath && !releasePath;
    if (hasOnlyHistory) states.push("HISTORY_ONLY");
    if (hasOnlyReel) states.push("REELDATA_ONLY");
    if (hasOnlyRender) states.push("RENDER_ONLY");
    if (hasHistoryAndRender) states.push("HISTORY_AND_RENDER");
    if (history && !reelRecord) states.push("MISSING_REELDATA");

    const hasUntrackedArtifacts =
      !history &&
      Boolean(reelRecord || renderPath || socialPath || qcPath || releasePath);

    if (hasUntrackedArtifacts) states.push("UNTRACKED_PARTIAL");
    if (reelRecord?.error) {
      states.push("INVALID_REELDATA");
      errors.push(`ReelData: ${reelRecord.error}`);
    }
    if (history?.status === "RENDERED" && !renderPath) states.push("MISSING_RENDER");
    if (history?.status === "RENDERED" && !socialPath) states.push("MISSING_SOCIAL_COPY");
    if (history && !qcPath) states.push("MISSING_QC");
    if (history?.status === "RENDERED" && !releasePath) states.push("RELEASE_MISSING");
    const qcComplete = history?.status === "QC_PASSED" && reelRecord?.reel && qcPath && !reelRecord.error;
    const renderComplete = history?.status === "RENDERED" && reelRecord?.reel && render && socialPath && qcPath && release?.valid;
    if ((qcComplete || renderComplete) && states.length === 0) states.push("COMPLETE");
    items.push({
      reelId,
      states,
      ...(history ? { historyStatus: history.status } : {}),
      paths: {
        ...(reelRecord ? { reelData: reelRecord.path } : {}),
        ...(history?.renderPath ? { historyRender: history.renderPath } : {}),
        ...(renderPath ? { render: renderPath } : {}),
        ...(socialPath ? { socialCopy: socialPath } : {}),
        ...(qcPath ? { qc: qcPath } : {}),
        ...(releasePath ? { release: releasePath } : {}),
      },
      ...(render ? { render } : {}),
      ...(release ? { release } : {}),
      errors,
    });
  }

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    deep: options.deep ?? false,
    summary: {
      historyEntries: historyEntries.length,
      reelData: reels.size,
      renders: renderEntries.length,
      validRenders: items.filter((item) => item.render).length,
      missingRenders: items.filter((item) => item.states.includes("MISSING_RENDER")).length,
      invalidRenders: items.filter((item) => item.states.includes("INVALID_RENDER")).length,
      socialCopies: socialEntries.length,
      qcArtifacts: qcEntries.length,
      releases: releaseEntries.length,
      validReleases: items.filter((item) => item.release?.valid).length,
      complete: items.filter((item) => item.states.includes("COMPLETE")).length,
    },
    items,
    orphans: {
      renders: orphanRenders.sort(),
      socialCopies: orphanSocial.sort(),
      qcDirectories: qcEntries.filter((entry) => !trackedIds.has(entry.name)).map((entry) => join(qcDirectory, entry.name)).sort(),
      releases: releaseEntries.filter((entry) => !trackedIds.has(entry.name)).map((entry) => join(releaseDirectory, entry.name)).sort(),
    },
    warnings,
  };
};
