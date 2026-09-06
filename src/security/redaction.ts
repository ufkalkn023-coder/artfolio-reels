const SECRET_ASSIGNMENT = /(\b(?:[A-Z][A-Z0-9_]*?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|token|secret|password|x-goog-api-key)\b\s*(?:=|:)\s*)[^\s,;]+/gi;
const SECRET_QUERY = /([?&](?:key|token|api[_-]?key|access[_-]?token)=)[^&\s]+/gi;

/** Keep operational context while removing credentials and untrusted URLs. */
export const sanitizeDiagnostic = (value: string, maxLength = 600): string => value
  .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
  .replace(SECRET_ASSIGNMENT, "$1[redacted]")
  .replace(SECRET_QUERY, "$1[redacted]")
  .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-google-api-key]")
  .replace(/(?:https?|wss?):\/\/[^\s'"<>]+/gi, "[redacted-url]")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, maxLength);
