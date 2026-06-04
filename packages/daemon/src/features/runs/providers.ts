import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import {
  type ProviderPreset,
  type ResolvedSecret,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { providerSecretStatus, resolveProviderSecret } from "../providers/secrets.js";
import { removeUndefined } from "../../shared/validation.js";
import type { RunRequest } from "./schemas.js";

export function resolveProviderForRun(store: RunStore, runRequest: RunRequest, secretResolver: SecretResolver): PiRunnerProviderConfig {
  if (runRequest.providerPresetId && runRequest.provider) {
    throw new HttpError(400, "bad_request", "providerPresetId and inline provider cannot both be supplied");
  }

  if (runRequest.providerPresetId) {
    const preset = store.getProviderPreset(runRequest.providerPresetId);
    if (!preset) {
      throw new HttpError(404, "provider_not_found", `Provider preset not found: ${runRequest.providerPresetId}`);
    }
    if (!preset.enabled) {
      throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
    }
    if (preset.api === "media-job") {
      throw new HttpError(400, "unsupported_capability", "Media provider presets cannot run pi coding tasks");
    }
    if (!preset.capabilities.includes("chat")) {
      throw new HttpError(400, "unsupported_capability", "Provider preset must include chat capability for coding runs");
    }
    assertProviderRunPreflight(store, preset, runRequest.skipProviderPreflight === true, secretResolver);
    const secret: ResolvedSecret = preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
    return removeUndefined({
      provider: preset.providerId,
      model: preset.model,
      displayName: preset.displayName,
      apiKey: secret.value,
      baseUrl: preset.baseUrl,
      api: preset.api as PiRunnerProviderConfig["api"],
      headers: preset.headers,
      authHeader: preset.authHeader,
      reasoning: preset.reasoning,
      input: preset.input,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      compat: preset.compat,
    }) as PiRunnerProviderConfig;
  }

  if (!runRequest.provider) {
    throw new HttpError(400, "bad_request", "Either providerPresetId or provider is required");
  }

  return runRequest.provider;
}

function assertProviderRunPreflight(store: RunStore, preset: ProviderPreset, skipProviderPreflight: boolean, secretResolver: SecretResolver): void {
  if (skipProviderPreflight) {
    return;
  }

  const secretBlocker = providerSecretPreflightBlocker(store, preset, secretResolver);
  if (secretBlocker) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: ${secretBlocker}`);
  }

  if (!preset.lastCheck) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: provider has not been checked. Run provider check before starting.`);
  }
  if (!preset.lastCheck.ok) {
    throw new HttpError(
      400,
      "provider_preflight_failed",
      `${preset.displayName}: provider check failed (${preset.lastCheck.code ?? "failed"}). ${preset.lastCheck.message}`.trim(),
    );
  }
}

function providerSecretPreflightBlocker(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): string | undefined {
  const needsSecret = preset.api !== "media-job" && (preset.api === "anthropic-messages" || preset.authHeader !== false);
  if (needsSecret && !preset.apiKeyRef) {
    return "API key missing.";
  }
  if (preset.apiKeyRef) {
    const status = providerSecretStatus(store, preset, secretResolver);
    if (!status.configured) {
      return `${status.message ?? "API key missing."}`;
    }
  }
  return undefined;
}
