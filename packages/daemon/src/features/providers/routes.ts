import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  secretPurposes,
  type SecretPurpose,
  type SecretResolver,
  type ProviderPreset,
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
  parseProviderPresetCreateRequest,
  parseProviderPresetUpdateRequest,
  providerUpdateWithSecretRef,
  validateProviderPresetUpdate,
} from "./schemas.js";
import {
  createDraftProviderSecretResolver,
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
