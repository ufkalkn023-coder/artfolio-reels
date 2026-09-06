import { createScenePlan, getDurationInFrames } from "../v2/timing";
import { VIDEO } from "../v2/design";
import { type ReelData } from "../v2/schema";
import { assertValidReelData } from "../v2/templates";

export type MusicPacing = "slow" | "medium" | "fast";

export type MusicIntent = {
  mood: string[];
  energy: number;
  motionIntensity: number;
  pacing: MusicPacing;
  intimacy: number;
  darkness: number;
  grandeur: number;
  playfulness: number;
  abstraction: number;
  acousticPreference: number;
  electronicPreference: number;
  historicalAffinity: number;
  durationSeconds: number;
  sceneChangeRate: number;
  detailDensity: number;
  semanticTokens: string[];
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const normalize = (value: string): string => value
  .normalize("NFKD")
  .replace(/\p{Mark}/gu, "")
  .toLocaleLowerCase("en-US");
const tokens = (value: string): string[] => normalize(value).match(/[\p{Letter}\p{Number}]+/gu) ?? [];
// Require several independent words for a saturated semantic dimension.
const keywordSignal = (haystack: Set<string>, words: readonly string[]): number => clamp(words.filter((word) => haystack.has(word)).length / 3);

const CAMERA_MOTION: Record<string, number> = {
  none: 0,
  "detail-hold": 0.08,
  reveal: 0.42,
  "zoom-in": 0.58,
  "zoom-out": 0.52,
  "full-to-detail": 0.68,
  "detail-to-full": 0.64,
  "pan-left": 0.82,
  "pan-right": 0.82,
  "pan-up": 0.82,
  "pan-down": 0.82,
};

const DARK_WORDS = ["dark", "shadow", "night", "black", "death", "dead", "storm", "grief", "lamentation", "vanitas", "mysterious"];
const PLAYFUL_WORDS = ["play", "playful", "curious", "dance", "dancing", "bright", "comic", "joy", "whimsy", "rhythm"];
const ABSTRACT_WORDS = ["abstract", "geometric", "geometry", "pattern", "line", "lines", "form", "forms", "modern", "rhythm", "repetition"];
const GRAND_WORDS = ["monument", "monumental", "majestic", "palace", "cathedral", "empire", "triumph", "creation", "heaven", "world"];
const HISTORICAL_WORDS = ["classical", "baroque", "renaissance", "medieval", "antique", "historical", "chamber", "portrait", "altarpiece"];

/** Derives soundtrack intent only from an already compiled, immutable ReelData value. */
export const deriveMusicIntent = (input: ReelData): MusicIntent => {
  const reel = assertValidReelData(input);
  const scenes = createScenePlan(reel);
  const durationSeconds = getDurationInFrames(reel) / VIDEO.fps;
  const sceneChangeRate = scenes.length > 1 ? (scenes.length - 1) / durationSeconds : 0;
  const averageSceneSeconds = durationSeconds / scenes.length;
  const detailCount = scenes.filter((scene) => scene.kind === "detail" || scene.kind === "observation").length;
  const overviewCount = scenes.filter((scene) => scene.kind === "overview" || scene.kind === "comparison" || scene.kind === "metadata").length;
  const detailDensity = detailCount / scenes.length;
  const motionIntensity = clamp(scenes.reduce((sum, scene) => sum + (CAMERA_MOTION[scene.input?.camera?.move ?? reel.camera?.move ?? "none"] ?? 0), 0) / scenes.length);
  const pacing: MusicPacing = averageSceneSeconds <= 3 || sceneChangeRate >= 0.32
    ? "fast"
    : averageSceneSeconds >= 3.7 && sceneChangeRate <= 0.24
      ? "slow"
      : "medium";

  const semanticText = [
    reel.title,
    reel.hook,
    reel.centralIdea,
    reel.visualTone,
    ...reel.observations,
    // Artist and museum names are identity/provenance, not editorial soundtrack signals.
    ...reel.artworks.flatMap((artwork) => [artwork.title, artwork.date, artwork.medium ?? ""]),
    ...reel.artworks.flatMap((artwork) => artwork.detailPoints.flatMap((detail) => [detail.label, detail.observation ?? ""])),
  ].filter((value): value is string => typeof value === "string").join(" ");
  const semanticTokenSet = new Set(tokens(semanticText));
  const darkness = clamp(keywordSignal(semanticTokenSet, DARK_WORDS) * 0.72 + (reel.visualTone && /dark|moody|somber/i.test(reel.visualTone) ? 0.35 : 0));
  const abstraction = clamp(keywordSignal(semanticTokenSet, ABSTRACT_WORDS) * 0.62 + motionIntensity * 0.22);
  const grandeur = clamp(keywordSignal(semanticTokenSet, GRAND_WORDS) * 0.65 + overviewCount / scenes.length * 0.34);
  const historicalAffinity = clamp(keywordSignal(semanticTokenSet, HISTORICAL_WORDS) * 0.65 + (semanticTokenSet.has("oil") ? 0.12 : 0));
  const energy = clamp(
    motionIntensity * 0.48 +
    clamp((sceneChangeRate - 0.14) / 0.25) * 0.34 +
    (pacing === "fast" ? 0.18 : pacing === "slow" ? -0.08 : 0.05),
  );
  const playfulness = clamp(keywordSignal(semanticTokenSet, PLAYFUL_WORDS) * 0.58 + energy * 0.34 + (pacing === "fast" ? 0.16 : 0));
  const intimacy = clamp(detailDensity * 0.58 + (1 - energy) * 0.27 + (reel.textDensity === "low" ? 0.12 : 0));
  const electronicPreference = clamp(abstraction * 0.5 + motionIntensity * 0.3 + energy * 0.22 - historicalAffinity * 0.2);
  const acousticPreference = clamp(intimacy * 0.34 + historicalAffinity * 0.42 + (1 - electronicPreference) * 0.24);

  const mood = [
    ...(energy < 0.36 ? ["contemplative"] : []),
    ...(motionIntensity > 0.5 ? ["rhythmic"] : []),
    ...(intimacy > 0.62 ? ["intimate"] : []),
    ...(darkness > 0.42 ? ["dark"] : []),
    ...(playfulness > 0.55 ? ["curious", "playful"] : []),
    ...(grandeur > 0.58 ? ["majestic"] : []),
    ...(abstraction > 0.5 ? ["abstract"] : []),
  ];
  if (mood.length === 0) mood.push("reflective");

  return {
    mood: [...new Set(mood)],
    energy,
    motionIntensity,
    pacing,
    intimacy,
    darkness,
    grandeur,
    playfulness,
    abstraction,
    acousticPreference,
    electronicPreference,
    historicalAffinity,
    durationSeconds,
    sceneChangeRate,
    detailDensity,
    semanticTokens: [...new Set([...semanticTokenSet, ...mood, pacing])].sort(),
  };
};
