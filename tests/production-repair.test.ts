import {
  planProductionRepair,
  repairProduction,
} from "../src/operations/production-repair";
import {
  type ProductionAuditItem,
  type ProductionAuditReport,
  type ProductionAuditState,
} from "../src/operations/production-audit";

const equal = (
  actual: unknown,
  expected: unknown,
  label: string,
): void => {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
};

const deepEqual = (
  actual: unknown,
  expected: unknown,
  label: string,
): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
};

const item = (
  reelId: string,
  states: ProductionAuditState[],
): ProductionAuditItem => ({
  reelId,
  states,
  paths: {
    reelData: `/fixture/data/reels/${reelId}.json`,
  },
  errors: [],
});

const report = (
  items: ProductionAuditItem[],
): ProductionAuditReport => ({
  generatedAt: "2026-09-08T00:00:00.000Z",
  deep: true,
  summary: {
    historyEntries: items.length,
    reelData: items.length,
    renders: 0,
    validRenders: 0,
    missingRenders: 0,
    invalidRenders: 0,
    socialCopies: 0,
    qcArtifacts: 0,
    releases: 0,
    validReleases: 0,
    complete: 0,
  },
  items,
  orphans: {
    renders: [],
    socialCopies: [],
    qcDirectories: [],
    releases: [],
  },
  warnings: [],
});

const main = async (): Promise<void> => {
  const fullRepair = item(
    "repair-full",
    [
      "MISSING_RENDER",
      "MISSING_SOCIAL_COPY",
      "RELEASE_MISSING",
    ],
  );

  deepEqual(
    planProductionRepair(fullRepair).actions,
    [
      "RENDER",
      "SOCIAL_COPY",
      "PACKAGE",
      "VERIFY_RELEASE",
    ],
    "full repair action order",
  );

  const blocked = item(
    "repair-blocked",
    ["MISSING_REELDATA"],
  );

  equal(
    Boolean(
      planProductionRepair(blocked).blockedReason,
    ),
    true,
    "unsafe state is blocked",
  );

  const dryRun = await repairProduction({
    dryRun: true,
    limit: 1,
    audit: async () =>
      report([
        fullRepair,
        item(
          "release-only",
          ["RELEASE_MISSING"],
        ),
        blocked,
      ]),
  });

  equal(
    dryRun.selected,
    1,
    "bulk limit selects one repairable item",
  );

  equal(
    dryRun.results[0]?.status,
    "DRY_RUN",
    "dry-run performs no mutation",
  );

  const calls: string[] = [];

  const executed = await repairProduction({
    audit: async () =>
      report([
        fullRepair,
        item(
          "release-only",
          ["RELEASE_MISSING"],
        ),
      ]),
    runRender: async (reelId) => {
      calls.push(`render:${reelId}`);
    },
    recoverSocialCopy: async (candidate) => {
      calls.push(`social:${candidate.reelId}`);
    },
    packageReel: async (reelId) => {
      calls.push(`package:${reelId}`);
    },
    verifyRelease: async (reelId) => {
      calls.push(`verify:${reelId}`);
    },
  });

  equal(
    executed.repaired,
    2,
    "two repairable items complete",
  );

  deepEqual(
    calls,
    [
      "render:repair-full",
      "social:repair-full",
      "package:repair-full",
      "verify:repair-full",
      "package:release-only",
      "verify:release-only",
    ],
    "repair actions execute in dependency order",
  );

  const failureCalls: string[] = [];

  const failure = await repairProduction({
    audit: async () =>
      report([
        fullRepair,
        item(
          "second-item",
          ["RELEASE_MISSING"],
        ),
      ]),
    runRender: async (reelId) => {
      failureCalls.push(`render:${reelId}`);
    },
    recoverSocialCopy: async (candidate) => {
      failureCalls.push(
        `social:${candidate.reelId}`,
      );
    },
    packageReel: async (reelId) => {
      failureCalls.push(`package:${reelId}`);

      if (reelId === "repair-full") {
        throw new Error(
          "fixture package failure",
        );
      }
    },
    verifyRelease: async (reelId) => {
      failureCalls.push(`verify:${reelId}`);
    },
  });

  equal(
    failure.failed,
    1,
    "one item failure is reported",
  );

  equal(
    failure.repaired,
    1,
    "later item continues after failure",
  );

  deepEqual(
    failureCalls,
    [
      "render:repair-full",
      "social:repair-full",
      "package:repair-full",
      "package:second-item",
      "verify:second-item",
    ],
    "failure is isolated to one item",
  );

  const explicitBlocked = await repairProduction({
    reelIds: ["repair-blocked"],
    dryRun: true,
    audit: async () =>
      report([blocked]),
  });

  equal(
    explicitBlocked.skipped,
    1,
    "explicit unsafe target is skipped",
  );

  console.log(
    "Production repair orchestration tests passed",
  );
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
