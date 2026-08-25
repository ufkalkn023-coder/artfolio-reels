import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type ArtworkHandoff } from "../planner/handoff";
import { renderFilenameForArtwork } from "../planner/render-path";
import { type ReelPlan } from "../planner/reel-plan";

export const SOCIAL_COPY_QUESTION_CTAS = [
  "Which detail did you notice first?",
  "What caught your eye first?",
  "Which detail would you look at longer?",
  "What do you see first in this work?",
  "Which part would you return to?",
] as const;

export const SOCIAL_COPY_NON_QUESTION_CTAS = [
  "Save this for a closer look later.",
  "Look again before you scroll past.",
  "Come back to this detail later.",
  "Save this work for another look.",
] as const;

export type SocialCopyCta =
  | (typeof SOCIAL_COPY_QUESTION_CTAS)[number]
  | (typeof SOCIAL_COPY_NON_QUESTION_CTAS)[number];

export type SocialCopy = {
  hook: string;
  observations: string[];
  centralIdea?: string;
  credit: string;
  museum: string;
  cta: SocialCopyCta;
  hashtags: string[];
  text: string;
};

export type SocialCopyWriter = (
  artwork: ArtworkHandoff,
  plan: ReelPlan,
  outputDirectory?: string,
) => Promise<string>;

const comparableText = (value: string): string => value
  .normalize("NFKD")
  .replace(/\p{Mark}/gu, "")
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
  .trim()
  .replace(/\s+/g, " ");

const CONTENT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "does", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "their", "this", "through", "to", "what", "when", "where", "which", "why", "with",
]);

const CONTENT_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  brushstroke: "stroke",
  brushstrokes: "stroke",
  brushwork: "stroke",
  create: "create",
  created: "create",
  creates: "create",
  creating: "create",
  generate: "create",
  generated: "create",
  generates: "create",
  generating: "create",
  motion: "motion",
  motions: "motion",
  movement: "motion",
  movements: "motion",
  moving: "motion",
  stroke: "stroke",
  strokes: "stroke",
};

export const SOCIAL_COPY_OVERLAP_THRESHOLD = 0.6;
export const SOCIAL_COPY_MIN_SHARED_TOKENS = 3;

const contentTokens = (value: string): Set<string> => new Set(
  comparableText(value)
    .split(" ")
    .filter((token) => token && !CONTENT_STOP_WORDS.has(token))
    .map((token) => CONTENT_TOKEN_ALIASES[token] ?? token),
);

/**
 * Conservative containment similarity: suppress only when at least three content
 * concepts overlap and they cover 60% of the shorter sentence's content tokens.
 */
export const areSocialTextsStronglyOverlapping = (left: string, right: string): boolean => {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  const shorterSize = Math.min(leftTokens.size, rightTokens.size);
  if (shorterSize === 0) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared >= SOCIAL_COPY_MIN_SHARED_TOKENS && shared / shorterSize >= SOCIAL_COPY_OVERLAP_THRESHOLD;
};

