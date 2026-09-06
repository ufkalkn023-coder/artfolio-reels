import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { verifyRenderMedia, type RenderVerification } from "../media/render-verification";
import { resolveRenderOutputPath } from "../planner/render-path";
import { resolveSocialOutputPath } from "../social/social-copy";
import { VIDEO } from "../v2/design";
import { type ReelData } from "../v2/schema";
import { getDurationInFrames } from "../v2/timing";
import { validateRenderableReelData } from "../v2/validation";

const SAFE_REEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const RELEASE_VERSION = "artfolio-release-v1" as const;
const MUSIC_SUGGESTIONS_DELIMITER = "\nMUSIC SUGGESTIONS\n-----------------\n";

export type ReleaseFileKey = "video" | "caption" | "metadata" | "qcContactSheet";

export type ReleasePaths = {
  video: string;
  caption: string;
  reelData: string;
  qcContactSheet: string;
  releaseDirectory: string;
};

export type ReleaseMetadata = {
  canonicalId: string;
  reelId: string;
  title: string;
  artist?: string;
  artworkTitle?: string;
  date?: string;
  museum?: string;
  template: string;
  durationSeconds: number;
  hook: string;
  hookType?: string;
  musicTrackId?: string;
  musicSubfamily?: string;
  generatedAt: string;
};

export type ReleaseManifest = {
  version: typeof RELEASE_VERSION;
  reelId: string;
  createdAt: string;
  files: Record<ReleaseFileKey, string>;
  sha256: Record<string, string>;
};

export type PackageReleaseOptions = {
  reelId: string;
  overwrite?: boolean;
  outputDirectory?: string;
  reelDirectory?: string;
  createdAt?: Date;
  verifyMedia?: ReleaseMediaVerifier;
};

export type ReleaseMediaVerifier = (
  path: string,
  expectations: { durationSeconds: number; requireAudio: boolean },
  options?: { deep?: boolean },
) => Promise<RenderVerification>;

export type ReleaseVerification = {
  valid: boolean;
  directory: string;
  reelId?: string;
  errors: string[];
  media?: RenderVerification;
};

export type PackagedRelease = {
  directory: string;
  metadata: ReleaseMetadata;
  manifest: ReleaseManifest;
};

const assertSafeReelId = (reelId: string): void => {
  if (!SAFE_REEL_ID.test(reelId)) throw new Error("Reel ID is not safe for a release destination");
};

const assertPathWithin = (directory: string, destination: string, message: string): void => {
  const fromDirectory = relative(directory, destination);
  if (fromDirectory === "" || fromDirectory === ".." || fromDirectory.startsWith(`..${sep}`) || isAbsolute(fromDirectory)) {
    throw new Error(message);
  }
};

export const resolveReleaseDirectory = (reelId: string, outputDirectory = resolve("output")): string => {
  assertSafeReelId(reelId);
  const releasesDirectory = resolve(outputDirectory, "releases");
  const destination = resolve(releasesDirectory, reelId);
  assertPathWithin(releasesDirectory, destination, "Release destination must remain inside output/releases");
  return destination;
};

export const resolveReleasePaths = ({
  reelId,
  outputDirectory = resolve("output"),
  reelDirectory = resolve("data/reels"),
  artworkTitle,
}: {
  reelId: string;
  outputDirectory?: string;
  reelDirectory?: string;
  artworkTitle: string;
}): ReleasePaths => {
  assertSafeReelId(reelId);
  const verifiedReelDirectory = resolve(reelDirectory);
  const reelData = resolve(verifiedReelDirectory, `${reelId}.json`);
  assertPathWithin(verifiedReelDirectory, reelData, "ReelData source must remain inside data/reels");
  return {
    video: resolveRenderOutputPath(reelId, artworkTitle, outputDirectory),
    caption: resolveSocialOutputPath(reelId, artworkTitle, outputDirectory),
    reelData,
    qcContactSheet: resolve(outputDirectory, "qc", reelId, "contact-sheet.png"),
    releaseDirectory: resolveReleaseDirectory(reelId, outputDirectory),
  };
};

const requireNonEmptyFile = async (path: string, label: string): Promise<void> => {
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new Error(`Missing required ${label}: ${path}`);
  }
  if (!file.isFile() || file.size === 0) throw new Error(`Required ${label} is empty or not a file: ${path}`);
};

