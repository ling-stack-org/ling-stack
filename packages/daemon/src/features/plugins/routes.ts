import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  ManagedPluginPackageRecord,
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
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
  resolveCuaDriverCommand,
} from "./presets.js";
import {
  parseManagedPluginApplyPresetRequest,
  parseManagedPluginConnectRequest,
  parseManagedPluginCreateRequest,
  parseManagedPluginDisableRequest,
  parseManagedPluginInstallRequest,
  parseManagedPluginUninstallRequest,
  parseManagedPluginValidatePackageRequest,
} from "./schemas.js";
import {
  configuredCuaDriverCommand,
  connectCuaDriver,
} from "./cua-driver.js";
import { activateCuaDriver, pluginHealthFromMcpSnapshot } from "./cua-driver-activation.js";
import { toPublicMcpServer } from "../mcp/secrets.js";
import {
  getBundledPluginPackage,
  listPluginSourceViews,
  toPluginPackageView,
} from "./source-index.js";
import {
  installBundledPluginPackage,
  refreshManagedPluginPackage,
  uninstallManagedPluginPackage,
} from "./install.js";
import { buildManagedPluginRuntimePreview } from "./runtime-injection.js";
import { createTrustedLocalMcpPlugin } from "./create-local-plugin.js";

export type ManagedPluginRoute =
  | {
      readonly pluginId: string;
      readonly action?: "enable" | "disable" | "check" | "connect" | "apply-preset" | "validate-package" | "install" | "uninstall" | "refresh-package" | "runtime-preview";
    };

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
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        plugins: listManagedPluginViews({
          cwd,
          extensionRegistry,
          store,
          now: new Date().toISOString(),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginCreateRequest(body);
      const now = new Date().toISOString();
      const created = createTrustedLocalMcpPlugin({ store, ...input, now });
      writeJson(response, 201, {
        cwd,
        plugin: getRequiredPluginView({
          cwd,
          extensionRegistry,
          store,
          pluginId: created.pluginId,
          includeEvents: true,
        }),
      });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /plugins` });
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
            cwd,
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
      });
      return;
    }

    if (request.method === "GET" && route.action === "runtime-preview") {
      const now = new Date().toISOString();
      const preview = buildManagedPluginRuntimePreview({ cwd, store, descriptor, now });
      ensureManagedPluginRecord({
        store,
        descriptor,
        enabled: store.getManagedPlugin(route.pluginId)?.enabled ?? descriptor.defaultEnabled === true,
        now,
      });
      store.appendManagedPluginEvent({
        pluginId: route.pluginId,
        type: "runtime_previewed",
        actor: "local-user",
        message: `Runtime preview ${preview.status}.`,
        data: { status: preview.status, blockers: preview.blockers, policyOverlayCount: preview.policyOverlays.length },
      }, now);
      writeJson(response, 200, {
        cwd,
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
        preview,
      });
      return;
    }

    if (request.method === "POST" && route.action === "connect") {
      if (route.pluginId !== CUA_DRIVER_PLUGIN_ID) {
        throw new HttpError(400, "plugin_connect_not_supported", `Plugin does not support connect: ${route.pluginId}`);
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginConnectRequest(body);
      const now = new Date().toISOString();
      let linkedServer;
      try {
        linkedServer = connectCuaDriver({
          store,
          descriptor,
          command: input.command,
          now,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        throw new HttpError(400, "plugin_connect_failed", "Cua Driver could not be connected.");
      }
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
        linkedMcpServer: publicMcpServer(store, linkedServer.id, secretResolver, now),
      });
      return;
    }

    if (request.method === "POST" && route.action === "enable") {
      if (route.pluginId === CUA_DRIVER_PLUGIN_ID) {
        const configuredCommand = configuredCuaDriverCommand(store);
        await handlePluginApplyPreset({
          response,
          cwd,
          descriptor,
          extensionRegistry,
          store,
          pluginId: route.pluginId,
          options: configuredCommand ? { command: configuredCommand } : {},
          operation: "enable",
          mcpBroker,
          secretResolver,
        });
        return;
      }
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "check") {
      await handlePluginCheck({
        response,
        cwd,
        descriptor,
        extensionRegistry,
        store,
        pluginId: route.pluginId,
        mcpBroker,
        secretResolver,
      });
      return;
    }

    if (request.method === "POST" && route.action === "install") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginInstallRequest(body);
      const now = new Date().toISOString();
      const result = await installBundledPluginPackage({
        cwd,
        store,
        pluginId: route.pluginId,
        options: input.options,
        now,
      });
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: result.descriptor.id, includeEvents: true }),
        package: publicPluginPackage(result.packageRecord),
      });
      return;
    }

    if (request.method === "POST" && route.action === "uninstall") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginUninstallRequest(body);
      const now = new Date().toISOString();
      const packageRecord = uninstallManagedPluginPackage({
        store,
        descriptor,
        reason: input.reason,
        now,
      });
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true }),
        ...(packageRecord ? { package: publicPluginPackage(packageRecord) } : {}),
      });
      return;
    }

    if (request.method === "POST" && route.action === "refresh-package") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginInstallRequest(body);
      const now = new Date().toISOString();
      const result = await refreshManagedPluginPackage({
        cwd,
        store,
        pluginId: route.pluginId,
        options: input.options,
        now,
      });
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: result.descriptor.id, includeEvents: true }),
        package: publicPluginPackage(result.packageRecord),
      });
      return;
    }

    if (request.method === "POST" && route.action === "apply-preset") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginApplyPresetRequest(body);
      await handlePluginApplyPreset({
        response,
        cwd,
        descriptor,
        extensionRegistry,
        store,
        pluginId: route.pluginId,
        options: input.options,
        operation: "apply",
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
  readonly cwd: string;
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
    cwd: input.cwd,
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
  readonly cwd: string;
  readonly descriptor: ManagedPluginDescriptor;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly operation: "apply" | "enable";
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
}): Promise<void> {
  if (input.pluginId !== CUA_DRIVER_PLUGIN_ID) {
    throw new HttpError(400, "plugin_preset_not_applicable", `Plugin does not support apply-preset: ${input.pluginId}`);
  }
  const now = new Date().toISOString();
  const command = typeof input.options.command === "string" ? input.options.command : undefined;
  const result = await activateCuaDriver({
    store: input.store,
    descriptor: input.descriptor,
    pluginId: input.pluginId,
    command,
    operation: input.operation,
    mcpBroker: input.mcpBroker,
    secretResolver: input.secretResolver,
    now,
  });
  writeJson(input.response, result.statusCode, {
    ...(result.error ? { error: result.error, message: result.message ?? result.health.message ?? "Cua Driver activation failed." } : {}),
    plugin: getRequiredPluginView({
      cwd: input.cwd,
      extensionRegistry: input.extensionRegistry,
      store: input.store,
      pluginId: input.pluginId,
      includeEvents: true,
    }),
    ...(result.linkedMcpServerId ? { linkedMcpServer: publicMcpServer(input.store, result.linkedMcpServerId, input.secretResolver, now) } : {}),
    ...(result.statusSnapshot ? { statusSnapshot: result.statusSnapshot } : {}),
    health: result.health,
    tools: result.tools,
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
  const mcpContribution = input.store.listManagedPluginContributions(input.descriptor.id)
    .find((contribution) => contribution.contributionKind === "mcp-server");
  if (input.descriptor.contributions.some((contribution) => contribution.kind === "mcp-server")) {
    const linkedServer = mcpContribution?.linkedResourceId
      ? input.store.getMcpServer(mcpContribution.linkedResourceId)
      : undefined;
    if (!linkedServer) {
      return createPluginHealthSnapshot({
        pluginId: input.descriptor.id,
        now: input.now,
        status: "failed",
        message: "Linked MCP server is missing.",
        details: { errorCode: "plugin_linked_resource_missing" },
      });
    }
    const result = await input.mcpBroker.checkServer(linkedServer, {
      secretResolver: input.secretResolver,
      now: () => input.now,
    });
    const statusSnapshot = input.store.upsertMcpStatusSnapshot(result.statusSnapshot, input.now);
    return pluginHealthFromMcpSnapshot(input.descriptor.id, statusSnapshot);
  }
  return createPluginHealthSnapshot({
    pluginId: input.descriptor.id,
    now: input.now,
    status: "ready",
    message: "Built-in plugin metadata is available.",
  });
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
  readonly cwd: string;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly includeEvents: boolean;
}) {
  const plugin = getManagedPluginView({
    cwd: input.cwd,
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

function publicPluginPackage(record: ManagedPluginPackageRecord) {
  return {
    pluginId: record.pluginId,
    sourceKind: record.sourceKind,
    version: record.version,
    status: record.status,
    cacheRef: record.cacheRef,
    packageHash: record.packageHash,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    uninstalledAt: record.uninstalledAt,
  };
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
