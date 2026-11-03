import {
  providerApis,
  providerCapabilities,
  providerKinds,
  providerThinkingModes,
  providerTransports,
  isSupportedSecretRef,
  type ProviderApi,
  type ProviderCapability,
  type ProviderKind,
  type ProviderModelImportRequest,
  type ProviderModelOption,
  type ProviderModelOptionCapabilityConfidence,
  type ProviderModelOptionCapabilitySource,
  type ProviderThinkingSupport,
  type ProviderThinkingMode,
  type ProviderTransport,
  type ProviderModelListRequest,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
} from "@ling-stack/core";
import {
  isRecord,
  readNullableBoolean,
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
  const apiKey = readOptionalApiKey(value);
  const presetInput = parseProviderPresetInput(value);
  validateProviderSecretHeaderShape({ ...presetInput, hasApiKey: Boolean(apiKey) });
  return {
    presetInput,
    apiKey,
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
  const updateInput = parseProviderPresetUpdateInput(value);
  validateProviderSecretHeaderShape({ ...updateInput, hasApiKey: Boolean(apiKey) });
  return {
    updateInput,
    apiKey,
    clearApiKey,
  };
}

export function parseProviderModelListRequest(value: unknown): ProviderModelListRequest {
  if (!isRecord(value)) {
    throw new Error("Provider model list request must be a JSON object");
  }
  const request: ProviderModelListRequest = {
    providerPresetId: readOptionalString(value, "providerPresetId"),
    kind: readProviderKind(value, "kind"),
    providerId: readString(value, "providerId"),
    api: readProviderApi(value, "api"),
    providerTransport: readOptionalProviderTransport(value, "providerTransport"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    apiKey: readOptionalApiKey(value),
    headers: readOptionalStringRecord(value, "headers"),
    secretHeaderRefs: readOptionalSecretHeaderRefs(value, "secretHeaderRefs"),
    authHeader: readOptionalBoolean(value, "authHeader"),
  };
  validateProviderSecretHeaderShape({ ...request, hasApiKey: Boolean(request.apiKey) });
  return request;
}

export function parseProviderModelImportRequest(value: unknown): ProviderModelImportRequest {
  if (!isRecord(value)) {
    throw new Error("Provider model import request must be a JSON object");
  }
  const modelsValue = value.models;
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    throw new Error("models must contain at least one model");
  }
  const request: ProviderModelImportRequest = {
    kind: readProviderKind(value, "kind"),
    displayName: readString(value, "displayName"),
    providerId: readString(value, "providerId"),
    api: readProviderApi(value, "api"),
    providerTransport: readOptionalProviderTransport(value, "providerTransport"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    apiKey: readOptionalApiKey(value),
    headers: readOptionalStringRecord(value, "headers"),
    secretHeaderRefs: readOptionalSecretHeaderRefs(value, "secretHeaderRefs"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    thinkingModes: readProviderThinkingModes(value, "thinkingModes"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalPositiveInteger(value, "contextWindow"),
    maxTokens: readOptionalPositiveInteger(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
    models: modelsValue.map((model, index) => parseProviderImportModel(model, index)),
  };
  for (const model of request.models) {
    validateProviderPresetShape({
      kind: request.kind,
      displayName: providerModelDisplayName(request.providerId, request.displayName, model),
      providerId: request.providerId,
      model: model.id,
      api: model.api ?? request.api,
      baseUrl: request.baseUrl,
      apiKeyRef: request.apiKeyRef,
      secretHeaderRefs: request.secretHeaderRefs,
      headers: request.headers,
      authHeader: request.authHeader,
      hasApiKey: Boolean(request.apiKey),
      capabilities: model.capabilities ?? request.capabilities,
      contextWindow: model.contextWindow ?? request.contextWindow,
      maxTokens: model.maxTokens ?? request.maxTokens,
    });
  }
  return request;
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
    headers: input.headers ?? existing.headers,
    secretHeaderRefs: input.secretHeaderRefs ?? existing.secretHeaderRefs,
    authHeader: input.authHeader === null ? undefined : input.authHeader ?? existing.authHeader,
    contextWindow: input.contextWindow === null ? undefined : input.contextWindow ?? existing.contextWindow,
    maxTokens: input.maxTokens === null ? undefined : input.maxTokens ?? existing.maxTokens,
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
    providerTransport: readOptionalProviderTransport(value, "providerTransport"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    secretHeaderRefs: readOptionalSecretHeaderRefs(value, "secretHeaderRefs"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    thinkingModes: readProviderThinkingModes(value, "thinkingModes"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalPositiveInteger(value, "contextWindow"),
    maxTokens: readOptionalPositiveInteger(value, "maxTokens"),
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
    providerTransport: value.providerTransport === undefined ? undefined : readNullableProviderTransport(value, "providerTransport"),
    baseUrl: readNullableString(value, "baseUrl"),
    apiKeyRef: readNullableApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    secretHeaderRefs: readOptionalSecretHeaderRefs(value, "secretHeaderRefs"),
    authHeader: readNullableBoolean(value, "authHeader"),
    reasoning: readNullableBoolean(value, "reasoning"),
    thinkingModes: value.thinkingModes === undefined ? undefined : readProviderThinkingModes(value, "thinkingModes"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: value.contextWindow === null ? null : readOptionalPositiveInteger(value, "contextWindow"),
    maxTokens: value.maxTokens === null ? null : readOptionalPositiveInteger(value, "maxTokens"),
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

/** Validate the final token pair after catalog enrichment and saved-value inheritance. */
export function validateProviderTokenBudget(input: {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}): void {
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  if (input.contextWindow !== undefined && input.maxTokens !== undefined && input.maxTokens >= input.contextWindow) {
    throw new Error("maxTokens must be less than contextWindow");
  }
}

function validateProviderPresetShape(input: {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly hasApiKey?: boolean;
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly authHeader?: boolean | null;
  readonly capabilities?: readonly ProviderCapability[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}): void {
  validateProviderTokenBudget(input);
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
  validateProviderSecretHeaderShape(input);
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

function validateProviderSecretHeaderShape(input: {
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly apiKeyRef?: string | null;
  readonly hasApiKey?: boolean;
  readonly authHeader?: boolean | null;
}): void {
  const staticHeaderNames = new Set(Object.keys(input.headers ?? {}).map(normalizeHeaderName));
  for (const [headerName, ref] of Object.entries(input.secretHeaderRefs ?? {})) {
    const normalizedHeaderName = normalizeHeaderName(headerName);
    if (!normalizedHeaderName) {
      throw new Error("secretHeaderRefs header names must be non-empty");
    }
    if (staticHeaderNames.has(normalizedHeaderName)) {
      throw new Error(`Header ${headerName} cannot be configured as both a static and secret header`);
    }
    if (!isSupportedSecretRef(ref)) {
      throw new Error("secretHeaderRefs values must use env:NAME or keychain:NAME");
    }
    if (normalizedHeaderName === "authorization" && input.authHeader !== false && (input.apiKeyRef || input.hasApiKey)) {
      throw new Error("Authorization secret header requires authHeader=false when API key auth is configured");
    }
  }
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

function parseProviderImportModel(value: unknown, index: number): ProviderModelOption {
  if (!isRecord(value)) {
    throw new Error(`models[${index}] must be an object`);
  }
  const id = readString(value, "id").trim();
  if (!id) {
    throw new Error(`models[${index}].id must be a non-empty string`);
  }
  return {
    id,
    displayName: readOptionalString(value, "displayName"),
    ownedBy: readOptionalString(value, "ownedBy"),
    createdAt: readOptionalString(value, "createdAt"),
    api: value.api === undefined ? undefined : readProviderApi(value, "api"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    capabilities: value.capabilities === undefined ? undefined : readProviderCapabilities(value, "capabilities"),
    thinkingModes: value.thinkingModes === undefined ? undefined : readProviderThinkingModes(value, "thinkingModes"),
    thinkingSupport: readProviderThinkingSupport(value, "thinkingSupport"),
    contextWindow: readOptionalPositiveInteger(value, "contextWindow"),
    maxTokens: readOptionalPositiveInteger(value, "maxTokens"),
    supportedParameters: readOptionalStringArray(value, "supportedParameters"),
    capabilitySource: readProviderModelOptionCapabilitySource(value, "capabilitySource"),
    capabilityConfidence: readProviderModelOptionCapabilityConfidence(value, "capabilityConfidence"),
  };
}

function providerModelDisplayName(
  providerId: string,
  providerDisplayName: string,
  model: Pick<ProviderModelOption, "displayName" | "id">,
): string {
  const modelName = model.displayName?.trim() || model.id;
  if (providerId === "custom-openai-compatible") return model.id;
  return `${providerDisplayName.trim()} · ${modelName}`;
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

function readOptionalSecretHeaderRefs(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = readOptionalStringRecord(record, key);
  if (value === undefined) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([headerName, ref]) => [headerName.trim(), ref.trim()] as const)
    .filter(([headerName, ref]) => headerName.length > 0 || ref.length > 0);
  const result: Record<string, string> = {};
  for (const [headerName, ref] of entries) {
    if (!headerName) {
      throw new Error("secretHeaderRefs header names must be non-empty");
    }
    if (!ref) {
      throw new Error("secretHeaderRefs values must be non-empty");
    }
    result[headerName] = ref;
  }
  return result;
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

function readOptionalProviderTransport(record: Record<string, unknown>, key: string): ProviderTransport | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!providerTransports.includes(value as ProviderTransport)) {
    throw new Error(`${key} must be one of: ${providerTransports.join(", ")}`);
  }
  return value as ProviderTransport;
}

function readNullableProviderTransport(record: Record<string, unknown>, key: string): ProviderTransport | null {
  const value = readNullableString(record, key);
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return null;
  }
  if (!providerTransports.includes(value as ProviderTransport)) {
    throw new Error(`${key} must be one of: ${providerTransports.join(", ")}`);
  }
  return value as ProviderTransport;
}

function readProviderCapabilities(record: Record<string, unknown>, key: string): ProviderCapability[] {
  return readOptionalStringArray(record, key, providerCapabilities)?.map((capability) => capability as ProviderCapability) ?? [];
}

function readProviderThinkingModes(record: Record<string, unknown>, key: string): ProviderThinkingMode[] {
  return readOptionalStringArray(record, key, providerThinkingModes)?.map((mode) => mode as ProviderThinkingMode) ?? [];
}

function readProviderThinkingSupport(record: Record<string, unknown>, key: string): ProviderThinkingSupport | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const levels = readProviderThinkingModes(value, "levels");
  return {
    levels,
    minTokens: readOptionalPositiveInteger(value, "minTokens"),
    maxTokens: readOptionalPositiveInteger(value, "maxTokens"),
    zeroAllowed: readOptionalBoolean(value, "zeroAllowed"),
    dynamicAllowed: readOptionalBoolean(value, "dynamicAllowed"),
  };
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return value;
}

function readProviderModelOptionCapabilitySource(
  record: Record<string, unknown>,
  key: string,
): ProviderModelOptionCapabilitySource | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  const allowed: readonly ProviderModelOptionCapabilitySource[] = [
    "upstream",
    "model_catalog",
    "provider_template",
    "user_override",
    "conservative_default",
  ];
  if (!allowed.includes(value as ProviderModelOptionCapabilitySource)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as ProviderModelOptionCapabilitySource;
}

function readProviderModelOptionCapabilityConfidence(
  record: Record<string, unknown>,
  key: string,
): ProviderModelOptionCapabilityConfidence | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  const allowed: readonly ProviderModelOptionCapabilityConfidence[] = ["known", "estimated", "conservative"];
  if (!allowed.includes(value as ProviderModelOptionCapabilityConfidence)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as ProviderModelOptionCapabilityConfidence;
}
