import { type SceneKind } from "./schema";
import { type PlannedScene } from "./timing";

export type QcCheckpointPhase = "early" | "settled";

export type QcCheckpoint = {
  id: string;
  filename: string;
  sceneId: string;
  sceneKind: SceneKind;
  absoluteFrame: number;
  localFrame: number;
  phase: QcCheckpointPhase;
};

const CHECKPOINT_POSITIONS: ReadonlyArray<{ phase: QcCheckpointPhase; position: number }> = [
  { phase: "early", position: 0.3 },
  { phase: "settled", position: 0.7 },
];

const toStableIdPart = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "scene";
};

export const planQcCheckpoints = (scenePlan: readonly PlannedScene[]): QcCheckpoint[] => {
  const checkpoints: QcCheckpoint[] = [];
  let sceneStartFrame = 0;

  scenePlan.forEach((scene, sceneIndex) => {
    if (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames <= 0) {
      throw new Error(`Cannot plan QC checkpoints for scene ${scene.id} with invalid duration ${scene.durationInFrames}.`);
    }

    const lastLocalFrame = scene.durationInFrames - 1;
    const plannedLocalFrames = new Set<number>();

    for (const { phase, position } of CHECKPOINT_POSITIONS) {
      const localFrame = Math.min(lastLocalFrame, Math.floor(scene.durationInFrames * position));
      if (plannedLocalFrames.has(localFrame)) continue;
      plannedLocalFrames.add(localFrame);

      const absoluteFrame = sceneStartFrame + localFrame;
      const id = [
        String(sceneIndex + 1).padStart(2, "0"),
        toStableIdPart(scene.id),
        scene.kind,
        phase,
        `f${absoluteFrame}`,
      ].join("-");
      checkpoints.push({
        id,
        filename: `${id}.png`,
        sceneId: scene.id,
        sceneKind: scene.kind,
        absoluteFrame,
        localFrame,
        phase,
      });
    }

    sceneStartFrame += scene.durationInFrames;
  });

  return checkpoints;
};
