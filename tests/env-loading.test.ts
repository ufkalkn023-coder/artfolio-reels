import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMissingEnvironmentFrom } from "../src/planner/config";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const run = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "artfolio-env-loading-"));
  const envPath = join(directory, ".env.local");
  await writeFile(envPath, "ARTFOLIO_ENV_TEST_VALUE=from-file\nARTFOLIO_ENV_TEST_PRECEDENCE=from-file\n");
  const previousValue = process.env.ARTFOLIO_ENV_TEST_VALUE;
  const previousPrecedence = process.env.ARTFOLIO_ENV_TEST_PRECEDENCE;
  try {
    delete process.env.ARTFOLIO_ENV_TEST_VALUE;
    process.env.ARTFOLIO_ENV_TEST_PRECEDENCE = "from-process";
    loadMissingEnvironmentFrom(envPath);
    equal(process.env.ARTFOLIO_ENV_TEST_VALUE, "from-file", "local env loads missing values");
    equal(process.env.ARTFOLIO_ENV_TEST_PRECEDENCE, "from-process", "process environment remains authoritative");
  } finally {
    if (previousValue === undefined) delete process.env.ARTFOLIO_ENV_TEST_VALUE;
    else process.env.ARTFOLIO_ENV_TEST_VALUE = previousValue;
    if (previousPrecedence === undefined) delete process.env.ARTFOLIO_ENV_TEST_PRECEDENCE;
    else process.env.ARTFOLIO_ENV_TEST_PRECEDENCE = previousPrecedence;
  }
  console.log("Environment loading tests passed");
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
