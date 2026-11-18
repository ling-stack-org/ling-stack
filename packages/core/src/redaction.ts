const REDACTED = "[REDACTED]";
const SECRET_KEY_NAMES = new Set(["apikey", "apikeyref", "authorization", "cookie", "password", "token", "secret"]);
const OPENAI_STYLE_SECRET_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const AUTH_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
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
  return extraRedacted.replace(AUTH_VALUE_PATTERN, REDACTED).replace(OPENAI_STYLE_SECRET_PATTERN, REDACTED)
    .replace(REMOTE_URL_IN_TEXT_PATTERN, redactGitRemoteUrl);
}
