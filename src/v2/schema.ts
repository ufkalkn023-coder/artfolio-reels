import { z } from "zod";

export const TEMPLATE_IDS = [
  "look-closer",
  "three-details",
  "inside-the-painting",
  "one-artwork",
  "why-this-works",
  "two-works-one-idea",
] as const;

export const TemplateIdSchema = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

export const HOOK_TYPES = ["VISUAL_DETAIL", "QUESTION", "OBSERVATION", "CONTRAST", "DISCOVERY"] as const;
export const HookTypeSchema = z.enum(HOOK_TYPES);
export type HookType = z.infer<typeof HookTypeSchema>;

export const CameraMoveSchema = z.enum([
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "detail-hold",
  "full-to-detail",
  "detail-to-full",
  "reveal",
  "none",
]);

export const CameraSchema = z.object({
  move: CameraMoveSchema.default("none"),
  // These remain optional so target framing can distinguish an intentionally
  // supplied camera value from a planner scene that only chose a move.
  focalX: z.number().min(0).max(1).optional(),
  focalY: z.number().min(0).max(1).optional(),
  endFocalX: z.number().min(0).max(1).optional(),
  endFocalY: z.number().min(0).max(1).optional(),
  startScale: z.number().positive().max(2.5).optional(),
  endScale: z.number().positive().max(2.5).optional(),
});
export type CameraSettings = z.infer<typeof CameraSchema>;

export const TargetTypeSchema = z.enum(["COMPACT", "REGION", "RELATION"]);
export type TargetType = z.infer<typeof TargetTypeSchema>;

export const TargetRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((region, context) => {
  if (region.x + region.width > 1) context.addIssue({ code: "custom", message: "target region must remain within normalized bounds" });
  if (region.y + region.height > 1) context.addIssue({ code: "custom", message: "target region must remain within normalized bounds" });
});
export type TargetRegion = z.infer<typeof TargetRegionSchema>;

export const DetailPointSchema = z.object({
  id: z.string().min(1).max(48),
  label: z.string().min(1).max(36),
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
  scale: z.number().positive().max(2.5).default(1.12),
  // A detail can intentionally be visual-only. Renderers must not substitute
  // an observation from another detail when this is absent.
  observation: z.string().min(1).max(120).optional(),
  targetType: TargetTypeSchema.optional(),
  targetRegion: TargetRegionSchema.optional(),
});
export type DetailPoint = z.infer<typeof DetailPointSchema>;

export const ArtworkSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  title: z.string().min(1).max(72),
  artist: z.string().min(1).max(72),
  date: z.string().min(1).max(36),
  medium: z.string().max(120).optional(),
  museum: z.string().min(1).max(100),
  orientation: z.enum(["portrait", "landscape", "panorama"]).default("landscape"),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  detailPoints: z.array(DetailPointSchema).default([]),
});
export type Artwork = z.infer<typeof ArtworkSchema>;

export const SceneKindSchema = z.enum([
  "intro",
  "overview",
  "detail",
  "observation",
  "comparison",
  "metadata",
  "outro",
]);
export type SceneKind = z.infer<typeof SceneKindSchema>;

export const SceneInputSchema = z.object({
  id: z.string().min(1).max(60),
  kind: SceneKindSchema,
  seconds: z.number().positive().max(20).optional(),
  artworkIndex: z.number().int().nonnegative().optional(),
  detailId: z.string().optional(),
  observationIndex: z.number().int().nonnegative().optional(),
  camera: CameraSchema.optional(),
});
export type SceneInput = z.infer<typeof SceneInputSchema>;

const AudioTrackSchema = z.object({
  src: z.string().min(1),
  volume: z.number().min(0).max(1).default(0.3),
  start: z.number().nonnegative().default(0),
  fadeIn: z.number().nonnegative().optional(),
  fadeOut: z.number().nonnegative().optional(),
});

export const ReelDataSchema = z.object({
  version: z.literal(2).default(2),
  id: z.string().min(1).max(80),
  template: TemplateIdSchema,
  templateVersion: z.string().default("2.0"),
  title: z.string().min(1).max(72),
  hook: z.string().min(1).max(120),
  // Saved production reels created before this field existed remain valid; their
  // question hooks are detected from their terminal question mark at render time.
  hookType: HookTypeSchema.optional(),
  label: z.string().min(1).max(36).default("AN ARTFOLIO STUDY"),
  artworks: z.array(ArtworkSchema).min(1).max(2),
  observations: z.array(z.string().min(1).max(120)).default([]),
  scenes: z.array(SceneInputSchema).optional(),
  duration: z.number().positive().max(60).optional(),
  camera: CameraSchema.optional(),
  music: AudioTrackSchema.optional(),
  voiceover: z
    .object({ src: z.string().min(1), volume: z.number().min(0).max(1).default(1) })
    .optional(),
  captions: z
    .array(
      z.object({
        text: z.string().min(1),
        startMs: z.number().nonnegative(),
        endMs: z.number().nonnegative(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  visualTone: z.string().max(40).optional(),
  textDensity: z.enum(["low", "medium"]).optional(),
  // Never enabled by production render paths. This only exposes deterministic
  // target geometry in QC stills.
  debugTargetOverlay: z.boolean().optional(),
  endingMode: z.enum(["outro", "metadata"]).default("outro"),
});
export type ReelData = z.infer<typeof ReelDataSchema>;
