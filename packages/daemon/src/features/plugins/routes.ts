import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  McpRuntimeStatusSnapshot,
  PublicMcpServer,
  SecretResolver,
} from "@ling-stack/core";
import type { LingExtensionRegistry } from "@ling-stack/plugin-sdk";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  createPluginHealthSnapshot,
  ensureManagedPluginRecord,
  getManagedPluginDescriptor,
  getManagedPluginView,
  listManagedPluginViews,
} from "./catalog.js";
import {
  applyCuaDriverToolApprovalOverrides,
  createCuaDriverMcpServerInput,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
  resolveCuaDriverCommand,
} from "./presets.js";
import {
  parseManagedPluginApplyPresetRequest,
  parseManagedPluginDisableRequest,
  parseManagedPluginValidatePackageRequest,
} from "./schemas.js";
import { toPublicMcpServer } from "../mcp/secrets.js";
import {
  getBundledPluginPackage,
  listPluginSourceViews,
  toPluginPackageView,
} from "./source-index.js";

export type ManagedPluginRoute =
  | { readonly pluginId: string; readonly action?: "enable" | "disable" | "check" | "apply-preset" | "validate-package" };

export async function handlePluginsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  extensionRegistry: LingExtensionRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /plugins` });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      plugins: listManagedPluginViews({
        extensionRegistry,
        store,
        now: new Date().toISOString(),
      }),
    });
  } catch (error) {
    writeRouteError(response, error);
  }
}

export async function handlePluginSourcesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /plugins/sources` });
    return;
  }
  writeJson(response, 200, { cwd, sources: listPluginSourceViews() });
}

export async function handlePluginPackageItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  pluginId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /plugins/packages/:id` });
    return;
  }
  const pluginPackage = getBundledPluginPackage(pluginId);
  if (!pluginPackage) {
    writeJson(response, 404, { error: "plugin_package_not_found", message: `Plugin package not found: ${pluginId}` });
    return;
  }
  writeJson(response, 200, {
    cwd,
    package: toPluginPackageView(pluginPackage),
    validation: pluginPackage.validation,
  });
}

export async function handlePluginItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  extensionRegistry: LingExtensionRegistry,
  mcpBroker: McpBroker,
  secretResolver: SecretResolver,
  route: ManagedPluginRoute,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "POST" && route.action === "validate-package") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      parseManagedPluginValidatePackageRequest(body);
      const validationPackage = getBundledPluginPackage(route.pluginId);
      if (!validationPackage) {
        writeJson(response, 404, { error: "plugin_package_not_found", message: `Plugin package not found: ${route.pluginId}` });
        return;
      }
      const plugin = validationPackage.validation.compiledDescriptor
        ? getManagedPluginView({
            extensionRegistry,
            store,
            pluginId: validationPackage.validation.compiledDescriptor.id,
            now: new Date().toISOString(),
            includeEvents: true,
          })
        : undefined;
      writeJson(response, 200, {
        cwd,
        ...(plugin ? { plugin } : {}),
        package: toPluginPackageView(validationPackage),
        validation: validationPackage.validation,
      });
      return;
    }

    const descriptor = getManagedPluginDescriptor(extensionRegistry, store, route.pluginId);
    if (!descriptor) {
      throw new HttpError(404, "plugin_not_found", `Plugin not found: ${route.pluginId}`);
    }

    if (request.method === "GET" && !route.action) {
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "enable") {
      const now = new Date().toISOString();
      ensureManagedPluginRecord({ store, descriptor, enabled: true, now });
      setLinkedContributionsEnabled(store, route.pluginId, true, now);
      store.appendManagedPluginEvent({
        pluginId: route.pluginId,
        type: "enabled",
        actor: "local-user",
        message: "Plugin enabled.",
      }, now);
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "disable") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginDisableRequest(body);
      const now = new Date().toISOString();
      ensureManagedPluginRecord({
        store,
        descriptor,
        enabled: false,
        disabledReason: input.reason,
        now,
      });
      setLinkedContributionsEnabled(store, route.pluginId, false, now);
      store.appendManagedPluginEvent({
        pluginId: route.pluginId,
        type: "disabled",
        actor: "local-user",
        message: input.reason ? `Plugin disabled: ${input.reason}` : "Plugin disabled.",
      }, now);
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "check") {
      await handlePluginCheck({
        response,
        descriptor,
        extensionRegistry,
        store,
        pluginId: route.pluginId,
        mcpBroker,
        secretResolver,
      });
      return;
    }

    if (request.method === "POST" && route.action === "apply-preset") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginApplyPresetRequest(body);
      await handlePluginApplyPreset({
        response,
        descriptor,
        extensionRegistry,
        store,
        pluginId: route.pluginId,
        options: input.options,
        mcpBroker,
        secretResolver,
      });
      return;
    }

    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for plugin route.`,
    });
  } catch (error) {
    writeRouteError(response, error);
  }
}

