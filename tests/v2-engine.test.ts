import { getSafeTargetScale, getTargetHoldStartFrame, resolveArtworkFraming, resolveCameraState, resolveTargetCamera, targetNeedsTopText } from "../src/v2/camera";
import { ReelDataSchema, type DetailPoint } from "../src/v2/schema";
import { SAMPLE_REELS } from "../src/v2/samples";
import { assertValidReelData, templateIds, validateTemplateRequirements } from "../src/v2/templates";
import { createScenePlan, getDurationInFrames, validateScenePlan } from "../src/v2/timing";
import { DESIGN } from "../src/v2/design";
import { shouldRenderDetailObservation } from "../src/v2/ReelComposition";
import { getSafeEditorialFontSize } from "../src/v2/text";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};

equal(templateIds.length, 6, "six templates are registered");
equal(new Set(templateIds).size, 6, "template IDs are unique");

for (const [templateId, sample] of Object.entries(SAMPLE_REELS)) {
  const data = assertValidReelData(sample);
  const plan = createScenePlan(data);
  equal(validateScenePlan(plan).length, 0, `${templateId} has a valid scene plan`);
  truthy(getDurationInFrames(data) > 0, `${templateId} has positive duration`);
  equal(plan.reduce((sum, scene) => sum + scene.durationInFrames, 0), getDurationInFrames(data), `${templateId} duration derives only from scene plan`);
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
const explicitTargetPlan = createScenePlan({ ...SAMPLE_REELS["look-closer"], scenes: [
  { id: "intro", kind: "intro", seconds: 2 },
  { id: "detail", kind: "detail", seconds: 3, detailId: "sky" },
  { id: "observation", kind: "observation", seconds: 3, detailId: "stars", observationIndex: 0 },
  { id: "detail-2", kind: "detail", seconds: 3, detailId: "cypress" },
  { id: "overview", kind: "overview", seconds: 3 },
  { id: "outro", kind: "outro", seconds: 3 },
] });
equal(explicitTargetPlan[2].detailIndex, 1, "observation camera uses its explicit detail target rather than observation prose");

const questionThreeDetails = { ...SAMPLE_REELS["three-details"], hook: "What separates the two sides?", hookType: "QUESTION" as const };
truthy(shouldRenderDetailObservation(questionThreeDetails, "detail"), "question three-details renders its saved detail observations");
truthy(shouldRenderDetailObservation({ ...questionThreeDetails, hookType: undefined }, "detail"), "legacy saved question reels render their detail observations");
equal(shouldRenderDetailObservation(questionThreeDetails, "overview"), false, "overview remains artwork-led");
equal(shouldRenderDetailObservation({ ...questionThreeDetails, template: "look-closer" }, "detail"), false, "other templates keep their established density");
truthy(getSafeEditorialFontSize("A spotted snake loops tightly over the forearm, positioned directly against the exposed skin.", "observation", 760, 3) >= 47, "text fitting does not shrink approved observations below the readable bound");

console.log("V2 engine tests passed");
