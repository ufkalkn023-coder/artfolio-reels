import { getSafeTargetScale, getTargetHoldStartFrame, resolveArtworkFraming, resolveCameraState, resolveTargetCamera, targetNeedsTopText } from "../src/v2/camera";
import { ReelDataSchema, type DetailPoint } from "../src/v2/schema";
import { SAMPLE_REELS } from "../src/v2/samples";
import { assertValidReelData, templateIds, validateTemplateRequirements } from "../src/v2/templates";
import { createScenePlan, getDurationInFrames, resolveDetailSceneContent, resolveOverviewSceneSynthesis, shouldRenderDetailObservation, validateScenePlan } from "../src/v2/timing";
import { DESIGN, VIDEO } from "../src/v2/design";
import { ArtworkDetailScene, MasterIntroScene, ObservationScene } from "../src/v2/scenes";
import { getEditorialRevealProgress, getSafeEditorialFontSize } from "../src/v2/text";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};

type InspectableElement = { props: { children: InspectableElement[]; revealStartFrame?: number } };
const sceneChildren = (scene: unknown): InspectableElement[] =>
  (scene as InspectableElement).props.children;

equal(templateIds.length, 6, "six templates are registered");
equal(new Set(templateIds).size, 6, "template IDs are unique");

for (const [templateId, sample] of Object.entries(SAMPLE_REELS)) {
  const data = assertValidReelData(sample);
  const plan = createScenePlan(data);
  equal(validateScenePlan(plan).length, 0, `${templateId} has a valid scene plan`);
  truthy(getDurationInFrames(data) > 0, `${templateId} has positive duration`);
  equal(plan.reduce((sum, scene) => sum + scene.durationInFrames, 0), getDurationInFrames(data), `${templateId} duration derives only from scene plan`);
  for (const [sceneIndex, scene] of plan.entries()) {
    if (scene.kind !== "detail") continue;
    const artwork = data.artworks[scene.artworkIndex] ?? data.artworks[0];
    const content = resolveDetailSceneContent(artwork, scene);
    truthy(content.observation, `${templateId}:${scene.id} resolves editorial copy for its detail target`);
    const nextScene = plan[sceneIndex + 1];
    if (nextScene?.kind === "observation" && nextScene.artworkIndex === scene.artworkIndex && nextScene.detailIndex === scene.detailIndex) {
      equal(shouldRenderDetailObservation(scene, nextScene), false, `${templateId}:${scene.id} yields editorial copy to its paired observation scene`);
    } else {
      equal(shouldRenderDetailObservation(scene, nextScene), true, `${templateId}:${scene.id} retains editorial copy without a paired observation scene`);
    }
  }
  const eligibleOverviews = plan.filter((scene) => scene.kind === "overview" && scene.durationInFrames > VIDEO.fps);
  for (const scene of plan.filter((candidate) => candidate.kind === "overview")) {
    const expected = scene === eligibleOverviews[eligibleOverviews.length - 1] ? data.centralIdea : undefined;
    equal(resolveOverviewSceneSynthesis(data.centralIdea, scene, plan), expected, `${templateId}:${scene.id} follows final-overview editorial policy`);
  }
}

for (const templateId of ["inside-the-painting", "one-artwork"] as const) {
  const data = assertValidReelData(SAMPLE_REELS[templateId]);
  const plan = createScenePlan(data);
  const overviews = plan.filter((scene) => scene.kind === "overview");
  equal(overviews.length, 2, `${templateId} has two resolved overview scenes`);
  equal(resolveOverviewSceneSynthesis(data.centralIdea, overviews[0], plan), undefined, `${templateId} keeps its first overview visual-only`);
  equal(resolveOverviewSceneSynthesis(data.centralIdea, overviews[1], plan), data.centralIdea, `${templateId} renders centralIdea only in its final overview`);
}

const singleOverviewData = assertValidReelData(SAMPLE_REELS["look-closer"]);
const singleOverviewPlan = createScenePlan(singleOverviewData);
const singleOverview = singleOverviewPlan.find((scene) => scene.kind === "overview");
if (!singleOverview) throw new Error("look-closer requires one overview scene");
equal(resolveOverviewSceneSynthesis(singleOverviewData.centralIdea, singleOverview, singleOverviewPlan), singleOverviewData.centralIdea, "a sole eligible overview renders centralIdea");

const shortOverviewPlan = singleOverviewPlan.map((scene) =>
  scene === singleOverview ? { ...scene, durationInFrames: VIDEO.fps } : scene
);
const shortOverview = shortOverviewPlan.find((scene) => scene.kind === "overview");
if (!shortOverview) throw new Error("short overview control requires one overview scene");
equal(resolveOverviewSceneSynthesis(singleOverviewData.centralIdea, shortOverview, shortOverviewPlan), undefined, "a one-second overview remains visual-only");

