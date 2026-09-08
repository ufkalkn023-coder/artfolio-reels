import {
  runAutonomousReelPipeline,
} from "../src/operations/autonomous-reel-pipeline";

const USAGE =
  "Usage: npm run reels:auto -- --count <n> [--candidate-limit <n>] [--force-plan] [--dry-run]";

type CliOptions = {
  count?: number;
  candidateLimit?: number;
  forcePlan: boolean;
  dryRun: boolean;
};

const positiveInteger = (
  value: string | undefined,
  flag: string,
): number => {
  if (
    !value ||
    !/^\d+$/.test(value)
  ) {
    throw new Error(
      `${flag} requires a positive integer\n${USAGE}`,
    );
  }

  const parsed =
    Number(value);

  if (parsed < 1) {
    throw new Error(
      `${flag} requires a positive integer\n${USAGE}`,
    );
  }

  return parsed;
};

export const parseAutonomousReelCliArgs = (
  rawArgs: readonly string[],
): CliOptions => {
  const args =
    rawArgs[0] === "--"
      ? rawArgs.slice(1)
      : [...rawArgs];

  const options: CliOptions = {
    forcePlan: false,
    dryRun: false,
  };

  for (
    let index = 0;
    index <
    args.length;
    index += 1
  ) {
    const arg =
      args[index];

    if (arg === "--count") {
      options.count =
        positiveInteger(
          args[index + 1],
          "--count",
        );

      index += 1;
      continue;
    }

    if (
      arg ===
      "--candidate-limit"
    ) {
      options.candidateLimit =
        positiveInteger(
          args[index + 1],
          "--candidate-limit",
        );

      index += 1;
      continue;
    }

    if (
      arg ===
      "--force-plan"
    ) {
      options.forcePlan =
        true;
      continue;
    }

    if (
      arg ===
      "--dry-run"
    ) {
      options.dryRun =
        true;
      continue;
    }

    throw new Error(USAGE);
  }

  if (
    options.count ===
    undefined
  ) {
    throw new Error(USAGE);
  }

  if (
    options.candidateLimit !==
      undefined &&
    options.candidateLimit <
      options.count
  ) {
    throw new Error(
      "--candidate-limit cannot be lower than --count",
    );
  }

  return options;
};

const main =
  async (): Promise<void> => {
    const options =
      parseAutonomousReelCliArgs(
        process.argv.slice(2),
      );

    const report =
      await runAutonomousReelPipeline({
        count:
          options.count!,
        ...(options.candidateLimit !==
        undefined
          ? {
              candidateLimit:
                options.candidateLimit,
            }
          : {}),
        forcePlan:
          options.forcePlan,
        dryRun:
          options.dryRun,
      });

    console.log(
      `Autonomous Reel pipeline (${report.dryRun ? "dry-run" : "execute"})`,
    );

    console.log(
      `requested=${report.requestedCount} baseline_ready=${report.baselineProductionReady}`,
    );

    if (
      report.dryRun
    ) {
      const command = [
        "npm run reels:batch -- --render",
        `--target ${report.requestedCount}`,
        ...(report.candidateLimit !==
        undefined
          ? [
              `--candidate-limit ${report.candidateLimit}`,
            ]
          : []),
        ...(report.forcePlan
          ? ["--force-plan"]
          : []),
      ].join(" ");

      console.log(
        `would_run=${command}`,
      );

      console.log(
        "would_follow=repair new production entries -> package -> deep verify",
      );

      return;
    }

    console.log(
      `batch_exit=${report.batchExitCode} new_production=${report.newProductionIds.length}`,
    );

    console.log(
      `repair_selected=${report.repair.selected} repaired=${report.repair.repaired} skipped=${report.repair.skipped} failed=${report.repair.failed}`,
    );

    console.log(
      `ready=${report.readyCount} shortfall=${report.shortfall}`,
    );

    if (
      report.newProductionIds.length >
      0
    ) {
      console.log(
        `new_ids=${report.newProductionIds.join(",")}`,
      );
    }

    if (
      report.productionReadyIds
        .length > 0
    ) {
      console.log(
        `ready_ids=${report.productionReadyIds.join(",")}`,
      );
    }

    console.log(
      `global history=${report.global.historyEntries} valid_renders=${report.global.validRenders} missing_renders=${report.global.missingRenders} invalid_renders=${report.global.invalidRenders} valid_releases=${report.global.validReleases} complete=${report.global.complete}`,
    );

    console.log(
      `outcome=${report.outcome}`,
    );

    if (
      report.outcome !==
      "COMPLETE"
    ) {
      process.exitCode = 1;
    }
  };

void main().catch(
  (error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    process.exitCode = 1;
  },
);
