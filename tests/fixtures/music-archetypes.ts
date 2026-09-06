import { getSampleReel } from "../../src/v2/samples";
import { type CameraSettings, type ReelData } from "../../src/v2/schema";
import { createScenePlan } from "../../src/v2/timing";
import { type FirstPassFamilyCode } from "./music-catalog";

type Pace = "slow" | "medium" | "fast";

export type MusicArchetype = {
  name: string;
  expectedFamily: FirstPassFamilyCode;
  incompatibleFamily: FirstPassFamilyCode;
  reel: ReelData;
};

const paceSettings: Record<Pace, { seconds: number; move: CameraSettings["move"] }> = {
  slow: { seconds: 4.4, move: "detail-hold" },
  medium: { seconds: 3.35, move: "reveal" },
  fast: { seconds: 2.45, move: "pan-right" },
};

export const createArchetypeReel = (input: {
  id: string;
  words: string;
  pace: Pace;
  visualTone?: string;
  textDensity?: ReelData["textDensity"];
  date?: string;
  artist?: string;
  medium?: string;
}): ReelData => {
  const reel = structuredClone(getSampleReel("why-this-works"));
  const setting = paceSettings[input.pace];
  reel.id = input.id;
  reel.title = input.words.slice(0, 72);
  reel.hook = input.words.slice(0, 120);
  reel.centralIdea = input.words.slice(0, 180);
  reel.observations = [input.words.slice(0, 120), input.words.slice(0, 120), input.words.slice(0, 120)];
  reel.visualTone = input.visualTone;
  reel.textDensity = input.textDensity ?? "low";
  reel.artworks[0].id = input.id;
  reel.artworks[0].title = input.words.slice(0, 72);
  reel.artworks[0].artist = input.artist ?? "Fixture Artist";
  reel.artworks[0].date = input.date ?? "1900";
  reel.artworks[0].medium = input.medium ?? "Oil on canvas";
  reel.artworks[0].detailPoints = reel.artworks[0].detailPoints.map((detail) => ({
    ...detail,
    label: input.words.slice(0, 36),
    observation: input.words.slice(0, 120),
  }));
  reel.scenes = createScenePlan(reel).map((scene) => ({
    id: scene.id,
    kind: scene.kind,
    seconds: setting.seconds,
    ...(scene.detailIndex === undefined ? {} : { detailId: reel.artworks[0].detailPoints[scene.detailIndex]?.id }),
    ...(scene.observationIndex === undefined ? {} : { observationIndex: scene.observationIndex }),
    camera: { move: setting.move },
  }));
  return reel;
};

