import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  McpRuntimeStatusSnapshot,
  McpTool,
  SecretResolver,
} from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { createPluginHealthSnapshot, ensureManagedPluginRecord } from "./catalog.js";
import { connectCuaDriver, rollbackCuaDriverEnable } from "./cua-driver.js";
import { applyCuaDriverToolApprovalOverrides } from "./presets.js";

export interface CuaDriverActivationResult {
  readonly statusCode: 200 | 400;
  readonly error?: string;
  readonly message?: string;
  readonly linkedMcpServerId?: string;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
  readonly health: ManagedPluginHealthSnapshot;
}

export async function activateCuaDriver(input: {
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly descriptor: ManagedPluginDescriptor;
  readonly pluginId: string;
  readonly command?: string;
  readonly operation: "apply" | "enable";
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}): Promise<CuaDriverActivationResult> {
  let linkedServer;
  try {
    linkedServer = connectCuaDriver({
      store: input.store,
      descriptor: input.descriptor,
      command: input.command,
      now: input.now,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "plugin_connect_failed";
    const message = error instanceof Error ? error.message : "Cua Driver could not be connected.";
    return failActivation({ ...input, code, message, rollback: false });
  }

  setCuaDriverEnabled(input.store, input.descriptor, input.pluginId, linkedServer.id, input.now);
  const enabledServer = input.store.getMcpServer(linkedServer.id) ?? linkedServer;
  const errorCode = input.operation === "enable" ? "plugin_enable_failed" : "plugin_apply_failed";

  let checked;
  try {
    checked = await input.mcpBroker.checkServer(enabledServer, {
      secretResolver: input.secretResolver,
      now: () => input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failActivation({ ...input, code: errorCode, message, rollback: true });
  }
  const checkedSnapshot = input.store.upsertMcpStatusSnapshot(checked.statusSnapshot, input.now);
  if (checkedSnapshot.status !== "ready") {
    const message = checkedSnapshot.message ?? "Cua Driver MCP check failed.";
    rollbackCuaDriverEnable({ store: input.store, descriptor: input.descriptor, reason: message, now: input.now });
    return finishActivation({ ...input, linkedMcpServerId: linkedServer.id, statusSnapshot: checkedSnapshot, tools: [], error: errorCode, message });
  }

  let listed;
  try {
    listed = await input.mcpBroker.listTools(enabledServer, {
      secretResolver: input.secretResolver,
      now: () => input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failActivation({ ...input, code: errorCode, message, rollback: true });
  }
  const listedSnapshot = input.store.upsertMcpStatusSnapshot(listed.statusSnapshot, input.now);
  const tools = listedSnapshot.status === "ready"
    ? input.store.replaceMcpServerTools(linkedServer.id, applyCuaDriverToolApprovalOverrides(listed.tools), input.now)
    : [];
  if (listedSnapshot.status !== "ready") {
    rollbackCuaDriverEnable({
      store: input.store,
      descriptor: input.descriptor,
      reason: listedSnapshot.message ?? "Cua Driver tool sync failed.",
      now: input.now,
    });
  }
  return finishActivation({
    ...input,
    linkedMcpServerId: linkedServer.id,
    statusSnapshot: listedSnapshot,
    tools,
    ...(listedSnapshot.status === "ready" ? {} : { error: errorCode, message: listedSnapshot.message ?? "Cua Driver enable failed." }),
  });
}

export function pluginHealthFromMcpSnapshot(
  pluginId: string,
  snapshot: McpRuntimeStatusSnapshot,
): ManagedPluginHealthSnapshot {
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

function setCuaDriverEnabled(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  descriptor: ManagedPluginDescriptor,
  pluginId: string,
  serverId: string,
  now: string,
): void {
  ensureManagedPluginRecord({ store, descriptor, enabled: true, now });
  const contributions = store.listManagedPluginContributions(pluginId);
  store.replaceManagedPluginContributions(
    pluginId,
    contributions.map((contribution) => ({
      contributionKind: contribution.contributionKind,
      contributionId: contribution.contributionId,
      linkedResourceId: contribution.linkedResourceId,
      enabled: true,
    })),
    now,
  );
  store.updateMcpServer(serverId, { enabled: true }, now);
}

function failActivation(input: {
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly descriptor: ManagedPluginDescriptor;
  readonly pluginId: string;
  readonly operation: "apply" | "enable";
  readonly now: string;
  readonly code: string;
  readonly message: string;
  readonly rollback: boolean;
}): CuaDriverActivationResult {
  if (input.rollback) {
    rollbackCuaDriverEnable({ store: input.store, descriptor: input.descriptor, reason: input.message, now: input.now });
  } else {
    ensureManagedPluginRecord({
      store: input.store,
      descriptor: input.descriptor,
      enabled: input.store.getManagedPlugin(input.pluginId)?.enabled ?? false,
      now: input.now,
    });
  }
  return finishActivation({ ...input, error: input.code, tools: [] });
}

function finishActivation(input: {
  readonly store: ReturnType<RunStoreRegistry["getStore"]>;
  readonly pluginId: string;
  readonly operation: "apply" | "enable";
  readonly now: string;
  readonly linkedMcpServerId?: string;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
  readonly error?: string;
  readonly message?: string;
}): CuaDriverActivationResult {
  const health = input.statusSnapshot
    ? input.store.upsertManagedPluginHealthSnapshot(pluginHealthFromMcpSnapshot(input.pluginId, input.statusSnapshot), input.now)
    : input.store.upsertManagedPluginHealthSnapshot(createPluginHealthSnapshot({
        pluginId: input.pluginId,
        now: input.now,
        status: "failed",
        message: input.message,
        details: { errorCode: input.error },
      }), input.now);
  const ready = !input.error && input.statusSnapshot?.status === "ready";
  input.store.appendManagedPluginEvent({
    pluginId: input.pluginId,
    type: input.operation === "enable" ? "enabled" : "preset_applied",
    actor: "local-user",
    message: ready
      ? input.operation === "enable"
        ? `Plugin enabled. ${input.tools.length} MCP tool(s) synced.`
        : `Preset applied. ${input.tools.length} MCP tool(s) synced.`
      : input.message ?? health.message,
    data: {
      status: health.status,
      ...(input.linkedMcpServerId ? { mcpServerId: input.linkedMcpServerId } : {}),
      toolCount: input.tools.length,
      ...(input.error ? { errorCode: input.error } : {}),
    },
  }, input.now);
  return {
    statusCode: ready ? 200 : 400,
    ...(input.error ? { error: input.error } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.linkedMcpServerId ? { linkedMcpServerId: input.linkedMcpServerId } : {}),
    ...(input.statusSnapshot ? { statusSnapshot: input.statusSnapshot } : {}),
    tools: input.tools,
    health,
  };
}
