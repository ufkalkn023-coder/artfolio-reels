import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { emptyReelProductionHistory, ReelProductionHistorySchema } from "../src/planner/production-history";
import { getSampleReel } from "../src/v2/samples";
import { type ReelData } from "../src/v2/schema";
import { createScenePlan } from "../src/v2/timing";
import { localizeAfmTrack, parseAfmTrackId, scanAfmCatalog, type AfmTrack } from "../src/music/afm";
import { attachMusic } from "../src/music/enrichment";
import { deriveMusicIntent } from "../src/music/intent";
import { selectMusicForCompletedReel } from "../src/music/selector";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const throws = (operation: () => unknown, label: string): void => {
  try { operation(); } catch { return; }
  throw new Error(`${label}: expected an error`);
};

const completedReel = (pace: "slow" | "fast"): ReelData => {
  const reel = structuredClone(getSampleReel("why-this-works"));
  reel.id = "same-artwork";
  reel.artworks[0].id = "same-artwork";
  reel.hook = "How do repeated lines create rhythm?";
  reel.centralIdea = "Repeated geometric lines create a clear visual rhythm.";
  reel.scenes = createScenePlan(reel).map((scene) => ({
    id: scene.id,
    kind: scene.kind,
    seconds: pace === "slow" ? 3.75 : 2.5,
    camera: { move: pace === "slow" ? "none" as const : "pan-right" as const },
  }));
  return reel;
};

const track = (id: string, familyName: string, subfamilyName: string, variation: string): AfmTrack => {
  const parsed = parseAfmTrackId(id);
  return {
    id: parsed.id,
    familyCode: parsed.familyCode,
    familyName,
    subfamilyCode: parsed.subfamilyCode,
    subfamilyName,
    variation,
    variationSlot: parsed.slot,
    rating: 4,
    durationSeconds: 120,
    masterPath: `/afm/${id}.wav`,
  };
};

const run = async (): Promise<void> => {
const candidates = [
  track("AFM-MA01-04", "Minimal Ambient", "Museum Stillness", "Ambient / Atmospheric Variation"),
  track("AFM-AE01-07", "Abstract Electronic", "Geometric Pulse", "Rhythmic Variation"),
  track("AFM-CP01-07", "Curious / Playful", "Kinetic Detail", "Rhythmic Variation"),
];
const slowReel = completedReel("slow");
const fastReel = completedReel("fast");
const slowIntent = deriveMusicIntent(slowReel);
const fastIntent = deriveMusicIntent(fastReel);
equal(slowIntent.pacing, "slow", "completed slow Reel produces slow intent");
equal(fastIntent.pacing, "fast", "completed fast Reel produces fast intent");
truthy(fastIntent.motionIntensity > slowIntent.motionIntensity, "completed scene cameras drive motion intent");
truthy(fastIntent.energy > slowIntent.energy, "same artwork with a faster edit produces higher music energy");

const empty = emptyReelProductionHistory();
const slowSelection = selectMusicForCompletedReel(slowReel, candidates, empty);
const fastSelection = selectMusicForCompletedReel(fastReel, candidates, empty);
equal(slowSelection?.track.familyCode, "MA", "slow contemplative Reel favors an ambient family");
truthy(["AE", "CP"].includes(fastSelection?.track.familyCode ?? ""), "fast motion-heavy Reel favors a rhythmic family");
truthy(slowSelection?.track.familyCode !== fastSelection?.track.familyCode, "same artwork with different Reel plans can select different families");
equal(selectMusicForCompletedReel(fastReel, candidates, empty)?.track.id, fastSelection?.track.id, "selector is deterministic");

const historyEntry = (canonicalId: string, musicTrackId: string, day: number) => ({
  canonicalId,
  artist: "Artwork Artist",
  museum: "Museum",
  source: "test",
  template: "why-this-works",
  batchId: "music-test",
  status: "QC_PASSED" as const,
  qcPassedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  musicTrackId,
  musicSubfamily: parseAfmTrackId(musicTrackId).subfamilyCode,
});
const bestFastId = fastSelection?.track.id;
if (!bestFastId) throw new Error("fast selection fixture failed");
const bestFastTrack = candidates.find(({ id }) => id === bestFastId);
if (!bestFastTrack) throw new Error("selected fast track is missing from fixture catalog");
const recentHistory = ReelProductionHistorySchema.parse({ version: "reel-production-history-v1", entries: [historyEntry("prior", bestFastId, 1)] });
truthy(selectMusicForCompletedReel(fastReel, candidates, recentHistory)?.track.id !== bestFastId, "recent track exclusion avoids immediate reuse");
const outsideWindowHistory = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: [
    historyEntry("outside-window", bestFastId, 1),
    ...Array.from({ length: 12 }, (_, index) => ({
      canonicalId: `newer-reel-${index}`, artist: "Artwork Artist", museum: "Museum", source: "test",
      template: "why-this-works", batchId: "music-test", status: "QC_PASSED" as const,
      qcPassedAt: `2026-09-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`,
    })),
  ],
});
equal(selectMusicForCompletedReel(fastReel, [bestFastTrack], outsideWindowHistory)?.recentExclusionFallback, false, "recent exclusion uses the latest twelve Reels, not twelve music-bearing entries");
const allRecent = ReelProductionHistorySchema.parse({ version: "reel-production-history-v1", entries: candidates.map((candidate, index) => historyEntry(`prior-${index}`, candidate.id, index + 1)) });
equal(selectMusicForCompletedReel(fastReel, candidates, allRecent)?.recentExclusionFallback, true, "empty fresh candidate set falls back to recent-use penalties");
equal(selectMusicForCompletedReel(slowReel, candidates, empty, { forcedTrackId: "AFM-AE01-07" })?.track.id, "AFM-AE01-07", "forced accepted track overrides scoring after Reel completion");
throws(() => selectMusicForCompletedReel(slowReel, candidates, empty, { forcedTrackId: "invalid" }), "invalid forced AFM ID fails");
throws(() => selectMusicForCompletedReel(slowReel, candidates, empty, { forcedTrackId: "AFM-DE03-07" }), "missing forced catalog track fails");

