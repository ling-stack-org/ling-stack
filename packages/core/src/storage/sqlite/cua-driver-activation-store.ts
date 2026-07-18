import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type {
  CommitCuaDriverActivationInput,
  CommitCuaDriverActivationResult,
  CuaDriverActivationState,
} from "../../cua-driver-activation-types.js";
import type { SqliteManagedPluginStore } from "./managed-plugin-store.js";
import type { SqliteMcpStore } from "./mcp-store.js";
import { readBoolean, readNumber, readString } from "./helpers.js";

interface CrashableInput extends CommitCuaDriverActivationInput {
  readonly crashAfter?: CommitCuaDriverActivationInput["crashAfter"];
}

/**
 * Owns the durable Cua activation fence.  All projection writes are performed
 * while the caller's SQLite connection holds `BEGIN IMMEDIATE`; no individual
 * store method can publish a partially-ready provider.
 */
export class SqliteCuaDriverActivationStore {
  private readonly database: DatabaseSync;
  private readonly managedPlugins: SqliteManagedPluginStore;
  private readonly mcps: SqliteMcpStore;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly managedPlugins: SqliteManagedPluginStore;
    readonly mcps: SqliteMcpStore;
  }) {
    this.database = input.database;
    this.managedPlugins = input.managedPlugins;
    this.mcps = input.mcps;
  }

  ensureCuaDriverActivationState(pluginId: string, now: string): CuaDriverActivationState {
    this.database
      .prepare(`
        INSERT INTO cua_driver_activation_state (
          plugin_id, requested_enabled, requested_revision, activation_epoch, updated_at
        )
        VALUES (?, COALESCE((SELECT enabled FROM managed_plugins WHERE id = ?), 0), 0, 0, ?)
        ON CONFLICT(plugin_id) DO NOTHING
      `)
      .run(pluginId, pluginId, now);
    const state = this.getCuaDriverActivationState(pluginId);
    if (!state) {
      throw new Error(`Managed Cua Driver plugin is not initialized: ${pluginId}`);
    }
    return state;
  }

  getCuaDriverActivationState(pluginId: string): CuaDriverActivationState | undefined {
    const row = this.database
      .prepare(`
        SELECT plugin_id, requested_enabled, requested_revision, activation_epoch, updated_at
        FROM cua_driver_activation_state
        WHERE plugin_id = ?
      `)
      .get(pluginId) as Record<string, SQLOutputValue> | undefined;
    return row ? mapActivationState(row) : undefined;
  }

  commitCuaDriverActivation(input: CommitCuaDriverActivationInput): CommitCuaDriverActivationResult {
    assertMonotonicProjection(input);
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      began = true;
      const current = this.getCuaDriverActivationState(input.pluginId);
      if (!current
        || current.requestedRevision !== input.expected.requestedRevision
        || current.activationEpoch !== input.expected.activationEpoch) {
        this.database.exec("ROLLBACK");
        began = false;
        return { committed: false, ...(current ? { state: current } : {}) };
      }
      const revisionDelta = input.requestedRevision - current.requestedRevision;
      if (input.requestedEnabled !== current.requestedEnabled
        ? revisionDelta !== 1
        : revisionDelta !== 0) {
        throw new Error("Cua Driver requested intent must advance exactly one revision per toggle.");
      }

      this.mcps.replaceMcpServerTools(input.mcpServerId, input.tools, input.now);
      crash(input, "after_tools");

      if (input.statusSnapshot === null) {
        this.mcps.deleteMcpStatusSnapshot(input.mcpServerId);
        this.mcps.updateMcpServerStatus(input.mcpServerId, { kind: "unknown" }, input.now);
      } else {
        this.mcps.upsertMcpStatusSnapshot(input.statusSnapshot, input.now);
        this.mcps.updateMcpServerStatus(input.mcpServerId, {
          kind: input.statusSnapshot.status === "ready" ? "ready" : input.statusSnapshot.status === "disabled" ? "disabled" : "failed",
          message: input.statusSnapshot.message,
          checkedAt: input.statusSnapshot.checkedAt,
        }, input.now);
      }
      crash(input, "after_status");

      const plugin = this.managedPlugins.updateManagedPlugin(input.pluginId, {
        enabled: input.pluginEnabled,
        disabledReason: input.disabledReason === undefined
          ? input.pluginEnabled ? null : "Cua Driver activation is not ready."
          : input.disabledReason,
      }, input.now);
      if (!plugin) {
        throw new Error(`Managed Cua Driver plugin is not initialized: ${input.pluginId}`);
      }
      crash(input, "after_plugin");

      const contributions = this.managedPlugins.listManagedPluginContributions(input.pluginId);
      this.managedPlugins.replaceManagedPluginContributions(input.pluginId, contributions.map((contribution) => ({
        contributionKind: contribution.contributionKind,
        contributionId: contribution.contributionId,
        linkedResourceId: contribution.linkedResourceId,
        enabled: input.contributionEnabled,
      })), input.now);
      crash(input, "after_contribution");

      const server = this.mcps.updateMcpServer(input.mcpServerId, { enabled: input.mcpServerEnabled }, input.now);
      if (!server) {
        throw new Error(`Managed Cua Driver MCP server is not initialized: ${input.mcpServerId}`);
      }
      crash(input, "after_mcp");

      if (input.healthSnapshot !== undefined) {
        if (input.healthSnapshot === null) {
          this.database.prepare("DELETE FROM managed_plugin_health_snapshots WHERE plugin_id = ?").run(input.pluginId);
        } else {
          this.managedPlugins.upsertManagedPluginHealthSnapshot(input.healthSnapshot, input.now);
        }
      }
      crash(input, "after_health");

      if (input.event) {
        this.managedPlugins.appendManagedPluginEvent({
          pluginId: input.pluginId,
          type: input.event.type,
          actor: input.event.actor,
          message: input.event.message,
          data: input.event.data,
        }, input.now);
      }
      crash(input, "after_event");

      this.database
        .prepare(`
          UPDATE cua_driver_activation_state
          SET requested_enabled = ?, requested_revision = ?, activation_epoch = ?, updated_at = ?
          WHERE plugin_id = ?
        `)
        .run(
          input.requestedEnabled ? 1 : 0,
          input.requestedRevision,
          input.activationEpoch,
          input.now,
          input.pluginId,
        );
      crash(input, "after_fence");
      this.database.exec("COMMIT");
      began = false;
      const next = this.getCuaDriverActivationState(input.pluginId);
      if (!next) {
        throw new Error(`Cua Driver activation fence disappeared after commit: ${input.pluginId}`);
      }
      return { committed: true, state: next };
    } catch (error) {
      if (began) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original failure; SQLite will roll back on close.
        }
      }
      throw error;
    }
  }
}

