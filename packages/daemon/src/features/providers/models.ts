import {
  builtinMediaModelCandidates,
  normalizeProviderBaseUrlForAdapter,
  providerMediaKind,
  providerApis,
  providerCapabilities,
  type ProviderApi,
  type ProviderModelListRequest,
  type ProviderModelListResponse,
  type ProviderModelOption,
  type ProviderPreset,
  type ResolvedSecret,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { readLimitedResponseText } from "../../shared/http.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord, removeUndefined, validateUrl } from "../../shared/validation.js";
import { resolveProviderSecret } from "./secrets.js";

const PROVIDER_CHECK_TIMEOUT_MS = 10_000;

export async function listProviderModels(
  store: RunStore,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): Promise<ProviderModelListResponse> {
  const preset = providerModelListInputToPreset(input);
  if (preset.baseUrl) {
    validateUrl(preset.baseUrl, "baseUrl");
  }
  if (preset.api === "media-job") {
    return await listMediaProviderModels(store, preset, input, secretResolver);
  }
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(preset.api)) {
    throw new HttpError(400, "unsupported_capability", `Model discovery is not implemented for ${preset.api}.`);
  }
  const secret = resolveProviderModelListSecret(store, preset, input, secretResolver);
  if ((preset.api === "anthropic-messages" || preset.authHeader !== false) && !secret.configured) {
    throw new HttpError(400, "secret_missing", "API key missing. Add an API key before fetching models.");
  }

  const source = buildProviderModelsUrl(preset);
  try {
    const response = await fetch(source, {
      method: "GET",
      headers: buildProviderModelsHeaders(preset, secret),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 400,
        response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
        await providerModelListFailureMessage(response, secret.value),
      );
    }
    const body = await response.json() as unknown;
    return {
      source,
      models: parseProviderModelsResponse(body),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(
      400,
      "network_failed",
      `Provider model discovery failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), [secret.value])}`,
    );
  }
}

async function listMediaProviderModels(
  store: RunStore,
  preset: ProviderPreset,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): Promise<ProviderModelListResponse> {
  const mediaKind = providerMediaKind(preset);
  const builtin = builtinMediaModelCandidates(mediaKind);
  const secret = resolveProviderModelListSecret(store, preset, input, secretResolver);
  if (preset.authHeader === false && !secret.configured) {
    return { source: "builtin:media-models", models: builtin };
  }
  if ((preset.authHeader !== false || preset.apiKeyRef) && !secret.configured) {
    throw new HttpError(400, "secret_missing", "API key missing. Add an API key before fetching models.");
  }

  const source = buildProviderModelsUrl(preset);
  try {
    const response = await fetch(source, {
      method: "GET",
      headers: buildProviderModelsHeaders(preset, secret),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (builtin.length > 0) {
        return { source: "builtin:media-models", models: builtin };
      }
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 400,
        response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
        await providerModelListFailureMessage(response, secret.value),
      );
    }
    const body = await response.json() as unknown;
    const models = parseProviderModelsResponse(body);
    return {
      source,
      models: models.length > 0 ? models : builtin,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (builtin.length > 0) {
      return { source: "builtin:media-models", models: builtin };
    }
    throw new HttpError(
      400,
      "network_failed",
      `Provider model discovery failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), [secret.value])}`,
    );
  }
}

function providerModelListInputToPreset(input: ProviderModelListRequest): ProviderPreset {
  return {
    id: "provider_model_probe",
    kind: input.kind,
    displayName: "Provider model probe",
    providerId: input.providerId,
    model: "model-probe",
    api: input.api,
    providerTransport: input.providerTransport,
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKey ? "__request_api_key__" : input.apiKeyRef,
    headers: input.headers ?? {},
    authHeader: input.authHeader ?? true,
    reasoning: false,
    input: ["text"],
    compat: {},
    capabilities: ["chat"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function resolveProviderModelListSecret(
  store: RunStore,
  preset: ProviderPreset,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): ResolvedSecret {
  if (input.apiKey) {
    return {
      ref: "__request_api_key__",
      configured: true,
      value: input.apiKey,
      status: {
        ref: "__request_api_key__",
        kind: "local",
        configured: true,
      },
    };
  }
  return preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
}

function buildProviderModelsUrl(preset: ProviderPreset): string {
  return `${normalizeProviderBaseUrl(preset)}/models`;
}

function normalizeProviderBaseUrl(preset: ProviderPreset): string {
  return normalizeProviderBaseUrlForAdapter(preset);
}

function buildProviderModelsHeaders(preset: ProviderPreset, secret: ResolvedSecret): Record<string, string> {
  const headers: Record<string, string> = { ...preset.headers };
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

async function providerModelListFailureMessage(response: Response, secret?: string): Promise<string> {
  const bodyText = redactTextWithSecrets(await readLimitedResponseText(response, 800), [secret]);
  return `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`;
}

function parseProviderModelsResponse(body: unknown): readonly ProviderModelOption[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const model = parseProviderModelOption(item);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
    if (models.length >= 200) {
      break;
    }
  }
  return models;
}

function parseProviderModelOption(value: unknown): ProviderModelOption | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string"
    ? value.id.trim()
    : typeof value.name === "string"
      ? value.name.trim()
      : "";
  if (!id) {
    return undefined;
  }
  return removeUndefined({
    id,
    displayName: typeof value.display_name === "string" ? value.display_name : typeof value.displayName === "string" ? value.displayName : undefined,
    ownedBy: typeof value.owned_by === "string" ? value.owned_by : typeof value.ownedBy === "string" ? value.ownedBy : undefined,
    createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
    api: typeof value.api === "string" && providerApis.includes(value.api as ProviderApi) ? value.api as ProviderApi : undefined,
    input: parseProviderModelStringArray(value.input, ["text", "image"]),
    capabilities: parseProviderModelStringArray(value.capabilities, providerCapabilities),
  });
}

function parseProviderModelStringArray<T extends string>(value: unknown, allowed: readonly T[]): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      continue;
    }
    result.push(item as T);
  }
  return result.length > 0 ? result : undefined;
}
