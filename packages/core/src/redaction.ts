const REDACTED = "[REDACTED]";
const SECRET_KEY_NAMES = new Set(["apikey", "apikeyref", "authorization", "cookie", "password", "token", "secret"]);
const OPENAI_STYLE_SECRET_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const AUTH_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

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
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function redactString(value: string, extraSecrets: readonly string[]): string {
  const extraRedacted = extraSecrets.reduce((text, secret) => text.split(secret).join(REDACTED), value);
  AUTH_VALUE_PATTERN.lastIndex = 0;
  OPENAI_STYLE_SECRET_PATTERN.lastIndex = 0;
  return extraRedacted.replace(AUTH_VALUE_PATTERN, REDACTED).replace(OPENAI_STYLE_SECRET_PATTERN, REDACTED);
}
