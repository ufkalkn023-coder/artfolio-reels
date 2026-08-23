import { readFileSync } from "node:fs";
import { resolveDetailSceneContent, createScenePlan, type PlannedScene } from "../src/v2/timing";
import { ReelDataSchema, type ReelData } from "../src/v2/schema";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};

const loadReel = (id: string): ReelData =>
  ReelDataSchema.parse(JSON.parse(readFileSync(`data/reels/${id}.json`, "utf8")));

const sceneById = (reel: ReelData, id: string): PlannedScene => {
  const scene = createScenePlan(reel).find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`Missing scene ${id}`);
  return scene;
};

const detailContentFor = (reel: ReelData, id: string) => {
  const scene = sceneById(reel, id);
  const artwork = reel.artworks[scene.artworkIndex] ?? reel.artworks[0];
  return resolveDetailSceneContent(artwork, scene);
};

const assertSceneUsesOneDetail = (reel: ReelData, scene: PlannedScene): void => {
  const artwork = reel.artworks[scene.artworkIndex] ?? reel.artworks[0];
  const content = resolveDetailSceneContent(artwork, scene);
  const expected = artwork.detailPoints.find((detail) => detail.id === scene.input?.detailId);
  equal(content.detailId, expected?.id, `${scene.id} resolves its detailId`);
  equal(content.label, expected?.label, `${scene.id} resolves its label from that detail`);
  equal(content.observation, expected?.observation, `${scene.id} resolves its observation from that detail`);
  equal(content.target, expected, `${scene.id} passes that same detail to the camera`);
};

for (const id of ["met_436575", "met_435860", "met_438821", "met_436011"]) {
  const reel = loadReel(id);
  for (const scene of createScenePlan(reel).filter((candidate) => candidate.kind === "detail" || candidate.kind === "observation")) {
    assertSceneUsesOneDetail(reel, scene);
  }
}

const toledo = loadReel("met_436575");
const bridge = detailContentFor(toledo, "scene-obs-bridge");
const cathedral = detailContentFor(toledo, "scene-obs-city");
equal(bridge.detailId, "bridge", "Toledo bridge observation targets the bridge");
equal(bridge.observation, "A pale stone bridge spans the dark river gorge, catching stark highlights along its arches.", "Toledo bridge text remains bridge text");
equal(cathedral.detailId, "city-ridge", "Toledo transition switches to the cathedral detail");
equal(cathedral.label, "Cathedral and Alcázar on the Ridge", "Toledo cathedral label follows its detailId");
equal(cathedral.observation, "The cathedral spire and Alcázar gleam in crisp grey-white against the dark hillside.", "Toledo cathedral scene cannot retain bridge text");
truthy(cathedral.observation !== bridge.observation, "switching Toledo detailId changes the observation");
equal(cathedral.target?.targetType, "REGION", "Toledo cathedral camera receives the cathedral target type");

const senator = loadReel("met_435860");
const profile = detailContentFor(senator, "scene-obs-1");
const sash = detailContentFor(senator, "scene-obs-2");
equal(profile.detailId, "profile-contour", "Senator profile observation targets the profile");
equal(sash.detailId, "diagonal-sash", "Senator transition switches to the sash detail");
equal(sash.label, "Diagonal black sash", "Senator sash label follows its detailId");
equal(sash.observation, "A heavy black sash cuts diagonally across the deep vertical folds of the saturated crimson robe.", "Senator sash scene cannot retain profile text");
truthy(sash.observation !== profile.observation, "switching Senator detailId changes the observation");
equal(sash.target?.targetType, "REGION", "Senator sash camera receives the sash target type");

const maria = loadReel("met_438821");
for (const [sceneId, detailId, observation] of [
  ["scene-detail-1", "halos", "Fine golden halos float delicately above the heads of the standing mother and child."],
  ["scene-detail-2", "wings", "Yellow and violet wings emerge from behind a flowering branch beside the path."],
  ["scene-detail-3", "prayer", "Two central figures hold their hands pressed flat together in a posture of greeting."],
] as const) {
  const content = detailContentFor(maria, sceneId);
  equal(content.detailId, detailId, `${detailId} remains selected in the working control`);
  equal(content.observation, observation, `${detailId} retains its matching observation in the working control`);
}

const missingObservation = ReelDataSchema.parse({
  ...senator,
  artworks: [{
    ...senator.artworks[0],
    detailPoints: senator.artworks[0].detailPoints.map((detail) =>
      detail.id === "diagonal-sash" ? { ...detail, observation: undefined } : detail),
  }],
});
const missingSash = detailContentFor(missingObservation, "scene-obs-2");
equal(missingSash.detailId, "diagonal-sash", "missing text preserves the selected detail target");
equal(missingSash.observation, undefined, "missing text does not reuse the previous detail observation");

console.log("Detail observation sync tests passed");