function mapActivationState(row: Record<string, SQLOutputValue>): CuaDriverActivationState {
  return {
    pluginId: readString(row, "plugin_id"),
    requestedEnabled: readBoolean(row, "requested_enabled"),
    requestedRevision: readNumber(row, "requested_revision"),
    activationEpoch: readNumber(row, "activation_epoch"),
    updatedAt: readString(row, "updated_at"),
  };
}

function assertMonotonicProjection(input: CommitCuaDriverActivationInput): void {
  if (!Number.isSafeInteger(input.expected.requestedRevision) || input.expected.requestedRevision < 0
    || !Number.isSafeInteger(input.expected.activationEpoch) || input.expected.activationEpoch < 0
    || !Number.isSafeInteger(input.requestedRevision) || input.requestedRevision < input.expected.requestedRevision
    || !Number.isSafeInteger(input.activationEpoch) || input.activationEpoch < input.expected.activationEpoch) {
    throw new Error("Invalid Cua Driver activation fence projection.");
  }
  if (input.statusSnapshot && input.statusSnapshot.serverId !== input.mcpServerId) {
    throw new Error("Cua Driver status snapshot does not match the logical MCP server.");
  }
  if (input.healthSnapshot && input.healthSnapshot.pluginId !== input.pluginId) {
    throw new Error("Cua Driver health snapshot does not match the managed plugin.");
  }
  if (!input.effectiveEnabled && input.tools.length > 0) {
    throw new Error("Cua Driver cannot persist tools while effective enablement is false.");
  }
  if (input.pluginEnabled !== input.effectiveEnabled
    || input.contributionEnabled !== input.effectiveEnabled
    || input.mcpServerEnabled !== input.effectiveEnabled) {
    throw new Error("Cua Driver effective enablement must match every linked flag.");
  }
  if (input.effectiveEnabled && !input.requestedEnabled) {
    throw new Error("Cua Driver cannot be effectively enabled without retained user intent.");
  }
}

function crash(input: CrashableInput, point: NonNullable<CrashableInput["crashAfter"]>): void {
  if (input.crashAfter === point) {
    throw new Error(`cua_driver_activation_crash_injected:${point}`);
  }
}
