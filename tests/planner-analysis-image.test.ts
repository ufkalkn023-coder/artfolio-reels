import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { compileSingleArtworkPlan } from "../src/planner/compiler";
import { assessEligibility } from "../src/planner/eligibility";
import { planWithGemini } from "../src/planner/gemini";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
};

const createRgbPng = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const jpegDimensions = (bytes: Buffer): [number, number] => {
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    const segmentLength = bytes.readUInt16BE(offset);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += segmentLength;
  }
  throw new Error("Planner payload is not a JPEG with dimensions");
};

const withEnvironment = async (operation: () => Promise<void>): Promise<void> => {
  const previous = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "test-api-key";
    await operation();
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
};

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "artfolio-planner-analysis-image-"));
  const originalPath = join(root, "full-resolution-artwork.png");
  await writeFile(originalPath, createRgbPng(2400, 1400));
  const originalBytes = await readFile(originalPath);
  const artwork = { ...STARRY_NIGHT_HANDOFF, imagePath: originalPath, imageWidth: 2400, imageHeight: 1400 };
  const eligibility = assessEligibility(artwork);
  let uploadedMimeType = "";
  let uploadedBytes = Buffer.alloc(0);

  await withEnvironment(async () => {
    await planWithGemini(artwork, eligibility, undefined, {
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> };
        const inlineData = request.contents[0].parts[1].inlineData!;
        uploadedMimeType = inlineData.mimeType;
        uploadedBytes = Buffer.from(inlineData.data, "base64");
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(STARRY_NIGHT_MOCK_PLAN) }] } }], usageMetadata: {} }), { status: 200 });
      },
      appendTelemetry: async () => undefined,
    });
  });

  equal(uploadedMimeType, "image/jpeg", "planner sends a JPEG analysis copy");
  equal(uploadedBytes.equals(originalBytes), false, "planner never uploads the original full-resolution bytes");
  equal(jpegDimensions(uploadedBytes).join("x"), "1600x933", "planner analysis copy preserves aspect ratio within the 1600px long edge");
  equal(artwork.imagePath, originalPath, "planner analysis does not mutate the original handoff path");
  const compiled = compileSingleArtworkPlan(artwork, STARRY_NIGHT_MOCK_PLAN, eligibility);
  equal(compiled.reel.artworks[0].src, originalPath, "ReelData and the render path retain the original full-resolution artwork reference");
  equal(compiled.reel.artworks[0].imageWidth, 2400, "ReelData retains original artwork dimensions");
  equal(compiled.reel.artworks[0].imageHeight, 1400, "ReelData retains original artwork dimensions");
  console.log("Planner analysis image tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
