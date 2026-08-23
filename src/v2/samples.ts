import { type ReelData } from "./schema";

const starryNight = {
  id: "starry-night",
  src: "artworks/starry-night.jpg",
  title: "The Starry Night",
  artist: "Vincent van Gogh",
  date: "1889",
  museum: "Museum of Modern Art, New York",
  orientation: "landscape" as const,
  detailPoints: [
    { id: "sky", label: "Sky", focalX: 0.52, focalY: 0.25, scale: 1.2, observation: "The sky is built from visible currents of paint." },
    { id: "stars", label: "Stars", focalX: 0.72, focalY: 0.2, scale: 1.28, observation: "Each star pulses through repeated rings of light." },
    { id: "cypress", label: "Cypress", focalX: 0.23, focalY: 0.55, scale: 1.22, observation: "The cypress rises as a dark counter-rhythm." },
  ],
};

// Uses the installed fixture twice only to exercise the two-artwork layout. Replace src and metadata with a second licensed asset in production.
const studyCompanion = {
  ...starryNight,
  id: "starry-night-study",
  title: "The Starry Night — Study View",
  date: "1889",
};

const base = {
  version: 2 as const,
  templateVersion: "2.0",
  label: "AN ARTFOLIO STUDY",
  centralIdea: "Repetitive curved strokes generate rhythmic movement across the sky, land, and foreground.",
  artworks: [starryNight],
  observations: [
    "Movement begins in the sky, not in the story.",
    "Rhythm makes each star feel alive.",
    "The dark cypress sharpens the light around it.",
  ],
  textDensity: "low" as const,
  endingMode: "outro" as const,
};

export const SAMPLE_REELS: Record<string, ReelData> = {
  "look-closer": { ...base, id: "starry-night-look-closer", template: "look-closer", title: "Look Closer", hook: "Look at the cypress." },
  "three-details": { ...base, id: "starry-night-three-details", template: "three-details", title: "3 Details You Might Miss", hook: "Three details you might miss." },
  "inside-the-painting": { ...base, id: "starry-night-inside", template: "inside-the-painting", title: "Inside the Painting", hook: "Step inside the night." },
  "one-artwork": { ...base, id: "starry-night-one-artwork", template: "one-artwork", title: "One Artwork in 30 Seconds", hook: "One artwork. One restless sky." },
  "why-this-works": { ...base, id: "starry-night-why-this-works", template: "why-this-works", title: "Why This Works", hook: "Why does this painting feel alive?" },
  "two-works-one-idea": {
    ...base,
    id: "starry-night-two-works",
    template: "two-works-one-idea",
    title: "Two Works, One Idea",
    hook: "Two works. One restless rhythm.",
    artworks: [starryNight, studyCompanion],
  },
};

export const getSampleReel = (templateId: string): ReelData => {
  const sample = SAMPLE_REELS[templateId];
  if (!sample) throw new Error(`Unknown sample template: ${templateId}`);
  return sample;
};
