import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const tsxCli = require.resolve("tsx/cli");

const findTestFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return findTestFiles(path);
        return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
      }),
  );

  return files.flat();
};

const main = async (): Promise<void> => {
  for (const testFile of await findTestFiles("tests")) {
    const result = spawnSync(process.execPath, [tsxCli, testFile], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
