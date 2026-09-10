import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getSampleReel } from "../src/v2/samples";
import {
  createReleaseMetadata,
  packageRelease,
  resolveReleaseDirectory,
  resolveReleasePaths,
  sha256File,
  verifyReleasePackage,
  type ReleaseMediaVerifier,
} from "../src/release/package";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const rejects = async (operation: () => Promise<unknown>, expected: string, label: string): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    truthy(error instanceof Error && error.message.includes(expected), `${label}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${label}: expected an error`);
};

type Fixture = { root: string; outputDirectory: string; reelDirectory: string; reelId: string; paths: ReturnType<typeof resolveReleasePaths> };

const verifyMedia: ReleaseMediaVerifier = async (path, expectations, options = {}) => ({
  path,
  sizeBytes: (await stat(path)).size,
  durationSeconds: expectations.durationSeconds,
  video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
  ...(expectations.requireAudio ? { audio: { codec: "aac" } } : {}),
  deep: options.deep ?? false,
});

const createFixture = async (reelId = "release-fixture"): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-release-"));
  const outputDirectory = join(root, "output");
  const reelDirectory = join(root, "data", "reels");
  const reel = structuredClone(getSampleReel("inside-the-painting"));
  reel.id = reelId;
  reel.artworks[0].id = reelId;
  reel.artworks[0].title = "Fixture Artwork";
  reel.artworks[0].artist = "Fixture Artist";
  reel.artworks[0].date = "1901";
  reel.artworks[0].museum = "Fixture Museum";
  reel.music = { src: "reel-audio/AFM-DE03-07.wav", trackId: "AFM-DE03-07", subfamily: "DE03", volume: 0.18, start: 0, durationSeconds: 120, fadeIn: 0.6, fadeOut: 1.5 };
  const paths = resolveReleasePaths({ reelId, outputDirectory, reelDirectory, artworkTitle: reel.artworks[0].title });
  await Promise.all([
    mkdir(reelDirectory, { recursive: true }),
    mkdir(join(outputDirectory, "renders"), { recursive: true }),
    mkdir(join(outputDirectory, "social"), { recursive: true }),
    mkdir(join(outputDirectory, "qc", reelId), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.reelData, JSON.stringify(reel)),
    writeFile(paths.video, "video bytes"),
    writeFile(paths.caption, "Canonical caption\n\nMUSIC SUGGESTIONS\n-----------------\n\n1. Artist — Song\n"),
    writeFile(paths.qcContactSheet, "contact sheet bytes"),
  ]);
  return { root, outputDirectory, reelDirectory, reelId, paths };
};

const stagedDirectoriesFor = async (fixture: Fixture): Promise<string[]> => {
  const releases = join(fixture.outputDirectory, "releases");
  if (!existsSync(releases)) return [];
  return (await readdir(releases)).filter((entry) => entry.startsWith(`.${fixture.reelId}.`));
};

