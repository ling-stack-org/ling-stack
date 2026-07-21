import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  McpRuntimeStatusSnapshot,
  McpServer,
  McpTool,
  ReplaceMcpServerToolInput,
  RunStore,
} from "@ling-stack/core";
import type {
  CuaDriverProviderState,
  DesktopCuaDriverAvailabilityV1,
} from "@ling-stack/contracts";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "../mcp/status.js";
import { createPluginHealthSnapshot, ensureManagedPluginRecord } from "./catalog.js";
import {
  captureCuaDriverActivationFence,
  commitCurrentCuaDriverActivation,
  isCurrentCuaDriverActivationFence,
} from "./cua-driver-activation-fence.js";
import type { CuaDriverClientPool } from "./cua-driver-client-pool.js";
import type { CuaDriverLeaseMcpClient } from "./cua-driver-lease-client.js";
import type { CuaDriverLeaseRegistry } from "./cua-driver-lease.js";
import { isRecord } from "../../shared/validation.js";
import {
  applyBundledCuaDriverToolPolicy,
  BundledCuaDriverToolPolicyError,
  createBundledCuaDriverLogicalMcpServerInput,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
} from "./presets.js";

export type BundledCuaDriverActivationOperation = "check" | "enable";

export interface BundledCuaDriverActivationResult {
  readonly statusCode: 200 | 400 | 409;
  readonly committed: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly linkedMcpServerId: string;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
  readonly health: ManagedPluginHealthSnapshot;
}

export interface BundledCuaDriverResetResult {
  readonly committed: boolean;
  readonly requestedEnabled: boolean;
  readonly requestedRevision: number;
  readonly activationEpoch: number;
}

export class BundledCuaDriverActivationError extends Error {
  constructor(readonly activationCode: "plugin_identity_invalid") {
    super(`cua_driver_bundled_activation_${activationCode}`);
    this.name = "BundledCuaDriverActivationError";
  }
}

/**
 * Generation- and intent-fenced activation for Desktop-owned Cua Driver.
 *
 * The logical MCP record contributes ids/timeouts only. Its persisted transport
 * is never read: all protocol operations use the current in-memory Desktop lease.
 */
export class BundledCuaDriverActivationService {
  constructor(private readonly options: {
    readonly leaseRegistry: CuaDriverLeaseRegistry;
    readonly clientPool: CuaDriverClientPool<CuaDriverLeaseMcpClient>;
    readonly getDesktopAvailability?: () => DesktopCuaDriverAvailabilityV1 | undefined;
  }) {}

