import { z } from "zod";

export const PlannerFailureCategory = {
  API_ERROR: "API_ERROR",
  TIMEOUT: "TIMEOUT",
  INVALID_JSON: "INVALID_JSON",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  ACCEPTANCE_REJECTED: "ACCEPTANCE_REJECTED",
  COMPILER_ERROR: "COMPILER_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type PlannerFailureCategory = (typeof PlannerFailureCategory)[keyof typeof PlannerFailureCategory];

export class PlannerFailureError extends Error {
  constructor(
    readonly category: PlannerFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "PlannerFailureError";
  }
}

export const classifyPlannerFailure = (error: unknown): PlannerFailureCategory => {
  if (error instanceof PlannerFailureError) return error.category;
  if (error instanceof z.ZodError) return PlannerFailureCategory.SCHEMA_INVALID;
  if (error instanceof SyntaxError) return PlannerFailureCategory.INVALID_JSON;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /\b(?:timed?\s*out|timeout)\b/i.test(error.message))) {
    return PlannerFailureCategory.TIMEOUT;
  }
  return PlannerFailureCategory.UNKNOWN;
};
