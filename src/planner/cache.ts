import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PLANNER_VERSION } from "./config";
import { type ArtworkHandoff } from "./handoff";
import { type ReelEligibility } from "./eligibility";
import { ReelPlanSchema, type ReelPlan, validateReelPlan } from "./reel-plan";

const CachedPlanSchema = z.object({
  plannerVersion: z.literal(PLANNER_VERSION),
  canonicalArtworkId: z.string().min(1),
  template: ReelPlanSchema.shape.template,
  plan: ReelPlanSchema,
  fallback: z.boolean().optional(),
}).strict();
export type CachedPlan = z.infer<typeof CachedPlanSchema>;
export type CachedPlanRead = Pick<CachedPlan, "fallback"> & { plan: ReelPlan };
export const PlanCacheStatus = {
  HIT: "HIT",
  MISS: "MISS",
  INVALID: "INVALID",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  IO_ERROR: "IO_ERROR",
} as const;
export type PlanCacheStatus = (typeof PlanCacheStatus)[keyof typeof PlanCacheStatus];
export type CachedPlanReadResult =
  | { status: typeof PlanCacheStatus.HIT; value: CachedPlanRead }
  | { status: Exclude<PlanCacheStatus, typeof PlanCacheStatus.HIT>; path: string; reason?: string };

export class PlanCacheReadError extends Error {
  constructor(readonly status: Exclude<PlanCacheStatus, "HIT" | "MISS">, readonly path: string, reason?: string) {
    super(`Plan cache ${status.toLowerCase()} at ${path}${reason ? `: ${reason}` : ""}`);
    this.name = "PlanCacheReadError";
  }
}

export const cacheKeyFor = (canonicalId: string): string => canonicalId.replace(/[^A-Za-z0-9_-]/g, "_");

export const planCachePath = (directory: string, canonicalId: string): string => join(directory, `${cacheKeyFor(canonicalId)}.json`);

export const readCachedPlan = async (
  directory: string,
  artwork: ArtworkHandoff,
  eligibility: ReelEligibility,
): Promise<CachedPlanReadResult> => {
  const path = planCachePath(directory, artwork.canonicalId);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: PlanCacheStatus.MISS, path };
    return { status: PlanCacheStatus.IO_ERROR, path, reason: (error as NodeJS.ErrnoException).code ?? "read failed" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    return { status: PlanCacheStatus.INVALID, path, reason: "malformed JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: PlanCacheStatus.INVALID, path, reason: "cache root must be an object" };
  }
  if ((raw as { plannerVersion?: unknown }).plannerVersion !== PLANNER_VERSION) {
    return { status: PlanCacheStatus.SCHEMA_MISMATCH, path, reason: "planner version mismatch" };
  }
  const parsed = CachedPlanSchema.safeParse(raw);
  if (!parsed.success) return { status: PlanCacheStatus.INVALID, path, reason: "cache schema validation failed" };
  if (parsed.data.canonicalArtworkId !== artwork.canonicalId) {
    return { status: PlanCacheStatus.SCHEMA_MISMATCH, path, reason: "canonical artwork ID mismatch" };
  }
  try {
    return {
      status: PlanCacheStatus.HIT,
      value: { plan: validateReelPlan(parsed.data.plan, eligibility, 1), fallback: parsed.data.fallback },
    };
  } catch {
    return { status: PlanCacheStatus.SCHEMA_MISMATCH, path, reason: "cached plan is incompatible with current validation" };
  }
};

export const writeCachedPlan = async (directory: string, artwork: ArtworkHandoff, plan: ReelPlan, fallback?: boolean): Promise<string> => {
  await mkdir(directory, { recursive: true });
  const cache: CachedPlan = {
    plannerVersion: PLANNER_VERSION,
    canonicalArtworkId: artwork.canonicalId,
    template: plan.template,
    plan,
    ...(fallback ? { fallback: true } : {}),
  };
  const destination = planCachePath(directory, artwork.canonicalId);
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`);
    await rename(temporaryPath, destination);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return destination;
};
