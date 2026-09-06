import { parseAfmTrackId, type AfmTrack } from "../../src/music/afm";

export const FIRST_PASS_SUBFAMILIES = {
  DE: ["Impressionist Mist", "Moonlit Dream"],
  NP: ["Felt Piano Intimate", "Sparse Minimal Piano"],
  PS: ["Piano + Solo Cello", "Piano + Violin"],
  DM: ["Chiaroscuro", "Midnight Chamber"],
  BC: ["Harpsichord Minimal", "Baroque Strings"],
  RC: ["Sweeping Romantic", "Tragic Romantic"],
  MA: ["Warm Ambient", "Cold Ambient"],
  AE: ["Modular Minimal", "Geometric Pulse"],
  SU: ["Dream Logic", "Uncanny Waltz"],
  MM: ["Grand Historical", "Monumental Strings"],
  ID: ["Fragile Strings", "Intimate Piano"],
  CP: ["Pizzicato Curiosity", "Playful Piano"],
} as const;

export type FirstPassFamilyCode = keyof typeof FIRST_PASS_SUBFAMILIES;

export const FAMILY_NAMES: Record<FirstPassFamilyCode, string> = {
  DE: "Dreamy / Ethereal",
  NP: "Neo-Classical Piano",
  PS: "Piano + Strings",
  DM: "Dark / Mysterious",
  BC: "Baroque-Inspired Chamber",
  RC: "Romantic Cinematic",
  MA: "Minimal Ambient",
  AE: "Abstract Electronic",
  SU: "Surreal / Uncanny",
  MM: "Monumental / Majestic",
  ID: "Intimate / Delicate",
  CP: "Curious / Playful",
};

const variations: Record<FirstPassFamilyCode, readonly [string, string]> = {
  DE: ["Ambient / Atmospheric Variation", "Organic / Acoustic Variation"],
  NP: ["Minimal Variation", "Lead-Instrument Variation"],
  PS: ["Organic / Acoustic Variation", "Signature Variation"],
  DM: ["Minimal Variation", "Experimental Variation"],
  BC: ["Organic / Acoustic Variation", "Lead-Instrument Variation"],
  RC: ["Signature Variation", "Organic / Acoustic Variation"],
  MA: ["Ambient / Atmospheric Variation", "Minimal Variation"],
  AE: ["Experimental Variation", "Rhythmic Variation"],
  SU: ["Experimental Variation", "Hybrid Variation"],
  MM: ["Signature Variation", "Rhythmic Variation"],
  ID: ["Organic / Acoustic Variation", "Minimal Variation"],
  CP: ["Rhythmic Variation", "Lead-Instrument Variation"],
};

/** Metadata-only accepted catalog fixture; no AFM files are read or written. */
export const createSyntheticAfmCatalog = (rating = 4): AfmTrack[] => Object.entries(FIRST_PASS_SUBFAMILIES)
  .flatMap(([familyCode, subfamilies]) => subfamilies.flatMap((subfamilyName, subfamilyIndex) => [1, 2].map((slot, variationIndex) => {
    const subfamilyCode = `${familyCode}${String(subfamilyIndex + 1).padStart(2, "0")}`;
    const id = `AFM-${subfamilyCode}-${String(slot).padStart(2, "0")}`;
    const parsed = parseAfmTrackId(id);
    return {
      id: parsed.id,
      familyCode,
      familyName: FAMILY_NAMES[familyCode as FirstPassFamilyCode],
      subfamilyCode,
      subfamilyName,
      variation: variations[familyCode as FirstPassFamilyCode][variationIndex],
      variationSlot: parsed.slot,
      rating,
      durationSeconds: 90,
      masterPath: `/synthetic-afm/${id}.wav`,
    };
  })))
  .sort((left, right) => left.id.localeCompare(right.id));
