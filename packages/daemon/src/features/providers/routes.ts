import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  secretPurposes,
  type SecretPurpose,
  type SecretResolver,
  type ProviderPreset,
  type RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listProviderModels } from "./models.js";
import { checkProviderPreset } from "./preflight.js";
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
      const preset = store.createProviderPreset(input.presetInput, now);
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

    for (const model of dedupeProviderImportModels(input.models)) {
      const modelApi = model.api ?? input.api;
      const modelCapabilities = model.capabilities ?? input.capabilities;
      const modelInput = model.input ?? input.input ?? ["text"];
      const displayName = providerImportDisplayName(input.displayName, model);
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
          authHeader: input.authHeader ?? existing.authHeader,
          reasoning: input.reasoning ?? existing.reasoning,
          input: modelInput,
          contextWindow: input.contextWindow ?? existing.contextWindow,
          maxTokens: input.maxTokens ?? existing.maxTokens,
          compat: input.compat ?? existing.compat,
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
        const checked = await checkImportedProviderPreset(store, updated, secretResolver, cwd, controlPlaneEvents);
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
        authHeader: input.authHeader,
        reasoning: input.reasoning,
        input: modelInput,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
        compat: input.compat,
        capabilities: modelCapabilities,
        enabled: input.enabled,
      }, now);
      const provider = input.apiKey ? saveLocalProviderSecret(store, created, input.apiKey, now) : created;
      const checked = await checkImportedProviderPreset(store, provider, secretResolver, cwd, controlPlaneEvents);
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

async function checkImportedProviderPreset(
  store: RunStore,
  provider: ProviderPreset,
  secretResolver: SecretResolver,
  cwd: string,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<ProviderPreset> {
  if (provider.api === "media-job") {
    return provider;
  }
  const checkResult = await checkProviderPreset(store, provider, secretResolver);
  const checked = store.recordProviderCheckResult(provider.id, checkResult) ?? provider;
  appendControlPlaneEvent(store, controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "providers",
    entityType: "provider",
    entityId: provider.id,
    action: "provider.preflight_checked",
    data: {
      providerId: provider.id,
      ok: checkResult.ok,
      code: checkResult.code ?? (checkResult.ok ? "ok" : "failed"),
      checkedAt: checkResult.checkedAt,
    },
  });
  return checked;
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
    const preset = providerDraftInputToPreset(input.presetInput, input.apiKey, new Date().toISOString());
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
  controlPlaneEvents: ControlPlaneEventHub,
  route: { readonly providerId: string; readonly action?: "check" | "secret" },
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
    const checkResult = await checkProviderPreset(store, preset, secretResolver);
    store.recordProviderCheckResult(route.providerId, checkResult);
    appendControlPlaneEvent(store, controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "providers",
      entityType: "provider",
      entityId: route.providerId,
      action: "provider.preflight_checked",
      data: {
        providerId: route.providerId,
        ok: checkResult.ok,
        code: checkResult.code ?? (checkResult.ok ? "ok" : "failed"),
        checkedAt: checkResult.checkedAt,
      },
    });
    writeJson(response, 200, checkResult);
    return;
  }

  if (request.method === "GET" && route.action === "secret") {
    writeJson(response, 200, toProviderSecretResponse(store, preset));
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
      const updateInput = providerUpdateWithSecretRef(route.providerId, input);
      validateProviderPresetUpdate(preset, updateInput);
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

function providerImportDisplayName(providerDisplayName: string, model: { readonly id: string; readonly displayName?: string }): string {
  const modelName = model.displayName?.trim() || model.id;
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