const run = async (): Promise<void> => {
  const fixture = await createFixture();
  const fixedDate = new Date("2026-09-05T00:00:00.000Z");
  const releaseDirectory = resolveReleaseDirectory(fixture.reelId, fixture.outputDirectory);
  truthy(!relative(join(fixture.outputDirectory, "releases"), releaseDirectory).startsWith(".."), "release destination remains inside output/releases");
  await rejects(async () => { resolveReleaseDirectory("../outside", fixture.outputDirectory); }, "not safe", "path traversal is rejected");
  await rejects(async () => { resolveReleaseDirectory("/absolute", fixture.outputDirectory); }, "not safe", "absolute reel ID is rejected");

  const sourceBytes = await Promise.all([fixture.paths.video, fixture.paths.caption, fixture.paths.qcContactSheet].map((path) => readFile(path, "utf8")));
  const packaged = await packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, createdAt: fixedDate, verifyMedia });
  equal(packaged.directory, releaseDirectory, "package returns deterministic release path");
  const expectedFiles = ["reel.mp4", "caption.txt", "metadata.json", "manifest.json", "qc/contact-sheet.png"];
  for (const file of expectedFiles) truthy(Boolean(await readFile(join(releaseDirectory, file))), `${file} is packaged`);
  equal(await readFile(join(releaseDirectory, "caption.txt"), "utf8"), "Canonical caption\n", "caption excludes human-only music suggestions");
  equal(JSON.stringify(sourceBytes), JSON.stringify(await Promise.all([fixture.paths.video, fixture.paths.caption, fixture.paths.qcContactSheet].map((path) => readFile(path, "utf8")))), "source artifacts remain unchanged");

  const metadata = JSON.parse(await readFile(join(releaseDirectory, "metadata.json"), "utf8"));
  const sourceReel = JSON.parse(await readFile(fixture.paths.reelData, "utf8"));
  equal(metadata.canonicalId, fixture.reelId, "metadata canonical ID comes from ReelData");
  equal(metadata.artist, sourceReel.artworks[0].artist, "metadata artwork fields come from ReelData");
  equal(metadata.artworkTitle, sourceReel.artworks[0].title, "metadata artwork title comes from ReelData");
  equal(metadata.hook, sourceReel.hook, "metadata hook comes from ReelData");
  equal(metadata.musicTrackId, "AFM-DE03-07", "release metadata preserves selected AFM track identity");
  equal(metadata.musicSubfamily, "DE03", "release metadata preserves AFM subfamily identity");
  equal(metadata.generatedAt, fixedDate.toISOString(), "metadata contains packaging time only");
  const expectedMetadata = createReleaseMetadata(structuredClone(getSampleReel("inside-the-painting")), "inside-the-painting", fixedDate.toISOString());
  truthy(expectedMetadata.durationSeconds > 0, "metadata helper derives duration from validated ReelData");

  const manifest = JSON.parse(await readFile(join(releaseDirectory, "manifest.json"), "utf8"));
  equal(manifest.version, "artfolio-release-v1", "manifest records release format");
  truthy(!("cover" in manifest.files), "cover is excluded from the post-render package contract");
  for (const path of Object.values(manifest.files) as string[]) truthy(!path.startsWith("/") && !path.includes(fixture.root), "manifest contains only relative release paths");
  equal(manifest.sha256["reel.mp4"], await sha256File(join(releaseDirectory, "reel.mp4")), "manifest hashes final video bytes");
  equal((await verifyReleasePackage({ releaseDirectory, reelDirectory: fixture.reelDirectory, verifyMedia })).valid, true, "valid release manifest, hashes, metadata, and media verify");

  for (const failure of ["AFM library missing", "eligible AFM catalog empty", "selected AFM master missing", "audio localization failure"]) {
    const musicFailure = await createFixture(`music-${failure.replace(/ /g, "-")}`);
    const visualOnlyReel = JSON.parse(await readFile(musicFailure.paths.reelData, "utf8"));
    delete visualOnlyReel.music;
    await writeFile(musicFailure.paths.reelData, JSON.stringify(visualOnlyReel));
    await rejects(() => packageRelease({ reelId: musicFailure.reelId, outputDirectory: musicFailure.outputDirectory, reelDirectory: musicFailure.reelDirectory, verifyMedia }), "usable AFM", `${failure}: visual-only ReelData is not release-ready`);
    truthy(!existsSync(resolveReleaseDirectory(musicFailure.reelId, musicFailure.outputDirectory)), `${failure}: no release-ready package is created`);
  }

  const disappearedAudio = await createFixture("audio-disappeared-before-final-render");
  const failOnlyUnderDeepVerification: ReleaseMediaVerifier = async (path, expectations, options = {}) => {
    if (expectations.requireAudio && options.deep) throw new Error("Selected music audio is silent or inaudible");
    return verifyMedia(path, expectations, options);
  };
  await rejects(() => packageRelease({ reelId: disappearedAudio.reelId, outputDirectory: disappearedAudio.outputDirectory, reelDirectory: disappearedAudio.reelDirectory, verifyMedia: failOnlyUnderDeepVerification }), "silent or inaudible", "deep verification rejects audio that disappears before final render");
  truthy(!existsSync(resolveReleaseDirectory(disappearedAudio.reelId, disappearedAudio.outputDirectory)), "deep audio verification failure leaves no release-ready package");

  await rejects(() => packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, createdAt: fixedDate, verifyMedia }), "exists. Pass --overwrite", "existing release refuses overwrite by default");
  await writeFile(fixture.paths.video, "replacement video bytes");
  await packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, overwrite: true, createdAt: fixedDate, verifyMedia });
  equal(await readFile(join(releaseDirectory, "reel.mp4"), "utf8"), "replacement video bytes", "overwrite safely replaces completed release");

  const missing = await createFixture("missing-video");
  await writeFile(missing.paths.video, "");
  await rejects(() => packageRelease({ reelId: missing.reelId, outputDirectory: missing.outputDirectory, reelDirectory: missing.reelDirectory, verifyMedia }), "rendered Reel MP4", "missing required artifact fails clearly");
  truthy(!existsSync(resolveReleaseDirectory(missing.reelId, missing.outputDirectory)), "no final release remains after missing artifact failure");

  const captionFailure = await createFixture("caption-failure");
  await writeFile(captionFailure.paths.caption, "\nMUSIC SUGGESTIONS\n-----------------\n\n1. Artist — Song\n");
  await rejects(() => packageRelease({ reelId: captionFailure.reelId, outputDirectory: captionFailure.outputDirectory, reelDirectory: captionFailure.reelDirectory, verifyMedia }), "caption is empty", "invalid staged caption fails clearly");
  truthy(!existsSync(resolveReleaseDirectory(captionFailure.reelId, captionFailure.outputDirectory)), "staged failure leaves no partial final release");
  equal((await stagedDirectoriesFor(captionFailure)).length, 0, "staging directory is cleaned after failed packaging");

  const hashMismatch = await createFixture("hash-mismatch");
  await packageRelease({ reelId: hashMismatch.reelId, outputDirectory: hashMismatch.outputDirectory, reelDirectory: hashMismatch.reelDirectory, verifyMedia });
  const hashMismatchDirectory = resolveReleaseDirectory(hashMismatch.reelId, hashMismatch.outputDirectory);
  await writeFile(join(hashMismatchDirectory, "caption.txt"), "tampered caption");
  const hashMismatchResult = await verifyReleasePackage({ releaseDirectory: hashMismatchDirectory, reelDirectory: hashMismatch.reelDirectory, verifyMedia });
  truthy(hashMismatchResult.errors.some((error) => error.includes("SHA-256 mismatch")), "release hash mismatch is detected");

  const reelMismatch = await createFixture("reel-mismatch");
  await packageRelease({ reelId: reelMismatch.reelId, outputDirectory: reelMismatch.outputDirectory, reelDirectory: reelMismatch.reelDirectory, verifyMedia });
  const changedReel = JSON.parse(await readFile(reelMismatch.paths.reelData, "utf8"));
  changedReel.title = "Changed after packaging";
  await writeFile(reelMismatch.paths.reelData, JSON.stringify(changedReel));
  const reelMismatchResult = await verifyReleasePackage({ releaseDirectory: resolveReleaseDirectory(reelMismatch.reelId, reelMismatch.outputDirectory), reelDirectory: reelMismatch.reelDirectory, verifyMedia });
  truthy(reelMismatchResult.errors.some((error) => error.includes("metadata does not match")), "release ReelData mismatch is detected");

  const mediaMismatch = await createFixture("media-mismatch");
  await packageRelease({ reelId: mediaMismatch.reelId, outputDirectory: mediaMismatch.outputDirectory, reelDirectory: mediaMismatch.reelDirectory, verifyMedia });
  const mediaMismatchResult = await verifyReleasePackage({
    releaseDirectory: resolveReleaseDirectory(mediaMismatch.reelId, mediaMismatch.outputDirectory),
    reelDirectory: mediaMismatch.reelDirectory,
    verifyMedia: async () => { throw new Error("unexpected dimensions"); },
  });
  truthy(mediaMismatchResult.errors.some((error) => error.includes("Invalid release MP4") && error.includes("unexpected dimensions")), "release MP4 metadata mismatch is detected");

  console.log("Release package tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
