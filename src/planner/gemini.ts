import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getGeminiConfig, type GeminiThinkingLevel } from "./config";
import { type ArtworkHandoff } from "./handoff";
import { type ReelEligibility } from "./eligibility";
import { buildGeminiPlannerPrompt } from "./prompt";
import { NewReelPlanSchema } from "./reel-plan";
import { appendPlannerUsageTelemetry, createPlannerUsageTelemetry } from "./telemetry";
import { type PlannerCallResult } from "./service";
import { PlannerFailureCategory, PlannerFailureError } from "./failure";
import { EMPTY_RECENT_MUSIC_CONTEXT, type RecentMusicContext } from "./music-history";

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

const redactDiagnostic = (value: string): string => value
  .replace(/(?:https?|wss?):\/\/[^\s'"<>]+/gi, "[redacted-url]")
  .replace(/([?&](?:key|token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
  .replace(/(\b(?:[A-Z][A-Z0-9_]*?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|token|secret|password)\b\s*(?:=|:)\s*)[^\s,;]+/gi, "$1[redacted]")
  .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
  .replace(/\s+/g, " ")
  .trim();

const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

const arrayValue = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;

const keysForDiagnostic = (value: unknown): string => isRecord(value)
  ? `[${Object.keys(value).sort().slice(0, 16).map((key) => redactDiagnostic(key).slice(0, 64)).join(",")}]`
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
  return redactDiagnostic(parts.join(" — ")).slice(0, 440);
};

const parseGeminiErrorResponse = async (response: Response): Promise<unknown> => {
  // Google error payloads are small. Limit parsing to avoid retaining an
  // unexpected large provider response in diagnostics.
  const body = (await response.text()).slice(0, 8_192);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

/** Called only by the planning CLI after eligibility and cache checks; never imported by render/QC paths. */
export const planWithGemini = async (
  artwork: ArtworkHandoff,
  eligibility: ReelEligibility,
  recentMusic: RecentMusicContext = EMPTY_RECENT_MUSIC_CONTEXT,
): Promise<PlannerCallResult> => {
  const { apiKey, model, thinkingLevel } = getGeminiConfig();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required only when generating a new plan");
  const imageBytes = await readFile(resolve(artwork.imagePath));
  const requestStartedAt = performance.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: buildGeminiPlannerPrompt(artwork, eligibility, recentMusic) },
        { inlineData: { mimeType: mimeForPath(artwork.imagePath), data: imageBytes.toString("base64") } },
      ] }],
      generationConfig: buildGeminiPlannerGenerationConfig(thinkingLevel),
    }),
  });
  if (!response.ok) {
    const reason = summarizeGeminiApiError(response.status, await parseGeminiErrorResponse(response));
    throw new PlannerFailureError(PlannerFailureCategory.API_ERROR, `Gemini planner request failed (${reason})`);
  }
  const payload = await response.json() as {
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
  await appendPlannerUsageTelemetry(telemetry);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini planner returned no structured content");
  const parsed = JSON.parse(text) as unknown;
  const plan = NewReelPlanSchema.safeParse(parsed);
  if (!plan.success) {
    throw new Error(`Gemini planner structured response failed local validation (${summarizeInvalidReelPlanResponse(parsed)})`);
  }
  return { plan: plan.data, telemetry };
};
