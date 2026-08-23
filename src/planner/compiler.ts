import { CameraSchema, type ReelData, type SceneInput } from "../v2/schema";
import { getTemplate, assertValidReelData } from "../v2/templates";
import { type ArtworkHandoff } from "./handoff";
import { type ReelEligibility } from "./eligibility";
import { type ReelPlan, validateReelPlan } from "./reel-plan";

export type CompileResult = {
  reel: ReelData;
  plan: ReelPlan;
};

const reelSource = (imagePath: string): string => imagePath.replace(/^public\//, "");

const orientationFor = (artwork: ArtworkHandoff): "portrait" | "landscape" | "panorama" => {
  const ratio = artwork.imageWidth / artwork.imageHeight;
  if (ratio >= 2) return "panorama";
  return ratio >= 1 ? "landscape" : "portrait";
};

/**
 * Deterministically maps a validated plan and immutable verified handoff into V2.
 * Planner text never owns factual artwork fields; these always originate here.
 */
export const compileSingleArtworkPlan = (
  artwork: ArtworkHandoff,
  input: unknown,
  eligibility: ReelEligibility,
): CompileResult => {
  const plan = validateReelPlan(input, eligibility, 1);

  const template = getTemplate(plan.template);
  const scenes: SceneInput[] = plan.scenes.map((scene) => {
    // Older cached plans can contain both fields, with an observationIndex that
    // disagrees with the explicit detailId. The detail is authoritative; keep
    // the legacy index normalized to it for downstream compatibility.
    const detailId = scene.detailId ?? (scene.kind === "observation" && scene.observationIndex !== undefined
      ? plan.details[scene.observationIndex]?.id
      : undefined);
    const detailIndex = detailId === undefined ? -1 : plan.details.findIndex((detail) => detail.id === detailId);
    return {
      id: scene.id,
      kind: scene.kind,
      seconds: scene.seconds,
      detailId,
      observationIndex: scene.kind === "observation" && detailIndex >= 0 ? detailIndex : scene.observationIndex,
      camera: scene.camera ? CameraSchema.parse(scene.camera) : undefined,
    };
  });
  const reel: ReelData = {
    version: 2,
    id: artwork.canonicalId,
    template: plan.template,
    templateVersion: "2.0",
    title: template.label,
    hook: plan.hook.text,
    hookType: plan.hook.type,
    centralIdea: plan.centralIdea,
    label: "AN ARTFOLIO STUDY",
    artworks: [{
      id: artwork.canonicalId,
      src: reelSource(artwork.imagePath),
      title: artwork.title,
      artist: artwork.artist,
      date: artwork.date,
      medium: artwork.medium,
      museum: artwork.museum,
      orientation: orientationFor(artwork),
      imageWidth: artwork.imageWidth,
      imageHeight: artwork.imageHeight,
      detailPoints: plan.details.map((detail) => ({
        id: detail.id,
        label: detail.label,
        focalX: detail.focalX,
        focalY: detail.focalY,
        scale: detail.preferredScale,
        observation: detail.observation,
        targetType: detail.targetType,
        targetRegion: detail.targetRegion,
      })),
    }],
    observations: plan.details.map((detail) => detail.observation),
    scenes,
    textDensity: template.textDensity,
    endingMode: "outro",
  };
  return { reel: assertValidReelData(reel), plan };
};
