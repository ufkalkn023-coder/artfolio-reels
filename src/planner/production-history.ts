import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type ArtworkHandoff } from "./handoff";
import { RECENT_MUSIC_REEL_LIMIT, type RecentMusicContext, normalizedMusicArtist } from "./music-history";
import { MusicSuggestionsSchema, musicTrackIdentity } from "./reel-plan";

export const REEL_PRODUCTION_HISTORY_VERSION = "reel-production-history-v1" as const;

export const ProductionHistoryStatusSchema = z.enum(["QC_PASSED", "RENDERED"]);
export type ProductionHistoryStatus = z.infer<typeof ProductionHistoryStatusSchema>;

const requiredText = (maximum: number) => z.string().trim().min(1).max(maximum);
export const ReelProductionHistoryEntrySchema = z.object({
  canonicalId: requiredText(120),
  artist: requiredText(72),
  museum: requiredText(100),
  source: requiredText(48),
  template: requiredText(48),
  plannerVersion: z.number().int().positive().optional(),
  batchId: requiredText(160),
  status: ProductionHistoryStatusSchema,
  qcPassedAt: z.iso.datetime(),
  renderedAt: z.iso.datetime().optional(),
  renderPath: z.string().trim().min(1).max(1000).optional(),
  duration: z.number().positive().max(60).optional(),
  warnings: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  musicSuggestions: MusicSuggestionsSchema.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.status === "RENDERED" && (!entry.renderedAt || !entry.renderPath)) {
    context.addIssue({ code: "custom", message: "RENDERED history entries require renderedAt and renderPath" });
  }
  if (entry.status === "QC_PASSED" && (entry.renderedAt || entry.renderPath)) {
    context.addIssue({ code: "custom", message: "QC_PASSED history entries cannot include render metadata" });
  }
});
export type ReelProductionHistoryEntry = z.infer<typeof ReelProductionHistoryEntrySchema>;

export const ReelProductionHistorySchema = z.object({
  version: z.literal(REEL_PRODUCTION_HISTORY_VERSION),
  entries: z.array(ReelProductionHistoryEntrySchema),
}).strict().superRefine((history, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of history.entries.entries()) {
    if (ids.has(entry.canonicalId)) context.addIssue({ code: "custom", path: ["entries", index, "canonicalId"], message: "canonicalId must be unique" });
    ids.add(entry.canonicalId);
  }
});
export type ReelProductionHistory = z.infer<typeof ReelProductionHistorySchema>;

export type RecordProductionHistoryInput = Pick<ArtworkHandoff, "canonicalId" | "artist" | "museum" | "source"> & {
  template: string;
  plannerVersion?: number;
  batchId: string;
  status: ProductionHistoryStatus;
  completedAt: string;
  duration?: number;
  warnings?: string[];
  renderPath?: string;
  musicSuggestions?: z.infer<typeof MusicSuggestionsSchema>;
};

export type RecordProductionHistoryResult = {
  history: ReelProductionHistory;
  entry: ReelProductionHistoryEntry;
  changed: boolean;
  transition?: "QC_PASSED→RENDERED";
};

export const emptyReelProductionHistory = (): ReelProductionHistory => ({ version: REEL_PRODUCTION_HISTORY_VERSION, entries: [] });

