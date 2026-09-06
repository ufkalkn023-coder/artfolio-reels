import { SAMPLE_REELS } from "../src/v2/samples";
import { type ReelData } from "../src/v2/schema";
import { validateRenderableReelData } from "../src/v2/validation";

const rejectsWith = (input: unknown, expected: string, label: string): void => {
  try {
    validateRenderableReelData(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) throw new Error(`${label}: expected ${expected}, received ${message}`);
    return;
  }
  throw new Error(`${label}: expected an error`);
};

const base = structuredClone(SAMPLE_REELS["look-closer"]);
validateRenderableReelData(base);

rejectsWith({
  ...base,
  scenes: [{ id: "intro", kind: "intro", seconds: 0.01 }],
}, "must render at least 1 frame", "zero-frame scene");

rejectsWith({
  ...base,
  scenes: [
    { id: "duplicate", kind: "intro", seconds: 2 },
    { id: "duplicate", kind: "detail", seconds: 3, detailId: "sky" },
  ],
}, "scene id \"duplicate\" must be unique", "duplicate scene ID");

const duplicateDetails: ReelData = {
  ...base,
  artworks: [{
    ...base.artworks[0],
    detailPoints: [base.artworks[0].detailPoints[0], { ...base.artworks[0].detailPoints[1], id: base.artworks[0].detailPoints[0].id }],
  }],
};
rejectsWith(duplicateDetails, "detail id \"sky\" must be unique", "duplicate detail ID");

rejectsWith({
  ...base,
  scenes: [
    { id: "intro", kind: "intro", seconds: 2 },
    { id: "missing-detail", kind: "detail", seconds: 3, detailId: "not-there" },
  ],
}, "references missing detail \"not-there\"", "missing detail reference");

rejectsWith({
  ...base,
  scenes: [{ id: "missing-artwork", kind: "intro", seconds: 2, artworkIndex: 4 }],
}, "references missing artwork index 4", "missing artwork reference");

rejectsWith({
  ...base,
  scenes: [
    { id: "intro", kind: "intro", seconds: 2 },
    { id: "detail", kind: "detail", seconds: 3, detailId: "sky" },
    { id: "observation", kind: "observation", seconds: 3, observationIndex: 99 },
  ],
}, "references missing observation index 99", "missing observation reference");

console.log("Scene plan validation tests passed");
