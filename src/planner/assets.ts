import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { type ArtworkHandoff } from "./handoff";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_PUBLIC_DIRECTORY = resolve("public");
const DEFAULT_ASSET_DIRECTORY = resolve(DEFAULT_PUBLIC_DIRECTORY, "reel-assets");

export type LocalizedArtworkAsset = {
  artwork: ArtworkHandoff;
  sourcePath: string;
  destinationPath: string;
  renderablePath: string;
};

export type AssetLocalizationOptions = {
  publicDirectory?: string;
  assetDirectory?: string;
};

const isWithin = (path: string, directory: string): boolean => {
  const pathRelative = relative(directory, path);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative));
};

const safeAssetName = (canonicalId: string): string => {
  const sanitized = canonicalId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Artwork canonical ID cannot produce a safe local asset filename");
  }
  return sanitized;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const imageDimensions = (bytes: Buffer, extension: string): { width: number; height: number } => {
  if (extension === ".png") {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("Localized artwork is not a valid PNG");
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Localized artwork is not a valid JPEG");
    let offset = 2;
    while (offset < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (segmentLength < 7) break;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
    throw new Error("Localized artwork JPEG dimensions could not be read");
  }

  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Localized artwork is not a valid WebP");
  }
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {
      width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + ((bytes[21] | ((bytes[22] & 0x3f) << 8))),
      height: 1 + (((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))),
    };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  throw new Error("Localized artwork WebP dimensions could not be read");
};

const verifyImage = (bytes: Buffer, extension: string, artwork: ArtworkHandoff): void => {
  const { width, height } = imageDimensions(bytes, extension);
  if (width !== artwork.imageWidth || height !== artwork.imageHeight) {
    throw new Error(`Localized artwork dimensions do not match verified handoff metadata: expected ${artwork.imageWidth}x${artwork.imageHeight}, found ${width}x${height}`);
  }
};

const verifyRegularFile = async (path: string, label: string): Promise<void> => {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
};

const writeWithoutOverwriting = async (destination: string, bytes: Buffer): Promise<void> => {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readFile(destination);
      if (sha256(existing) !== sha256(bytes)) throw new Error(`Refusing to overwrite different localized artwork asset: ${destination}`);
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/**
 * Converts an external handoff image into a staticFile-compatible project asset.
 * The original handoff is never mutated; only the compiler receives this copy.
 */
export const localizeArtworkAsset = async (
  artwork: ArtworkHandoff,
  options: AssetLocalizationOptions = {},
): Promise<LocalizedArtworkAsset> => {
  const publicDirectory = resolve(options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY);
  const assetDirectory = resolve(options.assetDirectory ?? DEFAULT_ASSET_DIRECTORY);
  if (!isWithin(assetDirectory, publicDirectory)) throw new Error("Localized asset directory must be inside the Remotion public directory");

  const sourcePath = resolve(artwork.imagePath);
  await verifyRegularFile(sourcePath, "Artwork handoff image");
  const extension = extname(sourcePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) throw new Error(`Artwork handoff image format is not supported for Remotion: ${extension || "<none>"}`);
  const sourceBytes = await readFile(sourcePath);
  verifyImage(sourceBytes, extension, artwork);

  if (isWithin(sourcePath, publicDirectory)) {
    const renderablePath = relative(publicDirectory, sourcePath).split(sep).join("/");
    return { artwork: { ...artwork, imagePath: `public/${renderablePath}` }, sourcePath, destinationPath: sourcePath, renderablePath };
  }

  const filename = `${safeAssetName(artwork.canonicalId)}${extension}`;
  const destinationPath = resolve(assetDirectory, filename);
  if (!isWithin(destinationPath, assetDirectory)) throw new Error("Localized artwork destination escaped the asset directory");
  await mkdir(assetDirectory, { recursive: true });

  try {
    await verifyRegularFile(destinationPath, "Existing localized artwork asset");
    const existing = await readFile(destinationPath);
    if (sha256(existing) !== sha256(sourceBytes)) throw new Error(`Refusing to overwrite different localized artwork asset: ${destinationPath}`);
    verifyImage(existing, extension, artwork);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing localized artwork asset is missing:")) {
      await writeWithoutOverwriting(destinationPath, sourceBytes);
      await verifyRegularFile(destinationPath, "Localized artwork asset");
      const localized = await readFile(destinationPath);
      if (sha256(localized) !== sha256(sourceBytes)) throw new Error(`Localized artwork bytes do not match source: ${destinationPath}`);
      verifyImage(localized, extension, artwork);
    } else {
      throw error;
    }
  }

  const renderablePath = relative(publicDirectory, destinationPath).split(sep).join("/");
  return { artwork: { ...artwork, imagePath: `public/${renderablePath}` }, sourcePath, destinationPath, renderablePath };
};
