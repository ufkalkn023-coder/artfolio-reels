import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getSampleReel } from "../src/v2/samples";
import {
  createReleaseMetadata,
  packageRelease,
  resolveReleaseDirectory,
  resolveReleasePaths,
  sha256File,
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
  const packaged = await packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, createdAt: fixedDate });
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
  equal(metadata.generatedAt, fixedDate.toISOString(), "metadata contains packaging time only");
  const expectedMetadata = createReleaseMetadata(structuredClone(getSampleReel("inside-the-painting")), "inside-the-painting", fixedDate.toISOString());
  truthy(expectedMetadata.durationSeconds > 0, "metadata helper derives duration from validated ReelData");

  const manifest = JSON.parse(await readFile(join(releaseDirectory, "manifest.json"), "utf8"));
  equal(manifest.version, "artfolio-release-v1", "manifest records release format");
  truthy(!("cover" in manifest.files), "cover is excluded from the post-render package contract");
  for (const path of Object.values(manifest.files) as string[]) truthy(!path.startsWith("/") && !path.includes(fixture.root), "manifest contains only relative release paths");
  equal(manifest.sha256["reel.mp4"], await sha256File(join(releaseDirectory, "reel.mp4")), "manifest hashes final video bytes");

  await rejects(() => packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, createdAt: fixedDate }), "exists. Pass --overwrite", "existing release refuses overwrite by default");
  await writeFile(fixture.paths.video, "replacement video bytes");
  await packageRelease({ reelId: fixture.reelId, outputDirectory: fixture.outputDirectory, reelDirectory: fixture.reelDirectory, overwrite: true, createdAt: fixedDate });
  equal(await readFile(join(releaseDirectory, "reel.mp4"), "utf8"), "replacement video bytes", "overwrite safely replaces completed release");

  const missing = await createFixture("missing-video");
  await writeFile(missing.paths.video, "");
  await rejects(() => packageRelease({ reelId: missing.reelId, outputDirectory: missing.outputDirectory, reelDirectory: missing.reelDirectory }), "rendered Reel MP4", "missing required artifact fails clearly");
  truthy(!existsSync(resolveReleaseDirectory(missing.reelId, missing.outputDirectory)), "no final release remains after missing artifact failure");

  const captionFailure = await createFixture("caption-failure");
  await writeFile(captionFailure.paths.caption, "\nMUSIC SUGGESTIONS\n-----------------\n\n1. Artist — Song\n");
  await rejects(() => packageRelease({ reelId: captionFailure.reelId, outputDirectory: captionFailure.outputDirectory, reelDirectory: captionFailure.reelDirectory }), "caption is empty", "invalid staged caption fails clearly");
  truthy(!existsSync(resolveReleaseDirectory(captionFailure.reelId, captionFailure.outputDirectory)), "staged failure leaves no partial final release");
  equal((await stagedDirectoriesFor(captionFailure)).length, 0, "staging directory is cleaned after failed packaging");

  console.log("Release package tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
