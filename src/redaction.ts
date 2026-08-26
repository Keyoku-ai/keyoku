// Shared trust-boundary redaction. Keep this independent of the v2 activity
// recorder so the v3 Factfile verifier does not pull that legacy subsystem
// into the public package entrypoint.
const SECRET_ASSIGNMENT_RE =
  /([\w-]*(?:token|secret|passwd|password|api[_-]?key|access[_-]?key|credential|auth)[\w-]*["']?\s*[:=]\s*)(["']?)(?!bearer\b)(?!basic\b)(?!«redacted»)[^\s"']{4,}\2/gi;
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_RE = /\b(basic\s+)[A-Za-z0-9+/=]{8,}/gi;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']*:)[^\s@"']+@/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_RE, "$1«redacted»")
    .replace(BASIC_RE, "$1«redacted»")
    .replace(URL_USERINFO_RE, "$1«redacted»@")
    .replace(SECRET_ASSIGNMENT_RE, "$1«redacted»");
}
