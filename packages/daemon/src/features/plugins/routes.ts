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
  applyCuaDriverToolApprovalOverrides,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
  CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE,
  isCuaDriverPlatformSupported,
  resolveCuaDriverCommand,
} from "./presets.js";
import {
  checkCuaDriverProviderHealth,
} from "./provider-health.js";
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
import { bundledEmbeddedCuaDriverGateEnabled } from "./cua-driver-feature-gates.js";
import type {
  BundledCuaDriverActivationResult,
  BundledCuaDriverActivationService,
} from "./cua-driver-bundled-activation.js";
import { activateCuaDriver, pluginHealthFromMcpSnapshot } from "./cua-driver-activation.js";
import { toPublicMcpServer } from "../mcp/secrets.js";
import {
  getBundledPluginPackage,
  listPluginSourceViews,
  toPluginPackageView,
} from "./source-index.js";
import {
  checkInstalledPluginRuntimeDependencies,
  assertExclusiveBundledCuaMcpServerOwnership,
  installBundledPluginPackage,
  refreshManagedPluginPackage,
  uninstallManagedPluginPackage,
} from "./install.js";
import { buildManagedPluginRuntimePreview } from "./runtime-injection.js";
import { createTrustedLocalMcpPlugin } from "./create-local-plugin.js";
import type { LockedComputerControlRegistry } from "../computer-use/locked-control-registry.js";
import { CHROME_BROWSER_PLUGIN_ID } from "@ling-stack/contracts";
import type { ChromeBrowserPluginService } from "./chrome-browser.js";

export type ManagedPluginRoute =
  | {
      readonly pluginId: string;
      readonly action?: "enable" | "disable" | "check" | "connect" | "pairing" | "revoke" | "apply-preset" | "validate-package" | "install" | "uninstall" | "refresh-package" | "runtime-preview";
    };

const bundledCanonicalCuaDriverActions = new Set<NonNullable<ManagedPluginRoute["action"]>>([
  "enable",
  "disable",
  "check",
]);

