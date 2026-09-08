import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getGeminiConfig, type GeminiThinkingLevel } from "./config";
import { type ArtworkHandoff } from "./handoff";
import { type ReelEligibility } from "./eligibility";
import { buildGeminiMotionRepairPrompt, buildGeminiPlannerPrompt } from "./prompt";
import { NewReelPlanSchema } from "./reel-plan";
import { appendPlannerUsageTelemetry, createPlannerUsageTelemetry } from "./telemetry";
import { type PlannerCallContext, type PlannerCallResult } from "./service";
import { PlannerFailureCategory, PlannerFailureError } from "./failure";
import { EMPTY_RECENT_MUSIC_CONTEXT, type RecentMusicContext } from "./music-history";
import { sanitizeDiagnostic } from "../security/redaction";
import { type PlannerUsageTelemetry } from "./telemetry";

const mimeForPath = (filePath: string): string => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[extname(filePath).toLowerCase()] ?? "image/jpeg");

type GeminiJsonSchema = {
  type?: string;
  properties?: Record<string, GeminiJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | GeminiJsonSchema;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  items?: GeminiJsonSchema;
  minItems?: number;
};

type GeminiObjectSchema = GeminiJsonSchema & {
  type: "object";
  properties: Record<string, GeminiJsonSchema>;
  required: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Zod is the local source of truth. Keep only the JSON Schema keywords Gemini
 * documents for responseJsonSchema so conversion metadata cannot reintroduce
 * the prior provider-side schema rejection.
 */
const toGeminiResponseJsonSchema = (input: unknown): GeminiJsonSchema => {
  if (!isRecord(input)) throw new Error("ReelPlan JSON Schema must be an object");
  const schema: GeminiJsonSchema = {};
  if (typeof input.type === "string") schema.type = input.type;
  if (Array.isArray(input.required) && input.required.every((value) => typeof value === "string")) schema.required = [...input.required];
  if (typeof input.additionalProperties === "boolean") schema.additionalProperties = input.additionalProperties;
  if (Array.isArray(input.enum) && input.enum.every((value) => typeof value === "string" || typeof value === "number")) schema.enum = [...input.enum];
  if (typeof input.minimum === "number") schema.minimum = input.minimum;
  if (typeof input.maximum === "number") schema.maximum = input.maximum;
  if (typeof input.minItems === "number") schema.minItems = input.minItems;
  if (isRecord(input.properties)) {
    schema.properties = Object.fromEntries(Object.entries(input.properties).map(([key, value]) => [key, toGeminiResponseJsonSchema(value)]));
  }
  if (isRecord(input.items)) schema.items = toGeminiResponseJsonSchema(input.items);
  if (isRecord(input.additionalProperties)) schema.additionalProperties = toGeminiResponseJsonSchema(input.additionalProperties);
  return schema;
};

/**
 * This is derived from NewReelPlanSchema rather than hand-maintained so nested
 * details, scenes, enums, and required fields cannot silently drift.
 */
export const GEMINI_PLANNER_RESPONSE_SCHEMA = toGeminiResponseJsonSchema(NewReelPlanSchema.toJSONSchema()) as GeminiObjectSchema;

export const buildGeminiPlannerGenerationConfig = (thinkingLevel: GeminiThinkingLevel) => ({
  // This raw REST generateContent request supplies JSON Schema through
  // responseJsonSchema. responseSchema is the protobuf Schema variant.
  responseMimeType: "application/json",
  responseJsonSchema: GEMINI_PLANNER_RESPONSE_SCHEMA,
  temperature: 0.2,
  thinkingConfig: { thinkingLevel: thinkingLevel.toUpperCase() },
});

type GoogleApiError = {
  error?: {
    message?: unknown;
    status?: unknown;
    details?: unknown;
  };
};

const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

const arrayValue = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;

const keysForDiagnostic = (value: unknown): string => isRecord(value)
  ? `[${Object.keys(value).sort().slice(0, 16).map((key) => sanitizeDiagnostic(key, 64)).join(",")}]`
  : "[not-object]";

/**
 * Reports only the shape that is useful for debugging schema-invalid planner
 * output. It intentionally never includes editorial text, image data, URLs,
 * credentials, or a full provider response.
 */
export const summarizeInvalidReelPlanResponse = (value: unknown): string => {
  const root = isRecord(value) ? value : undefined;
  const details = arrayValue(root?.details);
  const scenes = arrayValue(root?.scenes);
  return [
    `root keys=${keysForDiagnostic(value)}`,
    `details.length=${details?.length ?? "not-array"}`,
    `details[0] keys=${keysForDiagnostic(details?.[0])}`,
    `scenes.length=${scenes?.length ?? "not-array"}`,
    `scenes[0] keys=${keysForDiagnostic(scenes?.[0])}`,
  ].join("; ").slice(0, 600);
};

/**
 * Extract only stable Google error fields; never expose request data or the
 * full provider response. This keeps batch manifests useful without leaking
 * prompts, image data, endpoint URLs, or credentials.
 */
export const summarizeGeminiApiError = (statusCode: number, body: unknown): string => {
  const error = (body as GoogleApiError | undefined)?.error;
  const parts = [`HTTP ${statusCode}`];
  const status = stringValue(error?.status);
  const message = stringValue(error?.message);
  if (status) parts.push(status);

  const fieldViolations = Array.isArray(error?.details)
    ? error.details.flatMap((detail) => {
      if (!detail || typeof detail !== "object" || !Array.isArray((detail as { fieldViolations?: unknown }).fieldViolations)) return [];
      return (detail as { fieldViolations: unknown[] }).fieldViolations.slice(0, 3).flatMap((violation) => {
        if (!violation || typeof violation !== "object") return [];
        const field = stringValue((violation as { field?: unknown }).field);
        const description = stringValue((violation as { description?: unknown }).description);
        return field || description ? [`${field ?? "field"}: ${description ?? "invalid"}`] : [];
      });
    })
    : [];
  if (fieldViolations.length > 0) parts.push(fieldViolations.join("; "));
  if (message) parts.push(message);
  // Leave room for the stable "Gemini planner request failed (...)" wrapper.
  return sanitizeDiagnostic(parts.join(" — "), 440);
};

export class GeminiResponseSizeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Gemini response exceeds the ${limitBytes}-byte limit`);
    this.name = "GeminiResponseSizeError";
  }
}

export const readGeminiResponseText = async (response: Response, limitBytes: number): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limitBytes) {
    throw new GeminiResponseSizeError(limitBytes);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GeminiResponseSizeError(limitBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
};

const parseGeminiErrorResponse = async (response: Response, limitBytes: number): Promise<unknown> => {
  const body = (await readGeminiResponseText(response, limitBytes)).slice(0, 8_192);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

export type GeminiPlannerDependencies = {
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<Buffer>;
  stat?: (path: string) => Promise<{ size: number }>;
  appendTelemetry?: (telemetry: PlannerUsageTelemetry) => Promise<void>;
};

const isPlannerCallContext = (value: PlannerCallContext | GeminiPlannerDependencies): value is PlannerCallContext =>
  (value as { kind?: unknown }).kind === "MOTION_REPAIR";

/** Called only by the planning CLI after eligibility and cache checks; never imported by render/QC paths. */
export const planWithGemini = async (
  artwork: ArtworkHandoff,
  eligibility: ReelEligibility,
  recentMusic: RecentMusicContext = EMPTY_RECENT_MUSIC_CONTEXT,
  contextOrDependencies: PlannerCallContext | GeminiPlannerDependencies = {},
  repairDependencies: GeminiPlannerDependencies = {},
): Promise<PlannerCallResult> => {
  let repairContext: PlannerCallContext | undefined;
  let dependencies: GeminiPlannerDependencies;
  if (isPlannerCallContext(contextOrDependencies)) {
    repairContext = contextOrDependencies;
    dependencies = repairDependencies;
  } else {
    dependencies = contextOrDependencies;
  }
  const { apiKey, model, thinkingLevel, timeoutMs, maxArtworkBytes, maxResponseBytes } = getGeminiConfig();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required only when generating a new plan");
  const artworkPath = resolve(artwork.imagePath);
  const artworkStat = await (dependencies.stat ?? stat)(artworkPath);
  if (artworkStat.size > maxArtworkBytes) {
    throw new Error(`Artwork exceeds the ${maxArtworkBytes}-byte Gemini input limit`);
  }
  const imageBytes = await (dependencies.readFile ?? readFile)(artworkPath);
  if (imageBytes.byteLength > maxArtworkBytes) {
    throw new Error(`Artwork exceeds the ${maxArtworkBytes}-byte Gemini input limit`);
  }
  const requestStartedAt = performance.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const withTimeoutClassification = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (timeoutSignal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
        throw new PlannerFailureError(PlannerFailureCategory.TIMEOUT, `Gemini planner request timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  };
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: timeoutSignal,
      body: JSON.stringify({
        contents: [{ parts: [
          { text: repairContext
            ? buildGeminiMotionRepairPrompt(artwork, eligibility, repairContext, recentMusic)
            : buildGeminiPlannerPrompt(artwork, eligibility, recentMusic) },
          { inlineData: { mimeType: mimeForPath(artwork.imagePath), data: imageBytes.toString("base64") } },
        ] }],
        generationConfig: buildGeminiPlannerGenerationConfig(thinkingLevel),
      }),
    });
  } catch (error) {
    if (timeoutSignal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      throw new PlannerFailureError(PlannerFailureCategory.TIMEOUT, `Gemini planner request timed out after ${timeoutMs}ms`);
    }
    throw new PlannerFailureError(PlannerFailureCategory.API_ERROR, "Gemini planner request failed (network error)");
  }
  if (!response.ok) {
    const body = await withTimeoutClassification(() => parseGeminiErrorResponse(response, maxResponseBytes));
    const reason = summarizeGeminiApiError(response.status, body);
    throw new PlannerFailureError(PlannerFailureCategory.API_ERROR, `Gemini planner request failed (${reason})`);
  }
  const responseText = await withTimeoutClassification(() => readGeminiResponseText(response, maxResponseBytes));
  const payload = JSON.parse(responseText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const telemetry = createPlannerUsageTelemetry({
    canonicalArtworkId: artwork.canonicalId,
    model,
    thinkingLevel,
    requestDurationMs: Math.round(performance.now() - requestStartedAt),
    usage: payload.usageMetadata,
  });
  await (dependencies.appendTelemetry ?? appendPlannerUsageTelemetry)(telemetry);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini planner returned no structured content");
  const parsed = JSON.parse(text) as unknown;
  const plan = NewReelPlanSchema.safeParse(parsed);
  if (!plan.success) {
    throw new Error(`Gemini planner structured response failed local validation (${summarizeInvalidReelPlanResponse(parsed)})`);
  }
  return { plan: plan.data, telemetry };
};
