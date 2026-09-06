import { constants } from "node:fs";
import { access, lstat, link, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";

export const AFM_TRACK_ID_PATTERN = /^AFM-([A-Z]{2})(\d{2})-(\d{2})$/;

export type AfmTrack = {
  id: string;
  familyCode: string;
  familyName: string;
  subfamilyCode: string;
  subfamilyName: string;
  variation: string;
  variationSlot: number;
  rating: number;
  durationSeconds: number;
  masterPath: string;
};

export type AfmCatalogScan = {
  root: string;
  available: boolean;
  tracks: AfmTrack[];
  warnings: string[];
};

type TaxonomyFamily = { name: string; folder: string; subfamilies: Record<string, string> };
type TrackMetadata = {
  id?: unknown;
  familyCode?: unknown;
  subfamilyCode?: unknown;
  variation?: unknown;
  variationSlot?: unknown;
  status?: unknown;
  tier?: unknown;
  rating?: unknown;
  audio?: { durationSeconds?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
const isWithin = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !fromRoot.startsWith(sep);
};

export const defaultAfmRoot = (): string => resolve(process.env.ARTFOLIO_AFM_ROOT ?? resolve(homedir(), "Developer/Artfolio-Music-Library"));

export const parseAfmTrackId = (trackId: string): { id: string; familyCode: string; subfamilyCode: string; slot: number } => {
  const id = trackId.trim().toUpperCase();
  const match = AFM_TRACK_ID_PATTERN.exec(id);
  if (!match) throw new Error(`Invalid AFM track ID: ${trackId}`);
  return { id, familyCode: match[1], subfamilyCode: `${match[1]}${match[2]}`, slot: Number(match[3]) };
};

const validateAcceptedMaster = async (root: string, trackDirectory: string, trackId: string): Promise<string> => {
  const masterPath = resolve(trackDirectory, "accepted", `${trackId}.wav`);
  if (!isWithin(root, masterPath) || basename(masterPath) !== `${trackId}.wav`) throw new Error(`Unsafe accepted master path for ${trackId}`);
  const master = await stat(masterPath);
  if (!master.isFile()) throw new Error(`Accepted AFM master is not a file: ${trackId}`);
  const [realRoot, realMaster] = await Promise.all([realpath(root), realpath(masterPath)]);
  if (!isWithin(realRoot, realMaster)) throw new Error(`Accepted AFM master escapes the library root: ${trackId}`);
  return masterPath;
};

export const scanAfmCatalog = async (root = defaultAfmRoot()): Promise<AfmCatalogScan> => {
  const resolvedRoot = resolve(root);
  try {
    await access(resolvedRoot, constants.R_OK);
  } catch (error) {
    if (isMissing(error)) return { root: resolvedRoot, available: false, tracks: [], warnings: [`AFM library not found: ${resolvedRoot}`] };
    throw error;
  }

  const taxonomyValue = JSON.parse(await readFile(resolve(resolvedRoot, "00-admin/catalog.json"), "utf8")) as unknown;
  if (!isRecord(taxonomyValue)) throw new Error("AFM catalog taxonomy must be an object");
  const warnings: string[] = [];
  const tracks: AfmTrack[] = [];

  for (const [familyCode, rawFamily] of Object.entries(taxonomyValue).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(rawFamily) || typeof rawFamily.name !== "string" || typeof rawFamily.folder !== "string" || !isRecord(rawFamily.subfamilies)) {
      warnings.push(`Ignored invalid AFM family ${familyCode}`);
      continue;
    }
    const family = rawFamily as unknown as TaxonomyFamily;
    const familyDirectory = resolve(resolvedRoot, family.folder);
    let subfamilyDirectories;
    try {
      subfamilyDirectories = await readdir(familyDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const [subNumber, subfamilyName] of Object.entries(family.subfamilies).sort(([left], [right]) => left.localeCompare(right))) {
      const subfamilyCode = `${familyCode}${subNumber}`;
      const subfamilyEntry = subfamilyDirectories.find((entry) => entry.isDirectory() && entry.name.startsWith(`${subfamilyCode}-`));
      if (!subfamilyEntry) continue;
      const subfamilyDirectory = resolve(familyDirectory, subfamilyEntry.name);
      for (const entry of (await readdir(subfamilyDirectory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || !AFM_TRACK_ID_PATTERN.test(entry.name)) continue;
        const parsedId = parseAfmTrackId(entry.name);
        if (parsedId.familyCode !== familyCode || parsedId.subfamilyCode !== subfamilyCode) continue;
        const trackDirectory = resolve(subfamilyDirectory, entry.name);
        try {
          const metadata = JSON.parse(await readFile(resolve(trackDirectory, "metadata/track.json"), "utf8")) as TrackMetadata;
          if (
            metadata.id !== parsedId.id || metadata.familyCode !== familyCode || metadata.subfamilyCode !== subfamilyCode ||
            metadata.status !== "ACCEPTED" || metadata.tier !== "PRODUCTION_READY"
          ) continue;
          const durationSeconds = metadata.audio?.durationSeconds;
          if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) continue;
          const variationSlot = typeof metadata.variationSlot === "number" ? metadata.variationSlot : parsedId.slot;
          if (variationSlot !== parsedId.slot) continue;
          tracks.push({
            id: parsedId.id,
            familyCode,
            familyName: family.name,
            subfamilyCode,
            subfamilyName,
            variation: typeof metadata.variation === "string" ? metadata.variation : "Core Version",
            variationSlot,
            rating: typeof metadata.rating === "number" ? metadata.rating : 0,
            durationSeconds,
            masterPath: await validateAcceptedMaster(resolvedRoot, trackDirectory, parsedId.id),
          });
        } catch (error) {
          if (!isMissing(error)) warnings.push(`Ignored invalid AFM track ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { root: resolvedRoot, available: true, tracks: tracks.sort((left, right) => left.id.localeCompare(right.id)), warnings };
};

export type LocalizedAfmTrack = { publicPath: string; filesystemPath: string; method: "hard-link" | "existing" };

export const localizeAfmTrack = async (track: AfmTrack, publicDirectory = resolve("public/reel-audio")): Promise<LocalizedAfmTrack> => {
  const destinationDirectory = resolve(publicDirectory);
  const destination = resolve(destinationDirectory, `${track.id}.wav`);
  if (!isWithin(destinationDirectory, destination)) throw new Error("AFM audio destination escapes public/reel-audio");
  await mkdir(destinationDirectory, { recursive: true });
  const sourceRealPath = await realpath(track.masterPath);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      if (await realpath(destination) === sourceRealPath) return { publicPath: `reel-audio/${track.id}.wav`, filesystemPath: destination, method: "existing" };
    } else if (existing.isFile()) {
      const [sourceStat, destinationStat] = await Promise.all([stat(sourceRealPath), stat(destination)]);
      if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
        return { publicPath: `reel-audio/${track.id}.wav`, filesystemPath: destination, method: "existing" };
      }
    }
    throw new Error(`Refusing to overwrite existing audio localization: ${destination}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    await link(sourceRealPath, destination);
    return { publicPath: `reel-audio/${track.id}.wav`, filesystemPath: destination, method: "hard-link" };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) {
      throw new Error(`AFM hard link is unavailable (${code}); an external symlink is not render-safe with the Remotion public bundle`);
    }
    throw error;
  }
};
