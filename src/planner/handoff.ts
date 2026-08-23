import { z } from "zod";

/**
 * The handoff is the trust boundary between artwork discovery and Artfolio Reels.
 * It intentionally contains only verified source metadata and a local image reference.
 */
export const RightsStatusSchema = z.literal("CONFIRMED_PUBLIC_DOMAIN");

export const ArtworkHandoffSchema = z.object({
  canonicalId: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(48),
  title: z.string().trim().min(1).max(72),
  artist: z.string().trim().min(1).max(72),
  date: z.string().trim().min(1).max(36),
  medium: z.string().trim().min(1).max(120),
  museum: z.string().trim().min(1).max(100),
  classification: z.string().trim().min(1).max(80),
  imagePath: z.string().trim().min(1).refine((value) => !/^[a-z]+:\/\//i.test(value), "imagePath must be a local path"),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  rightsStatus: RightsStatusSchema,
  sourceUrl: z.url().optional(),
}).strict();

export type ArtworkHandoff = z.infer<typeof ArtworkHandoffSchema>;

/** Reserved for the future two-works planner; it can only be invoked with two verified handoffs. */
export const TwoArtworkHandoffsSchema = z.tuple([ArtworkHandoffSchema, ArtworkHandoffSchema]).superRefine((artworks, context) => {
  if (artworks[0].canonicalId === artworks[1].canonicalId) {
    context.addIssue({ code: "custom", message: "two-works-one-idea requires two different canonical artworks" });
  }
});
export type TwoArtworkHandoffs = z.infer<typeof TwoArtworkHandoffsSchema>;
