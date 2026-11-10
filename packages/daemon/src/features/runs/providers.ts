import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import {
  type ProviderPreset,
  type ProviderStoreFacet,
  type ProviderTransport,
  type SecretResolver,
  providerThinkingModesToLevelMap,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { providerSecretStatus } from "../providers/secrets.js";
import {
  ProviderSecretMaterializationError,
  materializeProviderSecrets,
} from "../providers/secret-materializer.js";
import { removeUndefined } from "../../shared/validation.js";
import { assertInlineProviderCredentialsAvailable } from "./provider-persistence.js";
import type { RunRequest } from "./schemas.js";
import {
  bindResolvedProviderObservationScope,
  captureProviderConfigurationTicket,
  providerPresetForConfigurationTicket,
} from "../providers/runtime-observation-scope.js";

type ProviderRunSelection = Pick<
  RunRequest,
  "providerPresetId" | "provider" | "skipProviderPreflight"
>;

export function resolveProviderForRun<T extends ProviderRunSelection>(
  store: ProviderStoreFacet,
  runRequest: T,
  secretResolver: SecretResolver,
  options: { readonly providerWebSocketFallbackEnabled?: boolean } = {},
): PiRunnerProviderConfig {
  if (runRequest.providerPresetId && runRequest.provider) {
    throw new HttpError(400, "bad_request", "providerPresetId and inline provider cannot both be supplied");
  }

  if (runRequest.providerPresetId) {
    const ticket = captureProviderConfigurationTicket(store, runRequest.providerPresetId);
    const preset = ticket
      ? providerPresetForConfigurationTicket(ticket)
      : store.getProviderPreset(runRequest.providerPresetId);
    if (!preset) {
      throw new HttpError(404, "provider_not_found", `Provider preset not found: ${runRequest.providerPresetId}`);
    }
    if (!preset.enabled) {
      throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
    }
    if (preset.api === "media-job") {
      throw new HttpError(400, "unsupported_capability", "Generation-only model presets cannot run coding tasks");
    }
    if (!preset.capabilities.includes("chat")) {
      throw new HttpError(400, "unsupported_capability", "Provider preset must include chat capability for coding runs");
    }
    assertProviderRunPreflight(store, preset, runRequest.skipProviderPreflight === true, secretResolver);
    const materialized = materializeProviderSecretsForRun(store, preset, secretResolver);
    const provider = removeUndefined({
      provider: preset.providerId,
      model: preset.model,
      displayName: preset.displayName,
      apiKey: materialized.apiKeySecret.value,
      baseUrl: preset.baseUrl,
      api: preset.api as PiRunnerProviderConfig["api"],
      providerTransport: resolveEffectiveProviderTransport(
        preset.api,
        preset.providerTransport,
        options.providerWebSocketFallbackEnabled === true,
      ),
      headers: materialized.headers,
      authHeader: preset.authHeader,
      reasoning: preset.reasoning,
      thinkingLevelMap: providerThinkingModesToLevelMap(preset.thinkingModes),
      input: preset.input,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      compat: preset.compat,
    }) as PiRunnerProviderConfig;
    if (ticket) bindResolvedProviderObservationScope({ store, ticket, provider, materialized, materializedPreset: preset });
    return provider;
  }

  if (!runRequest.provider) {
    throw new HttpError(400, "bad_request", "Either providerPresetId or provider is required");
  }

  assertInlineProviderCredentialsAvailable(runRequest.provider);
  return removeUndefined({
    ...runRequest.provider,
    providerTransport: resolveEffectiveProviderTransport(
      runRequest.provider.api,
      runRequest.provider.providerTransport,
      options.providerWebSocketFallbackEnabled === true,
    ),
  }) as PiRunnerProviderConfig;
}

export function resolveProviderRunThinkingLevel(
  provider: Pick<PiRunnerProviderConfig, "reasoning" | "thinkingLevelMap">,
  requestedLevel: RunRequest["thinkingLevel"],
): RunRequest["thinkingLevel"] {
  const level = requestedLevel ?? "medium";
  if ((level === "max" || level === "ultra") &&
    (provider.reasoning === false || provider.thinkingLevelMap?.[level] !== level)) {
    throw new HttpError(400, "unsupported_capability", `Selected model does not support reasoning level ${level}. Refresh its model capabilities or choose a supported level.`);
  }
  if (provider.reasoning === false) {
    return "off";
  }
  if (provider.thinkingLevelMap?.[level] === null) {
    return "off";
  }
  return requestedLevel;
}

function resolveEffectiveProviderTransport(
  api: PiRunnerProviderConfig["api"] | undefined,
  configured: ProviderTransport | undefined,
  providerWebSocketFallbackEnabled: boolean,
): ProviderTransport | undefined {
  if (api !== "openai-codex-responses") {
    return undefined;
  }
  return providerWebSocketFallbackEnabled ? configured ?? "auto" : "sse";
}

function assertProviderRunPreflight(store: ProviderStoreFacet, preset: ProviderPreset, skipProviderPreflight: boolean, secretResolver: SecretResolver): void {
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

function providerSecretPreflightBlocker(store: ProviderStoreFacet, preset: ProviderPreset, secretResolver: SecretResolver): string | undefined {
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

function materializeProviderSecretsForRun(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  secretResolver: SecretResolver,
): ReturnType<typeof materializeProviderSecrets> {
  try {
    return materializeProviderSecrets({ store, preset, secretResolver });
  } catch (error) {
    if (error instanceof ProviderSecretMaterializationError) {
      throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: ${error.message}`);
    }
    throw error;
  }
}
