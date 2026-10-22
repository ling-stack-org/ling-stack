import type { SecretResolver } from "@ling-stack/core";

export class EngineCredentialError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function resolveEngineSecret(ref: string, resolver?: SecretResolver): string {
  if (!resolver) throw new EngineCredentialError("engine_secret_missing");
  let resolved;
  try { resolved = resolver.resolve(ref, "provider_api_key"); }
  catch { throw new EngineCredentialError("engine_secret_unavailable"); }
  if (!resolved.configured || !resolved.value) {
    const code = resolved.status?.errorCode;
    throw new EngineCredentialError(code && ["secret_missing", "secret_access_denied", "secret_store_unavailable", "invalid_secret_ref"].includes(code)
      ? `engine_${code}` : "engine_secret_missing");
  }
  if (resolved.value.length > 16 * 1024 || resolved.value.trim() !== resolved.value || /[\x00-\x1f\x7f]/.test(resolved.value)) {
    throw new EngineCredentialError("engine_secret_invalid");
  }
  return resolved.value;
}