  /**
   * Daemon startup/reconnect fence. Retain user intent, advance the epoch once,
   * and remove every effective flag, tool and ready status before routes serve.
   */
  resetForDaemonStart(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
  }): BundledCuaDriverResetResult {
    return this.invalidateProjection(input);
  }

  /**
   * Synchronous durable fence for replacement, expiry, revoke and authority
   * rotation. Execution is already rejected by the in-memory lease registry;
   * this projection also hides cached tools and all effective enabled flags.
   */
  invalidateForLeaseChange(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly availability?: DesktopCuaDriverAvailabilityV1;
  }): BundledCuaDriverResetResult {
    return this.invalidateProjection(input);
  }

  projectDesktopAvailability(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly availability: DesktopCuaDriverAvailabilityV1;
  }): BundledCuaDriverResetResult {
    return this.invalidateProjection(input);
  }

  enable(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly signal?: AbortSignal;
  }): Promise<BundledCuaDriverActivationResult> {
    return this.activate({ ...input, operation: "enable" });
  }

  check(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly signal?: AbortSignal;
  }): Promise<BundledCuaDriverActivationResult> {
    return this.activate({ ...input, operation: "check" });
  }

  /**
   * Lease-publish/reconnect hook for the future route composition. It is safe
   * to call for every accepted new generation and is inert without retained
   * enable intent.
   */
  reconcileRequestedIntent(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly signal?: AbortSignal;
  }): Promise<BundledCuaDriverActivationResult | undefined> {
    const { state } = ensureActivationPrerequisites(input);
    return state.requestedEnabled
      ? this.activate({ ...input, operation: "check" })
      : Promise.resolve(undefined);
  }

  async disable(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly reason?: string;
  }): Promise<BundledCuaDriverActivationResult> {
    const { server, state } = ensureActivationPrerequisites(input);
    const requestedRevision = state.requestedEnabled
      ? state.requestedRevision + 1
      : state.requestedRevision;
    const message = input.reason?.trim() || "Cua Driver is disabled.";
    const statusSnapshot = unavailableStatus(
      server,
      input.now,
      message,
      undefined,
      "disabled",
    );
    const healthSnapshot = activationHealth({
      pluginId: input.descriptor.id,
      now: input.now,
      status: "disabled",
      message,
      providerState: "included",
    });
    const committed = input.store.commitCuaDriverActivation({
      pluginId: input.descriptor.id,
      mcpServerId: server.id,
      now: input.now,
      expected: {
        requestedRevision: state.requestedRevision,
        activationEpoch: state.activationEpoch,
      },
      requestedEnabled: false,
      requestedRevision,
      activationEpoch: state.activationEpoch + 1,
      effectiveEnabled: false,
      pluginEnabled: false,
      contributionEnabled: false,
      mcpServerEnabled: false,
      tools: [],
      statusSnapshot,
      healthSnapshot,
      disabledReason: message,
      event: {
        type: "disabled",
        actor: "local-user",
        message,
      },
    });
    if (committed.committed) {
      // Disable is authoritative even if the lease disappeared or rotated.
      // Closing every pooled generation prevents a late active operation from
      // retaining a client after the durable requestedRevision fence advanced.
      await this.options.clientPool.closeAll();
    }
    // A CAS loser does not own the shared generation client; the newer intent
    // that won the fence is responsible for its lifecycle.
    const health = committed.committed
      ? input.store.getManagedPluginHealthSnapshot(input.descriptor.id) ?? healthSnapshot
      : healthSnapshot;
    return {
      statusCode: committed.committed ? 200 : 409,
      committed: committed.committed,
      ...(!committed.committed
        ? { error: "cua_driver_activation_stale", message: "A newer Cua Driver intent won the disable race." }
        : {}),
      linkedMcpServerId: server.id,
      statusSnapshot,
      tools: [],
      health,
    };
  }

  private async activate(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly operation: BundledCuaDriverActivationOperation;
    readonly signal?: AbortSignal;
  }): Promise<BundledCuaDriverActivationResult> {
    const { server, state } = ensureActivationPrerequisites(input);
    if (input.operation === "check" && !state.requestedEnabled) {
      const reset = this.beginAttempt(input, server, state, false);
      return this.disabledCheckResult(input, server, reset.committed);
    }
    const prepared = this.beginAttempt(
      input,
      server,
      state,
      input.operation === "enable" ? true : state.requestedEnabled,
    );
    if (!prepared.committed || !prepared.state) {
      return staleResult(input, server, "A newer Cua Driver intent won before activation started.");
    }

    const lease = this.options.leaseRegistry.getCurrent();
    if (!lease) {
      const health = input.store.getManagedPluginHealthSnapshot(input.descriptor.id)
        ?? activationHealth({
          pluginId: input.descriptor.id,
          now: input.now,
          status: "failed",
          message: "Bundled Cua Driver is waiting for a current Desktop lease.",
          providerState: "desktop_unavailable",
          errorCode: "cua_desktop_lease_unavailable",
        });
      const errorCode = isRecord(health.details) && typeof health.details.errorCode === "string"
        ? health.details.errorCode
        : "cua_desktop_lease_unavailable";
      return {
        statusCode: 409,
        committed: true,
        error: errorCode,
        message: health.message,
        linkedMcpServerId: server.id,
        statusSnapshot: input.store.getMcpStatusSnapshot(server.id),
        tools: [],
        health,
      };
    }

    const token = captureCuaDriverActivationFence(lease, prepared.state);
    const activationServer: McpServer = { ...server, enabled: true };
    let handle: Awaited<ReturnType<CuaDriverClientPool<CuaDriverLeaseMcpClient>["acquire"]>> | undefined;
    // Only a protocol failure durably committed by this attempt owns retiring
    // the shared client. Stale attempts must release their handle and leave the
    // winning same-generation attempt's client intact.
    let closeLeaseClient = false;
    try {
      handle = await this.options.clientPool.acquire(lease);
      const operationSignal = combineAbortSignals(input.signal, handle.signal);
      const checked = await handle.client.check(activationServer, input.now, operationSignal);
      operationSignal.throwIfAborted();
      if (checked.statusSnapshot.status !== "ready") {
        const result = this.finishAttempt({
          input,
          server,
          token,
          statusSnapshot: checked.statusSnapshot,
          tools: [],
          error: checked.statusSnapshot.errorCode ?? "cua_driver_check_failed",
          message: checked.statusSnapshot.message ?? "Bundled Cua Driver check failed.",
        });
        closeLeaseClient = result.committed;
        return result;
      }
      if (!this.isCurrentAttempt(input, token)) {
        return staleResult(input, server, "A newer lease or user intent won after the bundled MCP check.");
      }
      const health = await handle.client.checkHealth(activationServer, input.now, operationSignal);
      operationSignal.throwIfAborted();
      if (health.statusSnapshot.status !== "ready") {
        const result = this.finishAttempt({
          input,
          server,
          token,
          statusSnapshot: health.statusSnapshot,
          tools: [],
          error: health.statusSnapshot.errorCode ?? "cua_driver_health_report_failed",
          message: health.statusSnapshot.message ?? "Bundled Cua Driver health_report failed.",
        });
        closeLeaseClient = result.committed;
        return result;
      }
      if (!this.isCurrentAttempt(input, token)) {
        return staleResult(input, server, "A newer lease or user intent won during health_report.");
      }
      const listed = await handle.client.listTools(activationServer, input.now, operationSignal);
      operationSignal.throwIfAborted();
      if (listed.statusSnapshot.status !== "ready") {
        const result = this.finishAttempt({
          input,
          server,
          token,
          statusSnapshot: listed.statusSnapshot,
          tools: [],
          error: listed.statusSnapshot.errorCode ?? "cua_driver_tool_sync_failed",
          message: listed.statusSnapshot.message ?? "Bundled Cua Driver tool sync failed.",
        });
        closeLeaseClient = result.committed;
        return result;
      }
      const tools = applyBundledCuaDriverToolPolicy(listed.tools);
      return this.finishAttempt({
        input,
        server,
        token,
        statusSnapshot: listed.statusSnapshot,
        tools,
      });
    } catch (error) {
      if (!this.isCurrentAttempt(input, token)) {
        return staleResult(input, server, "A newer lease or user intent won during bundled activation.");
      }
      const incompatibleCatalog = error instanceof BundledCuaDriverToolPolicyError;
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = incompatibleCatalog
        ? "cua_embedded_protocol_mismatch"
        : "cua_desktop_lease_client_failed";
      const result = this.finishAttempt({
        input,
        server,
        token,
        statusSnapshot: unavailableStatus(
          server,
          input.now,
          message,
          errorCode,
          "failed",
        ),
        tools: [],
        error: errorCode,
        message,
      });
      closeLeaseClient = result.committed;
      return result;
    } finally {
      handle?.release();
      if (closeLeaseClient) {
        await this.options.clientPool.closeLease(lease);
      }
    }
  }

  private isCurrentAttempt(
    input: {
      readonly store: RunStore;
      readonly now: string;
    },
    token: ReturnType<typeof captureCuaDriverActivationFence>,
  ): boolean {
    return isCurrentCuaDriverActivationFence({
      token,
      leaseRegistry: this.options.leaseRegistry,
      state: input.store.getCuaDriverActivationState(CUA_DRIVER_PLUGIN_ID),
    });
  }

  private beginAttempt(
    input: {
      readonly store: RunStore;
      readonly descriptor: ManagedPluginDescriptor;
      readonly now: string;
      readonly operation: BundledCuaDriverActivationOperation;
    },
    server: McpServer,
    state: ReturnType<RunStore["ensureCuaDriverActivationState"]>,
    requestedEnabled: boolean,
  ): ReturnType<RunStore["commitCuaDriverActivation"]> {
    const requestedRevision = requestedEnabled === state.requestedEnabled
      ? state.requestedRevision
      : state.requestedRevision + 1;
    const projection = desktopAvailabilityProjection(
      requestedEnabled,
      requestedEnabled ? this.options.getDesktopAvailability?.() : undefined,
    );
    const message = projection.message;
    const statusSnapshot = unavailableStatus(
      server,
      input.now,
      message,
      projection.errorCode,
      requestedEnabled ? "failed" : "disabled",
    );
    return input.store.commitCuaDriverActivation({
      pluginId: input.descriptor.id,
      mcpServerId: server.id,
      now: input.now,
      expected: {
        requestedRevision: state.requestedRevision,
        activationEpoch: state.activationEpoch,
      },
      requestedEnabled,
      requestedRevision,
      activationEpoch: state.activationEpoch + 1,
      effectiveEnabled: false,
      pluginEnabled: false,
      contributionEnabled: false,
      mcpServerEnabled: false,
      tools: [],
      statusSnapshot,
      healthSnapshot: activationHealth({
        pluginId: input.descriptor.id,
        now: input.now,
        status: requestedEnabled ? "failed" : "disabled",
        message,
        providerState: projection.providerState,
        errorCode: statusSnapshot.errorCode,
        ...(projection.details ? { details: projection.details } : {}),
      }),
      disabledReason: requestedEnabled
        ? "Bundled Cua Driver is waiting for Desktop."
        : "Cua Driver is disabled.",
      ...(requestedEnabled !== state.requestedEnabled
        ? {
            event: {
              type: requestedEnabled ? "enabled" as const : "disabled" as const,
              actor: "local-user" as const,
              message: requestedEnabled ? "Cua Driver enable requested." : "Cua Driver disabled.",
            },
          }
        : {}),
    });
  }

  private finishAttempt(input: {
    readonly input: {
      readonly store: RunStore;
      readonly descriptor: ManagedPluginDescriptor;
      readonly now: string;
      readonly operation: BundledCuaDriverActivationOperation;
    };
    readonly server: McpServer;
    readonly token: ReturnType<typeof captureCuaDriverActivationFence>;
    readonly statusSnapshot: McpRuntimeStatusSnapshot;
    readonly tools: readonly ReplaceMcpServerToolInput[];
    readonly error?: string;
    readonly message?: string;
  }): BundledCuaDriverActivationResult {
    const ready = !input.error && input.statusSnapshot.status === "ready";
    const currentLease = this.options.leaseRegistry.getCurrent();
    const message = input.message ?? input.statusSnapshot.message ?? (
      ready ? "Bundled Cua Driver is ready." : "Bundled Cua Driver activation failed."
    );
    const healthSnapshot = activationHealth({
      pluginId: input.input.descriptor.id,
      now: input.input.now,
      status: ready ? "ready" : "failed",
      message,
      providerState: ready
        ? "ready"
        : input.error === "cua_driver_health_report_incompatible"
          || input.error === "cua_embedded_protocol_mismatch"
          ? "incompatible"
          : "desktop_unavailable",
      errorCode: input.error,
      details: {
        desktopInstanceId: input.token.desktopInstanceId,
        desktopInstanceEpoch: input.token.desktopInstanceEpoch,
        generation: input.token.leaseGeneration,
        ...(currentLease
          ? {
              platform: currentLease.platform,
              providerVersion: currentLease.providerVersion,
              providerDistributionRevision: currentLease.distributionRevision,
              providerSealDigest: currentLease.providerSealDigest,
              ...(currentLease.providerCatalogDigest
                ? { providerCatalogDigest: currentLease.providerCatalogDigest }
                : {}),
              ...(currentLease.integrityCoverage
                ? { integrityCoverage: currentLease.integrityCoverage }
                : {}),
              ...(currentLease.platform === "win32" && currentLease.integrityCoverage === "standard"
                ? { limitations: ["elevated_pixel_input", "uwp_send_input"] as const }
                : {}),
            }
          : {}),
      },
    });
    const committed = commitCurrentCuaDriverActivation({
      store: input.input.store,
      leaseRegistry: this.options.leaseRegistry,
      token: input.token,
      projection: {
        pluginId: input.input.descriptor.id,
        mcpServerId: input.server.id,
        now: input.input.now,
        requestedEnabled: true,
        requestedRevision: input.token.requestedRevision,
        activationEpoch: input.token.activationEpoch,
        effectiveEnabled: ready,
        pluginEnabled: ready,
        contributionEnabled: ready,
        mcpServerEnabled: ready,
        tools: ready ? input.tools : [],
        statusSnapshot: input.statusSnapshot,
        healthSnapshot,
        disabledReason: ready ? null : message,
        event: {
          type: input.input.operation === "check" ? "checked" : "enabled",
          actor: "local-user",
          message,
          data: {
            status: healthSnapshot.status,
            toolCount: ready ? input.tools.length : 0,
            generation: input.token.leaseGeneration,
            ...(input.error ? { errorCode: input.error } : {}),
          },
        },
      },
    });
    if (!committed.committed) {
      return staleResult(input.input, input.server, "A newer lease or user intent won during activation.");
    }
    return {
      statusCode: ready ? 200 : 400,
      committed: true,
      ...(input.error ? { error: input.error } : {}),
      ...(!ready || input.message ? { message } : {}),
      linkedMcpServerId: input.server.id,
      statusSnapshot: input.statusSnapshot,
      tools: ready ? input.input.store.listMcpTools({ serverId: input.server.id }) : [],
      health: input.input.store.getManagedPluginHealthSnapshot(input.input.descriptor.id) ?? healthSnapshot,
    };
  }

  private disabledCheckResult(
    input: {
      readonly store: RunStore;
      readonly descriptor: ManagedPluginDescriptor;
      readonly now: string;
    },
    server: McpServer,
    committed: boolean,
  ): BundledCuaDriverActivationResult {
    if (!committed) {
      return staleResult(input, server, "A newer Cua Driver intent won the disabled check.");
    }
    const health = input.store.getManagedPluginHealthSnapshot(input.descriptor.id)
      ?? activationHealth({
        pluginId: input.descriptor.id,
        now: input.now,
        status: "disabled",
        message: "Bundled Cua Driver is included but disabled.",
        providerState: "included",
      });
    return {
      statusCode: 200,
      committed: true,
      linkedMcpServerId: server.id,
      statusSnapshot: input.store.getMcpStatusSnapshot(server.id),
      tools: [],
      health,
    };
  }

  private invalidateProjection(input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
    readonly availability?: DesktopCuaDriverAvailabilityV1;
  }): BundledCuaDriverResetResult {
    let observed = ensureActivationPrerequisites(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { server, state } = observed;
      const projection = desktopAvailabilityProjection(
        state.requestedEnabled,
        input.availability,
      );
      const statusSnapshot = unavailableStatus(
        server,
        input.now,
        projection.message,
        projection.errorCode,
        state.requestedEnabled ? "failed" : "disabled",
      );
      const result = input.store.commitCuaDriverActivation({
        pluginId: input.descriptor.id,
        mcpServerId: server.id,
        now: input.now,
        expected: {
          requestedRevision: state.requestedRevision,
          activationEpoch: state.activationEpoch,
        },
        requestedEnabled: state.requestedEnabled,
        requestedRevision: state.requestedRevision,
        activationEpoch: state.activationEpoch + 1,
        effectiveEnabled: false,
        pluginEnabled: false,
        contributionEnabled: false,
        mcpServerEnabled: false,
        tools: [],
        statusSnapshot,
        healthSnapshot: activationHealth({
          pluginId: input.descriptor.id,
          now: input.now,
          status: state.requestedEnabled ? "failed" : "disabled",
          message: statusSnapshot.message,
          providerState: projection.providerState,
          errorCode: statusSnapshot.errorCode,
          ...(projection.details ? { details: projection.details } : {}),
        }),
        disabledReason: state.requestedEnabled
          ? projection.message
          : "Cua Driver is disabled.",
      });
      if (result.committed) {
        return {
          committed: true,
          requestedEnabled: result.state?.requestedEnabled ?? state.requestedEnabled,
          requestedRevision: result.state?.requestedRevision ?? state.requestedRevision,
          activationEpoch: result.state?.activationEpoch ?? state.activationEpoch + 1,
        };
      }
      observed = {
        server,
        state: result.state ?? input.store.ensureCuaDriverActivationState(
          input.descriptor.id,
          input.now,
        ),
      };
    }
    return {
      committed: false,
      requestedEnabled: observed.state.requestedEnabled,
      requestedRevision: observed.state.requestedRevision,
      activationEpoch: observed.state.activationEpoch,
    };
  }
}

