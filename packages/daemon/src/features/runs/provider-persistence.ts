import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";

/**
 * Historical Run snapshots are not credential stores. Keep audit placeholders
 * so existing inline-recovery validators reject unavailable credentials rather
 * than silently treating an authenticated connection as anonymous. Saved-preset
 * execution still resolves fresh values from its original credential source.
 */
export function providerForRunPersistence(provider: PiRunnerProviderConfig): PiRunnerProviderConfig {
  return {
    ...provider,
    ...(provider.apiKey === undefined ? {} : { apiKey: "[REDACTED]" }),
    ...(provider.headers === undefined ? {} : {
      headers: Object.fromEntries(Object.keys(provider.headers).map(name => [name, "[REDACTED]"])),
    }),
  };
}

/** Every inline resolution port must reject audit masks, never send them as credentials. */
export function assertInlineProviderCredentialsAvailable(provider: PiRunnerProviderConfig): void {
  const credentials = [provider.apiKey, ...Object.values(provider.headers ?? {})];
  if (credentials.some(value => typeof value !== "string" && value !== undefined || value?.includes("[REDACTED]"))) {
    throw new HttpError(409, "prepared_inline_credentials_unavailable",
      "The source Run has no reusable inline credentials. Select a configured provider preset for a new continuation.");
  }
}
