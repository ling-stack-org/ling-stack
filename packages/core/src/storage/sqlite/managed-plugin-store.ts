import { redactSecrets } from "../../redaction.js";
import {
  createManagedPluginEventId,
  createManagedPluginRuntimeSnapshotId,
  type CreateManagedPluginEventInput,
  type CreateManagedPluginRuntimeSnapshotInput,
  type ListManagedPluginEventsOptions,
  type ListManagedPluginsOptions,
  type ManagedPluginContributionRecord,
  type ManagedPluginEvent,
  type ManagedPluginHealthSnapshot,
  type ManagedPluginPackageRecord,
  type ManagedPluginRecord,
  type ManagedPluginRuntimeSnapshot,
  type UpdateManagedPluginInput,
  type UpsertManagedPluginContributionInput,
  type UpsertManagedPluginInput,
  type UpsertManagedPluginPackageInput,
} from "../../plugin-manager-types.js";
import {
  nullableUpdate,
  readString,
  stringifyJson,
} from "./helpers.js";
import {
  mapManagedPlugin,
  mapManagedPluginContribution,
  mapManagedPluginEvent,
  mapManagedPluginPackage,
  mapManagedPluginRuntimeSnapshot,
  parseManagedPluginHealthSnapshot,
} from "./managed-plugin-mappers.js";
import {
  managedPluginContributionSelectSql,
  managedPluginEventSelectSql,
  managedPluginPackageSelectSql,
  managedPluginRuntimeSnapshotSelectSql,
  managedPluginSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteManagedPluginStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  listManagedPlugins(options: ListManagedPluginsOptions = {}): ManagedPluginRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.sourceKind) {
      clauses.push("source_kind = ?");
      params.push(options.sourceKind);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${managedPluginSelectSql(whereClause)} ORDER BY source_kind ASC, id ASC LIMIT ?`)
      .all(...params)
      .map(mapManagedPlugin);
  }

  getManagedPlugin(pluginId: string): ManagedPluginRecord | undefined {
    const row = this.context.database.prepare(managedPluginSelectSql("WHERE id = ?")).get(pluginId);
    return row ? mapManagedPlugin(row) : undefined;
  }

  upsertManagedPlugin(input: UpsertManagedPluginInput, now: string): ManagedPluginRecord {
    const existing = this.getManagedPlugin(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.context.database
      .prepare(`
        INSERT INTO managed_plugins (
          id,
          source_kind,
          version,
          enabled,
          disabled_reason,
          descriptor_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_kind = excluded.source_kind,
          version = excluded.version,
          enabled = excluded.enabled,
          disabled_reason = excluded.disabled_reason,
          descriptor_json = excluded.descriptor_json,
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.sourceKind,
        input.version,
        input.enabled ? 1 : 0,
        input.disabledReason ?? null,
        stringifyJson(input.descriptor),
        createdAt,
        now,
      );
    const record = this.getManagedPlugin(input.id);
    if (!record) {
      throw new Error(`Failed to persist managed plugin: ${input.id}`);
    }
    return record;
  }

  updateManagedPlugin(pluginId: string, input: UpdateManagedPluginInput, now: string): ManagedPluginRecord | undefined {
    const existing = this.getManagedPlugin(pluginId);
    if (!existing) {
      return undefined;
    }
    const next: ManagedPluginRecord = {
      ...existing,
      version: input.version ?? input.descriptor?.version ?? existing.version,
      enabled: input.enabled ?? existing.enabled,
      disabledReason: nullableUpdate(input.disabledReason, existing.disabledReason),
      descriptor: input.descriptor ?? existing.descriptor,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE managed_plugins
        SET version = ?,
            enabled = ?,
            disabled_reason = ?,
            descriptor_json = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.version,
        next.enabled ? 1 : 0,
        next.disabledReason ?? null,
        stringifyJson(next.descriptor),
        now,
        pluginId,
      );
    return this.getManagedPlugin(pluginId);
  }

  replaceManagedPluginContributions(
    pluginId: string,
    contributions: readonly UpsertManagedPluginContributionInput[],
    now: string,
  ): ManagedPluginContributionRecord[] {
    if (!this.getManagedPlugin(pluginId)) {
      throw new Error(`Managed plugin not found: ${pluginId}`);
    }
    this.context.database.prepare("DELETE FROM managed_plugin_contributions WHERE plugin_id = ?").run(pluginId);
    const insert = this.context.database.prepare(`
      INSERT INTO managed_plugin_contributions (
        plugin_id,
        contribution_kind,
        contribution_id,
        linked_resource_id,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const contribution of dedupeManagedPluginContributionInputs(contributions)) {
      insert.run(
        pluginId,
        contribution.contributionKind,
        contribution.contributionId,
        contribution.linkedResourceId ?? null,
        contribution.enabled === false ? 0 : 1,
        now,
        now,
      );
    }
    return this.listManagedPluginContributions(pluginId);
  }

  listManagedPluginContributions(pluginId?: string): ManagedPluginContributionRecord[] {
    const whereClause = pluginId ? "WHERE plugin_id = ?" : "";
    const params = pluginId ? [pluginId] : [];
    return this.context.database
      .prepare(`${managedPluginContributionSelectSql(whereClause)} ORDER BY plugin_id ASC, contribution_kind ASC, contribution_id ASC`)
      .all(...params)
      .map(mapManagedPluginContribution);
  }

  upsertManagedPluginHealthSnapshot(snapshot: ManagedPluginHealthSnapshot, now: string): ManagedPluginHealthSnapshot {
    if (!this.getManagedPlugin(snapshot.pluginId)) {
      throw new Error(`Managed plugin not found: ${snapshot.pluginId}`);
    }
    this.context.database
      .prepare(`
        INSERT INTO managed_plugin_health_snapshots (
          plugin_id,
          status_json,
          checked_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          status_json = excluded.status_json,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(snapshot.pluginId, stringifyJson(snapshot), snapshot.checkedAt, snapshot.expiresAt, now, now);
    const stored = this.getManagedPluginHealthSnapshot(snapshot.pluginId);
    if (!stored) {
      throw new Error(`Failed to persist managed plugin health snapshot: ${snapshot.pluginId}`);
    }
    return stored;
  }

  getManagedPluginHealthSnapshot(pluginId: string, now?: string): ManagedPluginHealthSnapshot | undefined {
    const row = this.context.database
      .prepare("SELECT status_json, expires_at FROM managed_plugin_health_snapshots WHERE plugin_id = ?")
      .get(pluginId);
    if (!row) {
      return undefined;
    }
    const snapshot = parseManagedPluginHealthSnapshot(readString(row, "status_json"));
    const expiresAt = readString(row, "expires_at");
    if (now && expiresAt <= now) {
      return {
        ...snapshot,
        status: "expired",
        message: snapshot.message ?? "Plugin health snapshot expired.",
      };
    }
    return snapshot;
  }

  appendManagedPluginEvent(input: CreateManagedPluginEventInput, now: string): ManagedPluginEvent {
    if (!this.getManagedPlugin(input.pluginId)) {
      throw new Error(`Managed plugin not found: ${input.pluginId}`);
    }
    const event: ManagedPluginEvent = {
      id: input.id ?? createManagedPluginEventId(),
      pluginId: input.pluginId,
      type: input.type,
      actor: input.actor ?? "local-user",
      message: input.message,
      data: input.data,
      createdAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO managed_plugin_events (
          id,
          plugin_id,
          type,
          actor,
          message,
          data_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.pluginId,
        event.type,
        event.actor,
        event.message ?? null,
        event.data === undefined ? null : stringifyJson(redactSecrets(redactManagedPluginEventData(event.data))),
        event.createdAt,
      );
    return event;
  }

  listManagedPluginEvents(options: ListManagedPluginEventsOptions = {}): ManagedPluginEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.pluginId) {
      clauses.push("plugin_id = ?");
      params.push(options.pluginId);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${managedPluginEventSelectSql(whereClause)} ORDER BY created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapManagedPluginEvent);
  }

  upsertManagedPluginPackage(input: UpsertManagedPluginPackageInput, now: string): ManagedPluginPackageRecord {
    const existing = this.getManagedPluginPackage(input.pluginId);
    const installedAt = input.installedAt ?? existing?.installedAt ?? now;
    const status = input.status ?? "installed";
    this.context.database
      .prepare(`
        INSERT INTO managed_plugin_packages (
          plugin_id,
          source_kind,
          version,
          status,
          cache_ref,
          package_hash,
          manifest_json,
          installed_at,
          updated_at,
          uninstalled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          source_kind = excluded.source_kind,
          version = excluded.version,
          status = excluded.status,
          cache_ref = excluded.cache_ref,
          package_hash = excluded.package_hash,
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at,
          uninstalled_at = excluded.uninstalled_at
      `)
      .run(
        input.pluginId,
        input.sourceKind,
        input.version,
        status,
        input.cacheRef,
        input.packageHash ?? null,
        input.manifestJson,
        installedAt,
        now,
        input.uninstalledAt ?? null,
      );
    const record = this.getManagedPluginPackage(input.pluginId);
    if (!record) {
      throw new Error(`Failed to persist managed plugin package: ${input.pluginId}`);
    }
    return record;
  }

  markManagedPluginPackageUninstalled(pluginId: string, now: string): ManagedPluginPackageRecord | undefined {
    const existing = this.getManagedPluginPackage(pluginId);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE managed_plugin_packages
        SET status = 'uninstalled',
            updated_at = ?,
            uninstalled_at = ?
        WHERE plugin_id = ?
      `)
      .run(now, now, pluginId);
    return this.getManagedPluginPackage(pluginId);
  }

  getManagedPluginPackage(pluginId: string): ManagedPluginPackageRecord | undefined {
    const row = this.context.database.prepare(managedPluginPackageSelectSql("WHERE plugin_id = ?")).get(pluginId);
    return row ? mapManagedPluginPackage(row) : undefined;
  }

  listManagedPluginPackages(options: { readonly status?: ManagedPluginPackageRecord["status"] } = {}): ManagedPluginPackageRecord[] {
    const whereClause = options.status ? "WHERE status = ?" : "";
    const params = options.status ? [options.status] : [];
    return this.context.database
      .prepare(`${managedPluginPackageSelectSql(whereClause)} ORDER BY source_kind ASC, plugin_id ASC`)
      .all(...params)
      .map(mapManagedPluginPackage);
  }

  createManagedPluginRuntimeSnapshot(input: CreateManagedPluginRuntimeSnapshotInput): ManagedPluginRuntimeSnapshot {
    const snapshot: ManagedPluginRuntimeSnapshot = {
      id: input.id ?? createManagedPluginRuntimeSnapshotId(),
      runId: input.runId,
      cwd: input.cwd,
      pluginIds: input.pluginIds ?? input.capabilities.map((item) => item.pluginId),
      capabilities: input.capabilities,
      policyOverlays: input.policyOverlays,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.context.database
      .prepare(`
        INSERT INTO managed_plugin_runtime_snapshots (
          id,
          run_id,
          cwd,
          plugin_ids_json,
          capabilities_json,
          policy_overlays_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.runId ?? null,
        snapshot.cwd,
        stringifyJson(snapshot.pluginIds),
        stringifyJson(snapshot.capabilities),
        stringifyJson(snapshot.policyOverlays),
        snapshot.createdAt,
      );
    return snapshot;
  }

  getManagedPluginRuntimeSnapshot(id: string): ManagedPluginRuntimeSnapshot | undefined {
    const row = this.context.database.prepare(managedPluginRuntimeSnapshotSelectSql("WHERE id = ?")).get(id);
    return row ? mapManagedPluginRuntimeSnapshot(row) : undefined;
  }

  getManagedPluginRuntimeSnapshotForRun(runId: string): ManagedPluginRuntimeSnapshot | undefined {
    const row = this.context.database
      .prepare(`${managedPluginRuntimeSnapshotSelectSql("WHERE run_id = ?")} ORDER BY created_at DESC LIMIT 1`)
      .get(runId);
    return row ? mapManagedPluginRuntimeSnapshot(row) : undefined;
  }
}

function dedupeManagedPluginContributionInputs(
  contributions: readonly UpsertManagedPluginContributionInput[],
): readonly UpsertManagedPluginContributionInput[] {
  const byContribution = new Map<string, UpsertManagedPluginContributionInput>();
  for (const contribution of contributions) {
    byContribution.set(`${contribution.contributionKind}:${contribution.contributionId}`, contribution);
  }
  return [...byContribution.values()];
}

function redactManagedPluginEventData(value: unknown): unknown {
  return redactManagedPluginEventValue(value, new WeakSet<object>());
}

function redactManagedPluginEventValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return looksLikeLocalPath(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactManagedPluginEventValue(item, seen));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = shouldRedactManagedPluginEventKey(key)
        ? "[REDACTED]"
        : redactManagedPluginEventValue(item, seen);
    }
    return result;
  }
  return value;
}

function shouldRedactManagedPluginEventKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "command" ||
    normalized.endsWith("command") ||
    normalized.endsWith("path") ||
    normalized.endsWith("root") ||
    normalized.endsWith("binary")
  );
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}