const cases: Array<Omit<MusicArchetype, "reel"> & Parameters<typeof createArchetypeReel>[0]> = [
  { name: "luminous landscape", expectedFamily: "DE", incompatibleFamily: "DM", id: "de-landscape", words: "dreamy ethereal luminous mist moonlit flowing landscape", pace: "slow" },
  { name: "aquatic portrait", expectedFamily: "DE", incompatibleFamily: "MM", id: "de-aquatic", words: "soft reflective aquatic shimmer pastel reverie portrait", pace: "slow" },
  { name: "felt piano portrait", expectedFamily: "NP", incompatibleFamily: "AE", id: "np-portrait", words: "quiet contemplative sparse intimate felt piano portrait", pace: "slow" },
  { name: "minimal editorial", expectedFamily: "NP", incompatibleFamily: "CP", id: "np-editorial", words: "neo classical piano sparse minimal reflective editorial", pace: "slow" },
  { name: "cello reveal", expectedFamily: "PS", incompatibleFamily: "AE", id: "ps-cello", words: "emotional figurative piano solo cello intimate dramatic reveal", pace: "medium" },
  { name: "violin painting", expectedFamily: "PS", incompatibleFamily: "CP", id: "ps-violin", words: "tender tragic portrait piano violin strings emotional", pace: "medium" },
  { name: "chiaroscuro tension", expectedFamily: "DM", incompatibleFamily: "CP", id: "dm-shadow", words: "dark shadow chiaroscuro mysterious psychological tension portrait", pace: "slow", visualTone: "dark moody" },
  { name: "midnight chamber", expectedFamily: "DM", incompatibleFamily: "DE", id: "dm-midnight", words: "midnight chamber black grief ominous shadow", pace: "medium", visualTone: "somber dark" },
  { name: "courtly baroque", expectedFamily: "BC", incompatibleFamily: "AE", id: "bc-court", words: "baroque harpsichord courtly elegant chamber counterpoint", pace: "medium", date: "1720" },
  { name: "baroque architecture", expectedFamily: "BC", incompatibleFamily: "CP", id: "bc-architecture", words: "baroque strings classical palace restrained architectural composition", pace: "slow", date: "1685" },
  { name: "romantic crescendo", expectedFamily: "RC", incompatibleFamily: "MA", id: "rc-crescendo", words: "sweeping romantic cinematic emotional crescendo dramatic landscape", pace: "medium" },
  { name: "tragic romantic", expectedFamily: "RC", incompatibleFamily: "CP", id: "rc-tragic", words: "tragic romantic orchestral drama storm grief grand reveal", pace: "medium", visualTone: "somber" },
  { name: "warm gallery", expectedFamily: "MA", incompatibleFamily: "MM", id: "ma-warm", words: "warm ambient gallery stillness meditative minimal space", pace: "slow" },
  { name: "cold ambient", expectedFamily: "MA", incompatibleFamily: "CP", id: "ma-cold", words: "cold ambient drone airy minimal spatial observation", pace: "slow", textDensity: "low" },
  { name: "geometric pulse", expectedFamily: "AE", incompatibleFamily: "BC", id: "ae-geometry", words: "abstract electronic geometric pulse modular repetition modern", pace: "fast" },
  { name: "structured abstraction", expectedFamily: "AE", incompatibleFamily: "NP", id: "ae-structure", words: "nonfigurative abstract geometry digital rhythmic structured forms", pace: "fast" },
  { name: "dream logic", expectedFamily: "SU", incompatibleFamily: "BC", id: "su-dream", words: "surreal uncanny dream logic strange ambiguous floating reality", pace: "medium", visualTone: "moody" },
  { name: "uncanny waltz", expectedFamily: "SU", incompatibleFamily: "DE", id: "su-waltz", words: "uncanny waltz dissonant warped psychological surreal night", pace: "medium", visualTone: "dark" },
  { name: "grand historical", expectedFamily: "MM", incompatibleFamily: "ID", id: "mm-history", words: "monumental majestic grand historical ceremonial empire triumph", pace: "medium", date: "1810" },
  { name: "monumental strings", expectedFamily: "MM", incompatibleFamily: "MA", id: "mm-strings", words: "monumental strings cathedral architectural scale heroic world", pace: "medium" },
  { name: "fragile portrait", expectedFamily: "ID", incompatibleFamily: "MM", id: "id-fragile", words: "intimate delicate fragile strings tender human warmth close portrait", pace: "slow" },
  { name: "quiet piano", expectedFamily: "ID", incompatibleFamily: "AE", id: "id-piano", words: "intimate piano quiet reflection whispered delicate detail", pace: "slow" },
  { name: "pizzicato discovery", expectedFamily: "CP", incompatibleFamily: "DM", id: "cp-pizzicato", words: "curious playful pizzicato discovery clever detail whimsy", pace: "fast" },
  { name: "playful piano", expectedFamily: "CP", incompatibleFamily: "MM", id: "cp-piano", words: "playful piano comic joy unexpected museum puzzle", pace: "fast" },
];

export const MUSIC_ARCHETYPES: MusicArchetype[] = cases.map(({ name, expectedFamily, incompatibleFamily, ...input }) => ({
  name,
  expectedFamily,
  incompatibleFamily,
  reel: createArchetypeReel(input),
}));
