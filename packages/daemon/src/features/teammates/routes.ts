import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_WORKSPACE_ID, buildEffectiveTeammateSkills, resolveEffectiveTeammateProviderPresetId, type RunStore, type SecretResolver } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listExecutableSkillDefinitions, validateTeammateSkillBindings } from "../skills/registry.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { readOptionalTaskStatusQuery } from "../tasks/schemas.js";
import { buildTeammateActivityItems } from "./activity.js";
import { assertRunnableConversationProvider } from "../providers/conversation-model-validation.js";
import { validateTeammateModelUpdate } from "./model-binding-validation.js";
import {
  parseAiTeammateUpdateInput,
  parseCreateAiTeammateInput,
  parseReplaceTeammateChannelMembershipsRequest,
  parseReplaceTeammateMcpBindingsRequest,
  parseReplaceTeammateMemoryScopesRequest,
  parseReplaceTeammateSkillBindingsRequest,
  parseTeammatePersonaDraft,
} from "./schemas.js";

export async function handleTeammatesCollection(
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

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammates: store.listAiTeammates({
          includeHidden: url.searchParams.get("includeHidden") === "true",
          includeDisabled: url.searchParams.get("includeDisabled") === "true",
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateAiTeammateInput(body);
      const providerPresetId = assertRunnableConversationProvider({
        store,
        cwd,
        providerPresetId: input.providerPresetId,
        secretResolver,
        ownerLabel: "AI teammate",
      });
      const teammate = store.createAiTeammate({
        ...input,
        modelBindingMode: "fixed",
        providerPresetId,
      }, new Date().toISOString());
      writeJson(response, 201, { teammate });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /teammates` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { teammate });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = validateTeammateModelUpdate({
        store,
        cwd,
        teammate,
        update: parseAiTeammateUpdateInput(body),
        secretResolver,
      });
      const updated = store.updateAiTeammate(teammateId, input, new Date().toISOString());
      writeJson(response, 200, { teammate: updated });
      return;
    }
    if (request.method === "DELETE") {
      const disabled = store.disableAiTeammate(teammateId, new Date().toISOString());
      writeJson(response, 200, { teammate: disabled });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateChannelMemberships(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        memberships: store.listTeammateChannelMemberships(teammateId),
      });
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const memberships = store.replaceTeammateChannelMemberships(
        teammateId,
        parseReplaceTeammateChannelMembershipsRequest(body),
        new Date().toISOString(),
      );
      writeJson(response, 200, { cwd, teammateId, memberships });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate channels` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateMemoryScopes(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  controlPlaneEvents?: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        scopes: store.listTeammateMemoryScopes(teammateId),
      });
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const before = store.listTeammateMemoryScopes(teammateId).map((scope) => ({
        key: `${scope.kind}:${scope.channelId ?? ""}`,
        enabled: scope.enabled,
      }));
      const now = new Date().toISOString();
      const scopes = store.replaceTeammateMemoryScopes(
        teammateId,
        parseReplaceTeammateMemoryScopesRequest(body),
        now,
      );
      appendTeammateBindingChangeControlPlaneEvent(
        store,
        controlPlaneEvents,
        cwd,
        teammateId,
        "teammate.memory_scopes_changed",
        summarizeBindingChange(before, scopes.map((scope) => ({
          key: `${scope.kind}:${scope.channelId ?? ""}`,
          enabled: scope.enabled,
        }))),
        now,
      );
      writeJson(response, 200, { cwd, teammateId, scopes });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate memory scopes` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateSkillBindings(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  controlPlaneEvents?: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "GET") {
      const channelId = url.searchParams.get("channelId") ?? undefined;
      const channel = channelId ? store.getChannel(channelId) : undefined;
      const providerPresetId = resolveEffectiveTeammateProviderPresetId({
        teammate,
        surface: channel ? "channel" : "private",
        workspaceDefaultProviderPresetId: store.getWorkspaceSettings().defaultProviderPresetId,
        channelDefaultProviderPresetId: channel?.defaultProviderPresetId,
      });
      const providerPreset = providerPresetId ? store.getProviderPreset(providerPresetId) : undefined;
      const bindings = store.listTeammateSkillBindings(teammateId);
      writeJson(response, 200, {
        cwd,
        teammateId,
        bindings,
        effectiveSkills: buildEffectiveTeammateSkills({
          teammate,
          bindings,
          skills: listExecutableSkillDefinitions(store),
          channelAllowedTools: channel?.allowedTools,
          providerCapabilities: providerPreset?.capabilities,
        }),
      });
      return;
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const nextBindings = parseReplaceTeammateSkillBindingsRequest(body);
      validateTeammateSkillBindings(store, teammateId, nextBindings);
      const before = store.listTeammateSkillBindings(teammateId).map((binding) => ({
        key: binding.skillId,
        enabled: binding.enabled,
      }));
      const now = new Date().toISOString();
      const bindings = store.replaceTeammateSkillBindings(
        teammateId,
        nextBindings,
        now,
      );
      appendTeammateBindingChangeControlPlaneEvent(
        store,
        controlPlaneEvents,
        cwd,
        teammateId,
        "teammate.skills_changed",
        summarizeBindingChange(before, bindings.map((binding) => ({
          key: binding.skillId,
          enabled: binding.enabled,
        }))),
        now,
      );
      const channelId = url.searchParams.get("channelId") ?? undefined;
      const channel = channelId ? store.getChannel(channelId) : undefined;
      const providerPresetId = resolveEffectiveTeammateProviderPresetId({
        teammate,
        surface: channel ? "channel" : "private",
        workspaceDefaultProviderPresetId: store.getWorkspaceSettings().defaultProviderPresetId,
        channelDefaultProviderPresetId: channel?.defaultProviderPresetId,
      });
      const providerPreset = providerPresetId ? store.getProviderPreset(providerPresetId) : undefined;
      writeJson(response, 200, {
        cwd,
        teammateId,
        bindings,
        effectiveSkills: buildEffectiveTeammateSkills({
          teammate,
          bindings,
          skills: listExecutableSkillDefinitions(store),
          channelAllowedTools: channel?.allowedTools,
          providerCapabilities: providerPreset?.capabilities,
        }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate skills` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateMcpBindings(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  controlPlaneEvents?: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        bindings: store.listTeammateMcpBindings(teammateId),
      });
      return;
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const before = store.listTeammateMcpBindings(teammateId).map((binding) => ({
        key: binding.serverId,
        enabled: binding.enabled,
      }));
      const now = new Date().toISOString();
      const bindings = store.replaceTeammateMcpBindings(
        teammateId,
        parseReplaceTeammateMcpBindingsRequest(body),
        now,
      );
      appendTeammateBindingChangeControlPlaneEvent(
        store,
        controlPlaneEvents,
        cwd,
        teammateId,
        "teammate.mcp_bindings_changed",
        summarizeBindingChange(before, bindings.map((binding) => ({
          key: binding.serverId,
          enabled: binding.enabled,
        }))),
        now,
      );
      writeJson(response, 200, { cwd, teammateId, bindings });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate mcp` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function summarizeBindingChange(
  before: readonly { readonly key: string; readonly enabled: boolean }[],
  after: readonly { readonly key: string; readonly enabled: boolean }[],
): { readonly added: number; readonly removed: number; readonly disabled: number; readonly enabled: number } {
  const beforeKeys = new Set(before.map((item) => item.key));
  const afterKeys = new Set(after.map((item) => item.key));
  return {
    added: after.filter((item) => !beforeKeys.has(item.key)).length,
    removed: before.filter((item) => !afterKeys.has(item.key)).length,
    disabled: after.filter((item) => !item.enabled).length,
    enabled: after.filter((item) => item.enabled).length,
  };
}

function appendTeammateBindingChangeControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  teammateId: string,
  action: "teammate.skills_changed" | "teammate.memory_scopes_changed" | "teammate.mcp_bindings_changed",
  counts: { readonly added: number; readonly removed: number; readonly disabled: number; readonly enabled: number },
  now: string,
): void {
  if (!hub) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "teammates",
    entityType: "teammate",
    entityId: teammateId,
    action,
    data: {
      teammateId,
      ...counts,
    },
  }, now);
}

export async function handleTeammatePersonaDraft(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      writeJson(response, 200, {
        cwd,
        teammateId,
        draft: parseTeammatePersonaDraft(body, teammate),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate persona draft` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateTasks(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        tasks: store.listTasks({
          assigneeTeammateId: teammateId,
          status: readOptionalTaskStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate tasks` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateActivity(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        items: buildTeammateActivityItems(store, teammateId, readOptionalIntegerQuery(url, "limit", 1) ?? 100),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate activity` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
