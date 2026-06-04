import {
  providerApis,
  providerCapabilities,
  providerKinds,
  type ProviderApi,
  type ProviderCapability,
  type ProviderKind,
  type ProviderModelListRequest,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
} from "@ling-stack/core";
import {
  isRecord,
  readNullableBoolean,
  readNullableNumber,
  readNullableString,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readOptionalStringRecord,
  readString,
  validateUrl,
} from "../../shared/validation.js";
import { isSupportedProviderApiKeyRef, localProviderSecretRef } from "./secrets.js";

interface ProviderPresetCreateRequest {
  readonly presetInput: ProviderPresetInput;
  readonly apiKey?: string;
}

interface ProviderPresetUpdateRequest {
  readonly updateInput: ProviderPresetUpdateInput;
  readonly apiKey?: string;
  readonly clearApiKey: boolean;
}

export function parseProviderPresetCreateRequest(value: unknown): ProviderPresetCreateRequest {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return {
    presetInput: parseProviderPresetInput(value),
    apiKey: readOptionalApiKey(value),
  };
}

export function parseProviderPresetUpdateRequest(value: unknown): ProviderPresetUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }
  const apiKey = readOptionalApiKey(value);
  const clearApiKey = readOptionalBoolean(value, "clearApiKey") ?? false;
  if (apiKey && clearApiKey) {
    throw new Error("apiKey and clearApiKey cannot both be provided");
  }
  return {
    updateInput: parseProviderPresetUpdateInput(value),
    apiKey,
    clearApiKey,
  };
}

export function parseProviderModelListRequest(value: unknown): ProviderModelListRequest {
  if (!isRecord(value)) {
    throw new Error("Provider model list request must be a JSON object");
  }
  return {
    kind: readProviderKind(value, "kind"),
    providerId: readString(value, "providerId"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    apiKey: readOptionalApiKey(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
  };
}

export function providerUpdateWithSecretRef(providerId: string, input: ProviderPresetUpdateRequest): ProviderPresetUpdateInput {
  if (input.apiKey) {
    return { ...input.updateInput, apiKeyRef: localProviderSecretRef(providerId) };
  }
  if (input.clearApiKey) {
    return { ...input.updateInput, apiKeyRef: null };
  }
  return input.updateInput;
}

export function validateProviderPresetUpdate(existing: ProviderPreset, input: ProviderPresetUpdateInput): void {
  validateProviderPresetShape({
    kind: input.kind ?? existing.kind,
    displayName: input.displayName ?? existing.displayName,
    providerId: input.providerId ?? existing.providerId,
    model: input.model ?? existing.model,
    api: input.api ?? existing.api,
    baseUrl: input.baseUrl === null ? undefined : input.baseUrl ?? existing.baseUrl,
    apiKeyRef: input.apiKeyRef === null ? undefined : input.apiKeyRef ?? existing.apiKeyRef,
    capabilities: input.capabilities ?? existing.capabilities,
  });
}

function parseProviderPresetInput(value: unknown): ProviderPresetInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return validateProviderPresetInput({
    kind: readProviderKind(value, "kind"),
    displayName: readString(value, "displayName"),
    providerId: readString(value, "providerId"),
    model: readString(value, "model"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(value, "contextWindow"),
    maxTokens: readOptionalNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  });
}

function parseProviderPresetUpdateInput(value: unknown): ProviderPresetUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }

  const input: ProviderPresetUpdateInput = {
    kind: value.kind === undefined ? undefined : readProviderKind(value, "kind"),
    displayName: readOptionalString(value, "displayName"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    api: value.api === undefined ? undefined : readProviderApi(value, "api"),
    baseUrl: readNullableString(value, "baseUrl"),
    apiKeyRef: readNullableApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readNullableBoolean(value, "authHeader"),
    reasoning: readNullableBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readNullableNumber(value, "contextWindow"),
    maxTokens: readNullableNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: value.capabilities === undefined ? undefined : readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  };

  return input;
}

function validateProviderPresetInput(input: ProviderPresetInput): ProviderPresetInput {
  validateProviderPresetShape(input);
  return input;
}

function validateProviderPresetShape(input: {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly capabilities?: readonly ProviderCapability[];
}): void {
  if (!input.displayName?.trim()) {
    throw new Error("displayName must be a non-empty string");
  }
  if (!input.providerId?.trim()) {
    throw new Error("providerId must be a non-empty string");
  }
  if (input.providerId && !/^[A-Za-z0-9._-]+$/.test(input.providerId)) {
    throw new Error("providerId may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!input.model?.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (input.kind === "openai-compatible" && !input.baseUrl) {
    throw new Error("baseUrl is required for openai-compatible providers");
  }
  if (input.baseUrl) {
    validateUrl(input.baseUrl, "baseUrl");
  }
  if (input.apiKeyRef && !isSupportedProviderApiKeyRef(input.apiKeyRef)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  if (!input.capabilities || input.capabilities.length === 0) {
    throw new Error("capabilities must contain at least one capability");
  }
  if (input.api === "media-job") {
    const hasMediaCapability = input.capabilities.some((capability) =>
      ["image_generate", "image_edit", "video_generate"].includes(capability),
    );
    if (!hasMediaCapability) {
      throw new Error("media-job providers must include a media capability");
    }
    return;
  }
  if (!input.capabilities.includes("chat")) {
    throw new Error("coding provider presets must include chat capability");
  }
}

function readOptionalApiKey(record: Record<string, unknown>): string | undefined {
  const value = record.apiKey;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("apiKey must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalApiKeyRef(record: Record<string, unknown>): string | undefined {
  const value = readOptionalString(record, "apiKeyRef");
  if (value && !isSupportedProviderApiKeyRef(value)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  return value;
}

function readNullableApiKeyRef(record: Record<string, unknown>): string | null | undefined {
  const value = readNullableString(record, "apiKeyRef");
  if (typeof value === "string" && !isSupportedProviderApiKeyRef(value)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  return value;
}

function readProviderKind(record: Record<string, unknown>, key: string): ProviderKind {
  const value = readString(record, key);
  if (!providerKinds.includes(value as ProviderKind)) {
    throw new Error(`${key} must be one of: ${providerKinds.join(", ")}`);
  }
  return value as ProviderKind;
}

function readProviderApi(record: Record<string, unknown>, key: string): ProviderApi {
  const value = readString(record, key);
  if (!providerApis.includes(value as ProviderApi)) {
    throw new Error(`${key} must be one of: ${providerApis.join(", ")}`);
  }
  return value as ProviderApi;
}

function readProviderCapabilities(record: Record<string, unknown>, key: string): ProviderCapability[] {
  return readOptionalStringArray(record, key, providerCapabilities)?.map((capability) => capability as ProviderCapability) ?? [];
}
