const REDACTED = "[REDACTED]";
const SECRET_KEY_NAMES = new Set(["apikey", "apikeyref", "authorization", "cookie", "password", "token", "secret",
  "accesskey", "accesskeyid", "secretaccesskey", "privatekey", "signingkey"]);
const OPENAI_STYLE_SECRET_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const AUTH_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const CLOUD_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// Inspect each key once. Searching for a secret substring inside an unbounded
// regex prefix retries at every character of ordinary long output lines.
const ASSIGNMENT_PREFIX_PATTERN = /(?<![A-Za-z0-9_.-])["'`]?([A-Za-z0-9_.-]+)["'`]?\s*[:=]\s*/gu;
const SECRET_ASSIGNMENT_KEY_PATTERN = /api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization|[_-]?token)?|client[_-]?secret|database[_-]?url|pass(?:word|phrase)?|private[_-]?key|secret|session[_-]?token|signing[_-]?key|token|credentials?/iu;
const UNQUOTED_VALUE_PATTERN = /[^\s,;{})\[\]"'`]+/yu;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+(@)/giu;
const GIT_REMOTE_SENSITIVE_QUERY_KEYS = new Set(["token", "access_token", "private_token", "auth", "key"]);
const GIT_REMOTE_SCP_PATTERN = /^[^@\s/:]+@[^:\s/]+:[^\s]+$/u;
const REMOTE_URL_IN_TEXT_PATTERN = /\b(?:https?|ssh):\/\/[^\s<>"'`]+/giu;

export function redactSecrets(value: unknown, extraSecrets: readonly (string | undefined)[] = []): unknown {
  return redactValue(value, new WeakSet<object>(), extraSecrets.filter((secret): secret is string => Boolean(secret)));
}

function redactValue(value: unknown, seen: WeakSet<object>, extraSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, extraSecrets);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    try {
      return value.map((item) => redactValue(item, seen, extraSecrets));
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    try {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = normalizeKey(key) === "gitremoteurl" && typeof item === "string"
          ? redactString(redactGitRemoteUrl(item), extraSecrets)
          : shouldRedactKey(key) ? REDACTED : redactValue(item, seen, extraSecrets);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SECRET_KEY_NAMES.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("accesstoken") ||
    normalized === "authorization" ||
    normalized.endsWith("authorization") ||
    normalized.includes("authorizationheader") ||
    normalized.includes("authorizationvalue") ||
    normalized.includes("clientsecret") ||
    normalized.includes("databaseurl") ||
    normalized.includes("sessiontoken") ||
    normalized.includes("privatekey") ||
    normalized.includes("signingkey") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("credentialvalue") ||
    normalized.endsWith("secretvalue") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Redacts Git remote userinfo and credential-shaped query parameters before a remote
 * is placed in status, logs, errors, or evidence. Invalid values are redacted defensively.
 */
export function redactGitRemoteUrl(value: string): string {
  const remote = typeof value === "string" ? value : String(value);
  try {
    if (GIT_REMOTE_SCP_PATTERN.test(remote.trim())) {
      return remote.trim();
    }
    const parsed = new URL(remote.trim());
    let changed = false;
    const hasCredentialUserInfo = Boolean(parsed.password) || (parsed.protocol !== "ssh:" && Boolean(parsed.username));
    if (hasCredentialUserInfo) {
      parsed.username = "***";
      parsed.password = "";
      changed = true;
    }
    for (const key of new Set(parsed.searchParams.keys())) {
      if (GIT_REMOTE_SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "***");
        changed = true;
      }
    }
    return changed ? parsed.toString() : remote;
  } catch {
    return REDACTED;
  }
}

function redactString(value: string, extraSecrets: readonly string[]): string {
  const extraRedacted = extraSecrets.reduce((text, secret) => text.split(secret).join(REDACTED), value);
  AUTH_VALUE_PATTERN.lastIndex = 0;
  OPENAI_STYLE_SECRET_PATTERN.lastIndex = 0;
  const patterned = extraRedacted
    .replace(AUTH_VALUE_PATTERN, REDACTED)
    .replace(OPENAI_STYLE_SECRET_PATTERN, REDACTED)
    .replace(CLOUD_ACCESS_KEY_PATTERN, REDACTED)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED)
    .replace(SLACK_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(REMOTE_URL_IN_TEXT_PATTERN, redactGitRemoteUrl)
    .replace(URL_CREDENTIAL_PATTERN, (_match, prefix: string, suffix: string) => `${prefix}${REDACTED}${suffix}`);
  return redactSecretAssignments(patterned);
}

function redactSecretAssignments(value: string): string {
  let output = "";
  let cursor = 0;
  ASSIGNMENT_PREFIX_PATTERN.lastIndex = 0;
  for (let match = ASSIGNMENT_PREFIX_PATTERN.exec(value); match; match = ASSIGNMENT_PREFIX_PATTERN.exec(value)) {
    const key = match[1]!;
    if (!SECRET_ASSIGNMENT_KEY_PATTERN.test(key)) continue;
    const start = ASSIGNMENT_PREFIX_PATTERN.lastIndex;
    const quote = value[start];
    let end: number;
    let assignedValue: string;
    let replacement: string;
    if (quote === '"' || quote === "'" || quote === "`") {
      end = start + 1;
      while (end < value.length && value[end] !== quote) end += value[end] === "\\" ? 2 : 1;
      assignedValue = value.slice(start + 1, end);
      end = Math.min(end + 1, value.length);
      replacement = `${quote}${REDACTED}${quote}`;
    } else {
      UNQUOTED_VALUE_PATTERN.lastIndex = start;
      const unquoted = UNQUOTED_VALUE_PATTERN.exec(value);
      if (!unquoted) continue;
      assignedValue = unquoted[0];
      end = UNQUOTED_VALUE_PATTERN.lastIndex;
      replacement = REDACTED;
    }
    output += isTokenCountAssignment(key, assignedValue) ? value.slice(cursor, end) : value.slice(cursor, start) + replacement;
    cursor = end;
    ASSIGNMENT_PREFIX_PATTERN.lastIndex = end;
  }
  return output + value.slice(cursor);
}

function isTokenCountAssignment(key: string, assignedValue: string): boolean {
  return /tokens$/iu.test(key) && !shouldRedactKey(key)
    && /^\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*$/u.test(assignedValue);
}
