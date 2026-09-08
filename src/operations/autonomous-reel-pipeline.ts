import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  auditProduction,
  type ProductionAuditItem,
  type ProductionAuditReport,
} from "./production-audit";
import {
  repairProduction,
  type ProductionRepairReport,
} from "./production-repair";

export const AUTONOMOUS_REEL_PIPELINE_VERSION =
  "autonomous-reel-pipeline-v1" as const;

export type AutonomousReelPipelineOptions = {
  count: number;
  candidateLimit?: number;
  forcePlan?: boolean;
  dryRun?: boolean;
  rootDirectory?: string;

  audit?: typeof auditProduction;
  repair?: typeof repairProduction;
  runBatch?: (
    options: {
      count: number;
      candidateLimit?: number;
      forcePlan: boolean;
      rootDirectory: string;
    },
  ) => Promise<number>;
  now?: () => Date;
};

export type AutonomousReelPipelineReport = {
  version: typeof AUTONOMOUS_REEL_PIPELINE_VERSION;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  requestedCount: number;
  candidateLimit?: number;
  forcePlan: boolean;

  baselineProductionReady: number;
  batchExitCode?: number;

  newProductionIds: string[];

  repair: {
    selected: number;
    repaired: number;
    skipped: number;
    failed: number;
  };

  productionReadyIds: string[];
  readyCount: number;
  shortfall: number;

  outcome: "COMPLETE" | "SHORTFALL";

  global: {
    historyEntries: number;
    validRenders: number;
    missingRenders: number;
    invalidRenders: number;
    validReleases: number;
    complete: number;
  };
};

const productionReady = (
  item: ProductionAuditItem,
): boolean =>
  item.historyStatus === "RENDERED" &&
  item.states.includes("COMPLETE") &&
  item.release?.valid === true;

const defaultRunBatch = async ({
  count,
  candidateLimit,
  forcePlan,
  rootDirectory,
}: {
  count: number;
  candidateLimit?: number;
  forcePlan: boolean;
  rootDirectory: string;
}): Promise<number> =>
  new Promise((resolveBatch, reject) => {
    const args = [
      "run",
      "reels:batch",
      "--",
      "--render",
      "--target",
      String(count),
    ];

    if (candidateLimit !== undefined) {
      args.push(
        "--candidate-limit",
        String(candidateLimit),
      );
    }

    if (forcePlan) {
      args.push("--force-plan");
    }

    const child = spawn(
      "npm",
      args,
      {
        cwd: rootDirectory,
        stdio: "inherit",
        env: process.env,
      },
    );

    child.on("error", reject);

    child.on("close", (code) => {
      resolveBatch(code ?? 1);
    });
  });

const emptyRepairReport = (): Pick<
  ProductionRepairReport,
  "selected" | "repaired" | "skipped" | "failed"
> => ({
  selected: 0,
  repaired: 0,
  skipped: 0,
  failed: 0,
});

const summarizeGlobal = (
  report: ProductionAuditReport,
): AutonomousReelPipelineReport["global"] => ({
  historyEntries: report.summary.historyEntries,
  validRenders: report.summary.validRenders,
  missingRenders: report.summary.missingRenders,
  invalidRenders: report.summary.invalidRenders,
  validReleases: report.summary.validReleases,
  complete: report.summary.complete,
});

export const runAutonomousReelPipeline = async (
  options: AutonomousReelPipelineOptions,
): Promise<AutonomousReelPipelineReport> => {
  if (
    !Number.isInteger(options.count) ||
    options.count < 1
  ) {
    throw new Error(
      "Autonomous Reel count must be a positive integer",
    );
  }

  if (
    options.candidateLimit !== undefined &&
    (
      !Number.isInteger(options.candidateLimit) ||
      options.candidateLimit < options.count
    )
  ) {
    throw new Error(
      "Candidate limit must be an integer greater than or equal to count",
    );
  }

  const rootDirectory = resolve(
    options.rootDirectory ?? ".",
  );

  const now =
    options.now ?? (() => new Date());

  const startedAt =
    now().toISOString();

  const audit =
    options.audit ?? auditProduction;

  const repair =
    options.repair ?? repairProduction;

  const runBatch =
    options.runBatch ?? defaultRunBatch;

  const baseline = await audit({
    rootDirectory,
    deep: false,
  });

  const baselineHistoryIds = new Set(
    baseline.items
      .filter(
        (item) =>
          item.historyStatus !== undefined,
      )
      .map((item) => item.reelId),
  );

  const baselineProductionReady =
    baseline.items.filter(productionReady).length;

  if (options.dryRun) {
    return {
      version:
        AUTONOMOUS_REEL_PIPELINE_VERSION,
      startedAt,
      finishedAt:
        now().toISOString(),
      dryRun: true,
      requestedCount: options.count,
      ...(options.candidateLimit !== undefined
        ? {
            candidateLimit:
              options.candidateLimit,
          }
        : {}),
      forcePlan:
        options.forcePlan ?? false,

      baselineProductionReady,

      newProductionIds: [],

      repair: emptyRepairReport(),

      productionReadyIds: [],
      readyCount: 0,
      shortfall: options.count,

      outcome: "SHORTFALL",

      global:
        summarizeGlobal(baseline),
    };
  }

  const batchExitCode =
    await runBatch({
      count: options.count,
      candidateLimit:
        options.candidateLimit,
      forcePlan:
        options.forcePlan ?? false,
      rootDirectory,
    });

  const afterBatch = await audit({
    rootDirectory,
    deep: false,
  });

  const newProductionIds =
    afterBatch.items
      .filter(
        (item) =>
          item.historyStatus !== undefined &&
          !baselineHistoryIds.has(
            item.reelId,
          ),
      )
      .map((item) => item.reelId)
      .sort();

  let repairResult:
    | ProductionRepairReport
    | undefined;

  if (newProductionIds.length > 0) {
    repairResult =
      await repair({
        rootDirectory,
        reelIds:
          newProductionIds,
      });
  }

  let productionReadyIds:
    string[] = [];

  if (newProductionIds.length > 0) {
    const verification =
      await audit({
        rootDirectory,
        deep: true,
        reelIds:
          newProductionIds,
      });

    productionReadyIds =
      verification.items
        .filter(productionReady)
        .map(
          (item) =>
            item.reelId,
        )
        .sort();
  }

  const globalAfter =
    await audit({
      rootDirectory,
      deep: false,
    });

  const readyCount =
    productionReadyIds.length;

  const shortfall =
    Math.max(
      0,
      options.count -
        readyCount,
    );

  const repairSummary =
    repairResult
      ? {
          selected:
            repairResult.selected,
          repaired:
            repairResult.repaired,
          skipped:
            repairResult.skipped,
          failed:
            repairResult.failed,
        }
      : emptyRepairReport();

  const outcome =
    batchExitCode === 0 &&
    repairSummary.failed === 0 &&
    readyCount >=
      options.count
      ? "COMPLETE"
      : "SHORTFALL";

  return {
    version:
      AUTONOMOUS_REEL_PIPELINE_VERSION,

    startedAt,

    finishedAt:
      now().toISOString(),

    dryRun: false,

    requestedCount:
      options.count,

    ...(options.candidateLimit !== undefined
      ? {
          candidateLimit:
            options.candidateLimit,
        }
      : {}),

    forcePlan:
      options.forcePlan ?? false,

    baselineProductionReady,

    batchExitCode,

    newProductionIds,

    repair:
      repairSummary,

    productionReadyIds,

    readyCount,

    shortfall,

    outcome,

    global:
      summarizeGlobal(
        globalAfter,
      ),
  };
};
