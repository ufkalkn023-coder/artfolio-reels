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

export const cacheKeyFor = (canonicalId: string): string => canonicalId.replace(/[^A-Za-z0-9_-]/g, "_");

export const planCachePath = (directory: string, canonicalId: string): string => join(directory, `${cacheKeyFor(canonicalId)}.json`);

export const readCachedPlan = async (
  directory: string,
  artwork: ArtworkHandoff,
  eligibility: ReelEligibility,
): Promise<CachedPlanRead | undefined> => {
  try {
    const raw = JSON.parse(await readFile(planCachePath(directory, artwork.canonicalId), "utf8"));
    const cached = CachedPlanSchema.parse(raw);
    if (cached.canonicalArtworkId !== artwork.canonicalId) return undefined;
    return { plan: validateReelPlan(cached.plan, eligibility, 1), fallback: cached.fallback };
  } catch {
    return undefined;
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
