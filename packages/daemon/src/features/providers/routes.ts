import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  secretPurposes,
  type SecretPurpose,
  type SecretResolver,
  type ProviderCapability,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
  type RunStore,
  enrichProviderModelOption,
  normalizeMediaProviderCompat,
  parseSecretRef,
} from "@ling-stack/core";
import type { ExternalSecretStore } from "../../context.js";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listProviderModels } from "./models.js";
import { checkProviderPreset } from "./preflight.js";
import { publishProviderCheckResult } from "./check-publication.js";
import type { ProviderImportPreflightService } from "./import-preflight.js";
import {
  formatProviderDeleteBlockedMessage,
  formatProviderReferenceBlockedMessage,
  inspectProviderReferences,
} from "./reference-inspector.js";
import { providerReferenceGuardAction } from "./provider-reference-guard.js";
import {
  parseProviderModelListRequest,
  parseProviderModelImportRequest,
  parseProviderPresetCreateRequest,
  parseProviderPresetUpdateRequest,
  providerUpdateWithSecretRef,
  validateProviderPresetUpdate,
} from "./schemas.js";
import {
  createDraftProviderSecretResolver,
  localProviderSecretRef,
  providerDraftInputToPreset,
  saveLocalProviderSecret,
  toProviderSecretResponse,
  toPublicProviderPreset,
} from "./secrets.js";

export function handleSecretStatus(response: ServerResponse, url: URL, secretResolver: SecretResolver): void {
  const ref = url.searchParams.get("ref");
  if (!ref) {
    writeJson(response, 400, { error: "bad_request", message: "ref query parameter is required" });
    return;
  }
  const purpose = readOptionalSecretPurposeQuery(url);
  if (purpose === null) {
    writeJson(response, 400, { error: "bad_request", message: "purpose is not supported" });
    return;
  }
  const status = secretResolver.status(ref, purpose);
  writeJson(response, 200, { status });
}