export async function handlePluginsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  extensionRegistry: LingExtensionRegistry,
  mcpBroker: McpBroker,
  lockedComputerControl?: LockedComputerControlRegistry,
  chromeBrowserPlugin?: ChromeBrowserPluginService,
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
          cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
          cuaDriverFeatureFlags: config.cuaDriver,
          lockedControlProjection: lockedComputerControl?.snapshot().projection,
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
          cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
          cuaDriverFeatureFlags: config.cuaDriver,
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
  bundledCuaDriverActivation: BundledCuaDriverActivationService,
  route: ManagedPluginRoute,
  chromeBrowserPlugin?: ChromeBrowserPluginService,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    if (
      route.pluginId === CUA_DRIVER_PLUGIN_ID
      && bundledEmbeddedCuaDriverGateEnabled(config, process.platform)
      && route.action
    ) {
      assertBundledCuaDriverWorkspace(config, cwd);
      if (!bundledCanonicalCuaDriverActions.has(route.action)) {
        throw new HttpError(
          409,
          "cua_driver_bundled_action_forbidden",
          `Bundled Cua Driver does not allow the ${route.action} package action on its canonical runtime surface.`,
        );
      }
    }
    const store = storeRegistry.getStore(cwd);
    if (route.pluginId === CHROME_BROWSER_PLUGIN_ID) {
      if (!chromeBrowserPlugin) {
        throw new HttpError(503, "chrome_browser_unavailable", "Chrome browser plugin service is unavailable.");
      }
      if (!chromeBrowserPlugin.supportsWorkspace(cwd)) {
        throw new HttpError(409, "chrome_browser_workspace_mismatch", "Chrome is available only in the daemon authority workspace.");
      }
      if (request.method === "POST" && route.action === "enable") {
        chromeBrowserPlugin.enable(cwd);
        writeJson(response, 200, {
          plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
        });
        return;
      }
      if (request.method === "POST" && route.action === "disable") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const input = parseManagedPluginDisableRequest(body);
        chromeBrowserPlugin.disable(cwd, input.reason);
        writeJson(response, 200, {
          plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
        });
        return;
      }
      if (request.method === "POST" && route.action === "check") {
        const health = chromeBrowserPlugin.sync(cwd);
        const plugin = getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver });
        writeJson(response, health.status === "ready" ? 200 : 400, health.status === "ready"
          ? { plugin, health }
          : { error: readChromeHealthError(health), message: health.message ?? "Chrome is not connected.", plugin, health });
        return;
      }
      if (request.method === "POST" && route.action === "pairing") {
        const pairing = chromeBrowserPlugin.createPairing(cwd);
        writeJson(response, 200, {
          pluginId: CHROME_BROWSER_PLUGIN_ID,
          pairingCode: pairing.pairingCode,
          expiresAt: pairing.expiresAt,
          ...(pairing.storeUrl ? { storeUrl: pairing.storeUrl } : {}),
        });
        return;
      }
      if (request.method === "POST" && route.action === "revoke") {
        const health = chromeBrowserPlugin.revoke(cwd);
        writeJson(response, 200, {
          plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
          health,
        });
        return;
      }
    }
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
            cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
            cuaDriverFeatureFlags: config.cuaDriver,
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
    if (
      bundledEmbeddedCuaDriverGateEnabled(config, process.platform)
      && route.pluginId === "bundled:cua-driver"
      && route.action
    ) {
      throw new HttpError(
        409,
        "cua_driver_compatibility_record_hidden",
        "The hidden bundled compatibility record is not a second Cua Driver runtime surface.",
      );
    }

    if (request.method === "GET" && !route.action) {
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
      });
      return;
    }

    if (request.method === "GET" && route.action === "runtime-preview") {
      const now = new Date().toISOString();
      const preview = buildManagedPluginRuntimePreview({
        cwd,
        store,
        descriptor,
        now,
        cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
      });
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
        preview,
      });
      return;
    }

    if (request.method === "POST" && route.action === "connect") {
      if (route.pluginId !== CUA_DRIVER_PLUGIN_ID) {
        throw new HttpError(400, "plugin_connect_not_supported", `Plugin does not support connect: ${route.pluginId}`);
      }
      assertBundledCuaDriverRuntimeAvailable(config);
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
        linkedMcpServer: publicMcpServer(store, linkedServer.id, secretResolver, now),
      });
      return;
    }

    if (request.method === "POST" && route.action === "enable") {
      if (route.pluginId === CUA_DRIVER_PLUGIN_ID) {
        if (bundledEmbeddedCuaDriverGateEnabled(config, process.platform)) {
          assertBundledCuaDriverWorkspace(config, cwd);
          const now = new Date().toISOString();
          const result = await bundledCuaDriverActivation.enable({ store, descriptor, now });
          writeBundledActivationResponse({
            response,
            cwd,
            descriptor,
            extensionRegistry,
            store,
            secretResolver,
            result,
            cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
            cuaDriverFeatureFlags: config.cuaDriver,
            now,
          });
          return;
        }
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
          cuaDriverFeatureFlags: config.cuaDriver,
        });
        return;
      }
      const now = new Date().toISOString();
      if (route.pluginId === "bundled:cua-driver") {
        assertExclusiveBundledCuaMcpServerOwnership({ store, descriptor, now });
      }
      ensureManagedPluginRecord({ store, descriptor, enabled: true, now });
      setLinkedContributionsEnabled(store, route.pluginId, true, now);
      try {
        await checkInstalledPluginRuntimeDependencies({
          descriptor,
          store,
          mcpBroker,
          secretResolver,
          now,
        });
      } catch (error) {
        ensureManagedPluginRecord({
          store,
          descriptor,
          enabled: false,
          disabledReason: error instanceof Error ? error.message : "Plugin runtime dependency check failed.",
          now,
        });
        setLinkedContributionsEnabled(store, route.pluginId, false, now);
        throw error;
      }
      store.appendManagedPluginEvent({
        pluginId: route.pluginId,
        type: "enabled",
        actor: "local-user",
        message: "Plugin enabled.",
      }, now);
      writeJson(response, 200, {
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "disable") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseManagedPluginDisableRequest(body);
      const now = new Date().toISOString();
      if (
        route.pluginId === CUA_DRIVER_PLUGIN_ID
        && bundledEmbeddedCuaDriverGateEnabled(config, process.platform)
      ) {
        assertBundledCuaDriverWorkspace(config, cwd);
        const result = await bundledCuaDriverActivation.disable({
          store,
          descriptor,
          now,
          reason: input.reason,
        });
        writeBundledActivationResponse({
          response,
          cwd,
          descriptor,
          extensionRegistry,
          store,
          secretResolver,
          result,
          cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
          cuaDriverFeatureFlags: config.cuaDriver,
          now,
        });
        return;
      }
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
      });
      return;
    }

    if (request.method === "POST" && route.action === "check") {
      if (
        route.pluginId === CUA_DRIVER_PLUGIN_ID
        && bundledEmbeddedCuaDriverGateEnabled(config, process.platform)
      ) {
        assertBundledCuaDriverWorkspace(config, cwd);
        const now = new Date().toISOString();
        const result = await bundledCuaDriverActivation.check({ store, descriptor, now });
        writeBundledActivationResponse({
          response,
          cwd,
          descriptor,
          extensionRegistry,
          store,
          secretResolver,
          result,
          cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority,
          cuaDriverFeatureFlags: config.cuaDriver,
          now,
        });
        return;
      }
      await handlePluginCheck({
        response,
        cwd,
        descriptor,
        extensionRegistry,
        store,
        pluginId: route.pluginId,
        mcpBroker,
        secretResolver,
        cuaDriverFeatureFlags: config.cuaDriver,
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: result.descriptor.id, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: route.pluginId, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
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
        plugin: getRequiredPluginView({ cwd, extensionRegistry, store, pluginId: result.descriptor.id, includeEvents: true, cuaDriverRuntimeAuthority: mcpBroker.cuaDriverRuntimeAuthority, cuaDriverFeatureFlags: config.cuaDriver }),
        package: publicPluginPackage(result.packageRecord),
      });
      return;
    }

    if (request.method === "POST" && route.action === "apply-preset") {
      if (route.pluginId === CUA_DRIVER_PLUGIN_ID) {
        assertBundledCuaDriverRuntimeAvailable(config);
      }
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
        cuaDriverFeatureFlags: config.cuaDriver,
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

export function assertBundledCuaDriverRuntimeAvailable(
  config: ResolvedDaemonConfig,
  platform: NodeJS.Platform = process.platform,
): void {
  if (bundledEmbeddedCuaDriverGateEnabled(config, platform)) {
    throw new HttpError(
      409,
      "cua_desktop_lease_unavailable",
      "Bundled Cua Driver runtime is not available until Desktop publishes a validated lease.",
    );
  }
}

function assertBundledCuaDriverWorkspace(config: ResolvedDaemonConfig, cwd: string): void {
  if (cwd !== config.defaultWorkspaceCwd) {
    throw new HttpError(
      409,
      "cua_driver_workspace_mismatch",
      "Bundled Cua Driver is available only to the Desktop authority workspace.",
    );
  }
}

function writeBundledActivationResponse(input: {
  readonly response: ServerResponse;
  readonly cwd: string;
  readonly descriptor: ManagedPluginDescriptor;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly secretResolver: SecretResolver;
  readonly result: BundledCuaDriverActivationResult;
  readonly cuaDriverRuntimeAuthority: McpBroker["cuaDriverRuntimeAuthority"];
  readonly cuaDriverFeatureFlags: ResolvedDaemonConfig["cuaDriver"];
  readonly now: string;
}): void {
  writeJson(input.response, input.result.statusCode, {
    ...(input.result.error
      ? {
          error: input.result.error,
          message: input.result.message ?? input.result.health.message ?? "Bundled Cua Driver activation failed.",
        }
      : {}),
    plugin: getRequiredPluginView({
      cwd: input.cwd,
      extensionRegistry: input.extensionRegistry,
      store: input.store,
      pluginId: input.descriptor.id,
      includeEvents: true,
      cuaDriverRuntimeAuthority: input.cuaDriverRuntimeAuthority,
      cuaDriverFeatureFlags: input.cuaDriverFeatureFlags,
    }),
    linkedMcpServer: publicMcpServer(
      input.store,
      input.result.linkedMcpServerId,
      input.secretResolver,
      input.now,
    ),
    ...(input.result.statusSnapshot ? { statusSnapshot: input.result.statusSnapshot } : {}),
    health: input.result.health,
    tools: input.result.tools,
  });
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
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
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
    cuaDriverRuntimeAuthority: input.mcpBroker.cuaDriverRuntimeAuthority,
    cuaDriverFeatureFlags: input.cuaDriverFeatureFlags,
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
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
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
      cuaDriverRuntimeAuthority: input.mcpBroker.cuaDriverRuntimeAuthority,
      cuaDriverFeatureFlags: input.cuaDriverFeatureFlags,
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
  if (input.descriptor.id === CUA_DRIVER_PLUGIN_ID || input.descriptor.id === "bundled:cua-driver") {
    if (!isCuaDriverPlatformSupported()) {
      return createPluginHealthSnapshot({
        pluginId: input.descriptor.id,
        now: input.now,
        status: "failed",
        message: CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE,
        details: { errorCode: "plugin_platform_blocked" },
      });
    }
    if (input.descriptor.id === "bundled:cua-driver") {
      assertExclusiveBundledCuaMcpServerOwnership({
        store: input.store,
        descriptor: input.descriptor,
        now: input.now,
      });
    }
    const linkedServer = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
    if (linkedServer) {
      const result = await input.mcpBroker.checkServer(linkedServer, {
        secretResolver: input.secretResolver,
        now: () => input.now,
      });
      const statusSnapshot = input.store.upsertMcpStatusSnapshot(result.statusSnapshot, input.now);
      if (statusSnapshot.status !== "ready") {
        return pluginHealthFromMcpSnapshot(input.descriptor.id, statusSnapshot);
      }
      if (process.platform === "win32") {
        const listed = await input.mcpBroker.listTools(linkedServer, {
          secretResolver: input.secretResolver,
          now: () => input.now,
        });
        const listedSnapshot = input.store.upsertMcpStatusSnapshot(listed.statusSnapshot, input.now);
        if (listedSnapshot.status !== "ready") {
          return pluginHealthFromMcpSnapshot(input.descriptor.id, listedSnapshot);
        }
        const tools = applyCuaDriverToolApprovalOverrides(listed.tools);
        input.store.replaceMcpServerTools(linkedServer.id, tools, input.now);
        const providerHealth = await checkCuaDriverProviderHealth({
          server: linkedServer,
          mcpBroker: input.mcpBroker,
          secretResolver: input.secretResolver,
          now: input.now,
          availableToolNames: tools.map((tool) => tool.rawName),
        });
        return createPluginHealthSnapshot({
          pluginId: input.descriptor.id,
          now: input.now,
          status: providerHealth.ok ? "ready" : "failed",
          message: providerHealth.message,
          details: providerHealth.details,
        });
      }
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
  readonly cuaDriverRuntimeAuthority: McpBroker["cuaDriverRuntimeAuthority"];
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
}) {
  const plugin = getManagedPluginView({
    cwd: input.cwd,
    extensionRegistry: input.extensionRegistry,
    store: input.store,
    pluginId: input.pluginId,
    now: new Date().toISOString(),
    includeEvents: input.includeEvents,
    cuaDriverRuntimeAuthority: input.cuaDriverRuntimeAuthority,
    cuaDriverFeatureFlags: input.cuaDriverFeatureFlags,
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

function readChromeHealthError(health: ManagedPluginHealthSnapshot): string {
  return isRecord(health.details) && typeof health.details.errorCode === "string"
    ? health.details.errorCode
    : "chrome_browser_disconnected";
}
