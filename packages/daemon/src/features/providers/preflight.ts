import {
  normalizeProviderBaseUrlForAdapter,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderStoreFacet,
  type ResolvedSecret,
  type SecretResolver,
} from "@ling-stack/core";
import { executeMediaJob as executeMediaAdapterJob, resolveMediaVendorTransportGateConfig } from "@ling-stack/providers";
import { readLimitedResponseText } from "../../shared/http.js";
import { validateUrl } from "../../shared/validation.js";
import { createMediaAdapterForProvider } from "../media/provider.js";
import { providerSecretStatus, resolveProviderSecret } from "./secrets.js";

const PROVIDER_CHECK_TIMEOUT_MS = 10_000;

export async function checkProviderPreset(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  secretResolver: SecretResolver,
): Promise<ProviderCheckResult> {
  const checkedAt = new Date().toISOString();
  if (preset.baseUrl) {
    try {
      validateUrl(preset.baseUrl, "baseUrl");
    } catch (error) {
      return { ok: false, code: "bad_request", message: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }
  const needsSecret = preset.api === "anthropic-messages" || preset.authHeader !== false;
  if (needsSecret && !preset.apiKeyRef) {
    return { ok: false, code: "secret_missing", message: "API key missing. Add an API key before running a live check.", checkedAt };
  }
  if (preset.apiKeyRef) {
    const secretStatus = providerSecretStatus(store, preset, secretResolver);
    if (!secretStatus.configured) {
      return {
        ok: false,
        code: secretStatus.errorCode ?? "secret_missing",
        message: secretStatus.message ?? `API key missing: ${preset.apiKeyRef} is not configured.`,
        checkedAt,
      };
    }
  }
  if (preset.api !== "media-job" && !preset.capabilities.includes("chat")) {
    return { ok: false, code: "unsupported_capability", message: "Provider preset cannot run chat tasks.", checkedAt };
  }
  if (!preset.enabled) {
    return { ok: false, code: "provider_disabled", message: "Provider preset is disabled.", checkedAt };
  }

  if (preset.api === "media-job") {
    if (preset.kind !== "seedream" || !preset.capabilities.includes("image_generate")) {
      return {
        ok: false,
        code: "unsupported_live_probe",
        message: `${preset.displayName} does not support a real check yet.`,
        checkedAt,
      };
    }
    const gate = resolveMediaVendorTransportGateConfig(preset.compat);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.errorCode ?? "invalid_request",
        message: gate.errorMessage ?? "Invalid media vendor transport configuration.",
        checkedAt,
      };
    }
    if (gate.config?.mode === "live") {
      if (!preset.baseUrl) {
        return { ok: false, code: "bad_request", message: "baseUrl is required for live generation transport.", checkedAt };
      }
      if (!preset.apiKeyRef) {
        return { ok: false, code: "secret_missing", message: "API key missing. Add an API key before enabling live generation transport.", checkedAt };
      }
      const secretStatus = providerSecretStatus(store, preset, secretResolver);
      if (!secretStatus.configured) {
        return {
          ok: false,
          code: secretStatus.errorCode ?? "secret_missing",
          message: secretStatus.message ?? `API key missing: ${preset.apiKeyRef} is not configured.`,
          checkedAt,
        };
      }
      return await probeLiveSeedreamProvider(store, preset, checkedAt, secretResolver);
    }
    return {
      ok: true,
      code: "static_check",
      message: "Generation model configuration is valid. Live generation transport is disabled by default and no generation request will be made.",
      checkedAt,
    };
  }

  if (preset.api === "openai-codex-responses") {
    return {
      ok: true,
      code: "static_check",
      message: "OpenAI Codex Responses configuration is valid. Provider check does not open a live WebSocket or send a model request.",
      checkedAt,
    };
  }

  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(preset.api)) {
    return {
      ok: true,
      code: "static_check",
      message: `Provider configuration is valid. Live checks for ${preset.api} are not implemented yet.`,
      checkedAt,
    };
  }

  return await probeChatProvider(store, preset, checkedAt, secretResolver);
}