async function handlePluginCheck(input: {
  readonly response: ServerResponse;
  readonly descriptor: ManagedPluginDescriptor;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
}): Promise<void> {
  const now = new Date().toISOString();
  const record = ensureManagedPluginRecord({
    store: input.store,
    descriptor: input.descriptor,
    enabled: input.store.getManagedPlugin(input.pluginId)?.enabled ?? input.descriptor.defaultEnabled === true,
    now,
  });
  const health = await checkPluginHealth({
    descriptor: input.descriptor,
    store: input.store,
    mcpBroker: input.mcpBroker,
    secretResolver: input.secretResolver,
    now,
  });
  const storedHealth = input.store.upsertManagedPluginHealthSnapshot(health, now);
  input.store.appendManagedPluginEvent({
    pluginId: input.pluginId,
    type: "checked",
    actor: "local-user",
    message: storedHealth.message,
    data: { status: storedHealth.status },
  }, now);
  const plugin = getRequiredPluginView({
    extensionRegistry: input.extensionRegistry,
    store: input.store,
    pluginId: record.id,
    includeEvents: true,
  });
  const status = storedHealth.status === "failed" ? 400 : 200;
  writeJson(input.response, status, status === 200
    ? { plugin, health: storedHealth }
    : {
        error: storedHealth.details && isRecord(storedHealth.details) && typeof storedHealth.details.errorCode === "string"
          ? storedHealth.details.errorCode
          : "plugin_check_failed",
        message: storedHealth.message ?? "Plugin check failed.",
        plugin,
        health: storedHealth,
      });
}

