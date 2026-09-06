export const AFM_FAMILY_CODES = ["DE", "NP", "PS", "DM", "BC", "RC", "MA", "AE", "SU", "MM", "ID", "CP"] as const;
export type AfmFamilyCode = (typeof AFM_FAMILY_CODES)[number];

export type AfmFamilyProfile = {
  code: AfmFamilyCode;
  name: string;
  semanticKeywords: readonly string[];
};

export type AfmSubfamilyProfile = {
  code: string;
  familyCode: AfmFamilyCode;
  name: string;
  semanticKeywords: readonly string[];
};

export const AFM_FAMILY_PROFILES: readonly AfmFamilyProfile[] = [
  { code: "DE", name: "Dreamy / Ethereal", semanticKeywords: ["dreamy", "ethereal", "mist", "moonlit", "luminous", "flowing", "aquatic", "shimmer", "pastel", "reverie"] },
  { code: "NP", name: "Neo-Classical Piano", semanticKeywords: ["piano", "contemplative", "quiet", "sparse", "felt", "minimal", "editorial", "reflective"] },
  { code: "PS", name: "Piano + Strings", semanticKeywords: ["piano", "strings", "cello", "violin", "emotional", "figurative", "tender"] },
  { code: "DM", name: "Dark / Mysterious", semanticKeywords: ["dark", "mysterious", "shadow", "night", "midnight", "chiaroscuro", "tension", "ominous", "grief"] },
  { code: "BC", name: "Baroque-Inspired Chamber", semanticKeywords: ["baroque", "chamber", "harpsichord", "courtly", "classical", "counterpoint", "elegant", "architectural"] },
  { code: "RC", name: "Romantic Cinematic", semanticKeywords: ["romantic", "cinematic", "sweeping", "crescendo", "dramatic", "orchestral", "emotional", "tragic"] },
  { code: "MA", name: "Minimal Ambient", semanticKeywords: ["ambient", "minimal", "gallery", "stillness", "meditative", "drone", "airy", "spatial"] },
  { code: "AE", name: "Abstract Electronic", semanticKeywords: ["abstract", "electronic", "geometric", "geometry", "modular", "pulse", "digital", "nonfigurative", "repetition"] },
  { code: "SU", name: "Surreal / Uncanny", semanticKeywords: ["surreal", "uncanny", "dream", "strange", "ambiguous", "warped", "dissonant", "floating"] },
  { code: "MM", name: "Monumental / Majestic", semanticKeywords: ["monument", "monumental", "majestic", "grand", "historical", "ceremonial", "empire", "triumph", "heroic", "cathedral"] },
  { code: "ID", name: "Intimate / Delicate", semanticKeywords: ["intimate", "delicate", "fragile", "tender", "human", "warmth", "close", "whispered", "quiet"] },
  { code: "CP", name: "Curious / Playful", semanticKeywords: ["curious", "playful", "pizzicato", "discovery", "clever", "whimsy", "comic", "joy", "puzzle", "unexpected"] },
] as const;

/** The deliberately small first-pass benchmark surface, independent of current catalog availability. */
export const AFM_FIRST_PASS_SUBFAMILIES: readonly AfmSubfamilyProfile[] = [
  { code: "DE01", familyCode: "DE", name: "Impressionist Mist", semanticKeywords: ["impressionist", "mist", "luminous", "pastel"] },
  { code: "DE02", familyCode: "DE", name: "Moonlit Dream", semanticKeywords: ["moonlit", "dream", "night", "ethereal"] },
  { code: "NP01", familyCode: "NP", name: "Felt Piano Intimate", semanticKeywords: ["felt", "piano", "intimate", "warm"] },
  { code: "NP02", familyCode: "NP", name: "Sparse Minimal Piano", semanticKeywords: ["sparse", "minimal", "piano", "quiet"] },
  { code: "PS01", familyCode: "PS", name: "Piano + Solo Cello", semanticKeywords: ["piano", "solo", "cello", "emotional"] },
  { code: "PS02", familyCode: "PS", name: "Piano + Violin", semanticKeywords: ["piano", "violin", "strings", "tender"] },
  { code: "DM01", familyCode: "DM", name: "Chiaroscuro", semanticKeywords: ["chiaroscuro", "shadow", "contrast", "dark"] },
  { code: "DM02", familyCode: "DM", name: "Midnight Chamber", semanticKeywords: ["midnight", "night", "chamber", "mysterious"] },
  { code: "BC01", familyCode: "BC", name: "Harpsichord Minimal", semanticKeywords: ["harpsichord", "minimal", "courtly", "baroque"] },
  { code: "BC02", familyCode: "BC", name: "Baroque Strings", semanticKeywords: ["baroque", "strings", "classical", "chamber"] },
  { code: "RC01", familyCode: "RC", name: "Sweeping Romantic", semanticKeywords: ["sweeping", "romantic", "crescendo", "landscape"] },
  { code: "RC02", familyCode: "RC", name: "Tragic Romantic", semanticKeywords: ["tragic", "romantic", "grief", "dramatic"] },
  { code: "MA01", familyCode: "MA", name: "Warm Ambient", semanticKeywords: ["warm", "ambient", "organic", "meditative"] },
  { code: "MA02", familyCode: "MA", name: "Cold Ambient", semanticKeywords: ["cold", "ambient", "airy", "spatial"] },
  { code: "AE01", familyCode: "AE", name: "Modular Minimal", semanticKeywords: ["modular", "minimal", "electronic", "structured"] },
  { code: "AE02", familyCode: "AE", name: "Geometric Pulse", semanticKeywords: ["geometric", "pulse", "rhythmic", "repetition"] },
  { code: "SU01", familyCode: "SU", name: "Dream Logic", semanticKeywords: ["dream", "logic", "surreal", "floating"] },
  { code: "SU02", familyCode: "SU", name: "Uncanny Waltz", semanticKeywords: ["uncanny", "waltz", "warped", "strange"] },
  { code: "MM01", familyCode: "MM", name: "Grand Historical", semanticKeywords: ["grand", "historical", "ceremonial", "empire"] },
  { code: "MM02", familyCode: "MM", name: "Monumental Strings", semanticKeywords: ["monumental", "strings", "heroic", "majestic"] },
  { code: "ID01", familyCode: "ID", name: "Fragile Strings", semanticKeywords: ["fragile", "strings", "delicate", "tender"] },
  { code: "ID02", familyCode: "ID", name: "Intimate Piano", semanticKeywords: ["intimate", "piano", "quiet", "close"] },
  { code: "CP01", familyCode: "CP", name: "Pizzicato Curiosity", semanticKeywords: ["pizzicato", "curious", "discovery", "detail"] },
  { code: "CP02", familyCode: "CP", name: "Playful Piano", semanticKeywords: ["playful", "piano", "comic", "joy"] },
] as const;

export const isAfmFamilyCode = (value: string): value is AfmFamilyCode => AFM_FAMILY_CODES.includes(value as AfmFamilyCode);