function ensureActivationPrerequisites(input: {
  readonly store: RunStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly now: string;
}): {
  readonly server: McpServer;
  readonly state: ReturnType<RunStore["ensureCuaDriverActivationState"]>;
} {
  if (input.descriptor.id !== CUA_DRIVER_PLUGIN_ID) {
    throw new BundledCuaDriverActivationError("plugin_identity_invalid");
  }
  if (!input.store.getManagedPlugin(input.descriptor.id)) {
    ensureManagedPluginRecord({
      store: input.store,
      descriptor: input.descriptor,
      enabled: false,
      now: input.now,
    });
  }
  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID)
    ?? input.store.createMcpServer(
      createBundledCuaDriverLogicalMcpServerInput(),
      input.now,
    );
  const contribution = input.store.listManagedPluginContributions(input.descriptor.id)
    .find((candidate) => candidate.contributionKind === "mcp-server"
      && candidate.linkedResourceId === server.id);
  if (!contribution) {
    input.store.replaceManagedPluginContributions(input.descriptor.id, [{
      contributionKind: "mcp-server",
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      linkedResourceId: server.id,
      enabled: false,
    }], input.now);
  }
  return {
    server,
    state: input.store.ensureCuaDriverActivationState(input.descriptor.id, input.now),
  };
}