export const loadReelProductionHistory = async (path: string): Promise<ReelProductionHistory> => {
  try {
    return ReelProductionHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyReelProductionHistory();
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Reel production history is invalid at ${path}: ${detail}`);
  }
};

export const productionHistoryForPortfolio = (history: ReelProductionHistory): Array<Pick<ReelProductionHistoryEntry, "canonicalId" | "artist" | "museum">> => (
  history.entries.map(({ canonicalId, artist, museum }) => ({ canonicalId, artist, museum }))
);

/** The minimal cross-process exclusion boundary for automatic Reel production. */
export const productionHistoryExcludedCanonicalIds = (history: ReelProductionHistory): string[] => (
  history.entries
    .filter((entry) => entry.status === "QC_PASSED" || entry.status === "RENDERED")
    .map((entry) => entry.canonicalId)
    .sort()
);

/** Music diversity is deliberately a rolling window, never a global lifetime ban. */
export const recentMusicContextFromProductionHistory = (
  history: ReelProductionHistory,
  reelLimit = RECENT_MUSIC_REEL_LIMIT,
  excludeCanonicalId?: string,
): RecentMusicContext => {
  const recentEntries = history.entries
    .filter((entry) => (entry.status === "QC_PASSED" || entry.status === "RENDERED") && entry.canonicalId !== excludeCanonicalId)
    .sort((left, right) => right.qcPassedAt.localeCompare(left.qcPassedAt))
    .slice(0, reelLimit);
  const tracks: RecentMusicContext["tracks"] = [];
  const trackIds = new Set<string>();
  const artists = new Map<string, { display: string; count: number }>();
  for (const entry of recentEntries) {
    for (const suggestion of entry.musicSuggestions ?? []) {
      const trackId = musicTrackIdentity(suggestion);
      if (!trackIds.has(trackId)) {
        trackIds.add(trackId);
        tracks.push({ artist: suggestion.artist, title: suggestion.title });
      }
      const artistId = normalizedMusicArtist(suggestion.artist);
      const current = artists.get(artistId);
      artists.set(artistId, { display: current?.display ?? suggestion.artist, count: (current?.count ?? 0) + 1 });
    }
  }
  const frequentArtists = [...artists.values()]
    .filter(({ count }) => count > 1)
    .sort((left, right) => right.count - left.count || left.display.localeCompare(right.display))
    .slice(0, 8)
    .map(({ display }) => display);
  return { tracks, frequentArtists };
};

export const writeReelProductionHistory = async (path: string, history: ReelProductionHistory): Promise<void> => {
  const validated = ReelProductionHistorySchema.parse(history);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

export const recordProductionHistory = async (
  path: string,
  history: ReelProductionHistory,
  input: RecordProductionHistoryInput,
): Promise<RecordProductionHistoryResult> => {
  const validatedHistory = ReelProductionHistorySchema.parse(history);
  const existingIndex = validatedHistory.entries.findIndex((entry) => entry.canonicalId === input.canonicalId);
  const existing = existingIndex === -1 ? undefined : validatedHistory.entries[existingIndex];
  const repeatedStatus = existing?.status === "RENDERED" || (existing?.status === "QC_PASSED" && input.status === "QC_PASSED");
  const canBackfillMusic = Boolean(existing && !existing.musicSuggestions && input.musicSuggestions);
  if (repeatedStatus && !canBackfillMusic) {
    return { history: validatedHistory, entry: existing, changed: false };
  }
  if (existing && repeatedStatus && input.musicSuggestions) {
    const entry = ReelProductionHistoryEntrySchema.parse({ ...existing, musicSuggestions: input.musicSuggestions });
    const entries = [...validatedHistory.entries];
    entries[existingIndex] = entry;
    const next = ReelProductionHistorySchema.parse({ version: REEL_PRODUCTION_HISTORY_VERSION, entries });
    await writeReelProductionHistory(path, next);
    return { history: next, entry, changed: true };
  }
  const entry = ReelProductionHistoryEntrySchema.parse({
    canonicalId: input.canonicalId,
    artist: input.artist,
    museum: input.museum,
    source: input.source,
    template: input.template,
    ...(input.plannerVersion ? { plannerVersion: input.plannerVersion } : {}),
    batchId: input.batchId,
    status: input.status,
    qcPassedAt: existing?.qcPassedAt ?? input.completedAt,
    ...(input.status === "RENDERED" ? { renderedAt: input.completedAt, renderPath: input.renderPath } : {}),
    ...(input.duration ? { duration: input.duration } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
    ...(input.musicSuggestions ? { musicSuggestions: input.musicSuggestions } : existing?.musicSuggestions ? { musicSuggestions: existing.musicSuggestions } : {}),
  });
  const entries = [...validatedHistory.entries];
  if (existingIndex === -1) entries.push(entry); else entries[existingIndex] = entry;
  const next = ReelProductionHistorySchema.parse({ version: REEL_PRODUCTION_HISTORY_VERSION, entries });
  await writeReelProductionHistory(path, next);
  return {
    history: next,
    entry,
    changed: true,
    ...(existing?.status === "QC_PASSED" && input.status === "RENDERED" ? { transition: "QC_PASSED→RENDERED" as const } : {}),
  };
};
