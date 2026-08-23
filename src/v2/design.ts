export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
} as const;

export const DESIGN = {
  color: {
    ivory: "#F4F2ED",
    charcoal: "#111417",
    neutral: "#A7A49E",
    line: "#D8D5CE",
    lightText: "#F3F0E8",
  },
  font: {
    serif: 'Iowan Old Style, "Palatino Linotype", "Book Antiqua", Georgia, serif',
    sans: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  },
  safe: {
    top: 110,
    right: 115,
    bottom: 260,
    left: 70,
  },
  type: {
    hook: 78,
    title: 62,
    observation: 58,
    metadata: 24,
    label: 19,
  },
} as const;

export const secondsToFrames = (seconds: number): number =>
  Math.round(seconds * VIDEO.fps);

export const framesToSeconds = (frames: number): number => frames / VIDEO.fps;