export const loadVerifiedReel = async (reelId: string, reelDirectory: string): Promise<ReelData> => {
  const reelPath = resolve(reelDirectory, `${reelId}.json`);
  await requireNonEmptyFile(reelPath, "ReelData");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(reelPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ReelData: ${error instanceof Error ? error.message : String(error)}`);
  }
  let reel: ReelData;
  try {
    reel = validateRenderableReelData(raw);
  } catch (error) {
    throw new Error(`Invalid ReelData: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reel.id !== reelId || reel.artworks[0]?.id !== reelId) {
    throw new Error(`Invalid ReelData: expected reel and artwork ID to match ${reelId}`);
  }
  return reel;
};

const optionalText = (value: string | undefined): string | undefined => value?.trim() || undefined;

export const createReleaseMetadata = (reel: ReelData, reelId: string, generatedAt: string): ReleaseMetadata => {
  const artwork = reel.artworks[0];
  return {
    canonicalId: reel.id,
    reelId,
    title: reel.title,
    ...(optionalText(artwork?.artist) ? { artist: artwork.artist } : {}),
    ...(optionalText(artwork?.title) ? { artworkTitle: artwork.title } : {}),
    ...(optionalText(artwork?.date) ? { date: artwork.date } : {}),
    ...(optionalText(artwork?.museum) ? { museum: artwork.museum } : {}),
    template: reel.template,
    durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
    hook: reel.hook,
    ...(reel.hookType ? { hookType: reel.hookType } : {}),
    ...(reel.music?.trackId ? { musicTrackId: reel.music.trackId } : {}),
    ...(reel.music?.subfamily ? { musicSubfamily: reel.music.subfamily } : {}),
    generatedAt,
  };
};

export const extractCanonicalCaption = (socialOutput: string): string => {
  const caption = socialOutput.split(MUSIC_SUGGESTIONS_DELIMITER, 1)[0] ?? "";
  if (!caption.trim()) throw new Error("Required caption is empty");
  return caption;
};

export const sha256File = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

export const releaseFiles = (): Record<ReleaseFileKey, string> => ({
  video: "reel.mp4",
  caption: "caption.txt",
  metadata: "metadata.json",
  qcContactSheet: "qc/contact-sheet.png",
});

export const createReleaseManifest = async (directory: string, reelId: string, createdAt: string): Promise<ReleaseManifest> => {
  const files = releaseFiles();
  const sha256 = Object.fromEntries(await Promise.all(
    Object.values(files).map(async (path) => [path, await sha256File(join(directory, path))]),
  ));
  return { version: RELEASE_VERSION, reelId, createdAt, files, sha256 };
};

