import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  auditProduction,
  type ProductionAuditItem,
  type ProductionAuditReport,
  type ProductionAuditState,
} from "./production-audit";
import { PLANNER_VERSION } from "../planner/config";
import { type ArtworkHandoff } from "../planner/handoff";
import { ReelPlanSchema, type ReelPlan } from "../planner/reel-plan";
import {
  packageRelease,
  resolveReleaseDirectory,
  verifyReleasePackage,
} from "../release/package";
import { writeSocialCopy } from "../social/social-copy";
import { validateRenderableReelData } from "../v2/validation";

export type ProductionRepairAction =
  | "RENDER"
  | "SOCIAL_COPY"
  | "PACKAGE"
  | "VERIFY_RELEASE";

export type ProductionRepairStatus =
  | "DRY_RUN"
  | "REPAIRED"
  | "SKIPPED"
  | "FAILED";

export type ProductionRepairItemResult = {
  reelId: string;
  statesBefore: ProductionAuditState[];
  plannedActions: ProductionRepairAction[];
  completedActions: ProductionRepairAction[];
  status: ProductionRepairStatus;
  reason?: string;
  error?: string;
};

export type ProductionRepairReport = {
  generatedAt: string;
  dryRun: boolean;
  selected: number;
  repairable: number;
  repaired: number;
  skipped: number;
  failed: number;
  results: ProductionRepairItemResult[];
};

type AuditProduction = (
  options?: Parameters<typeof auditProduction>[0],
) => Promise<ProductionAuditReport>;

type RunRender = (
  reelId: string,
  rootDirectory: string,
) => Promise<void>;

type RecoverSocialCopy = (
  item: ProductionAuditItem,
  rootDirectory: string,
) => Promise<void>;

type PackageReel = (
  reelId: string,
  rootDirectory: string,
) => Promise<void>;

type VerifyRelease = (
  reelId: string,
  rootDirectory: string,
) => Promise<void>;

export type ProductionRepairOptions = {
  rootDirectory?: string;
  reelIds?: readonly string[];
  limit?: number;
  dryRun?: boolean;
  audit?: AuditProduction;
  runRender?: RunRender;
  recoverSocialCopy?: RecoverSocialCopy;
  packageReel?: PackageReel;
  verifyRelease?: VerifyRelease;
  now?: () => Date;
};

const REPAIRABLE_STATES = new Set<ProductionAuditState>([
  "MISSING_RENDER",
  "MISSING_SOCIAL_COPY",
  "RELEASE_MISSING",
]);

export const planProductionRepair = (
  item: ProductionAuditItem,
): {
  actions: ProductionRepairAction[];
  blockedReason?: string;
} => {
  if (item.states.includes("COMPLETE")) {
    return {
      actions: [],
      blockedReason: "already complete",
    };
  }

  const blockingStates = item.states.filter(
    (state) => !REPAIRABLE_STATES.has(state),
  );

  if (blockingStates.length > 0) {
    return {
      actions: [],
      blockedReason: `blocked audit state(s): ${blockingStates.join(",")}`,
    };
  }

  const actions: ProductionRepairAction[] = [];

  if (item.states.includes("MISSING_RENDER")) {
    actions.push("RENDER");
  }

  if (item.states.includes("MISSING_SOCIAL_COPY")) {
    actions.push("SOCIAL_COPY");
  }

  if (item.states.includes("RELEASE_MISSING")) {
    actions.push("PACKAGE", "VERIFY_RELEASE");
  }

  if (actions.length === 0) {
    return {
      actions: [],
      blockedReason: "no repairable audit state",
    };
  }

  return { actions };
};

const defaultRunRender: RunRender = async (
  reelId,
  rootDirectory,
) => {
  const result = spawnSync(
    "npm",
    ["run", "render", "--", reelId],
    {
      cwd: rootDirectory,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `render failed for ${reelId} with status ${result.status ?? "unknown"}`,
    );
  }
};

const loadRecoveryInputs = async (
  item: ProductionAuditItem,
  rootDirectory: string,
): Promise<{
  handoff: ArtworkHandoff;
  plan: ReelPlan;
}> => {
  const reelPath =
    item.paths.reelData ??
    resolve(
      rootDirectory,
      "data/reels",
      `${item.reelId}.json`,
    );

  const reel = validateRenderableReelData(
    JSON.parse(await readFile(reelPath, "utf8")) as unknown,
  );

  if (
    reel.id !== item.reelId ||
    reel.artworks[0]?.id !== item.reelId
  ) {
    throw new Error(
      `ReelData identity mismatch for ${item.reelId}`,
    );
  }

  const cachePath = resolve(
    rootDirectory,
    "data/plans",
    `${item.reelId}.json`,
  );

  const rawCache: unknown = JSON.parse(
    await readFile(cachePath, "utf8"),
  );

  if (
    !rawCache ||
    typeof rawCache !== "object" ||
    Array.isArray(rawCache)
  ) {
    throw new Error(
      `Invalid plan cache for ${item.reelId}: cache root must be an object`,
    );
  }

  const cache = rawCache as Record<string, unknown>;

  if (cache.plannerVersion !== PLANNER_VERSION) {
    throw new Error(
      `Plan cache schema mismatch for ${item.reelId}: planner version mismatch`,
    );
  }

  if (cache.canonicalArtworkId !== item.reelId) {
    throw new Error(
      `Plan cache identity mismatch for ${item.reelId}`,
    );
  }

  const plan = ReelPlanSchema.parse(cache.plan);
  const artwork = reel.artworks[0];

  if (!artwork) {
    throw new Error(
      `ReelData ${item.reelId} has no artwork`,
    );
  }

  const handoff: ArtworkHandoff = {
    canonicalId: item.reelId,
    source: "production-recovery",
    title: artwork.title,
    artist: artwork.artist,
    date: artwork.date,
    medium: artwork.medium ?? "Painting",
    museum: artwork.museum,
    classification: "painting",
    imagePath: artwork.src,
    imageWidth: artwork.imageWidth ?? 1,
    imageHeight: artwork.imageHeight ?? 1,
    rightsStatus: "CONFIRMED_PUBLIC_DOMAIN",
  };

  return {
    handoff,
    plan,
  };
};