async function handlePluginApplyPreset(input: {
  readonly response: ServerResponse;
  readonly descriptor: ManagedPluginDescriptor;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
}): Promise<void> {
  if (input.pluginId !== CUA_DRIVER_PLUGIN_ID) {
    throw new HttpError(400, "plugin_preset_not_applicable", `Plugin does not support apply-preset: ${input.pluginId}`);
  }
  const now = new Date().toISOString();
  if (process.platform !== "darwin") {
    const record = ensureManagedPluginRecord({ store: input.store, descriptor: input.descriptor, enabled: false, now });
    const health = input.store.upsertManagedPluginHealthSnapshot(createPluginHealthSnapshot({
      pluginId: input.pluginId,
      now,
      status: "failed",
      message: "Cua Driver is only supported on macOS.",
      details: { errorCode: "plugin_platform_blocked" },
    }), now);
    input.store.appendManagedPluginEvent({
      pluginId: record.id,
      type: "checked",
      actor: "local-user",
      message: health.message,
      data: { status: health.status, errorCode: "plugin_platform_blocked" },
    }, now);
    writeJson(input.response, 400, {
      error: "plugin_platform_blocked",
      message: health.message,
      plugin: getRequiredPluginView({
        extensionRegistry: input.extensionRegistry,
        store: input.store,
        pluginId: input.pluginId,
        includeEvents: true,
      }),
      health,
      tools: [],
    });
    return;
  }
  const command = resolveCuaDriverCommand(input.options);
  if (!command.ok || !command.command) {
    const record = ensureManagedPluginRecord({ store: input.store, descriptor: input.descriptor, enabled: false, now });
    const health = input.store.upsertManagedPluginHealthSnapshot(createPluginHealthSnapshot({
      pluginId: input.pluginId,
      now,
      status: "failed",
      message: command.message ?? "cua-driver binary was not found.",
      details: { errorCode: "plugin_binary_not_found" },
    }), now);
    input.store.appendManagedPluginEvent({
      pluginId: record.id,
      type: "checked",
      actor: "local-user",
      message: health.message,
      data: { status: health.status, errorCode: "plugin_binary_not_found" },
    }, now);
    writeJson(input.response, 400, {
      error: "plugin_binary_not_found",
      message: health.message,
      plugin: getRequiredPluginView({
        extensionRegistry: input.extensionRegistry,
        store: input.store,
        pluginId: input.pluginId,
        includeEvents: true,
      }),
      health,
      tools: [],
    });
    return;
  }

  const existingRecord = input.store.getManagedPlugin(input.pluginId);
  const existingLinks = input.store.listManagedPluginContributions(input.pluginId);
  const record = ensureManagedPluginRecord({
    store: input.store,
    descriptor: input.descriptor,
    enabled: existingRecord?.enabled === false && existingLinks.length > 0 ? false : true,
    now,
  });
  const mcpInput = createCuaDriverMcpServerInput(command.command, record.enabled);
  const existingServer = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  const linkedServer = existingServer
    ? input.store.updateMcpServer(CUA_DRIVER_MCP_SERVER_ID, mcpInput, now) ?? existingServer
    : input.store.createMcpServer(mcpInput, now);
  input.store.replaceManagedPluginContributions(input.pluginId, [
    {
      contributionKind: "mcp-server",
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      linkedResourceId: linkedServer.id,
      enabled: record.enabled,
    },
  ], now);
  input.store.appendManagedPluginEvent({
    pluginId: input.pluginId,
    type: "contribution_linked",
    actor: "system",
    message: `Linked MCP server ${linkedServer.id}.`,
    data: { linkedResourceId: linkedServer.id },
  }, now);

  const checked = await input.mcpBroker.checkServer(linkedServer, {
    secretResolver: input.secretResolver,
    now: () => now,
  });
  const checkedSnapshot = input.store.upsertMcpStatusSnapshot(checked.statusSnapshot, now);
  if (checkedSnapshot.status !== "ready") {
    const health = input.store.upsertManagedPluginHealthSnapshot(pluginHealthFromMcpSnapshot(input.pluginId, checkedSnapshot), now);
    input.store.appendManagedPluginEvent({
      pluginId: input.pluginId,
      type: "preset_applied",
      actor: "local-user",
      message: health.message ?? "Preset applied but MCP check failed.",
      data: { status: health.status, mcpServerId: linkedServer.id },
    }, now);
    writeJson(input.response, 400, {
      error: "plugin_apply_failed",
      message: health.message ?? "Plugin preset apply failed.",
      plugin: getRequiredPluginView({
        extensionRegistry: input.extensionRegistry,
        store: input.store,
        pluginId: input.pluginId,
        includeEvents: true,
      }),
      linkedMcpServer: publicMcpServer(input.store, linkedServer.id, input.secretResolver, now),
      statusSnapshot: checkedSnapshot,
      tools: [],
    });
    return;
  }

  const listed = await input.mcpBroker.listTools(linkedServer, {
    secretResolver: input.secretResolver,
    now: () => now,
  });
  const listedSnapshot = input.store.upsertMcpStatusSnapshot(listed.statusSnapshot, now);
  const tools = listedSnapshot.status === "ready"
    ? input.store.replaceMcpServerTools(linkedServer.id, applyCuaDriverToolApprovalOverrides(listed.tools), now)
    : [];
  const health = input.store.upsertManagedPluginHealthSnapshot(pluginHealthFromMcpSnapshot(input.pluginId, listedSnapshot), now);
  input.store.appendManagedPluginEvent({
    pluginId: input.pluginId,
    type: "preset_applied",
    actor: "local-user",
    message: listedSnapshot.status === "ready" ? `Preset applied. ${tools.length} MCP tool(s) synced.` : health.message,
    data: { status: health.status, mcpServerId: linkedServer.id, toolCount: tools.length },
  }, now);
  writeJson(input.response, listedSnapshot.status === "ready" ? 200 : 400, {
    ...(listedSnapshot.status === "ready" ? {} : { error: "plugin_apply_failed", message: health.message ?? "Plugin preset apply failed." }),
    plugin: getRequiredPluginView({
      extensionRegistry: input.extensionRegistry,
      store: input.store,
      pluginId: input.pluginId,
      includeEvents: true,
    }),
    linkedMcpServer: publicMcpServer(input.store, linkedServer.id, input.secretResolver, now),
    statusSnapshot: listedSnapshot,
    tools,
  });
}

