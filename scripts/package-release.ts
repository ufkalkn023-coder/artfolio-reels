import { packageRelease } from "../src/release/package";

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const reelIds = args.filter((argument) => argument !== "--overwrite");
  if (reelIds.length !== 1) throw new Error("Usage: npm run package -- <reel-id> [--overwrite]");

  const release = await packageRelease({ reelId: reelIds[0], overwrite });
  console.log(`Packaged release: ${release.directory}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
