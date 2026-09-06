import { VIDEO } from "./design";
import { type ReelData } from "./schema";
import { createScenePlan, type PlannedScene } from "./timing";
import { assertValidReelData } from "./templates";

export class ScenePlanValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid scene plan: ${errors.join("; ")}`);
    this.name = "ScenePlanValidationError";
  }
}

/** Central renderability validation for compiled, saved, and runtime ReelData. */
export const validateScenePlan = (data: ReelData, plan: readonly PlannedScene[] = createScenePlan(data)): string[] => {
  const errors: string[] = [];
  if (plan.length === 0) errors.push("scene plan must not be empty");

  const sceneIds = new Set<string>();
  for (const scene of plan) {
    if (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames < 1) {
      errors.push(`scene "${scene.id}" must render at least 1 frame at ${VIDEO.fps} FPS`);
    }
    if (sceneIds.has(scene.id)) errors.push(`scene id "${scene.id}" must be unique`);
    sceneIds.add(scene.id);
    const artwork = data.artworks[scene.artworkIndex];
    if (!artwork) {
      errors.push(`scene "${scene.id}" references missing artwork index ${scene.artworkIndex}`);
      continue;
    }
    if ((scene.kind === "detail" || scene.kind === "observation") &&
      (scene.detailIndex === undefined || !artwork.detailPoints[scene.detailIndex])) {
      errors.push(`scene "${scene.id}" references a missing detail`);
    }
    if (scene.kind === "comparison" && !data.observations[scene.observationIndex ?? 0]) {
      errors.push(`scene "${scene.id}" references a missing observation`);
    }
  }

  data.artworks.forEach((artwork) => {
    const detailIds = new Set<string>();
    for (const detail of artwork.detailPoints) {
      if (detailIds.has(detail.id)) errors.push(`detail id "${detail.id}" must be unique within artwork "${artwork.id}"`);
      detailIds.add(detail.id);
    }
  });

  data.scenes?.forEach((input, index) => {
    const resolved = plan[index];
    if (!resolved) {
      errors.push(`scene "${input.id}" has no registered template position`);
      return;
    }
    if (input.kind !== resolved.kind) {
      errors.push(`scene "${input.id}" kind "${input.kind}" does not match template kind "${resolved.kind}"`);
    }
    if (input.artworkIndex !== undefined && !data.artworks[input.artworkIndex]) {
      errors.push(`scene "${input.id}" references missing artwork index ${input.artworkIndex}`);
    }
    const artwork = data.artworks[input.artworkIndex ?? resolved.artworkIndex];
    if (input.detailId && artwork && !artwork.detailPoints.some((detail) => detail.id === input.detailId)) {
      errors.push(`scene "${input.id}" references missing detail "${input.detailId}"`);
    }
    if (input.observationIndex !== undefined && !input.detailId) {
      const observationExists = input.kind === "comparison"
        ? Boolean(data.observations[input.observationIndex])
        : Boolean(artwork?.detailPoints[input.observationIndex]);
      if (!observationExists) errors.push(`scene "${input.id}" references missing observation index ${input.observationIndex}`);
    }
  });

  return errors;
};

export const assertValidScenePlan = (data: ReelData): readonly PlannedScene[] => {
  const plan = createScenePlan(data);
  const errors = validateScenePlan(data, plan);
  if (errors.length > 0) throw new ScenePlanValidationError(errors);
  return plan;
};

export const validateRenderableReelData = (input: unknown): ReelData => {
  const data = assertValidReelData(input);
  assertValidScenePlan(data);
  return data;
};
