import { planQcCheckpoints } from "../src/v2/qc";
import { SAMPLE_REELS } from "../src/v2/samples";
import { assertValidReelData } from "../src/v2/templates";
import { createScenePlan, type PlannedScene } from "../src/v2/timing";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};

const whyThisWorksPlan = createScenePlan(assertValidReelData(SAMPLE_REELS["why-this-works"]));
const checkpoints = planQcCheckpoints(whyThisWorksPlan);

equal(checkpoints.length, whyThisWorksPlan.length * 2, "every normal scene receives two checkpoints");
equal(checkpoints.map((checkpoint) => checkpoint.phase).join(","), whyThisWorksPlan.flatMap(() => ["early", "settled"]).join(","), "each scene receives early then settled checkpoints");

let sceneStartFrame = 0;
for (const scene of whyThisWorksPlan) {
  const sceneCheckpoints = checkpoints.filter((checkpoint) => checkpoint.sceneId === scene.id);
  equal(sceneCheckpoints.length, 2, `${scene.id} receives early and settled checkpoints`);
  for (const checkpoint of sceneCheckpoints) {
    truthy(checkpoint.absoluteFrame >= sceneStartFrame, `${checkpoint.id} remains at or after its scene start`);
    truthy(checkpoint.absoluteFrame <= sceneStartFrame + scene.durationInFrames - 1, `${checkpoint.id} remains within its scene end`);
    equal(checkpoint.absoluteFrame, sceneStartFrame + checkpoint.localFrame, `${checkpoint.id} resolves its absolute frame from its local frame`);
  }
  sceneStartFrame += scene.durationInFrames;
}

equal(checkpoints.map((checkpoint) => checkpoint.sceneId).join(","), whyThisWorksPlan.flatMap((scene) => [scene.id, scene.id]).join(","), "checkpoint order preserves scene order");
equal(JSON.stringify(planQcCheckpoints(whyThisWorksPlan)), JSON.stringify(checkpoints), "checkpoint metadata and filenames are deterministic");
equal(new Set(checkpoints.map((checkpoint) => checkpoint.id)).size, checkpoints.length, "checkpoint IDs are unique");
truthy(checkpoints.every((checkpoint) => checkpoint.filename === `${checkpoint.id}.png`), "filenames derive deterministically from checkpoint IDs");
equal(checkpoints[0].id, "01-intro-1-intro-early-f19", "checkpoint IDs have stable structural content");
equal(checkpoints[0].filename, "01-intro-1-intro-early-f19.png", "checkpoint filenames have stable structural content");

const shortScene: PlannedScene = {
  id: "flash",
  kind: "detail",
  durationInFrames: 1,
  artworkIndex: 0,
};
const shortCheckpoints = planQcCheckpoints([shortScene]);
equal(shortCheckpoints.length, 1, "a one-frame scene deduplicates coincident checkpoints");
equal(shortCheckpoints[0].absoluteFrame, 0, "a deduplicated checkpoint remains on the only valid frame");
equal(shortCheckpoints[0].phase, "early", "deduplication preserves the first checkpoint phase");

const structuralPlan: PlannedScene[] = [
  { id: "opening", kind: "intro", durationInFrames: 10, artworkIndex: 0 },
  { id: "inserted-overview", kind: "overview", durationInFrames: 20, artworkIndex: 0 },
  { id: "closing", kind: "outro", durationInFrames: 10, artworkIndex: 0 },
];
const structuralCheckpoints = planQcCheckpoints(structuralPlan);
equal(structuralCheckpoints.length, 6, "checkpoint count follows the supplied resolved plan structure");
equal(structuralCheckpoints[2].sceneId, "inserted-overview", "an inserted resolved scene receives checkpoints without template-name logic");
equal(structuralCheckpoints[2].absoluteFrame, 16, "inserted scene frame uses preceding resolved scene duration");
equal(structuralCheckpoints[4].absoluteFrame, 33, "later scene frame shifts according to resolved plan structure");

console.log("QC checkpoint planning tests passed");
