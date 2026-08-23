import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** The only Gemini configuration location. Keep credentials out of source and logs. */
export const PLANNER_VERSION = 1 as const;

export const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";
export const GEMINI_THINKING_LEVELS = ["low", "medium", "high"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];
export const GEMINI_DEFAULT_THINKING_LEVEL: GeminiThinkingLevel = "high";

/** Load local development values without overriding process/CI environment variables. */
export const loadMissingEnvironmentFrom = (path = resolve(process.cwd(), ".env.local")): void => {
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, "utf8"));
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
  }
};

loadMissingEnvironmentFrom();

export const getGeminiThinkingLevel = (): GeminiThinkingLevel => {
  const value = process.env.GEMINI_THINKING_LEVEL;
  if (value === undefined) return GEMINI_DEFAULT_THINKING_LEVEL;
  const thinkingLevel = value.trim();
  if ((GEMINI_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    return thinkingLevel as GeminiThinkingLevel;
  }
  throw new Error(`GEMINI_THINKING_LEVEL must be one of: ${GEMINI_THINKING_LEVELS.join(", ")}`);
};

export const getGeminiConfig = (): { apiKey: string | undefined; model: string; thinkingLevel: GeminiThinkingLevel } => ({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL,
  thinkingLevel: getGeminiThinkingLevel(),
});
