import { ArtworkHandoffSchema, type ArtworkHandoff } from "../handoff";
import { type ReelPlan } from "../reel-plan";

export const STARRY_NIGHT_HANDOFF: ArtworkHandoff = ArtworkHandoffSchema.parse({
  canonicalId: "starry-night",
  source: "moma",
  title: "The Starry Night",
  artist: "Vincent van Gogh",
  date: "1889",
  medium: "Oil on canvas",
  museum: "Museum of Modern Art, New York",
  classification: "Paintings",
  imagePath: "public/artworks/starry-night.jpg",
  imageWidth: 3840,
  imageHeight: 3041,
  rightsStatus: "CONFIRMED_PUBLIC_DOMAIN",
});

export const STARRY_NIGHT_MOCK_PLAN: ReelPlan = {
  template: "why-this-works",
  hook: { type: "QUESTION", text: "Why does this painting feel alive?" },
  centralIdea: "The composition creates movement through repeated curves and strong vertical contrast.",
  details: [
    { id: "movement", label: "MOVEMENT", observation: "The sky moves in broad, curling bands.", focalX: 0.53, focalY: 0.24, preferredScale: 1.22 },
    { id: "rhythm", label: "RHYTHM", observation: "Bright circular stars repeat across the upper half like visual beats.", focalX: 0.72, focalY: 0.2, preferredScale: 1.3 },
    { id: "contrast", label: "CONTRAST", observation: "The dark cypress rises sharply against the luminous moving sky.", focalX: 0.23, focalY: 0.55, preferredScale: 1.24 },
  ],
  scenes: [
    { id: "intro-1", kind: "intro", seconds: 2.2, camera: { move: "zoom-in", focalX: 0.52, focalY: 0.35, startScale: 1.03, endScale: 1.1 } },
    { id: "detail-1", kind: "detail", seconds: 3.2, detailId: "movement", camera: { move: "detail-hold", focalX: 0.53, focalY: 0.24, startScale: 1.22, endScale: 1.27 } },
    { id: "observation-1", kind: "observation", seconds: 2.8, observationIndex: 0, camera: { move: "detail-hold", focalX: 0.53, focalY: 0.24, startScale: 1.25, endScale: 1.28 } },
    { id: "detail-2", kind: "detail", seconds: 3.2, detailId: "rhythm", camera: { move: "detail-hold", focalX: 0.72, focalY: 0.2, startScale: 1.3, endScale: 1.34 } },
    { id: "observation-2", kind: "observation", seconds: 2.8, observationIndex: 1, camera: { move: "detail-hold", focalX: 0.72, focalY: 0.2, startScale: 1.32, endScale: 1.35 } },
    { id: "detail-3", kind: "detail", seconds: 3.2, detailId: "contrast", camera: { move: "detail-hold", focalX: 0.23, focalY: 0.55, startScale: 1.24, endScale: 1.28 } },
    { id: "overview-1", kind: "overview", seconds: 3.5, camera: { move: "zoom-out", focalX: 0.5, focalY: 0.5, startScale: 1.08, endScale: 1 } },
    { id: "outro-1", kind: "outro", seconds: 4, camera: { move: "none" } },
  ],
  musicSuggestions: [
    { artist: "Claude Debussy", title: "Nuages", role: "best_fit", reason: "Its drifting orchestral layers echo the sky's rolling, suspended motion." },
    { artist: "Toru Takemitsu", title: "Rain Tree Sketch II", role: "alternative", reason: "Sparse piano color offers a quieter interpretation of the painting's luminous night." },
    { artist: "Max Richter", title: "The Trees", role: "cinematic", reason: "A restrained modern pulse supports the Reel's intensity without overpowering the image." },
  ],
};
