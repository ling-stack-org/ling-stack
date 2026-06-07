export function redactSecrets(value: unknown, extraSecrets: readonly (string | undefined)[] = []): unknown {
  return redactValue(value, new WeakSet<object>(), extraSecrets.filter((secret): secret is string => Boolean(secret)));
}

export function redactSecretText(value: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const secrets = extraSecrets.filter((secret): secret is string => Boolean(secret));
  return redactValue(value, new WeakSet<object>(), secrets) as string;
}

function redactValue(value: unknown, seen: WeakSet<object>, extraSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return extraSecrets.reduce(
      (text, secret) => text.split(secret).join("[REDACTED]"),
      value.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"),
    );
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactValue(item, seen, extraSecrets));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shouldRedactKey(key) ? "[REDACTED]" : redactValue(item, seen, extraSecrets)]),
    );
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "apikey" ||
    normalized === "apikeyref" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}