async function probeChatProvider(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  checkedAt: string,
  secretResolver: SecretResolver,
): Promise<ProviderCheckResult> {
  try {
    const response = await fetch(buildProviderCheckUrl(preset), {
      method: "POST",
      headers: buildProviderCheckHeaders(store, preset, secretResolver),
      body: JSON.stringify(buildProviderCheckBody(preset)),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      return {
        ok: true,
        code: "ready",
        message: "Provider is reachable and accepted the configured model.",
        checkedAt,
      };
    }

    return await providerCheckHttpFailure(response, checkedAt);
  } catch (error) {
    return {
      ok: false,
      code: "network_failed",
      message: `Provider network check failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  }
}

function buildProviderCheckUrl(preset: ProviderPreset): string {
  const baseUrl = normalizeProviderBaseUrl(preset);
  if (preset.api === "anthropic-messages") {
    return `${baseUrl}/messages`;
  }
  if (preset.api === "openai-responses") {
    return `${baseUrl}/responses`;
  }
  return `${baseUrl}/chat/completions`;
}

function normalizeProviderBaseUrl(preset: ProviderPreset): string {
  return normalizeProviderBaseUrlForAdapter(preset);
}

async function probeLiveSeedreamProvider(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  checkedAt: string,
  secretResolver: SecretResolver,
): Promise<ProviderCheckResult> {
  const execution = await executeMediaAdapterJob(createMediaAdapterForProvider(store, preset, secretResolver), {
    jobId: "provider_check_seedream_live",
    provider: {
      id: preset.id,
      kind: preset.kind,
      displayName: preset.displayName,
      providerId: preset.providerId,
      model: preset.model,
      api: preset.api,
      baseUrl: preset.baseUrl,
      apiKeyRef: preset.apiKeyRef,
      capabilities: preset.capabilities,
    },
    operation: "image_generate",
    prompt: "Generate a small provider check image.",
    input: { response_format: "url", size: "1024x1024", stream: false },
    requestedAt: checkedAt,
  });
  if (execution.status === "failed") {
    return {
      ok: false,
      code: execution.errorCode ?? "provider_error",
      message: execution.errorMessage ?? "Seedream live image check failed.",
      checkedAt,
    };
  }
  const hasImage = execution.artifacts.some((artifact) => artifact.type === "image" && artifact.contentBytes !== undefined);
  if (!hasImage) {
    return {
      ok: false,
      code: "media_artifact_missing",
      message: "Seedream live image check did not return a usable image.",
      checkedAt,
    };
  }
  return {
    ok: true,
    code: "live_image_probe_ready",
    message: "生成真实图片成功",
    checkedAt,
  };
}

function buildProviderCheckHeaders(store: ProviderStoreFacet, preset: ProviderPreset, secretResolver: SecretResolver): Record<string, string> {
  const secret: ResolvedSecret = preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...preset.headers,
  };

  if (preset.api === "anthropic-messages") {
    if (secret.value) {
      headers["x-api-key"] = secret.value;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }

  if (preset.authHeader !== false && secret.value) {
    headers.Authorization = `Bearer ${secret.value}`;
  }
  return headers;
}

function buildProviderCheckBody(preset: ProviderPreset): Record<string, unknown> {
  if (preset.api === "anthropic-messages") {
    return {
      model: preset.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
    };
  }
  if (preset.api === "openai-responses") {
    return {
      model: preset.model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      stream: false,
    };
  }
  return {
    model: preset.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
  };
}

async function providerCheckHttpFailure(response: Response, checkedAt: string): Promise<ProviderCheckResult> {
  const bodyText = await readLimitedResponseText(response, 800);
  const lowerBody = bodyText.toLowerCase();
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "auth_failed",
      message: `Provider authentication failed with HTTP ${response.status}. Check the API key and account access.`,
      checkedAt,
    };
  }
  if (response.status === 404 || lowerBody.includes("model") && (lowerBody.includes("not found") || lowerBody.includes("does not exist"))) {
    return {
      ok: false,
      code: "model_unsupported",
      message: `Provider rejected the endpoint or model with HTTP ${response.status}. Check baseUrl and model.`,
      checkedAt,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      message: "Provider is reachable but rate limited the health check.",
      checkedAt,
    };
  }
  return {
    ok: false,
    code: "provider_error",
    message: `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`,
    checkedAt,
  };
}
