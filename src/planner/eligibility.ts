import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type TemplateId } from "../v2/schema";
import { type ArtworkHandoff } from "./handoff";

export type ReelEligibility = {
  eligible: boolean;
  score: number;
  reasons: string[];
  eligibleTemplates: TemplateId[];
};

const localImagePath = (imagePath: string): string => resolve(imagePath);

/** Cheap deterministic guard to avoid spending Gemini calls on unusable artwork. */
export const assessEligibility = (artwork: ArtworkHandoff): ReelEligibility => {
  const reasons: string[] = [];
  const imageExists = existsSync(localImagePath(artwork.imagePath));
  const minDimension = Math.min(artwork.imageWidth, artwork.imageHeight);
  const maxDimension = Math.max(artwork.imageWidth, artwork.imageHeight);
  const metadataUsable = Boolean(artwork.title && artwork.artist && artwork.date && artwork.museum && artwork.classification);

  if (!imageExists) reasons.push("local image is missing");
  if (minDimension < 1080) reasons.push("image resolution is below the 1080px Reel baseline");
  if (!metadataUsable) reasons.push("verified metadata is incomplete");

  const eligible = imageExists && minDimension >= 1080 && metadataUsable;
  if (!eligible) return { eligible: false, score: 0, reasons, eligibleTemplates: [] };

  const eligibleTemplates: TemplateId[] = ["one-artwork"];
  if (maxDimension >= 1800 && minDimension >= 1200) eligibleTemplates.push("look-closer");
  if (maxDimension >= 2200 && minDimension >= 1400) {
    eligibleTemplates.push("three-details", "why-this-works");
  }
  if (maxDimension >= 2600 && minDimension >= 1600) eligibleTemplates.push("inside-the-painting");

  if (maxDimension < 2200) reasons.push("resolution supports overview but limits multiple deep detail crops");
  else reasons.push("resolution supports detail exploration");

  // `two-works-one-idea` is intentionally absent: this is a single-artwork planner.
  return { eligible: true, score: 50 + eligibleTemplates.length * 10, reasons, eligibleTemplates };
};
