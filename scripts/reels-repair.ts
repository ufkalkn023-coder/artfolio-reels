import { repairProduction } from "../src/operations/production-repair";

type CliOptions = {
  dryRun: boolean;
  json: boolean;
  reelIds: string[];
  limit?: number;
  rootDirectory?: string;
};

const parseArgs = (
  args: readonly string[],
): CliOptions => {
  const options: CliOptions = {
    dryRun: false,
    json: false,
    reelIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--reel") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error(
          "--reel requires a Reel ID",
        );
      }

      options.reelIds.push(value);
      index += 1;
      continue;
    }

    if (argument === "--limit") {
      const value = args[index + 1];
      const parsed = Number(value);

      if (
        !value ||
        !Number.isInteger(parsed) ||
        parsed < 1
      ) {
        throw new Error(
          "--limit requires a positive integer",
        );
      }

      options.limit = parsed;
      index += 1;
      continue;
    }

    if (argument === "--root") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error(
          "--root requires a directory",
        );
      }

      options.rootDirectory = value;
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown argument: ${argument}`,
    );
  }

  return options;
};

const main = async (): Promise<void> => {
  const options = parseArgs(
    process.argv.slice(2),
  );

  const report = await repairProduction({
    dryRun: options.dryRun,
    ...(options.reelIds.length > 0
      ? { reelIds: options.reelIds }
      : {}),
    ...(options.limit !== undefined
      ? { limit: options.limit }
      : {}),
    ...(options.rootDirectory
      ? { rootDirectory: options.rootDirectory }
      : {}),
  });

  if (options.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(
      `Production repair (${report.dryRun ? "dry-run" : "execute"})`,
    );

    console.log(
      `selected=${report.selected} repairable=${report.repairable} repaired=${report.repaired} skipped=${report.skipped} failed=${report.failed}`,
    );

    for (const result of report.results) {
      const actions =
        result.plannedActions.length > 0
          ? result.plannedActions.join(" -> ")
          : "none";

      const detail =
        result.error ??
        result.reason ??
        actions;

      console.log(
        `${result.reelId}: ${result.status} ${detail}`,
      );
    }
  }

  if (report.failed > 0) {
    process.exitCode = 1;
  }
};

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : String(error),
  );
  process.exitCode = 1;
});
