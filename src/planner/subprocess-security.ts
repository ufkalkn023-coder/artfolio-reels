import { sanitizeDiagnostic } from "../security/redaction";

const ART_BOT_BASE_ENVIRONMENT = new Set([
  "HOME",
  "LANG",
  "PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "VIRTUAL_ENV",
]);

/** Build the minimum useful Python environment without forwarding planner or unrelated secrets. */
export const buildArtBotSubprocessEnvironment = (
  parentEnvironment: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && (ART_BOT_BASE_ENVIRONMENT.has(name) || name.startsWith("LC_"))) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

export const sanitizeSubprocessStderr = (stderr: string): string => sanitizeDiagnostic(stderr, 2_000);
