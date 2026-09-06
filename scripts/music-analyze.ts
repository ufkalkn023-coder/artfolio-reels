import { runMusicAnalyze } from "../src/music/analyze-cli";

void runMusicAnalyze(process.argv.slice(2)).then(
  (output) => process.stdout.write(output),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
