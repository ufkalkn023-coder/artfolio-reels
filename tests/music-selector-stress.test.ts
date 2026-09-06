import { emptyReelProductionHistory, ReelProductionHistorySchema } from "../src/planner/production-history";
import { deriveMusicIntent } from "../src/music/intent";
import {
  analyzeMusicForCompletedReel,
  rankMusicFamilies,
  rankMusicSubfamilies,
  selectMusicForCompletedReel,
} from "../src/music/selector";
import { AFM_FIRST_PASS_SUBFAMILIES } from "../src/music/taxonomy";
import { createScenePlan } from "../src/v2/timing";
import { createArchetypeReel } from "./fixtures/music-archetypes";
import { createSyntheticAfmCatalog } from "./fixtures/music-catalog";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const rankOf = (reel: ReturnType<typeof createArchetypeReel>, familyCode: string): number => rankMusicFamilies(deriveMusicIntent(reel)).findIndex((family) => family.code === familyCode);
const topFamily = (reel: ReturnType<typeof createArchetypeReel>): string => rankMusicFamilies(deriveMusicIntent(reel))[0].code;

const catalog = createSyntheticAfmCatalog();
const emptyHistory = emptyReelProductionHistory();

// All 24 first-pass subfamilies are represented and their own semantic probe beats the sibling profile.
equal(AFM_FIRST_PASS_SUBFAMILIES.length, 24, "first-pass taxonomy size");
for (const profile of AFM_FIRST_PASS_SUBFAMILIES) {
  const reel = createArchetypeReel({ id: `subfamily-${profile.code}`, words: profile.semanticKeywords.join(" "), pace: "medium" });
  const ranking = rankMusicSubfamilies(deriveMusicIntent(reel));
  const expected = ranking.find((candidate) => candidate.code === profile.code);
  const sibling = ranking.find((candidate) => candidate.familyCode === profile.familyCode && candidate.code !== profile.code);
  truthy(expected && sibling && expected.score > sibling.score, `${profile.code} semantic probe must beat its sibling subfamily`);
}

// Reel-first differential: identical artwork/editorial metadata, changed only by completed scene timing and camera motion.
const slow = createArchetypeReel({ id: "same-artwork", words: "repeated forms reveal measured visual rhythm", pace: "slow" });
const fast = createArchetypeReel({ id: "same-artwork", words: "repeated forms reveal measured visual rhythm", pace: "fast" });
slow.artworks = structuredClone(fast.artworks);
slow.title = fast.title;
slow.hook = fast.hook;
slow.centralIdea = fast.centralIdea;
slow.observations = structuredClone(fast.observations);
const slowIntent = deriveMusicIntent(slow);
const fastIntent = deriveMusicIntent(fast);
equal(slowIntent.pacing, "slow", "slow differential pacing");
equal(fastIntent.pacing, "fast", "fast differential pacing");
truthy(fastIntent.energy - slowIntent.energy > 0.35, "pacing materially changes energy");
truthy(fastIntent.motionIntensity - slowIntent.motionIntensity > 0.6, "camera plan materially changes motion");
truthy(topFamily(slow) !== topFamily(fast), "same artwork with a different completed edit changes ideal family ranking");

// Editorial semantics can change ranking while physical pacing remains identical.
const darkTone = createArchetypeReel({ id: "tone-dark", words: "chiaroscuro shadow mysterious psychological tension", pace: "medium", visualTone: "dark moody" });
const playfulTone = createArchetypeReel({ id: "tone-playful", words: "curious playful discovery clever comic joy", pace: "medium", visualTone: "bright playful" });
equal(deriveMusicIntent(darkTone).pacing, deriveMusicIntent(playfulTone).pacing, "tone comparison pacing");
truthy(rankOf(darkTone, "DM") < rankOf(darkTone, "CP"), "dark editorial tone favors DM over CP");
truthy(rankOf(playfulTone, "CP") < rankOf(playfulTone, "DM"), "playful editorial tone favors CP over DM");

// Conflicting/adversarial edits preserve multiple signals instead of collapsing to one metadata word.
const darkPlayful = createArchetypeReel({ id: "conflict-dark-playful", words: "dark portrait shadow playful curious discovery", pace: "fast", visualTone: "dark" });
const darkPlayfulTop = rankMusicFamilies(deriveMusicIntent(darkPlayful)).slice(0, 5).map((family) => family.code);
truthy(darkPlayfulTop.includes("DM") && darkPlayfulTop.includes("CP"), "dark/playful conflict keeps both relevant families competitive");
const historicGeometric = createArchetypeReel({ id: "conflict-historic-modern", words: "historical baroque artwork modern abstract geometric electronic pulse", pace: "fast", date: "1720" });
truthy(rankOf(historicGeometric, "AE") < rankOf(historicGeometric, "BC"), "modern geometric edit can outrank artwork period");
const intimateMotion = createArchetypeReel({ id: "conflict-intimate-motion", words: "intimate delicate close portrait fragile detail", pace: "fast" });
truthy(rankOf(intimateMotion, "ID") < 4, "intimate signal survives high motion");
const monumentalMinimal = createArchetypeReel({ id: "conflict-monumental-minimal", words: "monumental majestic ceremonial cathedral minimal contemplative", pace: "slow" });
truthy(rankOf(monumentalMinimal, "MM") < 3, "monumental signal survives contemplative pacing");

