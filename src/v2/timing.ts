import { secondsToFrames } from "./design";
import { type Artwork, type DetailPoint, type ReelData, type SceneInput, type SceneKind } from "./schema";
import { getTemplate } from "./templates";

export type PlannedScene = {
  id: string;
  kind: SceneKind;
  durationInFrames: number;
  artworkIndex: number;
  detailIndex?: number;
  observationIndex?: number;
  input?: SceneInput;
};

export type DetailSceneContent = {
  detailId?: string;
  label?: string;
  observation?: string;
  target?: DetailPoint;
};

/**
 * Resolves every detail-facing value from one scene-selected detail. In
 * particular, a legacy observationIndex must never select the displayed copy
 * after detailId has selected a different target.
 */
export const resolveDetailSceneContent = (artwork: Artwork, scene: PlannedScene): DetailSceneContent => {
  const target = scene.detailIndex === undefined ? undefined : artwork.detailPoints[scene.detailIndex];
  return {
    detailId: target?.id,
    label: target?.label,
    observation: target?.observation,
    target,
  };
};

export const createScenePlan = (data: ReelData): PlannedScene[] => {
  const template = getTemplate(data.template);
  const inputs = data.scenes;
  let detailIndex = 0;
  let observationIndex = 0;
  let overviewIndex = 0;
  return template.defaultScenePlan.map((kind, index) => {
    const input = inputs?.[index];
    const sequentialDetailIndex = kind === "detail" ? detailIndex++ : undefined;
    const assignedObservationIndex = kind === "observation" ? observationIndex++ : undefined;
    const artworkIndex = input?.artworkIndex ??
      (data.template === "two-works-one-idea" && ["overview", "detail"].includes(kind)
        ? overviewIndex++ % 2
        : 0);
    const selectedArtwork = data.artworks[artworkIndex] ?? data.artworks[0];
    const referencedDetailIndex = input?.detailId
      ? selectedArtwork.detailPoints.findIndex((detail) => detail.id === input.detailId)
      : -1;
    const observationTargetIndex = kind === "observation"
      ? (input?.observationIndex ?? assignedObservationIndex)
      : undefined;
    return {
      id: input?.id ?? `${kind}-${index + 1}`,
      kind,
      durationInFrames: secondsToFrames(input?.seconds ?? template.sceneSeconds[index]),
      artworkIndex,
      detailIndex: referencedDetailIndex >= 0
        ? referencedDetailIndex
        : kind === "detail"
          ? sequentialDetailIndex
          : observationTargetIndex,
      observationIndex: input?.observationIndex ?? assignedObservationIndex,
      input,
    };
  });
};

export const getDurationInFrames = (data: ReelData): number =>
  createScenePlan(data).reduce((total, scene) => total + scene.durationInFrames, 0);

export const validateScenePlan = (plan: PlannedScene[]): string[] => {
  if (plan.length === 0) return ["scene plan must not be empty"];
  if (plan.some((scene) => !Number.isInteger(scene.durationInFrames) || scene.durationInFrames <= 0)) {
    return ["all scene durations must be positive whole frames"];
  }
  return [];
};
