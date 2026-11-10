import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { PiRunnerProviderConfig } from "./types.js";

const SDK_ANONYMOUS_API_KEY = "ling-internal-anonymous-sdk-placeholder";

export interface PiProviderRequestAuth {
  /** Live SDK registration only; never persist or materialize this as a Host secret. */
  readonly registrationApiKey: string | undefined;
  readonly requestHeaders: (headers: ProviderHeaders | undefined) => ProviderHeaders | undefined;
}

/**
 * Preserve Host anonymous/custom-auth intent through the OpenAI SDK's key requirement.
 * Pi 1.1's authHeader=false does not remove the client's automatic Bearer header.
 * Only the two OpenAI-compatible APIs accept an opaque, non-credential placeholder;
 * Codex's JWT and non-OpenAI authentication contracts must not use that fallback.
 */
export function resolvePiProviderRequestAuth(provider: PiRunnerProviderConfig): PiProviderRequestAuth {
  const api = provider.api ?? "openai-completions";
  if (provider.authHeader !== false || (api !== "openai-completions" && api !== "openai-responses")) {
    return { registrationApiKey: provider.apiKey, requestHeaders: headers => headers };
  }

  // Only explicitly configured provider headers authorize a custom Authorization.
  // Canonicalize its name so a differently cased SDK default cannot win or duplicate it.
  const explicitAuthorization = Object.entries(provider.headers ?? {}).find(([name, value]) =>
    name.toLowerCase() === "authorization" && value.trim().length > 0);
  return {
    registrationApiKey: provider.apiKey || SDK_ANONYMOUS_API_KEY,
    requestHeaders: headers => {
      const result: ProviderHeaders = { ...headers };
      // Use the SDK-resolved value, not the original configuration expression.
      // An explicit runtime null remains an omission, never a restored credential.
      const authorization = explicitAuthorization
        ? headers === undefined ? explicitAuthorization[1] : headers[explicitAuthorization[0]]
        : undefined;
      for (const name of Object.keys(result)) {
        if (name.toLowerCase() === "authorization") delete result[name];
      }
      // Public Pi/OpenAI header semantics: null explicitly suppresses client defaults.
      // Keep every unrelated configured/runtime header, including proxy auth headers.
      result.Authorization = typeof authorization === "string" && authorization.trim().length > 0
        ? authorization : null;
      return result;
    },
  };
}
