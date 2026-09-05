import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    files: ["scripts/qc-rendering.ts"],
    rules: {
      "no-unsafe-finally": "off",
    },
  },
  {
    files: ["src/Composition.tsx"],
    rules: {
      "@remotion/from-0": "off",
    },
  },
  {
    files: ["src/v2/audio.tsx"],
    rules: {
      "@remotion/volume-callback": "off",
    },
  },
];