const selected = slowSelection;
if (!selected) throw new Error("slow selection fixture failed");
const original = JSON.stringify(slowReel);
const enriched = attachMusic(slowReel, selected, { publicPath: "reel-audio/AFM-MA01-04.wav", filesystemPath: "/tmp/AFM-MA01-04.wav", method: "hard-link" }, { volume: 0.18, fadeInSeconds: 0.6, fadeOutSeconds: 1.5 });
equal(JSON.stringify(slowReel), original, "music enrichment does not mutate visual ReelData");
equal(enriched.music?.trackId, selected.track.id, "music enrichment attaches AFM identity to existing audio schema");

const root = await mkdtemp(join(tmpdir(), "artfolio-afm-catalog-"));
const familyDirectory = join(root, "01-Dreamy-Ethereal");
const subfamilyDirectory = join(familyDirectory, "DE03-Aquatic-Shimmer");
const writeTrack = async (id: string, acceptedPath: string, metadataStatus = "ACCEPTED"): Promise<void> => {
  const directory = join(subfamilyDirectory, id);
  await mkdir(join(directory, "metadata"), { recursive: true });
  await mkdir(join(directory, "accepted"), { recursive: true });
  await writeFile(join(directory, "metadata", "track.json"), JSON.stringify({
    id, familyCode: "DE", subfamilyCode: "DE03", variation: "Rhythmic Variation", variationSlot: Number(id.slice(-2)),
    status: metadataStatus, tier: "PRODUCTION_READY", rating: 4, audio: { durationSeconds: 120 },
  }));
  if (acceptedPath === "local") await writeFile(join(directory, "accepted", `${id}.wav`), "immutable master");
};
await mkdir(join(root, "00-admin"), { recursive: true });
await writeFile(join(root, "00-admin", "catalog.json"), JSON.stringify({ DE: { name: "Dreamy / Ethereal", folder: "01-Dreamy-Ethereal", subfamilies: { "03": "Aquatic Shimmer" } } }));
await writeTrack("AFM-DE03-07", "local");
await writeTrack("AFM-DE03-08", "local", "REJECTED");
const outsideMaster = join(tmpdir(), `${basename(root)}-outside.wav`);
await writeFile(outsideMaster, "outside");
await writeTrack("AFM-DE03-09", "symlink");
await symlink(outsideMaster, join(subfamilyDirectory, "AFM-DE03-09", "accepted", "AFM-DE03-09.wav"));
const scanned = await scanAfmCatalog(root);
equal(scanned.tracks.map(({ id }) => id).join(","), "AFM-DE03-07", "catalog accepts only production-ready masters at validated accepted paths");

const publicDirectory = join(root, "public", "reel-audio");
const localized = await localizeAfmTrack(scanned.tracks[0], publicDirectory);
equal(localized.method, "hard-link", "same-filesystem AFM master uses a hard link");
const [masterStat, localizedStat] = await Promise.all([stat(scanned.tracks[0].masterPath), stat(localized.filesystemPath)]);
equal(`${masterStat.dev}:${masterStat.ino}`, `${localizedStat.dev}:${localizedStat.ino}`, "localized audio shares the immutable master inode");
equal(await readFile(scanned.tracks[0].masterPath, "utf8"), "immutable master", "catalog and localization never modify the master");

const unavailable = await scanAfmCatalog(join(root, "missing"));
equal(unavailable.available, false, "missing AFM library is reported without throwing");

console.log("Reel-first AFM music tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
