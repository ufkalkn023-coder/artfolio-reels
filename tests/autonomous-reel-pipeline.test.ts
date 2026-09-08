import {
  runAutonomousReelPipeline,
} from "../src/operations/autonomous-reel-pipeline";
import {
  type ProductionAuditItem,
  type ProductionAuditReport,
} from "../src/operations/production-audit";
import {
  type ProductionRepairReport,
} from "../src/operations/production-repair";

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

const readyItem = (
  reelId: string,
): ProductionAuditItem =>
  ({
    reelId,
    historyStatus:
      "RENDERED",
    states: ["COMPLETE"],
    paths: {
      reelData:
        `/fixture/${reelId}.json`,
      render:
        `/fixture/${reelId}.mp4`,
      socialCopy:
        `/fixture/${reelId}.txt`,
      qc:
        `/fixture/qc/${reelId}`,
      release:
        `/fixture/releases/${reelId}`,
    },
    release: {
      valid: true,
      directory:
        `/fixture/releases/${reelId}`,
      errors: [],
    },
    errors: [],
  }) as ProductionAuditItem;

const releaseMissingItem = (
  reelId: string,
): ProductionAuditItem =>
  ({
    reelId,
    historyStatus:
      "RENDERED",
    states: [
      "RELEASE_MISSING",
    ],
    paths: {
      reelData:
        `/fixture/${reelId}.json`,
      render:
        `/fixture/${reelId}.mp4`,
      socialCopy:
        `/fixture/${reelId}.txt`,
      qc:
        `/fixture/qc/${reelId}`,
    },
    errors: [],
  }) as ProductionAuditItem;

const qcOnlyItem = (
  reelId: string,
): ProductionAuditItem =>
  ({
    reelId,
    historyStatus:
      "QC_PASSED",
    states: ["COMPLETE"],
    paths: {
      reelData:
        `/fixture/${reelId}.json`,
      qc:
        `/fixture/qc/${reelId}`,
    },
    errors: [],
  }) as ProductionAuditItem;

const auditReport = (
  items: ProductionAuditItem[],
): ProductionAuditReport =>
  ({
    generatedAt:
      "2026-09-08T00:00:00.000Z",
    deep: false,
    summary: {
      historyEntries:
        items.filter(
          (item) =>
            item.historyStatus !==
            undefined,
        ).length,
      reelData:
        items.length,
      renders:
        items.filter(
          (item) =>
            item.paths.render,
        ).length,
      validRenders:
        items.filter(
          (item) =>
            item.paths.render,
        ).length,
      missingRenders: 0,
      invalidRenders: 0,
      socialCopies:
        items.filter(
          (item) =>
            item.paths.socialCopy,
        ).length,
      qcArtifacts:
        items.filter(
          (item) =>
            item.paths.qc,
        ).length,
      releases:
        items.filter(
          (item) =>
            item.paths.release,
        ).length,
      validReleases:
        items.filter(
          (item) =>
            item.release?.valid,
        ).length,
      complete:
        items.filter(
          (item) =>
            item.states.includes(
              "COMPLETE",
            ),
        ).length,
    },
    items,
    orphans: {
      renders: [],
      socialCopies: [],
      qcDirectories: [],
      releases: [],
    },
    warnings: [],
  }) as ProductionAuditReport;

const repairReport = (
  selected: number,
  repaired: number,
  skipped: number,
  failed: number,
): ProductionRepairReport =>
  ({
    generatedAt:
      "2026-09-08T00:00:00.000Z",
    dryRun: false,
    selected,
    repairable:
      repaired + failed,
    repaired,
    skipped,
    failed,
    results: [],
  });

const main =
  async (): Promise<void> => {
    let dryRunBatchCalls =
      0;
    let dryRunRepairCalls =
      0;

    const baseline =
      auditReport([
        readyItem("old-1"),
      ]);

    const dryRun =
      await runAutonomousReelPipeline({
        count: 2,
        dryRun: true,
        audit:
          async () =>
            baseline,
        runBatch:
          async () => {
            dryRunBatchCalls +=
              1;
            return 0;
          },
        repair:
          async () => {
            dryRunRepairCalls +=
              1;
            return repairReport(
              0,
              0,
              0,
              0,
            );
          },
      });

    equal(
      dryRun.dryRun,
      true,
      "dry-run flag",
    );

    equal(
      dryRunBatchCalls,
      0,
      "dry-run never starts batch",
    );

    equal(
      dryRunRepairCalls,
      0,
      "dry-run never repairs",
    );

    const afterBatch =
      auditReport([
        readyItem("old-1"),
        releaseMissingItem(
          "new-1",
        ),
        releaseMissingItem(
          "new-2",
        ),
        qcOnlyItem("new-qc"),
      ]);

    const verified =
      auditReport([
        readyItem("new-1"),
        readyItem("new-2"),
        qcOnlyItem("new-qc"),
      ]);

    const globalAfter =
      auditReport([
        readyItem("old-1"),
        readyItem("new-1"),
        readyItem("new-2"),
        qcOnlyItem("new-qc"),
      ]);

    const reports = [
      baseline,
      afterBatch,
      verified,
      globalAfter,
    ];

    let auditIndex = 0;
    let batchCalls = 0;
    let repairIds:
      readonly string[] = [];

    const executed =
      await runAutonomousReelPipeline({
        count: 2,
        audit:
          async () =>
            reports[
              auditIndex++
            ]!,
        runBatch:
          async ({
            count,
          }) => {
            batchCalls += 1;
            equal(
              count,
              2,
              "batch target",
            );
            return 0;
          },
        repair:
          async (options) => {
            repairIds =
              options?.reelIds ??
              [];

            return repairReport(
              3,
              2,
              1,
              0,
            );
          },
      });

    equal(
      batchCalls,
      1,
      "batch runs once",
    );

    equal(
      JSON.stringify(
        repairIds,
      ),
      JSON.stringify([
        "new-1",
        "new-2",
        "new-qc",
      ]),
      "repair is scoped to new production entries",
    );

    equal(
      executed.readyCount,
      2,
      "only rendered verified releases count as production ready",
    );

    equal(
      executed.shortfall,
      0,
      "target completed",
    );

    equal(
      executed.outcome,
      "COMPLETE",
      "successful autonomous outcome",
    );

    const shortfallReports = [
      baseline,
      auditReport([
        readyItem("old-1"),
        releaseMissingItem(
          "only-one",
        ),
      ]),
      auditReport([
        readyItem(
          "only-one",
        ),
      ]),
      auditReport([
        readyItem("old-1"),
        readyItem(
          "only-one",
        ),
      ]),
    ];

    let shortfallIndex = 0;

    const shortfall =
      await runAutonomousReelPipeline({
        count: 2,
        audit:
          async () =>
            shortfallReports[
              shortfallIndex++
            ]!,
        runBatch:
          async () => 1,
        repair:
          async () =>
            repairReport(
              1,
              1,
              0,
              0,
            ),
      });

    equal(
      shortfall.readyCount,
      1,
      "shortfall ready count",
    );

    equal(
      shortfall.shortfall,
      1,
      "shortfall amount",
    );

    equal(
      shortfall.outcome,
      "SHORTFALL",
      "shortfall outcome",
    );

    console.log(
      "Autonomous Reel pipeline orchestration tests passed",
    );
  };

void main().catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
