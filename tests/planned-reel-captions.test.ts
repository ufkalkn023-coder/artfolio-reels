import { ReelDataSchema } from "../src/v2/schema";
import { SAMPLE_REELS } from "../src/v2/samples";

const sampleDefault = SAMPLE_REELS["why-this-works"];
const { captions: sampleCaptions, ...productionInputWithoutCaptions } = sampleDefault;

if (sampleCaptions !== undefined) {
  throw new Error("Planned Reel sample defaults must not contain captions that can leak into production props");
}

const productionReel = ReelDataSchema.parse({
  ...productionInputWithoutCaptions,
  id: "production-planned-reel-without-captions",
});

if (productionReel.captions !== undefined) {
  throw new Error("A production Planned Reel that omits captions must keep captions undefined");
}

console.log("Planned Reel caption default regression test passed");