for (const templateId of ["why-this-works", "look-closer"] as const) {
  const data = assertValidReelData(SAMPLE_REELS[templateId]);
  const plan = createScenePlan(data);
  const pairedDetailIndex = plan.findIndex((scene, index) =>
    scene.kind === "detail" &&
    plan[index + 1]?.kind === "observation" &&
    scene.artworkIndex === plan[index + 1]?.artworkIndex &&
    scene.detailIndex === plan[index + 1]?.detailIndex
  );
  truthy(pairedDetailIndex >= 0, `${templateId} resolves a paired detail and observation scene`);
  equal(shouldRenderDetailObservation(plan[pairedDetailIndex], plan[pairedDetailIndex + 1]), false, `${templateId} does not duplicate paired observation copy in its detail scene`);
}

const threeDetailsPlan = createScenePlan(assertValidReelData(SAMPLE_REELS["three-details"]));
for (const [sceneIndex, scene] of threeDetailsPlan.entries()) {
  if (scene.kind === "detail") {
    equal(shouldRenderDetailObservation(scene, threeDetailsPlan[sceneIndex + 1]), true, `three-details:${scene.id} keeps its observation copy`);
  }
}

const invalidTemplate = ReelDataSchema.safeParse({ ...SAMPLE_REELS["look-closer"], template: "not-a-template" });
equal(invalidTemplate.success, false, "unknown template is rejected");
const invalidCamera = ReelDataSchema.safeParse({ ...SAMPLE_REELS["look-closer"], camera: { move: "zoom-in", focalX: 1.1, focalY: 0.5, startScale: 1 } });
equal(invalidCamera.success, false, "out-of-range camera focal point is rejected");

const wrongArtworkCount = { ...SAMPLE_REELS["two-works-one-idea"], artworks: [SAMPLE_REELS["two-works-one-idea"].artworks[0]] };
truthy(validateTemplateRequirements(ReelDataSchema.parse(wrongArtworkCount)).some((error) => error.includes("exactly 2")), "two works requires exactly two artworks");

const missingDetails = { ...SAMPLE_REELS["three-details"], artworks: [{ ...SAMPLE_REELS["three-details"].artworks[0], detailPoints: [] }] };
truthy(validateTemplateRequirements(ReelDataSchema.parse(missingDetails)).some((error) => error.includes("3 detail")), "three details requires three details");

const still = resolveCameraState({ move: "none", focalX: 0.5, focalY: 0.5, startScale: 1.08 });
equal(still.startScale, still.endScale, "none remains still");
const zoom = resolveCameraState({ move: "zoom-in", focalX: 0.5, focalY: 0.5, startScale: 1 });
truthy(zoom.endScale > zoom.startScale, "zoom-in increases scale");
const pan = resolveCameraState({ move: "pan-right", focalX: 0.5, focalY: 0.5, startScale: 1 });
truthy(pan.endFocalX > pan.focalX, "pan-right changes the focal point");
truthy(DESIGN.safe.top > 0 && DESIGN.safe.left > 0 && DESIGN.safe.right > 0 && DESIGN.safe.bottom > 0, "safe area contract reserves every Instagram edge");

