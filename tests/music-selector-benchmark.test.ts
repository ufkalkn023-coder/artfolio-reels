import { deriveMusicIntent } from "../src/music/intent";
import { rankMusicFamilies } from "../src/music/selector";
import { MUSIC_ARCHETYPES } from "./fixtures/music-archetypes";
import { createSyntheticAfmCatalog, FIRST_PASS_SUBFAMILIES } from "./fixtures/music-catalog";

const catalog = createSyntheticAfmCatalog();
const failures: string[] = [];
const familyResults = new Map<string, { total: number; topThree: number }>();

for (const archetype of MUSIC_ARCHETYPES) {
  const rankedFamilies = rankMusicFamilies(deriveMusicIntent(archetype.reel));
  const expectedIndex = rankedFamilies.findIndex((family) => family.code === archetype.expectedFamily);
  const incompatibleIndex = rankedFamilies.findIndex((family) => family.code === archetype.incompatibleFamily);
  const result = familyResults.get(archetype.expectedFamily) ?? { total: 0, topThree: 0 };
  result.total += 1;
  if (expectedIndex >= 0 && expectedIndex < 3) result.topThree += 1;
  familyResults.set(archetype.expectedFamily, result);
  if (expectedIndex < 0 || expectedIndex >= 3) failures.push(`${archetype.name}: ${archetype.expectedFamily} ranked ${expectedIndex + 1}; top=${rankedFamilies.slice(0, 4).map((family) => family.code).join(",")}`);
  if (expectedIndex >= incompatibleIndex) failures.push(`${archetype.name}: ${archetype.expectedFamily} did not beat incompatible ${archetype.incompatibleFamily}`);
  const expectedScore = rankedFamilies[expectedIndex]?.score ?? Number.NEGATIVE_INFINITY;
  const incompatibleScore = rankedFamilies[incompatibleIndex]?.score ?? Number.POSITIVE_INFINITY;
  if (expectedScore - incompatibleScore < 0.2) failures.push(`${archetype.name}: expected/incompatible separation is only ${(expectedScore - incompatibleScore).toFixed(3)}`);
}

if (Object.values(FIRST_PASS_SUBFAMILIES).flat().length !== 24) failures.push("fixture must cover exactly 24 first-pass subfamilies");
if (catalog.length !== 48) failures.push("fixture must provide two tracks per first-pass subfamily");

if (failures.length > 0) {
  const summary = [...familyResults].map(([family, result]) => `${family}=${result.topThree}/${result.total}`).join(" ");
  throw new Error(`12-family benchmark failed (${summary})\n${failures.join("\n")}`);
}

console.log("12-family selector benchmark passed");
