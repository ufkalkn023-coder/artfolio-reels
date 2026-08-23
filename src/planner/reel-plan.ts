import { z } from "zod";
import { CameraMoveSchema, HookTypeSchema, TargetRegionSchema, TargetTypeSchema, TemplateIdSchema, type TemplateId } from "../v2/schema";
import { getTemplate } from "../v2/templates";
import { type ReelEligibility } from "./eligibility";

const wordCount = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;
export const DISTANCE_THRESHOLD = 0.12;
export const DURATION_TOLERANCE_SECONDS = 1 / 30;

export const PlannedDetailSchema = z.object({
  id: z.string().trim().min(1).max(48),
  label: z.string().trim().min(1).max(36),
  observation: z.string().trim().min(1).max(120).refine((value) => wordCount(value) <= 18, "observation must contain no more than 18 words"),
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
  preferredScale: z.number().positive().max(2.5),
  targetType: TargetTypeSchema.optional(),
  targetRegion: TargetRegionSchema.optional(),
}).strict();
export type PlannedDetail = z.infer<typeof PlannedDetailSchema>;

export const PlannedSceneSchema = z.object({
  id: z.string().trim().min(1).max(60),
  kind: z.enum(["intro", "overview", "detail", "observation", "comparison", "metadata", "outro"]),
  seconds: z.number().positive().max(20),
  detailId: z.string().trim().min(1).max(48).optional(),
  observationIndex: z.number().int().nonnegative().optional(),
  camera: z.object({
    move: CameraMoveSchema,
    focalX: z.number().min(0).max(1).optional(),
    focalY: z.number().min(0).max(1).optional(),
    endFocalX: z.number().min(0).max(1).optional(),
    endFocalY: z.number().min(0).max(1).optional(),
    startScale: z.number().positive().max(2.5).optional(),
    endScale: z.number().positive().max(2.5).optional(),
  }).strict().optional(),
}).strict();
export type PlannedScene = z.infer<typeof PlannedSceneSchema>;

export const ReelPlanSchema = z.object({
  template: TemplateIdSchema,
  hook: z.object({
    type: HookTypeSchema,
    text: z.string().trim().min(1).max(120).refine((value) => wordCount(value) <= 12, "hook must contain no more than 12 words"),
  }).strict(),
  centralIdea: z.string().trim().min(1).max(180),
  details: z.array(PlannedDetailSchema).max(6),
  scenes: z.array(PlannedSceneSchema).min(1).max(10),
}).strict();
export type ReelPlan = z.infer<typeof ReelPlanSchema>;

export const isDistinctDetailSet = (details: readonly PlannedDetail[]): boolean =>
  details.every((detail, index) => details.slice(index + 1).every((other) =>
    Math.hypot(detail.focalX - other.focalX, detail.focalY - other.focalY) >= DISTANCE_THRESHOLD,
  ));

export const validateReelPlan = (input: unknown, eligibility: ReelEligibility, artworkCount = 1): ReelPlan => {
  const plan = ReelPlanSchema.parse(input);
  const template = getTemplate(plan.template);
  const errors: string[] = [];
  if (!eligibility.eligibleTemplates.includes(plan.template)) errors.push(`${plan.template} is not eligible for this artwork`);
  if (template.requiredArtworkCount !== artworkCount) errors.push(`${plan.template} requires exactly ${template.requiredArtworkCount} artwork(s)`);
  if (plan.details.length < template.requiredDetailCount) errors.push(`${plan.template} requires ${template.requiredDetailCount} detail points`);
  if (plan.template === "three-details" && !isDistinctDetailSet(plan.details.slice(0, 3))) {
    errors.push("three-details requires three distinct focal points");
  }
  const detailIds = new Set(plan.details.map((detail) => detail.id));
  const expectedScenes = template.defaultScenePlan;
  if (plan.scenes.length !== expectedScenes.length || plan.scenes.some((scene, index) => scene.kind !== expectedScenes[index])) {
    errors.push(`${plan.template} scene sequence must match its registered template`);
  }
  plan.scenes.forEach((scene) => {
    if (scene.kind === "detail" && !scene.detailId) errors.push(`detail scene ${scene.id} requires detailId`);
    if (scene.detailId && !detailIds.has(scene.detailId)) errors.push(`scene ${scene.id} references an unknown detail`);
    if (scene.kind === "observation" && scene.observationIndex === undefined && !scene.detailId) errors.push(`observation scene ${scene.id} requires detailId or observationIndex`);
    if (scene.observationIndex !== undefined && scene.observationIndex >= plan.details.length) errors.push(`scene ${scene.id} references an unknown observation`);
  });
  const duration = plan.scenes.reduce((total, scene) => total + scene.seconds, 0);
  if (duration < template.minDuration - DURATION_TOLERANCE_SECONDS || duration > template.maxDuration + DURATION_TOLERANCE_SECONDS) {
    errors.push(`${plan.template} duration must be between ${template.minDuration} and ${template.maxDuration} seconds`);
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return plan;
};

export const templateConstraintSummary = (templateIds: readonly TemplateId[]): string => templateIds.map((id) => {
  const template = getTemplate(id);
  return `${id}: ${template.minDuration}-${template.maxDuration}s; ${template.requiredDetailCount} detail(s); scenes: ${template.defaultScenePlan.join(", ")}`;
}).join("\n");
