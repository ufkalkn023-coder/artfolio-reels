import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve("scripts/reels-batch.ts"), "utf8");
const acquisition = script.indexOf('"src.reel_candidate_acquisition"');
const queue = script.indexOf("invokeCandidateBoundary(historyPath)");

if (acquisition < 0) throw new Error("batch runner does not invoke Art Bot acquisition");
if (queue < 0 || acquisition > queue) throw new Error("batch runner must acquire candidates before building its queue");
if (!script.includes("productionHistoryExcludedCanonicalIds(productionHistory)")) throw new Error("batch runner does not normalize production-history exclusions");
if (!script.includes('"--excluded-canonical-id"')) throw new Error("batch runner does not pass exclusion IDs to acquisition");
console.log("Reel acquisition integration test passed");