const ReleaseManifestSchema = z.object({
  version: z.literal(RELEASE_VERSION),
  reelId: z.string().regex(SAFE_REEL_ID),
  createdAt: z.iso.datetime(),
  files: z.object({
    video: z.literal("reel.mp4"),
    caption: z.literal("caption.txt"),
    metadata: z.literal("metadata.json"),
    qcContactSheet: z.literal("qc/contact-sheet.png"),
  }).strict(),
  sha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();

const ReleaseMetadataSchema = z.object({
  canonicalId: z.string().min(1),
  reelId: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().optional(),
  artworkTitle: z.string().optional(),
  date: z.string().optional(),
  museum: z.string().optional(),
  template: z.string().min(1),
  durationSeconds: z.number().positive(),
  hook: z.string().min(1),
  hookType: z.string().optional(),
  musicTrackId: z.string().optional(),
  musicSubfamily: z.string().optional(),
  generatedAt: z.iso.datetime(),
}).strict();

const sameMetadata = (actual: ReleaseMetadata, expected: ReleaseMetadata): boolean => {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((key) => actual[key as keyof ReleaseMetadata] === expected[key as keyof ReleaseMetadata]);
};

export const verifyReleasePackage = async ({
  releaseDirectory,
  reelDirectory = resolve("data/reels"),
  verifyMedia = verifyRenderMedia,
  deep = false,
}: {
  releaseDirectory: string;
  reelDirectory?: string;
  verifyMedia?: ReleaseMediaVerifier;
  deep?: boolean;
}): Promise<ReleaseVerification> => {
  const directory = resolve(releaseDirectory);
  const errors: string[] = [];
  let manifest: ReleaseManifest | undefined;
  try {
    manifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  } catch (error) {
    return { valid: false, directory, errors: [`Invalid release manifest: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const expectedFileNames = Object.values(releaseFiles()).sort();
  const hashKeys = Object.keys(manifest.sha256).sort();
  if (JSON.stringify(hashKeys) !== JSON.stringify(expectedFileNames)) errors.push("Manifest hash entries do not exactly match listed release files");
  for (const fileName of expectedFileNames) {
    const path = resolve(directory, fileName);
    try {
      assertPathWithin(directory, path, "Release file path escapes its package");
      await requireNonEmptyFile(path, `release file ${fileName}`);
      const actualHash = await sha256File(path);
      if (manifest.sha256[fileName] !== actualHash) errors.push(`SHA-256 mismatch for ${fileName}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let reel: ReelData | undefined;
  try {
    reel = await loadVerifiedReel(manifest.reelId, reelDirectory);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (reel) {
    try {
      const metadata = ReleaseMetadataSchema.parse(JSON.parse(await readFile(resolve(directory, manifest.files.metadata), "utf8"))) as ReleaseMetadata;
      const expectedMetadata = createReleaseMetadata(reel, manifest.reelId, manifest.createdAt);
      if (!sameMetadata(metadata, expectedMetadata)) errors.push("Release metadata does not match source ReelData or manifest identity");
    } catch (error) {
      errors.push(`Invalid release metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let media: RenderVerification | undefined;
  if (reel) {
    try {
      media = await verifyMedia(resolve(directory, manifest.files.video), {
        durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
        requireAudio: Boolean(reel.music),
      }, { deep });
    } catch (error) {
      errors.push(`Invalid release MP4: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { valid: errors.length === 0, directory, reelId: manifest.reelId, errors, ...(media ? { media } : {}) };
};

const moveIntoPlace = async (stagedDirectory: string, finalDirectory: string, overwrite: boolean): Promise<void> => {
  if (!overwrite) {
    try {
      await rename(stagedDirectory, finalDirectory);
    } catch (error) {
      throw new Error(`Could not create release: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  let backupDirectory: string | undefined;
  try {
    await stat(finalDirectory);
    backupDirectory = join(dirname(finalDirectory), `.${basename(finalDirectory)}.${randomUUID()}.backup`);
    await rename(finalDirectory, backupDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not prepare existing release for replacement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await rename(stagedDirectory, finalDirectory);
  } catch (error) {
    if (backupDirectory) await rename(backupDirectory, finalDirectory).catch(() => undefined);
    throw new Error(`Could not replace release: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true });
};

export const packageRelease = async ({
  reelId,
  overwrite = false,
  outputDirectory = resolve("output"),
  reelDirectory = resolve("data/reels"),
  createdAt = new Date(),
  verifyMedia = verifyRenderMedia,
}: PackageReleaseOptions): Promise<PackagedRelease> => {
  assertSafeReelId(reelId);
  const releaseDirectory = resolveReleaseDirectory(reelId, outputDirectory);
  try {
    await stat(releaseDirectory);
    if (!overwrite) throw new Error(`${releaseDirectory} exists. Pass --overwrite to replace it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const reel = await loadVerifiedReel(reelId, reelDirectory);
  const paths = resolveReleasePaths({ reelId, outputDirectory, reelDirectory, artworkTitle: reel.artworks[0].title });
  await Promise.all([
    requireNonEmptyFile(paths.video, "rendered Reel MP4"),
    requireNonEmptyFile(paths.caption, "social caption"),
    requireNonEmptyFile(paths.qcContactSheet, "QC contact sheet"),
  ]);
  await verifyMedia(paths.video, {
    durationSeconds: getDurationInFrames(reel) / VIDEO.fps,
    requireAudio: Boolean(reel.music),
  });

  const releasesDirectory = dirname(releaseDirectory);
  await mkdir(releasesDirectory, { recursive: true });
  const stagedDirectory = await mkdtemp(join(releasesDirectory, `.${reelId}.`));
  const generatedAt = createdAt.toISOString();
  try {
    await mkdir(join(stagedDirectory, "qc"));
    await Promise.all([
      copyFile(paths.video, join(stagedDirectory, "reel.mp4")),
      copyFile(paths.qcContactSheet, join(stagedDirectory, "qc", "contact-sheet.png")),
    ]);
    await writeFile(join(stagedDirectory, "caption.txt"), extractCanonicalCaption(await readFile(paths.caption, "utf8")), "utf8");

    const metadata = createReleaseMetadata(reel, reelId, generatedAt);
    await writeFile(join(stagedDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const manifest = await createReleaseManifest(stagedDirectory, reelId, generatedAt);
    await writeFile(join(stagedDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const verification = await verifyReleasePackage({ releaseDirectory: stagedDirectory, reelDirectory, verifyMedia });
    if (!verification.valid) throw new Error(`Release verification failed: ${verification.errors.join("; ")}`);
    await moveIntoPlace(stagedDirectory, releaseDirectory, overwrite);
    return { directory: releaseDirectory, metadata, manifest };
  } catch (error) {
    await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};
