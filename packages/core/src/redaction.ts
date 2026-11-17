const REDACTED = "[REDACTED]";
const SECRET_KEY_NAMES = new Set(["apikey", "apikeyref", "authorization", "cookie", "password", "token", "secret",
  "accesskey", "accesskeyid", "secretaccesskey", "privatekey", "signingkey"]);
const OPENAI_STYLE_SECRET_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const AUTH_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const CLOUD_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const SECRET_ASSIGNMENT_PREFIX_PATTERN = /(["'`]?(?=[A-Za-z_])[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization|[_-]?token)?|client[_-]?secret|database[_-]?url|pass(?:word|phrase)?|private[_-]?key|secret|session[_-]?token|signing[_-]?key|token|credential(?:s)?)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*)(["'`])/giu;
const SECRET_ASSIGNMENT_UNQUOTED_PATTERN = /(["'`]?(?=[A-Za-z_])[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth(?:orization|[_-]?token)?|client[_-]?secret|database[_-]?url|pass(?:word|phrase)?|private[_-]?key|secret|session[_-]?token|signing[_-]?key|token|credential(?:s)?)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*)([^\s,;)}\[\]"'\x60]+)/giu;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+(@)/giu;

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
        result[key] = shouldRedactKey(key) ? REDACTED : redactValue(item, seen, extraSecrets);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
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
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
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
    .replace(URL_CREDENTIAL_PATTERN, (_match, prefix: string, suffix: string) => `${prefix}${REDACTED}${suffix}`);
  return redactSecretAssignments(patterned);
}

function redactSecretAssignments(value: string): string {
  let output = "";
  let cursor = 0;
  SECRET_ASSIGNMENT_PREFIX_PATTERN.lastIndex = 0;
  for (let match = SECRET_ASSIGNMENT_PREFIX_PATTERN.exec(value); match; match = SECRET_ASSIGNMENT_PREFIX_PATTERN.exec(value)) {
    const prefix = match[1]!;
    const quote = match[2]!;
    let end = match.index + match[0].length;
    let escaped = false;
    while (end < value.length) {
      const character = value[end]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) { end += 1; break; }
      end += 1;
    }
    const quotedValue = value.slice(match.index + match[0].length, end - (value[end - 1] === quote ? 1 : 0));
    output += isTokenCountAssignment(prefix, quotedValue)
      ? value.slice(cursor, end)
      : `${value.slice(cursor, match.index)}${prefix}${quote}${REDACTED}${quote}`;
    cursor = end;
    SECRET_ASSIGNMENT_PREFIX_PATTERN.lastIndex = end;
  }
  output += value.slice(cursor);
  SECRET_ASSIGNMENT_UNQUOTED_PATTERN.lastIndex = 0;
  return output.replace(SECRET_ASSIGNMENT_UNQUOTED_PATTERN, (match, prefix: string, rawValue: string) =>
    isTokenCountAssignment(prefix, rawValue) ? match : `${prefix}${REDACTED}`);
}

function isTokenCountAssignment(prefix: string, assignedValue: string): boolean {
  const key = prefix.match(/["'`]?([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*$/)?.[1];
  if (!key || !/(?:^|[_-])tokens?$/iu.test(key)) return false;
  return /^\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*$/u.test(assignedValue);
}