// Artist identity is excluded from semantic scoring; artwork period alone and one token remain bounded.
const neutral = createArchetypeReel({ id: "artist-neutral", words: "measured portrait study", pace: "medium", artist: "Neutral Artist" });
const namedArtist = structuredClone(neutral);
namedArtist.artworks[0].artist = "Dark Baroque Romantic Majestic";
equal(JSON.stringify(rankMusicFamilies(deriveMusicIntent(namedArtist))), JSON.stringify(rankMusicFamilies(deriveMusicIntent(neutral))), "artist name cannot dominate family selection");
const oneToken = structuredClone(neutral);
oneToken.centralIdea = `${oneToken.centralIdea} baroque`;
const neutralBc = rankMusicFamilies(deriveMusicIntent(neutral)).find((family) => family.code === "BC");
const tokenBc = rankMusicFamilies(deriveMusicIntent(oneToken)).find((family) => family.code === "BC");
truthy(Boolean(neutralBc && tokenBc && tokenBc.score - neutralBc.score <= 1.5), "one semantic token has a bounded score effect");

// Rating and subfamily refinements cannot erase an obviously stronger family fit.
const darkReel = createArchetypeReel({ id: "dominance-dark", words: "dark mysterious shadow chiaroscuro tension", pace: "slow", visualTone: "dark" });
const dmTrack = catalog.find((track) => track.familyCode === "DM" && track.subfamilyCode === "DM01");
const cpTrack = catalog.find((track) => track.familyCode === "CP" && track.subfamilyCode === "CP01");
if (!dmTrack || !cpTrack) throw new Error("dominance fixtures missing");
const ratingCatalog = [{ ...dmTrack, rating: 0 }, { ...cpTrack, rating: 5 }];
equal(selectMusicForCompletedReel(darkReel, ratingCatalog, emptyHistory)?.track.familyCode, "DM", "rating cannot beat obvious semantic family fit");

const historyEntry = (canonicalId: string, musicTrackId: string, index: number) => ({
  canonicalId,
  artist: "Fixture Artist",
  museum: "Fixture Museum",
  source: "test",
  template: "why-this-works",
  batchId: "music-stress",
  status: "QC_PASSED" as const,
  qcPassedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  musicTrackId,
  musicSubfamily: musicTrackId.slice(4, 8),
});
const ideal = selectMusicForCompletedReel(darkReel, catalog, emptyHistory);
if (!ideal) throw new Error("ideal selection missing");
const oneRecent = ReelProductionHistorySchema.parse({ version: "reel-production-history-v1", entries: [historyEntry("recent-1", ideal.track.id, 1)] });
truthy(selectMusicForCompletedReel(darkReel, catalog, oneRecent)?.track.id !== ideal.track.id, "one recent track is hard-excluded when alternatives exist");
const fourRecent = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: [ideal.track, ...catalog.filter((track) => track.id !== ideal.track.id).slice(0, 3)]
    .map((track, index) => historyEntry(`four-recent-${index}`, track.id, index)),
});
truthy(selectMusicForCompletedReel(darkReel, catalog, fourRecent)?.track.id !== ideal.track.id, "latest four Reel history excludes the ideal recent track when fresh alternatives exist");
const repeatedRecent = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: catalog.slice(0, 12).map((track, index) => historyEntry(`recent-${index}`, track.id, index)),
});
truthy(selectMusicForCompletedReel(darkReel, catalog, repeatedRecent) !== undefined, "partial recent history keeps a deterministic fresh selection");
const tinyCatalog = catalog.filter((track) => track.familyCode === "DM").slice(0, 2);
const allRecent = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: tinyCatalog.map((track, index) => historyEntry(`tiny-${index}`, track.id, index)),
});
const fallback = analyzeMusicForCompletedReel(darkReel, tinyCatalog, allRecent);
equal(fallback.recentExclusionFallback, true, "all-recent small catalog activates penalty fallback");
truthy(Boolean(fallback.selection), "all-recent fallback does not hard fail");
truthy(fallback.trackRanking.every((track) => track.score.recentPenalty > 0), "all-recent fallback exposes penalties");
const repeatedTrackHistory = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: Array.from({ length: 4 }, (_, index) => historyEntry(`repeat-${index}`, ideal.track.id, index)),
});
const repeatedTrackFallback = analyzeMusicForCompletedReel(darkReel, [ideal.track], repeatedTrackHistory);
truthy(Boolean(repeatedTrackFallback.selection && repeatedTrackFallback.selection.score.recentPenalty > 0 && repeatedTrackFallback.selection.score.totalUsePenalty > 0), "repeated-track fallback applies bounded recent and total-use penalties without a permanent ban");

