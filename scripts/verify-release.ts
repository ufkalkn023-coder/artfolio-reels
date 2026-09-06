import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { verifyReleasePackage } from "../src/release/package";

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const deep = args.includes("--deep");
  const targets = args.filter((argument) => !argument.startsWith("--"));
  if (targets.length !== 1) throw new Error("Usage: npm run reels:verify-release -- <release-path-or-id> [--deep] [--json]");
  const raw = targets[0];
  const explicit = resolve(raw);
  const releaseDirectory = await stat(explicit).then((entry) => entry.isDirectory()).catch(() => false)
    ? explicit
    : resolve("output/releases", basename(raw));
  const result = await verifyReleasePackage({ releaseDirectory, deep });
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(`Release ${result.reelId ?? basename(releaseDirectory)}: ${result.valid ? "VALID" : "INVALID"}`);
    for (const error of result.errors) console.log(`- ${error}`);
  }
  if (!result.valid) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
