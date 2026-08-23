import { ReelDataSchema, type ReelData, TEMPLATE_IDS, type TemplateId, type SceneKind } from "./schema";

export type TemplateDefinition = {
  id: TemplateId;
  label: string;
  minDuration: number;
  maxDuration: number;
  requiredArtworkCount: 1 | 2;
  requiredDetailCount: number;
  supportsVoiceover: boolean;
  supportsLandscape: boolean;
  supportsPanorama: boolean;
  textDensity: "low" | "medium";
  defaultScenePlan: readonly SceneKind[];
  sceneSeconds: readonly number[];
};

export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateDefinition> = {
  "look-closer": {
    id: "look-closer", label: "Look Closer", minDuration: 15, maxDuration: 20,
    requiredArtworkCount: 1, requiredDetailCount: 2, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: true, textDensity: "low",
    defaultScenePlan: ["intro", "detail", "observation", "detail", "overview", "outro"],
    sceneSeconds: [2, 3.5, 3, 3.5, 3, 4],
  },
  "three-details": {
    id: "three-details", label: "3 Details You Might Miss", minDuration: 20, maxDuration: 30,
    requiredArtworkCount: 1, requiredDetailCount: 3, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: true, textDensity: "low",
    defaultScenePlan: ["intro", "detail", "detail", "detail", "overview", "outro"],
    sceneSeconds: [2, 3.8, 3.8, 3.8, 3.6, 4],
  },
  "inside-the-painting": {
    id: "inside-the-painting", label: "Inside the Painting", minDuration: 25, maxDuration: 35,
    requiredArtworkCount: 1, requiredDetailCount: 2, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: true, textDensity: "low",
    defaultScenePlan: ["intro", "overview", "detail", "observation", "detail", "overview", "outro"],
    sceneSeconds: [2.2, 4.2, 4.5, 3.5, 4.5, 3.5, 4],
  },
  "one-artwork": {
    id: "one-artwork", label: "One Artwork in 30 Seconds", minDuration: 25, maxDuration: 35,
    requiredArtworkCount: 1, requiredDetailCount: 2, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: true, textDensity: "medium",
    defaultScenePlan: ["intro", "overview", "detail", "observation", "detail", "metadata", "overview", "outro"],
    sceneSeconds: [2.2, 3.5, 4, 3.5, 4, 3.5, 3.5, 4],
  },
  "why-this-works": {
    id: "why-this-works", label: "Why This Works", minDuration: 20, maxDuration: 30,
    requiredArtworkCount: 1, requiredDetailCount: 3, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: false, textDensity: "low",
    defaultScenePlan: ["intro", "detail", "observation", "detail", "observation", "detail", "overview", "outro"],
    sceneSeconds: [2.2, 3.2, 2.8, 3.2, 2.8, 3.2, 3.5, 4],
  },
  "two-works-one-idea": {
    id: "two-works-one-idea", label: "Two Works, One Idea", minDuration: 25, maxDuration: 35,
    requiredArtworkCount: 2, requiredDetailCount: 2, supportsVoiceover: true,
    supportsLandscape: true, supportsPanorama: true, textDensity: "low",
    defaultScenePlan: ["intro", "overview", "overview", "detail", "detail", "comparison", "comparison", "outro"],
    sceneSeconds: [2.2, 3.5, 3.5, 3.8, 3.8, 3.5, 3.5, 4],
  },
};

export const getTemplate = (id: TemplateId): TemplateDefinition => TEMPLATE_REGISTRY[id];

export const validateTemplateRequirements = (data: ReelData): string[] => {
  const template = getTemplate(data.template);
  const errors: string[] = [];
  if (data.artworks.length !== template.requiredArtworkCount) {
    errors.push(`${template.id} requires exactly ${template.requiredArtworkCount} artwork(s)`);
  }
  const detailCount = data.artworks.reduce((total, artwork) => total + artwork.detailPoints.length, 0);
  if (detailCount < template.requiredDetailCount) {
    errors.push(`${template.id} requires ${template.requiredDetailCount} detail points`);
  }
  if (data.hook.trim().split(/\s+/).length > 12) {
    errors.push("hook must contain no more than 12 words");
  }
  return errors;
};

export const assertValidReelData = (input: unknown): ReelData => {
  const data = ReelDataSchema.parse(input);
  const errors = validateTemplateRequirements(data);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return data;
};

// Retain a stable public list for manifests and future analytics.
export const templateIds = [...TEMPLATE_IDS];