export async function handleProvidersCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd,
      providers: store.listProviderPresets().map((preset) => toPublicProviderPreset(store, preset, secretResolver)),
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseProviderPresetCreateRequest(body);
      const now = new Date().toISOString();
      const preset = store.createProviderPreset(providerPresetInputWithAutoMediaTransport(input.presetInput), now);
      const provider = input.apiKey ? saveLocalProviderSecret(store, preset, input.apiKey, now) : preset;
      appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, provider, now);
      writeJson(response, 201, { provider: toPublicProviderPreset(store, provider, secretResolver) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /providers` });
}

export async function handleProviderModelImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  controlPlaneEvents: ControlPlaneEventHub,
  providerImportPreflight: ProviderImportPreflightService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /providers/import-models` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseProviderModelImportRequest(body);
    const store = storeRegistry.getStore(cwd);
    const now = new Date().toISOString();
    const existingProviders = store.listProviderPresets();
    const imported: ProviderPreset[] = [];
    const warnings: string[] = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const rawModel of dedupeProviderImportModels(input.models)) {
      const model = enrichProviderModelOption(rawModel, {
        kind: input.kind,
        providerId: input.providerId,
        api: input.api,
      });
      const modelApi = model.api ?? input.api;
      const modelInput = model.input ?? input.input ?? ["text"];
      const modelThinkingModes = model.thinkingModes ?? input.thinkingModes ?? [];
      const modelReasoning = providerThinkingModesIncludeReasoning(modelThinkingModes);
      const modelCapabilities = providerCapabilitiesWithReasoning(model.capabilities ?? input.capabilities, modelReasoning);
      const modelContextWindow = model.contextWindow ?? input.contextWindow;
      const modelMaxTokens = model.maxTokens ?? input.maxTokens;
      const displayName = providerImportDisplayName(input.providerId, input.displayName, model);
      const existing = existingProviders.find((provider) =>
        provider.providerId === input.providerId &&
        provider.api === modelApi &&
        normalizeProviderImportEndpoint(provider.baseUrl) === normalizeProviderImportEndpoint(input.baseUrl) &&
        provider.model === model.id
      );

      if (existing) {
        const updated = store.updateProviderPreset(existing.id, {
          kind: input.kind,
          displayName,
          providerId: input.providerId,
          model: model.id,
          api: modelApi,
          providerTransport: input.providerTransport ?? null,
          baseUrl: input.baseUrl ?? null,
          apiKeyRef: input.apiKey ? localProviderSecretRef(existing.id) : input.apiKeyRef,
          headers: input.headers ?? existing.headers,
          secretHeaderRefs: input.secretHeaderRefs ?? existing.secretHeaderRefs,
          authHeader: input.authHeader ?? existing.authHeader,
	          reasoning: modelReasoning,
          thinkingModes: modelThinkingModes,
          input: modelInput,
          contextWindow: modelContextWindow ?? existing.contextWindow,
          maxTokens: modelMaxTokens ?? existing.maxTokens,
          compat: providerImportCompat(input.compat ?? existing.compat, model, {
            kind: input.kind,
            providerId: input.providerId,
            api: modelApi,
            input: modelInput,
            capabilities: modelCapabilities,
            thinkingModes: modelThinkingModes,
            contextWindow: modelContextWindow ?? existing.contextWindow,
            maxTokens: modelMaxTokens ?? existing.maxTokens,
          }),
          capabilities: modelCapabilities,
          enabled: input.enabled ?? existing.enabled,
        }, now);
        if (!updated) {
          warnings.push(`模型 ${model.id} 更新失败。`);
          continue;
        }
        if (input.apiKey) {
          store.setProviderSecret(updated.id, input.apiKey, now);
        }
        const checked = providerImportPreflight.enqueue(cwd, store, updated);
        imported.push(checked);
        updatedCount += 1;
        appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, checked, now);
        continue;
      }

      const created = store.createProviderPreset({
        kind: input.kind,
        displayName,
        providerId: input.providerId,
        model: model.id,
        api: modelApi,
        providerTransport: input.providerTransport,
        baseUrl: input.baseUrl,
        apiKeyRef: input.apiKey ? undefined : input.apiKeyRef,
        headers: input.headers,
        secretHeaderRefs: input.secretHeaderRefs,
        authHeader: input.authHeader,
        reasoning: modelReasoning,
        thinkingModes: modelThinkingModes,
        input: modelInput,
        contextWindow: modelContextWindow,
        maxTokens: modelMaxTokens,
        compat: providerImportCompat(input.compat, model, {
          kind: input.kind,
          providerId: input.providerId,
          api: modelApi,
          input: modelInput,
          capabilities: modelCapabilities,
          thinkingModes: modelThinkingModes,
          contextWindow: modelContextWindow,
          maxTokens: modelMaxTokens,
        }),
        capabilities: modelCapabilities,
        enabled: input.enabled,
      }, now);
      const provider = input.apiKey ? saveLocalProviderSecret(store, created, input.apiKey, now) : created;
      const checked = providerImportPreflight.enqueue(cwd, store, provider);
      imported.push(checked);
      existingProviders.push(checked);
      createdCount += 1;
      appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, checked, now);
    }

    writeJson(response, 200, {
      providers: imported.map((provider) => toPublicProviderPreset(store, provider, secretResolver)),
      createdCount,
      updatedCount,
      warnings,
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function providerThinkingModesIncludeReasoning(thinkingModes: readonly string[]): boolean {
  return thinkingModes.some((mode) => mode !== "off");
}

function providerPresetInputWithAutoMediaTransport(input: ProviderPresetInput): ProviderPresetInput {
  return {
    ...input,
    compat: providerCompatWithAutoMediaTransport(input.compat, {
      kind: input.kind,
      providerId: input.providerId,
      modelId: input.model,
      api: input.api,
      capabilities: input.capabilities,
    }),
  };
}

function providerPresetUpdateWithAutoMediaTransport(
  existing: ProviderPreset,
  input: ProviderPresetUpdateInput,
): ProviderPresetUpdateInput {
  const resolved = {
    kind: input.kind ?? existing.kind,
    providerId: input.providerId ?? existing.providerId,
    modelId: input.model ?? existing.model,
    api: input.api ?? existing.api,
    capabilities: input.capabilities ?? existing.capabilities,
  };
  return {
    ...input,
    compat: providerCompatWithAutoMediaTransport(input.compat ?? existing.compat, resolved),
  };
}

function providerCompatWithAutoMediaTransport(
  compat: Record<string, unknown> | undefined,
  input: {
    readonly kind?: ProviderPreset["kind"];
    readonly providerId?: string;
    readonly modelId?: string;
    readonly api?: ProviderPreset["api"];
    readonly capabilities?: readonly string[];
  },
): Record<string, unknown> | undefined {
  return normalizeMediaProviderCompat({ ...input, compat });
}

function providerCapabilitiesWithReasoning(capabilities: readonly ProviderCapability[], reasoning: boolean): readonly ProviderCapability[] {
  if (!reasoning || capabilities.includes("reasoning")) {
    return capabilities;
  }
  return [...capabilities, "reasoning"];
}

function providerImportCompat(
  compat: Record<string, unknown> | undefined,
  model: {
    readonly id: string;
    readonly displayName?: string;
    readonly ownedBy?: string;
    readonly createdAt?: string;
    readonly supportedParameters?: readonly string[];
    readonly thinkingSupport?: unknown;
    readonly capabilitySource?: string;
    readonly capabilityConfidence?: string;
  },
  resolved: {
    readonly kind: ProviderPreset["kind"];
    readonly providerId: string;
    readonly api: string;
    readonly input: readonly string[];
    readonly capabilities: readonly string[];
    readonly thinkingModes: readonly string[];
    readonly contextWindow?: number;
    readonly maxTokens?: number;
  },
): Record<string, unknown> | undefined {
  const modelMetadata = removeUndefined({
    id: model.id,
    displayName: model.displayName,
    ownedBy: model.ownedBy,
    createdAt: model.createdAt,
    api: resolved.api,
    input: resolved.input,
    capabilities: resolved.capabilities,
    thinkingModes: resolved.thinkingModes,
    thinkingSupport: model.thinkingSupport,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    supportedParameters: model.supportedParameters,
    capabilitySource: model.capabilitySource,
    capabilityConfidence: model.capabilityConfidence,
  });
  if (!compat && Object.keys(modelMetadata).length === 0) {
    return undefined;
  }
  const baseCompat = {
    ...(compat ?? {}),
    modelMetadata,
  };
  return normalizeMediaProviderCompat({
    kind: resolved.kind,
    providerId: resolved.providerId,
    modelId: model.id,
    api: resolved.api as ProviderPreset["api"],
    capabilities: resolved.capabilities,
    compat: baseCompat,
  }) ?? baseCompat;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function readOptionalSecretPurposeQuery(url: URL): SecretPurpose | null | undefined {
  const value = url.searchParams.get("purpose");
  if (value === null) {
    return undefined;
  }
  if (!secretPurposes.includes(value as SecretPurpose)) {
    return null;
  }
  return value as SecretPurpose;
}

function parseProviderKeychainSecretConfigureRequest(value: unknown): {
  readonly secretRef: string;
  readonly apiKey: string;
  readonly clearLocalSecret?: boolean;
} {
  if (!isRecord(value)) {
    throw new Error("provider secret configure request must be a JSON object");
  }
  const secretRef = readRequiredString(value, "secretRef");
  const apiKey = readRequiredString(value, "apiKey");
  const clearLocalSecret = readOptionalBooleanValue(value, "clearLocalSecret");
  return { secretRef, apiKey, clearLocalSecret };
}

function parseProviderKeychainSecretDeleteRequest(value: unknown | undefined): {
  readonly secretRef?: string;
} {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("provider secret delete request must be a JSON object");
  }
  const secretRef = readOptionalStringValue(value, "secretRef");
  return secretRef ? { secretRef } : {};
}

function assertKeychainSecretRef(secretRef: string): void {
  const parsed = parseSecretRef(secretRef);
  if (parsed.kind !== "keychain") {
    throw new Error("Provider keychain secret setup only supports keychain: refs.");
  }
}

function providerSecretStatusHttpStatus(errorCode: string | undefined): number {
  if (errorCode === "secret_store_unavailable") {
    return 501;
  }
  if (errorCode === "secret_access_denied") {
    return 403;
  }
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalBooleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

export async function handleProviderDraftCheck(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /provider-check` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseProviderPresetCreateRequest(body);
    const store = storeRegistry.getStore(cwd);
    const preset = providerDraftInputToPreset(providerPresetInputWithAutoMediaTransport(input.presetInput), input.apiKey, new Date().toISOString());
    const resolver = input.apiKey ? createDraftProviderSecretResolver(secretResolver, input.apiKey) : secretResolver;
    const result = await checkProviderPreset(store, preset, resolver);
    if (!result.ok && result.code === "bad_request") {
      writeJson(response, 400, { error: "bad_request", message: result.message });
      return;
    }
    writeJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleProviderItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
  controlPlaneEvents: ControlPlaneEventHub,
  route: {
    readonly providerId: string;
    readonly action?: "check" | "secret" | "configure-keychain-secret" | "delete-keychain-secret";
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const preset = store.getProviderPreset(route.providerId);
  if (!preset) {
    writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
    return;
  }

  if (request.method === "POST" && route.action === "check") {
    const admission = store.beginProviderCheckRequest(route.providerId, "manual");
    if (!admission) {
      writeJson(response, 404, { error: "provider_not_found", message: "Provider preset no longer exists." });
      return;
    }
    const checkResult = await checkProviderPreset(store, admission.provider, secretResolver);
    const publication = publishProviderCheckResult(store, controlPlaneEvents, admission.ticket, checkResult, cwd);
    if (publication.status !== "published") {
      writeJson(response, 409, { error: "provider_check_result_superseded",
        message: "Provider check result was superseded. Check the current provider again.", reason: publication.status });
      return;
    }
    writeJson(response, 200, publication.provider.lastCheck);
    return;
  }

  if (request.method === "GET" && route.action === "secret") {
    writeJson(response, 200, toProviderSecretResponse(store, preset));
    return;
  }

  if (request.method === "POST" && route.action === "configure-keychain-secret") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseProviderKeychainSecretConfigureRequest(body);
      assertKeychainSecretRef(input.secretRef);
      const status = externalSecretStore.setSecret(input.secretRef, input.apiKey, "provider_api_key");
      if (!status.configured) {
        writeJson(response, providerSecretStatusHttpStatus(status.errorCode), {
          error: status.errorCode ?? "provider_secret_store_unavailable",
          message: status.message ?? `Could not save provider secret: ${input.secretRef}`,
          status,
        });
        return;
      }
      const now = new Date().toISOString();
      const updated = store.updateProviderPreset(route.providerId, { apiKeyRef: input.secretRef }, now) ?? preset;
      if (input.clearLocalSecret !== false) {
        store.deleteProviderSecret(route.providerId);
      }
      appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, updated, now);
      writeJson(response, 200, {
        provider: toPublicProviderPreset(store, updated, secretResolver),
        secretRef: input.secretRef,
        status,
      });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.method === "DELETE" && route.action === "delete-keychain-secret") {
    try {
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parseProviderKeychainSecretDeleteRequest(body);
      const secretRef = input.secretRef ?? preset.apiKeyRef;
      if (!secretRef) {
        writeJson(response, 400, { error: "bad_request", message: "Provider does not have a keychain secret ref." });
        return;
      }
      assertKeychainSecretRef(secretRef);
      if (preset.apiKeyRef === secretRef) {
        const inspection = inspectProviderReferences(store, route.providerId);
        if (!inspection.canDelete) {
          writeJson(response, 409, {
            error: "provider_secret_delete_blocked",
            message: formatProviderReferenceBlockedMessage(inspection, "credential removed"),
            blockers: inspection.blockers,
          });
          return;
        }
      }
      const status = externalSecretStore.deleteSecret(secretRef, "provider_api_key");
      if (status.errorCode === "secret_access_denied" || status.errorCode === "secret_store_unavailable" || status.errorCode === "invalid_secret_ref") {
        writeJson(response, providerSecretStatusHttpStatus(status.errorCode), {
          error: status.errorCode,
          message: status.message ?? `Could not delete provider secret: ${secretRef}`,
          status,
        });
        return;
      }
      const now = new Date().toISOString();
      const updated = preset.apiKeyRef === secretRef
        ? store.updateProviderPreset(route.providerId, { apiKeyRef: null }, now) ?? preset
        : preset;
      appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, updated, now);
      writeJson(response, 200, {
        provider: toPublicProviderPreset(store, updated, secretResolver),
        secretRef,
        status,
      });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (route.action) {
    writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, { provider: toPublicProviderPreset(store, preset, secretResolver) });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseProviderPresetUpdateRequest(body);
      const updateInput = providerPresetUpdateWithAutoMediaTransport(
        preset,
        providerUpdateWithSecretRef(route.providerId, input),
      );
      validateProviderPresetUpdate(preset, updateInput);
      const guardAction = providerReferenceGuardAction(preset, updateInput);
      if (guardAction) {
        const inspection = inspectProviderReferences(store, route.providerId);
        if (!inspection.canDelete) {
          const action = guardAction === "disable"
            ? "disabled"
            : guardAction === "remove_secret"
              ? "credential removed"
              : "changed";
          writeJson(response, 409, {
            error: "provider_update_blocked",
            message: formatProviderReferenceBlockedMessage(inspection, action),
            blockers: inspection.blockers,
          });
          return;
        }
      }
      const now = new Date().toISOString();
      const updated = store.updateProviderPreset(route.providerId, updateInput, now);
      if (!updated) {
        writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
        return;
      }
      if (input.apiKey) {
        store.setProviderSecret(route.providerId, input.apiKey, now);
      }
      if (input.clearApiKey) {
        store.deleteProviderSecret(route.providerId);
      }
      appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, updated, now);
      writeJson(response, 200, { provider: toPublicProviderPreset(store, updated, secretResolver) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    const inspection = inspectProviderReferences(store, route.providerId);
    if (!inspection.canDelete) {
      writeJson(response, 409, {
        error: "provider_delete_blocked",
        message: formatProviderDeleteBlockedMessage(inspection),
        blockers: inspection.blockers,
      });
      return;
    }
    const now = new Date().toISOString();
    store.deleteProviderSecret(route.providerId);
    store.deleteProviderPreset(route.providerId);
    appendProviderUpdatedEvent(store, controlPlaneEvents, cwd, { ...preset, enabled: false }, now);
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for provider presets` });
}

function appendProviderUpdatedEvent(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  controlPlaneEvents: ControlPlaneEventHub,
  cwd: string,
  provider: Pick<ProviderPreset, "id" | "enabled" | "kind" | "api">,
  now: string,
): void {
  appendControlPlaneEvent(store, controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "providers",
    entityType: "provider",
    entityId: provider.id,
    action: "provider.updated",
    data: {
      providerId: provider.id,
      enabled: provider.enabled,
      kind: provider.kind,
      api: provider.api,
    },
  }, now);
}

function dedupeProviderImportModels<T extends { readonly id: string }>(models: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const model of models) {
    const key = model.id.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(model);
  }
  return result;
}

function normalizeProviderImportEndpoint(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function providerImportDisplayName(
  providerId: string,
  providerDisplayName: string,
  model: { readonly id: string; readonly displayName?: string },
): string {
  const modelName = model.displayName?.trim() || model.id;
  if (providerId === "custom-openai-compatible") return model.id;
  return `${providerDisplayName.trim()} · ${modelName}`;
}

export async function handleProviderModelsProbe(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /provider-models` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseProviderModelListRequest(body);
    const store = storeRegistry.getStore(cwd);
    const result = await listProviderModels(store, input, secretResolver);
    writeJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