const compactTarget: DetailPoint = { id: "hand", label: "Hand", focalX: 0.2, focalY: 0.45, scale: 2.1, observation: "A hand catches the light.", targetType: "COMPACT" };
const compactCamera = resolveTargetCamera({ move: "pan-right", focalX: 0.8, focalY: 0.8 }, compactTarget, { imageWidth: 2400, imageHeight: 1600 });
equal(compactCamera.move, "detail-hold", "compact target replaces arbitrary pan with a stable camera");
equal(compactCamera.focalX, compactTarget.focalX, "target focal x overrides scene camera");
equal(compactCamera.focalY, compactTarget.focalY, "target focal y overrides scene camera");
truthy((compactCamera.startScale ?? 0) >= compactTarget.scale, "target preferred scale survives old serialized camera defaults");
const regionTarget: DetailPoint = { id: "coast", label: "Coastline", focalX: 0.5, focalY: 0.5, scale: 2.5, observation: "The shoreline answers the eruption.", targetType: "REGION", targetRegion: { x: 0.18, y: 0.28, width: 0.64, height: 0.3 } };
const regionScale = getSafeTargetScale({ imageWidth: 2400, imageHeight: 1600 }, regionTarget, regionTarget.scale);
truthy(regionScale < regionTarget.scale, "region scale preserves contextual target bounds");
const regionFraming = resolveArtworkFraming({ imageWidth: 2400, imageHeight: 1600 }, regionScale, regionTarget.focalX, regionTarget.focalY, regionTarget);
truthy((regionFraming.targetBounds?.left ?? -1) >= 0 && (regionFraming.targetBounds?.left ?? Infinity) + (regionFraming.targetBounds?.width ?? Infinity) <= 1080, "aspect-aware crop keeps region on screen");
const relationTarget: DetailPoint = { ...regionTarget, id: "figure-and-volcano", targetType: "RELATION", targetRegion: { x: 0.15, y: 0.2, width: 0.7, height: 0.5 } };
truthy(getSafeTargetScale({ imageWidth: 2400, imageHeight: 1600 }, relationTarget, 2.5) <= regionScale, "relation target preserves at least as much context as its smaller region");
const lowerTargetFrame = resolveArtworkFraming({ imageWidth: 1200, imageHeight: 1800 }, 1.5, 0.5, 0.9, { ...compactTarget, focalY: 0.9 });
truthy(targetNeedsTopText(lowerTargetFrame), "lower target selects the fixed upper text-safe variant");
truthy(getTargetHoldStartFrame(105) < 104, "target scene reserves a stable hold after its short entrance");
const targetSceneDuration = 105;
const targetTextStart = getTargetHoldStartFrame(targetSceneDuration);
const sceneArtwork = SAMPLE_REELS["look-closer"].artworks[0];
const detailScene = sceneChildren(ArtworkDetailScene({
  artwork: sceneArtwork,
  detail: compactTarget,
  durationInFrames: targetSceneDuration,
  label: compactTarget.label,
  observation: compactTarget.observation,
}));
equal(detailScene[2].props.revealStartFrame, targetTextStart, "detail label reuses target-camera establishment timing");
equal(detailScene[3].props.revealStartFrame, targetTextStart, "detail observation reuses target-camera establishment timing");
equal(getEditorialRevealProgress(targetTextStart - 1, targetTextStart), 0, "detail text does not reveal before target establishment");
equal(getEditorialRevealProgress(targetTextStart, targetTextStart), 0, "detail text begins from hidden at target establishment");
truthy(getEditorialRevealProgress(targetTextStart + 1, targetTextStart) > 0, "detail text reveals after target establishment");

const observationScene = sceneChildren(ObservationScene({
  artwork: sceneArtwork,
  durationInFrames: targetSceneDuration,
  label: compactTarget.label,
  observation: compactTarget.observation,
  target: compactTarget,
}));
equal(observationScene[2].props.revealStartFrame, targetTextStart, "observation label reuses target-camera establishment timing");
equal(observationScene[3].props.revealStartFrame, targetTextStart, "observation copy reuses target-camera establishment timing");
equal(getEditorialRevealProgress(targetTextStart - 1, targetTextStart), 0, "observation text does not reveal before target establishment");

const introScene = sceneChildren(MasterIntroScene({
  artwork: sceneArtwork,
  durationInFrames: 60,
  hook: SAMPLE_REELS["look-closer"].hook,
  label: SAMPLE_REELS["look-closer"].label,
}));
equal(introScene[2].props.revealStartFrame, undefined, "intro label retains the default immediate reveal");
equal(introScene[3].props.revealStartFrame, undefined, "intro hook retains the default immediate reveal");
truthy(getEditorialRevealProgress(1) > 0, "default editorial text reveal progresses immediately after frame zero");
const explicitTargetPlan = createScenePlan({ ...SAMPLE_REELS["look-closer"], scenes: [
  { id: "intro", kind: "intro", seconds: 2 },
  { id: "detail", kind: "detail", seconds: 3, detailId: "sky" },
  { id: "observation", kind: "observation", seconds: 3, detailId: "stars", observationIndex: 0 },
  { id: "detail-2", kind: "detail", seconds: 3, detailId: "cypress" },
  { id: "overview", kind: "overview", seconds: 3 },
  { id: "outro", kind: "outro", seconds: 3 },
] });
equal(explicitTargetPlan[2].detailIndex, 1, "observation camera uses its explicit detail target rather than observation prose");
equal(shouldRenderDetailObservation(explicitTargetPlan[1], explicitTargetPlan[2]), true, "an observation for a different detail does not suppress detail copy");
equal(resolveOverviewSceneSynthesis(SAMPLE_REELS["look-closer"].centralIdea, explicitTargetPlan[4], explicitTargetPlan), SAMPLE_REELS["look-closer"].centralIdea, "overview uses the plan-level synthesis");

equal(shouldRenderDetailObservation(explicitTargetPlan[4], explicitTargetPlan[5]), false, "overview remains artwork-led");
truthy(getSafeEditorialFontSize("A spotted snake loops tightly over the forearm, positioned directly against the exposed skin.", "observation", 760, 3) >= 47, "text fitting does not shrink approved observations below the readable bound");

console.log("V2 engine tests passed");
