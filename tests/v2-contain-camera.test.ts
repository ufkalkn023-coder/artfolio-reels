import { getContainCameraProgress, resolveCameraState, resolveContainTransform, type ArtworkDimensions, type ContainTransform } from "../src/v2/camera";
import { VIDEO } from "../src/v2/design";

const PADDING = { top: 300, right: 52, bottom: 500, left: 52 };
const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const close = (actual: number, expected: number, label: string, tolerance = 1e-9): void => {
  truthy(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual}`);
};
const finiteAndContained = (transform: ContainTransform, label: string): void => {
  for (const [key, value] of Object.entries(transform)) truthy(Number.isFinite(value), `${label} has a finite ${key}`);
  truthy(transform.width > 0 && transform.height > 0 && transform.scale > 0, `${label} has positive geometry`);
  truthy(transform.left >= PADDING.left - 1e-9, `${label} stays inside the left safe edge`);
  truthy(transform.top >= PADDING.top - 1e-9, `${label} stays inside the top safe edge`);
  truthy(transform.left + transform.width <= VIDEO.width - PADDING.right + 1e-9, `${label} stays inside the right safe edge`);
  truthy(transform.top + transform.height <= VIDEO.height - PADDING.bottom + 1e-9, `${label} stays inside the bottom safe edge`);
};
const assertProgressesAtEveryCheckpoint = (values: number[], label: string): void => {
  for (let index = 1; index < values.length; index++) {
    truthy(Math.abs(values[index] - values[index - 1]) > 1e-9, `${label} changes from checkpoint ${index - 1} to ${index}`);
  }
};

const portrait = { imageWidth: 1200, imageHeight: 1800 };
const availableWidth = VIDEO.width - PADDING.left - PADDING.right;
const availableHeight = VIDEO.height - PADDING.top - PADDING.bottom;
const stillState = resolveCameraState({ move: "none", focalX: 0.1, focalY: 0.9, startScale: 1.08, endScale: 1.2 });
const stillStart = resolveContainTransform(portrait, stillState, 0, "none");
const stillEnd = resolveContainTransform(portrait, stillState, 1, "none");
equal(JSON.stringify(stillEnd), JSON.stringify(stillStart), "none remains exactly static despite supplied endpoints");
finiteAndContained(stillStart, "none portrait");

const zoomInState = resolveCameraState({ move: "zoom-in", focalX: 0.5, focalY: 0.5, startScale: 1, endScale: 1.06 });
const zoomInStart = resolveContainTransform(portrait, zoomInState, 0, "zoom-in");
const zoomInEnd = resolveContainTransform(portrait, zoomInState, 1, "zoom-in");
truthy(zoomInEnd.scale > zoomInStart.scale, "zoom-in changes contain scale");
truthy(zoomInStart.scale >= 0.97, "contain zoom reserves at most three percent scale variation");
finiteAndContained(zoomInStart, "zoom-in start");
finiteAndContained(zoomInEnd, "zoom-in end");

const zoomOutState = resolveCameraState({ move: "zoom-out", focalX: 0.5, focalY: 0.5, startScale: 1.08, endScale: 1 });
const zoomOutStart = resolveContainTransform({ imageWidth: 1800, imageHeight: 1200 }, zoomOutState, 0, "zoom-out");
const zoomOutEnd = resolveContainTransform({ imageWidth: 1800, imageHeight: 1200 }, zoomOutState, 1, "zoom-out");
truthy(zoomOutEnd.scale < zoomOutStart.scale, "zoom-out reduces contain scale");
finiteAndContained(zoomOutStart, "zoom-out landscape start");
finiteAndContained(zoomOutEnd, "zoom-out landscape end");

// Regression: per-frame clamping made an oversized zoom hit 0.97 near the start, then plateau.
const oversizedZoomState = resolveCameraState({ move: "zoom-out", startScale: 2, endScale: 1, focalX: 0.5, focalY: 0.5 });
const oversizedZoomCheckpoints = [0, 0.25, 0.5, 0.75, 1].map((fraction) => resolveContainTransform(
  { imageWidth: 1800, imageHeight: 1200 },
  oversizedZoomState,
  getContainCameraProgress(fraction * 100, 101),
  "zoom-out",
));
assertProgressesAtEveryCheckpoint(oversizedZoomCheckpoints.map(({ scale }) => scale), "oversized zoom safe range");
close(oversizedZoomCheckpoints[0].scale - oversizedZoomCheckpoints[4].scale, 0.03, "oversized zoom is converted to a three-percent endpoint delta");
for (const [index, transform] of oversizedZoomCheckpoints.entries()) finiteAndContained(transform, `oversized zoom checkpoint ${index}`);

const panState = resolveCameraState({ move: "pan-right", focalX: 0.5, focalY: 0.5, endFocalX: 1, startScale: 1, endScale: 1 });
const portraitPanCheckpoints = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
  const progress = getContainCameraProgress(fraction * 100, 101);
  return resolveContainTransform(portrait, panState, progress, "pan-right");
});
for (let index = 1; index < portraitPanCheckpoints.length; index++) {
  truthy(
    portraitPanCheckpoints[index].translateX < portraitPanCheckpoints[index - 1].translateX,
    `contain pan continues progressing through checkpoint ${index}`,
  );
}
close(getContainCameraProgress(0, 101), 0, "ambient progress starts at zero");
close(getContainCameraProgress(50, 101), 0.5, "ambient progress reaches its midpoint at half duration");
close(getContainCameraProgress(100, 101), 1, "ambient progress reaches one only at scene end");

const panEnd = resolveContainTransform({ imageWidth: 1600, imageHeight: 1600 }, panState, 1, "pan-right");
equal(panEnd.translateX, 0, "pan is clamped away when a square artwork has no horizontal contain slack");
truthy(Math.abs(portraitPanCheckpoints[4].translateX) <= availableWidth * 0.025 + 1e-9, "pan is reduced to the subtle contain-mode limit");
finiteAndContained(panEnd, "clamped square pan");

// Regression: requested pan exceeds ten pixels of real slack, so its endpoint must be
// reduced to that slack before interpolation instead of clamping halfway through.
const limitedPanArtwork = { imageWidth: availableWidth - 20, imageHeight: availableHeight };
const oversizedPanCheckpoints = [0, 0.25, 0.5, 0.75, 1].map((fraction) => resolveContainTransform(
  limitedPanArtwork,
  panState,
  getContainCameraProgress(fraction * 100, 101),
  "pan-right",
));
assertProgressesAtEveryCheckpoint(oversizedPanCheckpoints.map(({ translateX }) => translateX), "oversized pan safe range");
close(oversizedPanCheckpoints[4].translateX, -10, "oversized pan is converted to the available endpoint displacement");
for (const [index, transform] of oversizedPanCheckpoints.entries()) finiteAndContained(transform, `oversized pan checkpoint ${index}`);

const portraitBaseFit = Math.min(availableWidth / portrait.imageWidth, availableHeight / portrait.imageHeight);
close(portraitPanCheckpoints[4].width, portrait.imageWidth * portraitBaseFit, "pan does not shrink portrait artwork to manufacture headroom");
close(portraitPanCheckpoints[4].height, portrait.imageHeight * portraitBaseFit, "portrait uses the maximal practical contain height");

for (const [label, artwork] of Object.entries<ArtworkDimensions>({
  portrait,
  landscape: { imageWidth: 2400, imageHeight: 1200 },
  square: { imageWidth: 1600, imageHeight: 1600 },
})) {
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    finiteAndContained(resolveContainTransform(artwork, panState, progress, "pan-right"), `${label} at ${progress}`);
  }
}

const invalid = resolveContainTransform({ imageWidth: Number.NaN, imageHeight: Number.POSITIVE_INFINITY }, {
  startScale: Number.NaN,
  endScale: Number.POSITIVE_INFINITY,
  focalX: Number.NaN,
  focalY: Number.NEGATIVE_INFINITY,
  endFocalX: Number.POSITIVE_INFINITY,
  endFocalY: Number.NaN,
}, Number.NaN, "pan-down");
finiteAndContained(invalid, "invalid input fallback");

console.log("V2 contain camera tests passed");