async function checkPluginHealth(input: {
  readonly descriptor: ManagedPluginDescriptor;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}): Promise<ManagedPluginHealthSnapshot> {
  if (input.descriptor.id === CUA_DRIVER_PLUGIN_ID) {
    if (process.platform !== "darwin") {
      return createPluginHealthSnapshot({
        pluginId: input.descriptor.id,
        now: input.now,
        status: "failed",
        message: "Cua Driver is only supported on macOS.",
        details: { errorCode: "plugin_platform_blocked" },
      });
    }
    const linkedServer = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
    if (linkedServer) {
      const result = await input.mcpBroker.checkServer(linkedServer, {
        secretResolver: input.secretResolver,
        now: () => input.now,
      });
      const statusSnapshot = input.store.upsertMcpStatusSnapshot(result.statusSnapshot, input.now);
      return pluginHealthFromMcpSnapshot(input.descriptor.id, statusSnapshot);
    }
    const command = resolveCuaDriverCommand();
    return createPluginHealthSnapshot({
      pluginId: input.descriptor.id,
      now: input.now,
      status: command.ok ? "ready" : "failed",
      message: command.ok
        ? "cua-driver binary found."
        : command.message ?? "cua-driver binary was not found.",
      details: command.ok
        ? { binaryFound: true }
        : { errorCode: "plugin_binary_not_found" },
    });
  }
  return createPluginHealthSnapshot({
    pluginId: input.descriptor.id,
    now: input.now,
    status: "ready",
    message: "Built-in plugin metadata is available.",
  });
}

function pluginHealthFromMcpSnapshot(pluginId: string, snapshot: McpRuntimeStatusSnapshot): ManagedPluginHealthSnapshot {
  const status = snapshot.status === "ready"
    ? "ready"
    : snapshot.status === "disabled"
      ? "disabled"
      : snapshot.status === "expired"
        ? "expired"
        : "failed";
  return {
    pluginId,
    checkedAt: snapshot.checkedAt,
    expiresAt: snapshot.expiresAt,
    status,
    message: snapshot.message,
    details: {
      mcpServerId: snapshot.serverId,
      mcpStatus: snapshot.status,
      errorCode: snapshot.errorCode,
      toolCount: snapshot.toolCount,
      missingSecretRefs: snapshot.missingSecretRefs,
      authStatus: snapshot.authStatus.kind,
      latencyMs: snapshot.latencyMs,
    },
  };
}

function setLinkedContributionsEnabled(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  pluginId: string,
  enabled: boolean,
  now: string,
): void {
  const contributions = store.listManagedPluginContributions(pluginId);
  if (contributions.length > 0) {
    store.replaceManagedPluginContributions(
      pluginId,
      contributions.map((contribution) => ({
        contributionKind: contribution.contributionKind,
        contributionId: contribution.contributionId,
        linkedResourceId: contribution.linkedResourceId,
        enabled,
      })),
      now,
    );
  }
  for (const contribution of contributions) {
    if (contribution.contributionKind === "mcp-server" && contribution.linkedResourceId) {
      store.updateMcpServer(contribution.linkedResourceId, { enabled }, now);
    }
  }
}

function getRequiredPluginView(input: {
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly includeEvents: boolean;
}) {
  const plugin = getManagedPluginView({
    extensionRegistry: input.extensionRegistry,
    store: input.store,
    pluginId: input.pluginId,
    now: new Date().toISOString(),
    includeEvents: input.includeEvents,
  });
  if (!plugin) {
    throw new HttpError(404, "plugin_not_found", `Plugin not found: ${input.pluginId}`);
  }
  return plugin;
}

function publicMcpServer(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  serverId: string,
  secretResolver: SecretResolver,
  now: string,
): PublicMcpServer | undefined {
  const server = store.getMcpServer(serverId);
  return server ? toPublicMcpServer({ store, server, secretResolver, now }) : undefined;
}

function writeRouteError(response: ServerResponse, error: unknown): void {
  writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
