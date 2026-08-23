import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Produces an ASCII-only, cross-platform-safe presentation slug from verified artwork metadata. */
export const slugifyArtworkTitle = (title: string): string => title
  .normalize("NFKD")
  .replace(/\p{Mark}/gu, "")
  .toLowerCase()
  .replace(/[\u0027\u2019]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const assertSafeCanonicalId = (canonicalId: string): void => {
  if (!SAFE_CANONICAL_ID.test(canonicalId)) {
    throw new Error("Canonical ID is not safe for a render filename");
  }
};

export const renderFilenameForArtwork = (canonicalId: string, artworkTitle: string): string => {
  assertSafeCanonicalId(canonicalId);
  const titleSlug = slugifyArtworkTitle(artworkTitle);
  return `${canonicalId}${titleSlug ? `-${titleSlug}` : ""}.mp4`;
};

/** Resolves a title-based render destination without allowing it to leave the renders directory. */
export const resolveRenderOutputPath = (canonicalId: string, artworkTitle: string, outputDirectory = resolve("output")): string => {
  const rendersDirectory = resolve(outputDirectory, "renders");
  const destination = resolve(rendersDirectory, renderFilenameForArtwork(canonicalId, artworkTitle));
  const fromRendersDirectory = relative(rendersDirectory, destination);
  if (fromRendersDirectory === "" || fromRendersDirectory === ".." || fromRendersDirectory.startsWith(`..${sep}`) || isAbsolute(fromRendersDirectory)) {
    throw new Error("Render destination must remain inside output/renders");
  }
  return destination;
};

/** Keeps the existing explicit overwrite policy reusable and independently testable. */
export const assertRenderDestinationWritable = (destination: string, overwrite: boolean): void => {
  if (existsSync(destination) && !overwrite) {
    throw new Error(`${destination} exists. Pass --overwrite to replace it.`);
  }
};
