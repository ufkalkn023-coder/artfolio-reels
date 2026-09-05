import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRenderOutputPath } from "../planner/render-path";
import { resolveSocialOutputPath } from "../social/social-copy";
import { VIDEO } from "../v2/design";
import { ReelDataSchema, type ReelData } from "../v2/schema";
import { getDurationInFrames } from "../v2/timing";

const SAFE_REEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RELEASE_VERSION = "artfolio-release-v1";
const MUSIC_SUGGESTIONS_DELIMITER = "\nMUSIC SUGGESTIONS\n-----------------\n";

type ReleaseFileKey = "video" | "caption" | "metadata" | "qcContactSheet";

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

const loadVerifiedReel = async (reelId: string, reelDirectory: string): Promise<ReelData> => {
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
    reel = ReelDataSchema.parse(raw);
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
    generatedAt,
  };
};

export const extractCanonicalCaption = (socialOutput: string): string => {
  const caption = socialOutput.split(MUSIC_SUGGESTIONS_DELIMITER, 1)[0] ?? "";
  if (!caption.trim()) throw new Error("Required caption is empty");
  return caption;
};

export const sha256File = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

const releaseFiles = (): Record<ReleaseFileKey, string> => ({
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
    await moveIntoPlace(stagedDirectory, releaseDirectory, overwrite);
    return { directory: releaseDirectory, metadata, manifest };
  } catch (error) {
    await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};
