import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReelBatch, type BatchCandidateQueue } from "../src/planner/batch";
import { STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN } from "../src/planner/fixtures/starry-night";
import { type ReelPlan } from "../src/planner/reel-plan";
import {
  MAX_METADATA_HASHTAG_LENGTH,
  SOCIAL_COPY_NON_QUESTION_CTAS,
  SOCIAL_COPY_QUESTION_CTAS,
  areSocialTextsStronglyOverlapping,
  createSocialCopy,
  createSocialHashtags,
  ctaIndexForCanonicalId,
  resolveSocialOutputPath,
  selectSocialCopyCta,
} from "../src/social/social-copy";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};
const truthy = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
const missing = async (path: string, label: string): Promise<void> => {
  try { await readFile(path, "utf8"); } catch { return; }
  throw new Error(`${label}: expected no file at ${path}`);
};

const run = async (): Promise<void> => {
  const questionHook = "How does deliberate brushwork create continuous motion?";
  const nonQuestionHook = "Deliberate brushwork creates continuous motion.";
  const questionHookCta = selectSocialCopyCta(STARRY_NIGHT_HANDOFF.canonicalId, questionHook);
  const nonQuestionHookCta = selectSocialCopyCta(STARRY_NIGHT_HANDOFF.canonicalId, nonQuestionHook);
  equal(questionHookCta, selectSocialCopyCta(STARRY_NIGHT_HANDOFF.canonicalId, questionHook), "question-hook CTA selection is deterministic");
  equal(nonQuestionHookCta, selectSocialCopyCta(STARRY_NIGHT_HANDOFF.canonicalId, nonQuestionHook), "non-question-hook CTA selection is deterministic");
  equal(
    questionHookCta,
    SOCIAL_COPY_NON_QUESTION_CTAS[ctaIndexForCanonicalId(STARRY_NIGHT_HANDOFF.canonicalId, SOCIAL_COPY_NON_QUESTION_CTAS.length)],
    "question hooks select from the non-question CTA pool",
  );
  equal(
    nonQuestionHookCta,
    SOCIAL_COPY_QUESTION_CTAS[ctaIndexForCanonicalId(STARRY_NIGHT_HANDOFF.canonicalId, SOCIAL_COPY_QUESTION_CTAS.length)],
    "non-question hooks select from the question CTA pool",
  );
  truthy(!questionHookCta.includes("?"), "question hook does not receive a second question");

  const musicCopy = createSocialCopy(STARRY_NIGHT_HANDOFF, STARRY_NIGHT_MOCK_PLAN);
  equal(musicCopy.musicSuggestions.length, 3, "structured social copy retains exactly three music suggestions");
  truthy(!musicCopy.text.includes("MUSIC SUGGESTIONS"), "canonical caption field excludes music metadata");
  truthy(musicCopy.outputText.startsWith(musicCopy.text), "human-readable social output preserves the canonical caption verbatim");
  truthy(musicCopy.outputText.includes("MUSIC SUGGESTIONS\n-----------------"), "human-readable social output appends a separate music section");
  truthy(musicCopy.outputText.includes("Best fit —") && musicCopy.outputText.includes("Alternative —") && musicCopy.outputText.includes("Cinematic —"), "music output labels all three structural roles");
  const legacyMusicCopy = createSocialCopy(STARRY_NIGHT_HANDOFF, { ...structuredClone(STARRY_NIGHT_MOCK_PLAN), musicSuggestions: undefined });
  equal(legacyMusicCopy.outputText, legacyMusicCopy.text, "legacy plan writes its caption without arbitrary fallback songs");

  const duplicatePlan: ReelPlan = {
    ...structuredClone(STARRY_NIGHT_MOCK_PLAN),
    hook: { ...STARRY_NIGHT_MOCK_PLAN.hook, text: "The same phrase!" },
    centralIdea: "Second unique detail.",
    details: [
      { ...STARRY_NIGHT_MOCK_PLAN.details[0], observation: "the SAME phrase" },
      { ...STARRY_NIGHT_MOCK_PLAN.details[0], id: "first", observation: "First unique detail." },
      { ...STARRY_NIGHT_MOCK_PLAN.details[1], id: "first-copy", observation: "FIRST unique detail" },
      { ...STARRY_NIGHT_MOCK_PLAN.details[1], id: "second", observation: "Second unique detail." },
      { ...STARRY_NIGHT_MOCK_PLAN.details[2], id: "third", observation: "Third unique detail." },
      { ...STARRY_NIGHT_MOCK_PLAN.details[2], id: "fourth", observation: "Fourth unique detail." },
    ],
  };
  const deduplicated = createSocialCopy(STARRY_NIGHT_HANDOFF, duplicatePlan);
  equal(deduplicated.observations.join("|"), "First unique detail.|Second unique detail.|Third unique detail.", "three unique observations retain planner order");
  equal(deduplicated.centralIdea, undefined, "central idea duplicates are suppressed");
  equal((deduplicated.text.match(/same phrase/gi) ?? []).length, 1, "normalized duplicate hook text appears once");
  equal((deduplicated.text.match(/First unique detail/gi) ?? []).length, 1, "normalized duplicate observations appear once");
  equal(createSocialCopy(STARRY_NIGHT_HANDOFF, duplicatePlan).text, deduplicated.text, "same input produces identical final text");
  truthy(deduplicated.text.includes("First unique detail.\n\nSecond unique detail.\n\nThird unique detail."), "each observation is a separate paragraph");
  truthy(!/^(CAPTION|CTA|HASHTAGS)\b/im.test(deduplicated.text), "social copy has no editorial labels");

  const exactCentralDuplicate = createSocialCopy(STARRY_NIGHT_HANDOFF, {
    ...structuredClone(STARRY_NIGHT_MOCK_PLAN),
    centralIdea: STARRY_NIGHT_MOCK_PLAN.hook.text.toLocaleLowerCase("en-US").replace("?", "!"),
  });
  equal(exactCentralDuplicate.centralIdea, undefined, "exact normalized hook and central idea duplicates are suppressed");

  const overlappingCentralPlan = {
    ...structuredClone(STARRY_NIGHT_MOCK_PLAN),
    hook: { ...STARRY_NIGHT_MOCK_PLAN.hook, text: questionHook },
    centralIdea: "Repetitive curved strokes generate rhythmic movement unifying the sky, land, and foreground.",
  };
  const overlappingCentral = createSocialCopy(STARRY_NIGHT_HANDOFF, overlappingCentralPlan);
  truthy(areSocialTextsStronglyOverlapping(overlappingCentralPlan.hook.text, overlappingCentralPlan.centralIdea), "strong content overlap is detected");
  equal(overlappingCentral.centralIdea, undefined, "strongly overlapping hook and central idea are suppressed");
  equal(
    areSocialTextsStronglyOverlapping(overlappingCentralPlan.hook.text, overlappingCentralPlan.centralIdea),
    areSocialTextsStronglyOverlapping(overlappingCentralPlan.hook.text, overlappingCentralPlan.centralIdea),
    "overlap result is deterministic",
  );

  const distinctCentral = createSocialCopy(STARRY_NIGHT_HANDOFF, {
    ...structuredClone(STARRY_NIGHT_MOCK_PLAN),
    hook: { ...STARRY_NIGHT_MOCK_PLAN.hook, text: "Blue strokes create motion across the sky." },
    centralIdea: "The dark cypress anchors the foreground against the bright stars.",
  });
  truthy(Boolean(distinctCentral.centralIdea), "genuinely different central idea is retained");

  const accentedArtwork = {
    ...STARRY_NIGHT_HANDOFF,
    canonicalId: "met_123",
    artist: "Édouard Manet",
    title: "L'été à Paris",
    classification: "art history",
    medium: "Oil on canvas",
    museum: "Musée d'Orsay",
  };
  const hashtags = createSocialHashtags(accentedArtwork);
  truthy(hashtags.includes("#ÉdouardManet"), "accented artist names remain readable");
  truthy(hashtags.includes("#LÉtéÀParis"), "accented artwork titles remain readable");
  equal(hashtags.filter((tag) => tag.toLocaleLowerCase("en-US") === "#arthistory").length, 1, "hashtags deduplicate case-insensitively");
  truthy(hashtags.every((tag) => /^#[\p{Letter}\p{Number}]+$/u.test(tag)), "hashtags contain only valid token characters");
  truthy(hashtags.length <= 6, "hashtag set remains restrained without a forced minimum");
  truthy(!hashtags.some((tag) => ["#Renaissance", "#Baroque", "#Impressionism"].includes(tag)), "period and style hashtags are not fabricated");

  const deduplicatedHashtags = createSocialHashtags({
    ...accentedArtwork,
    artist: "Art History",
    title: "Untitled",
    classification: "ART HISTORY",
    medium: "Mixed media",
  });
  equal(deduplicatedHashtags.filter((tag) => tag.toLocaleLowerCase("en-US") === "#arthistory").length, 1, "candidate hashtags deduplicate case-insensitively");

  const overlongMetadataHashtags = createSocialHashtags({
    ...accentedArtwork,
    artist: "A".repeat(MAX_METADATA_HASHTAG_LENGTH + 1),
    title: "B".repeat(MAX_METADATA_HASHTAG_LENGTH + 1),
    classification: "C".repeat(MAX_METADATA_HASHTAG_LENGTH + 1),
    medium: "Mixed media",
    museum: "D".repeat(MAX_METADATA_HASHTAG_LENGTH + 1),
  });
  truthy(overlongMetadataHashtags.every((tag) => [...tag.slice(1)].length <= MAX_METADATA_HASHTAG_LENGTH), "overlong generated metadata hashtags are skipped");

  const starryHashtags = createSocialHashtags(STARRY_NIGHT_HANDOFF);
  equal(starryHashtags.join(" "), "#VincentVanGogh #TheStarryNight #OilPainting #ArtHistory #MuseumArt #PaintingDetails", "Starry Night keeps six strong deterministic hashtags");
  truthy(!starryHashtags.includes("#MuseumOfModernArtNewYork"), "long institutional hashtag is skipped");
  truthy(!starryHashtags.includes("#Paintings"), "generic classification hashtag is skipped");
  truthy(starryHashtags.includes("#OilPainting"), "meaningful medium hashtag is retained");
  truthy(starryHashtags.every((tag) => [...tag.slice(1)].length <= MAX_METADATA_HASHTAG_LENGTH), "metadata hashtag maximum length is enforced");
  equal(createSocialHashtags(STARRY_NIGHT_HANDOFF).join("|"), starryHashtags.join("|"), "hashtag output is deterministic");
  equal(
    resolveSocialOutputPath("met_437393", "The Toilet of Bathsheba", "/tmp/artfolio-output"),
    "/tmp/artfolio-output/social/met_437393-the-toilet-of-bathsheba.txt",
    "social path reuses the render filename slug",
  );

  const root = await mkdtemp(join(tmpdir(), "artfolio-social-batch-"));
  const makeCandidate = async (canonicalId: string) => {
    const handoff = { ...STARRY_NIGHT_HANDOFF, canonicalId };
    const handoffPath = join(root, `${canonicalId}.json`);
    await writeFile(handoffPath, JSON.stringify(handoff));
    return { handoff, candidate: { canonicalId, handoffPath, baseScore: 1, portfolioPriorityScore: 1 } };
  };
  const successful = await makeCandidate("social-success");
  const renderFailed = await makeCandidate("social-render-failed");
  const qcFailed = await makeCandidate("social-qc-failed");
  const rejected = await makeCandidate("social-rejected");
  const outputDirectory = join(root, "output");
  const queue: BatchCandidateQueue = {
    target: 4,
    candidateLimit: 4,
    candidateCount: 4,
    candidates: [successful.candidate, renderFailed.candidate, qcFailed.candidate, rejected.candidate],
  };
  const rejectedPlan = structuredClone(STARRY_NIGHT_MOCK_PLAN);
  rejectedPlan.details[1].focalX = rejectedPlan.details[0].focalX;
  rejectedPlan.details[1].focalY = rejectedPlan.details[0].focalY;
  let plannerCalls = 0;
  const manifest = await runReelBatch({
    queue,
    render: true,
    cacheDirectory: join(root, "plans"),
    reelDirectory: join(root, "reels"),
    outputDirectory,
    callPlanner: async (artwork) => {
      plannerCalls += 1;
      return artwork.canonicalId === rejected.handoff.canonicalId ? rejectedPlan : STARRY_NIGHT_MOCK_PLAN;
    },
    localizeArtwork: async (artwork) => ({ artwork, sourcePath: artwork.imagePath, destinationPath: artwork.imagePath, renderablePath: artwork.imagePath }),
    runExistingCommand: (name, reelId) => {
      if (name === "render" && reelId === renderFailed.handoff.canonicalId) throw new Error("render failed");
      if (name === "qc" && reelId === qcFailed.handoff.canonicalId) throw new Error("QC failed");
    },
  });
  const successPath = resolveSocialOutputPath(successful.handoff.canonicalId, successful.handoff.title, outputDirectory);
  truthy((await readFile(successPath, "utf8")).includes(STARRY_NIGHT_MOCK_PLAN.hook.text), "successful batch render creates ready-to-paste social copy");
  truthy((await readFile(successPath, "utf8")).includes("MUSIC SUGGESTIONS\n-----------------"), "successful batch render includes the separate music section");
  await missing(resolveSocialOutputPath(renderFailed.handoff.canonicalId, renderFailed.handoff.title, outputDirectory), "render failure creates no social copy");
  await missing(resolveSocialOutputPath(qcFailed.handoff.canonicalId, qcFailed.handoff.title, outputDirectory), "QC failure creates no social copy");
  await missing(resolveSocialOutputPath(rejected.handoff.canonicalId, rejected.handoff.title, outputDirectory), "rejected plan creates no social copy");
  equal(plannerCalls, 4, "social generation adds no planner or Gemini call");
  equal(manifest.candidates[0].socialPath, successPath, "batch manifest records generated social path");

  const writeFailure = await makeCandidate("social-write-failed");
  const writeFailureManifest = await runReelBatch({
    queue: { target: 1, candidateLimit: 1, candidateCount: 1, candidates: [writeFailure.candidate] },
    render: true,
    cacheDirectory: join(root, "plans-write-failure"),
    reelDirectory: join(root, "reels-write-failure"),
    outputDirectory: join(root, "output-write-failure"),
    callPlanner: async () => STARRY_NIGHT_MOCK_PLAN,
    localizeArtwork: async (artwork) => ({ artwork, sourcePath: artwork.imagePath, destinationPath: artwork.imagePath, renderablePath: artwork.imagePath }),
    runExistingCommand: () => undefined,
    writeSocialCopy: async () => { throw new Error("social disk unavailable"); },
  });
  equal(writeFailureManifest.renderedCount, 1, "social-copy failure does not misreport a successful render");
  equal(writeFailureManifest.candidates[0].renderStatus, "PASSED", "social-copy failure preserves render status");
  equal(writeFailureManifest.candidates[0].errorCode, "SOCIAL_COPY_FAILED", "social-copy failure is visible in the manifest");
  console.log("Social copy tests passed");
};

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