const defaultRecoverSocialCopy: RecoverSocialCopy = async (
  item,
  rootDirectory,
) => {
  const { handoff, plan } = await loadRecoveryInputs(
    item,
    rootDirectory,
  );

  await writeSocialCopy(
    handoff,
    plan,
    resolve(rootDirectory, "output"),
  );
};

const defaultPackageReel: PackageReel = async (
  reelId,
  rootDirectory,
) => {
  await packageRelease({
    reelId,
    outputDirectory: resolve(rootDirectory, "output"),
    reelDirectory: resolve(rootDirectory, "data/reels"),
  });
};

const defaultVerifyRelease: VerifyRelease = async (
  reelId,
  rootDirectory,
) => {
  const outputDirectory = resolve(
    rootDirectory,
    "output",
  );

  const verification = await verifyReleasePackage({
    releaseDirectory: resolveReleaseDirectory(
      reelId,
      outputDirectory,
    ),
    reelDirectory: resolve(
      rootDirectory,
      "data/reels",
    ),
    deep: true,
  });

  if (!verification.valid) {
    throw new Error(
      `deep release verification failed: ${verification.errors.join("; ")}`,
    );
  }
};

const executeAction = async (
  action: ProductionRepairAction,
  item: ProductionAuditItem,
  rootDirectory: string,
  dependencies: {
    runRender: RunRender;
    recoverSocialCopy: RecoverSocialCopy;
    packageReel: PackageReel;
    verifyRelease: VerifyRelease;
  },
): Promise<void> => {
  if (action === "RENDER") {
    await dependencies.runRender(
      item.reelId,
      rootDirectory,
    );
    return;
  }

  if (action === "SOCIAL_COPY") {
    await dependencies.recoverSocialCopy(
      item,
      rootDirectory,
    );
    return;
  }

  if (action === "PACKAGE") {
    await dependencies.packageReel(
      item.reelId,
      rootDirectory,
    );
    return;
  }

  await dependencies.verifyRelease(
    item.reelId,
    rootDirectory,
  );
};

export const repairProduction = async (
  options: ProductionRepairOptions = {},
): Promise<ProductionRepairReport> => {
  const rootDirectory = resolve(
    options.rootDirectory ?? ".",
  );

  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1)
  ) {
    throw new Error(
      "Repair limit must be a positive integer",
    );
  }

  const audit = options.audit ?? auditProduction;

  const initial = await audit({
    rootDirectory,
    deep: true,
    ...(options.reelIds?.length
      ? { reelIds: options.reelIds }
      : {}),
  });

  const planned = initial.items.map((item) => ({
    item,
    ...planProductionRepair(item),
  }));

  let selected;

  if (options.reelIds?.length) {
    selected = planned;
  } else {
    selected = planned.filter(
      (entry) => entry.actions.length > 0,
    );
  }

  if (options.limit !== undefined) {
    selected = selected.slice(0, options.limit);
  }

  const dependencies = {
    runRender:
      options.runRender ?? defaultRunRender,
    recoverSocialCopy:
      options.recoverSocialCopy ??
      defaultRecoverSocialCopy,
    packageReel:
      options.packageReel ?? defaultPackageReel,
    verifyRelease:
      options.verifyRelease ??
      defaultVerifyRelease,
  };

  const results: ProductionRepairItemResult[] = [];

  for (const entry of selected) {
    const completedActions: ProductionRepairAction[] = [];

    const base = {
      reelId: entry.item.reelId,
      statesBefore: [...entry.item.states],
      plannedActions: [...entry.actions],
      completedActions,
    };

    if (entry.blockedReason) {
      results.push({
        ...base,
        status: "SKIPPED",
        reason: entry.blockedReason,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        ...base,
        status: "DRY_RUN",
      });
      continue;
    }

    try {
      for (const action of entry.actions) {
        await executeAction(
          action,
          entry.item,
          rootDirectory,
          dependencies,
        );

        completedActions.push(action);
      }

      results.push({
        ...base,
        status: "REPAIRED",
      });
    } catch (error) {
      results.push({
        ...base,
        status: "FAILED",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  return {
    generatedAt: (
      options.now ?? (() => new Date())
    )().toISOString(),
    dryRun: options.dryRun ?? false,
    selected: results.length,
    repairable: results.filter(
      (result) =>
        result.plannedActions.length > 0,
    ).length,
    repaired: results.filter(
      (result) => result.status === "REPAIRED",
    ).length,
    skipped: results.filter(
      (result) => result.status === "SKIPPED",
    ).length,
    failed: results.filter(
      (result) => result.status === "FAILED",
    ).length,
    results,
  };
};
