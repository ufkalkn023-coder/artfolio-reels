import { calculateAudioGain } from "../src/v2/audio";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const throws = (operation: () => unknown, label: string): void => {
  try { operation(); } catch { return; }
  throw new Error(`${label}: expected an error`);
};

const gain = (overrides: Partial<Parameters<typeof calculateAudioGain>[0]> = {}): number => calculateAudioGain({
  absoluteFrame: 0,
  compositionDurationInFrames: 300,
  trackStartFrame: 0,
  sourceDurationInFrames: 600,
  fadeInFrames: 30,
  fadeOutFrames: 30,
  ...overrides,
});

equal(gain({ absoluteFrame: 0 }), 0, "start=0 begins fade-in at silence");
equal(gain({ absoluteFrame: 29 }), 1, "start=0 reaches full volume after fade-in");
equal(gain({ absoluteFrame: 299 }), 0, "audio longer than Reel fades to zero on the final composition frame");
equal(gain({ absoluteFrame: 60, trackStartFrame: 60 }), 0, "non-zero start uses absolute frame space for fade-in");
equal(gain({ absoluteFrame: 89, trackStartFrame: 60 }), 1, "non-zero start reaches full volume relative to its own start");
equal(gain({ absoluteFrame: 299, trackStartFrame: 60 }), 0, "non-zero start still fades on the final composition frame");
equal(gain({ absoluteFrame: 149, trackStartFrame: 60, sourceDurationInFrames: 90 }), 0, "short audio fades on its own final frame");
equal(gain({ absoluteFrame: 150, trackStartFrame: 60, sourceDurationInFrames: 90 }), 0, "short audio is silent after its source duration");
truthy(gain({ absoluteFrame: 10 }) > 0 && gain({ absoluteFrame: 10 }) < 1, "fade-in has an intermediate gain");
truthy(gain({ absoluteFrame: 280 }) > 0 && gain({ absoluteFrame: 280 }) < 1, "fade-out has an intermediate gain");
throws(() => gain({ trackStartFrame: 300 }), "track start outside composition is invalid");
throws(() => gain({ fadeOutFrames: -1 }), "negative fade bounds are invalid");
throws(() => gain({ absoluteFrame: 1.5 }), "fractional frames are invalid");

console.log("Audio fade tests passed");
