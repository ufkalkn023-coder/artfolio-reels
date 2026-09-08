import { resolve } from "node:path";
import { auditProduction } from "../src/operations/production-audit";

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const deep = args.includes("--deep");
  const root = valueAfter(args, "--root");
  const reelIds = args.flatMap((argument, index) => args[index - 1] === "--reel" ? [argument] : []);
  const report = await auditProduction({ rootDirectory: root ? resolve(root) : undefined, deep, reelIds });
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`Production audit (${deep ? "deep" : "fast"})`);
  console.log(`history=${report.summary.historyEntries} reels=${report.summary.reelData} renders=${report.summary.renders} valid_renders=${report.summary.validRenders}`);
  console.log(`missing_renders=${report.summary.missingRenders} invalid_renders=${report.summary.invalidRenders} releases=${report.summary.releases} valid_releases=${report.summary.validReleases}`);
  console.log(`orphan_renders=${report.orphans.renders.length} orphan_social=${report.orphans.socialCopies.length} complete=${report.summary.complete}`);
  for (const item of report.items.filter((candidate) => !candidate.states.includes("COMPLETE"))) {
    console.log(`${item.reelId}: ${item.states.join(",")}`);
  }
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