function unavailableStatus(
  server: McpServer,
  now: string,
  message: string,
  errorCode: string | undefined,
  status: "disabled" | "failed",
): McpRuntimeStatusSnapshot {
  return createMcpStatusSnapshot({
    server,
    now,
    status,
    authStatus: createMcpAuthStatus([]),
    message,
    errorCode,
    toolCount: 0,
  });
}

function activationHealth(input: {
  readonly pluginId: string;
  readonly now: string;
  readonly status: "disabled" | "failed" | "ready";
  readonly message?: string;
  readonly providerState: CuaDriverProviderState;
  readonly errorCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): ManagedPluginHealthSnapshot {
  return createPluginHealthSnapshot({
    pluginId: input.pluginId,
    now: input.now,
    status: input.status,
    message: input.message,
    details: {
      providerState: input.providerState,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...input.details,
    },
  });
}

function desktopAvailabilityProjection(
  requestedEnabled: boolean,
  availability: DesktopCuaDriverAvailabilityV1 | undefined,
): {
  readonly providerState: CuaDriverProviderState;
  readonly message: string;
  readonly errorCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  if (!requestedEnabled) {
    return {
      providerState: "included",
      message: "Bundled Cua Driver is included but disabled.",
    };
  }
  const providerState = availability?.providerState ?? "desktop_unavailable";
  const base = availability ? {
    desktopGeneration: availability.generation,
    desktopSequence: availability.sequence,
    platform: availability.platform,
    ...(availability.integrityCoverage
      ? { integrityCoverage: availability.integrityCoverage }
      : {}),
    ...(availability.limitations
      ? { limitations: availability.limitations }
      : {}),
    ...(availability.reason ? { reason: availability.reason } : {}),
  } : undefined;
  switch (providerState) {
    case "included":
      return {
        providerState,
        message: "Bundled Cua Driver is included and waiting for Desktop readiness.",
        errorCode: "cua_desktop_provider_included",
        ...(base ? { details: base } : {}),
      };
    case "permission_required":
      return {
        providerState,
        message: "Ling needs macOS Accessibility and Screen Recording permission.",
        errorCode: "cua_embedded_permission_required",
        ...(base ? { details: base } : {}),
      };
    case "interactive_session_required":
      return {
        providerState,
        message: "Cua Driver needs an unlocked interactive Windows session.",
        errorCode: "cua_windows_interactive_session_required",
        ...(base ? { details: base } : {}),
      };
    case "platform_unavailable":
      return {
        providerState,
        message: "The current platform cannot start the bundled Cua Driver safely.",
        errorCode: "cua_embedded_platform_unavailable",
        ...(base ? { details: base } : {}),
      };
    case "incompatible":
      return {
        providerState,
        message: "The bundled Cua Driver is incompatible with this Ling build.",
        errorCode: "cua_embedded_protocol_mismatch",
        ...(base ? { details: base } : {}),
      };
    case "corrupt":
      return {
        providerState,
        message: "The bundled Cua Driver failed package integrity verification.",
        errorCode: "cua_embedded_artifact_invalid",
        ...(base ? { details: base } : {}),
      };
    case "desktop_unavailable":
      return {
        providerState,
        message: "Bundled Cua Driver is waiting for a current Desktop lease.",
        errorCode: "cua_desktop_lease_unavailable",
        ...(base ? { details: base } : {}),
      };
    default:
      return assertNever(providerState);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported_cua_driver_desktop_availability:${String(value)}`);
}

function staleResult(
  input: {
    readonly store: RunStore;
    readonly descriptor: ManagedPluginDescriptor;
    readonly now: string;
  },
  server: McpServer,
  message: string,
): BundledCuaDriverActivationResult {
  return {
    statusCode: 409,
    committed: false,
    error: "cua_driver_activation_stale",
    message,
    linkedMcpServerId: server.id,
    tools: [],
    health: activationHealth({
      pluginId: input.descriptor.id,
      now: input.now,
      status: "failed",
      message,
      providerState: "desktop_unavailable",
      errorCode: "cua_driver_activation_stale",
    }),
  };
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  generationSignal: AbortSignal,
): AbortSignal {
  return callerSignal
    ? AbortSignal.any([callerSignal, generationSignal])
    : generationSignal;
}