// Catalog independence and deterministic tie-breaking/repetition.
const idealWithoutCatalog = analyzeMusicForCompletedReel(darkReel, [], emptyHistory);
equal(idealWithoutCatalog.familyRanking[0].code, analyzeMusicForCompletedReel(darkReel, catalog.filter((track) => track.familyCode === "DE"), emptyHistory).familyRanking[0].code, "ideal family ranking is catalog-independent");
const tied = [{ ...dmTrack, id: "AFM-DM01-02", variationSlot: 2 }, { ...dmTrack, id: "AFM-DM01-01", variationSlot: 1 }];
equal(selectMusicForCompletedReel(darkReel, tied, emptyHistory)?.track.id, "AFM-DM01-01", "ID is the deterministic final tie-break");
const repeated = Array.from({ length: 100 }, () => selectMusicForCompletedReel(darkReel, catalog, emptyHistory)?.track.id);
equal(new Set(repeated).size, 1, "100-run determinism");

// Duration/text/motion boundaries stay finite and keep cut rate separate from camera movement.
const veryShort = createArchetypeReel({ id: "very-short", words: "brief visual study", pace: "fast", textDensity: "low" });
veryShort.scenes = veryShort.scenes?.map((scene) => ({ ...scene, seconds: 0.5, camera: { move: "none" } }));
const veryLong = createArchetypeReel({ id: "very-long", words: "extended contemplative gallery observation with layered editorial text", pace: "slow", textDensity: "medium" });
veryLong.scenes = veryLong.scenes?.map((scene) => ({ ...scene, seconds: 7, camera: { move: "detail-hold" } }));
const shortIntent = deriveMusicIntent(veryShort);
const longIntent = deriveMusicIntent(veryLong);
equal(shortIntent.pacing, "fast", "very short Reel boundary");
equal(longIntent.pacing, "slow", "very long Reel boundary");
truthy(Number.isFinite(selectMusicForCompletedReel(veryShort, catalog, emptyHistory)?.score.total), "very short Reel score is finite");
truthy(Number.isFinite(selectMusicForCompletedReel(veryLong, catalog, emptyHistory)?.score.total), "very long/text-heavy Reel score is finite");
const highZoomLowCuts = createArchetypeReel({ id: "zoom-low-cuts", words: "measured portrait study", pace: "slow" });
highZoomLowCuts.scenes = highZoomLowCuts.scenes?.map((scene) => ({ ...scene, seconds: 4.4, camera: { move: "zoom-in" } }));
const highCutsLowMotion = createArchetypeReel({ id: "cuts-low-motion", words: "measured portrait study", pace: "fast" });
highCutsLowMotion.scenes = highCutsLowMotion.scenes?.map((scene) => ({ ...scene, seconds: 2.45, camera: { move: "none" } }));
const zoomIntent = deriveMusicIntent(highZoomLowCuts);
const cutIntent = deriveMusicIntent(highCutsLowMotion);
truthy(zoomIntent.motionIntensity > cutIntent.motionIntensity, "camera movement remains independent from cut rate");
truthy(cutIntent.sceneChangeRate > zoomIntent.sceneChangeRate, "cut rate remains independent from camera movement");
const ambiguous = createArchetypeReel({ id: "ambiguous", words: "dream dark playful grand abstract intimate", pace: "medium" });
equal(new Set(Array.from({ length: 20 }, () => topFamily(ambiguous))).size, 1, "ambiguous tokens remain deterministic");
const oneSceneInput = structuredClone(ambiguous);
oneSceneInput.scenes = oneSceneInput.scenes?.slice(0, 1);
const twoSceneInput = structuredClone(ambiguous);
twoSceneInput.scenes = twoSceneInput.scenes?.slice(0, 2);
equal(createScenePlan(oneSceneInput).length, 8, "one explicit scene input safely resolves through the registered template plan");
equal(createScenePlan(twoSceneInput).length, 8, "two explicit scene inputs safely resolve through the registered template plan");
truthy(Number.isFinite(selectMusicForCompletedReel(oneSceneInput, catalog, emptyHistory)?.score.total), "one-scene partial input remains analyzable");
truthy(Number.isFinite(selectMusicForCompletedReel(twoSceneInput, catalog, emptyHistory)?.score.total), "two-scene partial input remains analyzable");

// Repeating a subfamily does not incorrectly hard-exclude an unused sibling track; exclusion identity is track-level.
const siblingTracks = catalog.filter((track) => track.subfamilyCode === "DM01");
const siblingHistory = ReelProductionHistorySchema.parse({
  version: "reel-production-history-v1",
  entries: [historyEntry("same-subfamily", siblingTracks[0].id, 1)],
});
const siblingAnalysis = analyzeMusicForCompletedReel(darkReel, siblingTracks, siblingHistory);
truthy(siblingAnalysis.trackRanking.some((track) => track.track.id === siblingTracks[1].id && track.eligible), "unused track in a recent subfamily remains eligible");

console.log("Selector differential, dominance, recent-use, and determinism stress tests passed");
