import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PLANNER_VERSION, type GeminiThinkingLevel } from "./config";

export const GEMINI_PRICING = {
  version: "gemini-3.7-flash-standard-2026",
  inputUsdPerMillionTokens: 0.75,
  outputAndThinkingUsdPerMillionTokens: 3.75,
} as const;

export type GeminiUsageMetadata = {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  thoughtsTokenCount: number | null;
  totalTokenCount: number | null;
};

export type PlannerUsageTelemetry = GeminiUsageMetadata & {
  canonicalArtworkId: string;
  model: string;
  thinkingLevel: GeminiThinkingLevel;
  plannerVersion: number;
  cacheHit: false;
  geminiCalls: 1;
  requestDurationMs: number;
  inputCostUsd: number;
  outputAndThinkingCostUsd: number;
  estimatedCostUsd: number;
  pricingVersion: string;
  timestamp: string;
};

type GeminiUsageMetadataResponse = Partial<Record<keyof GeminiUsageMetadata, unknown>>;

const tokenCount = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
);

const costFor = (tokenCount: number | null, ratePerMillionTokens: number): number => (
  (tokenCount ?? 0) / 1_000_000 * ratePerMillionTokens
);

/** Extract count-only API usage. No response text, thought content, image data, or credentials enter telemetry. */
export const mapGeminiUsageMetadata = (usage: GeminiUsageMetadataResponse | undefined): GeminiUsageMetadata => ({
  promptTokenCount: tokenCount(usage?.promptTokenCount),
  candidatesTokenCount: tokenCount(usage?.candidatesTokenCount),
  thoughtsTokenCount: tokenCount(usage?.thoughtsTokenCount),
  totalTokenCount: tokenCount(usage?.totalTokenCount),
});

export const createPlannerUsageTelemetry = (input: {
  canonicalArtworkId: string;
  model: string;
  thinkingLevel: GeminiThinkingLevel;
  requestDurationMs: number;
  usage: GeminiUsageMetadataResponse | undefined;
  timestamp?: string;
}): PlannerUsageTelemetry => {
  const usage = mapGeminiUsageMetadata(input.usage);
  const inputCostUsd = costFor(usage.promptTokenCount, GEMINI_PRICING.inputUsdPerMillionTokens);
  const outputAndThinkingCostUsd = costFor(
    (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    GEMINI_PRICING.outputAndThinkingUsdPerMillionTokens,
  );
  return {
    canonicalArtworkId: input.canonicalArtworkId,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    plannerVersion: PLANNER_VERSION,
    cacheHit: false,
    geminiCalls: 1,
    requestDurationMs: input.requestDurationMs,
    ...usage,
    inputCostUsd,
    outputAndThinkingCostUsd,
    estimatedCostUsd: inputCostUsd + outputAndThinkingCostUsd,
    pricingVersion: GEMINI_PRICING.version,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
};

export const plannerUsageTelemetryPath = (): string => resolve("data/telemetry/planner-usage.jsonl");

export const appendPlannerUsageTelemetry = async (
  telemetry: PlannerUsageTelemetry,
  destination = plannerUsageTelemetryPath(),
): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  await appendFile(destination, `${JSON.stringify(telemetry)}\n`, "utf8");
};

export const formatPlannerUsageSummary = (telemetry: PlannerUsageTelemetry): string => (
  `[planner] artwork=${telemetry.canonicalArtworkId} model=${telemetry.model} thinking=${telemetry.thinkingLevel} `
  + `input=${telemetry.promptTokenCount ?? "unknown"} output=${telemetry.candidatesTokenCount ?? "unknown"} `
  + `thoughts=${telemetry.thoughtsTokenCount ?? "unknown"} total=${telemetry.totalTokenCount ?? "unknown"} `
  + `cost=$${telemetry.estimatedCostUsd.toFixed(4)} time=${(telemetry.requestDurationMs / 1_000).toFixed(2)}s`
);
