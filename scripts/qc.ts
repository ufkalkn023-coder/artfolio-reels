import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createScenePlan, getDurationInFrames } from "../src/v2/timing";
import { resolveReel } from "./reel-data";

const args = process.argv.slice(2);
const reelId = args.find((argument) => argument !== "--debug-targets") ?? "why-this-works";
const debugTargets = args.includes("--debug-targets");
const { reel, compositionId, propsPath } = resolveReel(reelId);
const plan = createScenePlan(reel);
const total = getDurationInFrames(reel);
let cursor = 0;
const starts = plan.map((scene) => {
  const start = cursor;
  cursor += scene.durationInFrames;
  return start;
});
const outroIndex = plan.findIndex((scene) => scene.kind === "outro");
const checkpoints = [
  ["intro", Math.min(15, total - 1)],
  ["middle", Math.floor(total / 2)],
  ["outro", starts[outroIndex] + 18],
] as const;
const directory = resolve("output/qc", reelId.replace(/[^A-Za-z0-9_-]/g, "_"));
mkdirSync(directory, { recursive: true });
const debugPropsPath = resolve(directory, "debug-props.json");
if (debugTargets) writeFileSync(debugPropsPath, JSON.stringify({ ...reel, debugTargetOverlay: true }, null, 2));
const renderPropsPath = debugTargets ? debugPropsPath : propsPath;
for (const [name, frame] of checkpoints) {
  const output = resolve(directory, `${name}.png`);
  const result = spawnSync("npx", ["remotion", "still", compositionId, output, "--frame", String(frame), ...(renderPropsPath ? [`--props=${renderPropsPath}`] : [])], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const contactSheet = resolve(directory, "contact-sheet.png");
const stills = checkpoints.map(([name]) => resolve(directory, `${name}.png`));
const ffmpeg = spawnSync("ffmpeg", ["-y", "-i", stills[0], "-i", stills[1], "-i", stills[2], "-filter_complex", "hstack=inputs=3", "-frames:v", "1", "-update", "1", contactSheet], { stdio: "inherit" });
if (ffmpeg.status !== 0 || !existsSync(contactSheet)) {
  throw new Error("Could not create the QC contact sheet with ffmpeg.");
}
console.log(`QC stills and contact sheet: ${directory}`);