const stableHash = (value: string): number => {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const ctaIndexForCanonicalId = (canonicalId: string, ctaCount: number): number => stableHash(canonicalId) % ctaCount;

export const selectSocialCopyCta = (canonicalId: string, hook: string): SocialCopyCta => {
  const pool = hook.trimEnd().endsWith("?") ? SOCIAL_COPY_NON_QUESTION_CTAS : SOCIAL_COPY_QUESTION_CTAS;
  return pool[ctaIndexForCanonicalId(canonicalId, pool.length)];
};

export const MAX_METADATA_HASHTAG_LENGTH = 20;
export const MAX_SOCIAL_HASHTAGS = 6;

const hashtagToken = (value: string): string | undefined => {
  const words = value.normalize("NFC").match(/[\p{Letter}\p{Number}]+/gu) ?? [];
  const token = words.map((word) => `${word[0]?.toLocaleUpperCase("en-US") ?? ""}${word.slice(1)}`).join("");
  if (token.length < 3 || token.length > MAX_METADATA_HASHTAG_LENGTH) return undefined;
  if (["unknown", "untitled", "anonymous"].includes(comparableText(token))) return undefined;
  return `#${token}`;
};

const mediumHashtag = (medium: string): string | undefined => {
  const normalized = comparableText(medium);
  if (/\boil\b/.test(normalized)) return "#OilPainting";
  if (/\bwatercolou?r\b/.test(normalized)) return "#Watercolor";
  if (/\btempera\b/.test(normalized)) return "#Tempera";
  return undefined;
};

export const createSocialHashtags = (artwork: ArtworkHandoff): string[] => {
  const classification = comparableText(artwork.classification);
  const classificationTag = ["art", "artwork", "artworks", "fine art", "painting", "paintings"].includes(classification)
    ? undefined
    : hashtagToken(artwork.classification);
  const candidates = [
    hashtagToken(artwork.artist),
    hashtagToken(artwork.title),
    mediumHashtag(artwork.medium),
    "#ArtHistory",
    "#MuseumArt",
    "#PaintingDetails",
    classificationTag,
    hashtagToken(artwork.museum),
  ];
  const hashtags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = comparableText(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(candidate);
    if (hashtags.length === MAX_SOCIAL_HASHTAGS) break;
  }
  return hashtags;
};

export const createSocialCopy = (artwork: ArtworkHandoff, plan: ReelPlan): SocialCopy => {
  const seen = new Set<string>();
  const addUnique = (value: string): boolean => {
    const normalized = comparableText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  };

  addUnique(plan.hook.text);
  const observations: string[] = [];
  for (const detail of plan.details) {
    if (observations.length === 3) break;
    if (addUnique(detail.observation)) observations.push(detail.observation);
  }
  const centralIdeaIsUnique = addUnique(plan.centralIdea);
  const centralIdea = centralIdeaIsUnique && !areSocialTextsStronglyOverlapping(plan.hook.text, plan.centralIdea)
    ? plan.centralIdea
    : undefined;
  const credit = `${artwork.title} — ${artwork.artist}, ${artwork.date}`;
  const cta = selectSocialCopyCta(artwork.canonicalId, plan.hook.text);
  const hashtags = createSocialHashtags(artwork);
  const sections = [
    plan.hook.text,
    ...observations,
    centralIdea,
    `${credit}\n${artwork.museum}`,
    cta,
    hashtags.join(" "),
  ].filter((section): section is string => Boolean(section));

  return {
    hook: plan.hook.text,
    observations,
    centralIdea,
    credit,
    museum: artwork.museum,
    cta,
    hashtags,
    text: `${sections.join("\n\n")}\n`,
  };
};

export const socialFilenameForArtwork = (canonicalId: string, artworkTitle: string): string =>
  renderFilenameForArtwork(canonicalId, artworkTitle).replace(/\.mp4$/, ".txt");

export const resolveSocialOutputPath = (canonicalId: string, artworkTitle: string, outputDirectory = resolve("output")): string => {
  const socialDirectory = resolve(outputDirectory, "social");
  const destination = resolve(socialDirectory, socialFilenameForArtwork(canonicalId, artworkTitle));
  const fromSocialDirectory = relative(socialDirectory, destination);
  if (fromSocialDirectory === "" || fromSocialDirectory === ".." || fromSocialDirectory.startsWith(`..${sep}`) || isAbsolute(fromSocialDirectory)) {
    throw new Error("Social-copy destination must remain inside output/social");
  }
  return destination;
};

export const writeSocialCopy: SocialCopyWriter = async (artwork, plan, outputDirectory = resolve("output")) => {
  const destination = resolveSocialOutputPath(artwork.canonicalId, artwork.title, outputDirectory);
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, createSocialCopy(artwork, plan).text, "utf8");
    await rename(temporaryPath, destination);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  console.info(`[social-copy] ${artwork.canonicalId} -> ${destination}`);
  return destination;
};
