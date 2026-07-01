import type { SQLOutputValue } from "node:sqlite";
import { readOnlyRunTools } from "../../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelBranchId,
  createChannelId,
  isLingAgentTeammateId,
  normalizeChannelRuntimePolicy,
  type Channel,
  type ChannelBranch,
  type ChannelBranchUpdateInput,
  type ChannelUpdateInput,
  type CreateChannelBranchInput,
  type CreateChannelInput,
  type ListChannelBranchesOptions,
  type ListChannelsOptions,
} from "../../workspace-types.js";
import { nullableUpdate, omitUndefined, stringifyJson } from "./helpers.js";
import { mapChannel, mapChannelBranch } from "./channel-core-mappers.js";
import { channelBranchSelectSql, channelSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelCoreStorePorts {
  readonly ensureLingAgentChannelMemberships: (now: string, channelId?: string) => void;
}

export class SqliteChannelCoreStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelCoreStorePorts,
  ) {}

  createChannel(input: CreateChannelInput, now: string): Channel {
    const channel: Channel = {
      id: input.id ?? createChannelId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: input.name,
      status: input.status ?? "active",
      boundPath: input.boundPath,
      workspaceBinding: input.workspaceBinding,
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultTeammateId: normalizePreferredSpecialistId(input.defaultTeammateId),
      autoReplyMode: input.autoReplyMode ?? "mentions_only",
      responseLanguage: input.responseLanguage,
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      runtimePolicy: normalizeChannelRuntimePolicy(input.runtimePolicy),
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channels (
          id,
          workspace_id,
          name,
          status,
          bound_path,
          default_provider_preset_id,
          default_teammate_id,
          auto_reply_mode,
          response_language,
          allowed_tools_json,
          runtime_policy_json,
          workspace_binding_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        channel.id,
        channel.workspaceId,
        channel.name,
        channel.status,
        channel.boundPath ?? null,
        channel.defaultProviderPresetId ?? null,
        channel.defaultTeammateId ?? null,
        channel.autoReplyMode,
        channel.responseLanguage ?? null,
        stringifyJson(channel.allowedTools),
        stringifyJson(channel.runtimePolicy),
        channel.workspaceBinding ? stringifyJson(channel.workspaceBinding) : null,
        channel.createdAt,
        channel.updatedAt,
      );

    const created = this.getChannel(channel.id);
    if (!created) {
      throw new Error(`Failed to create channel: ${channel.id}`);
    }
    this.ports.ensureLingAgentChannelMemberships(now, channel.id);
    return created;
  }

  getChannel(id: string): Channel | undefined {
    const row = this.context.database.prepare(channelSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannel(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannels(options: ListChannelsOptions = {}): Channel[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const whereParts = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.archived === true) {
      whereParts.push("status = 'archived'");
    } else {
      whereParts.push("status <> 'archived'");
    }
    if (options.defaultProviderPresetId) {
      whereParts.push("default_provider_preset_id = ?");
      params.push(options.defaultProviderPresetId);
    }
    return this.context.database
      .prepare(`${channelSelectSql(`WHERE ${whereParts.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapChannel(row as Record<string, SQLOutputValue>));
  }

  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined {
    const existing = this.getChannel(id);
    if (!existing) {
      return undefined;
    }

    const next: Channel = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      boundPath: nullableUpdate(input.boundPath, existing.boundPath),
      workspaceBinding: nullableUpdate(input.workspaceBinding, existing.workspaceBinding),
      defaultProviderPresetId: nullableUpdate(input.defaultProviderPresetId, existing.defaultProviderPresetId),
      defaultTeammateId: normalizePreferredSpecialistId(nullableUpdate(input.defaultTeammateId, existing.defaultTeammateId)),
      autoReplyMode: input.autoReplyMode === null ? "mentions_only" : input.autoReplyMode ?? existing.autoReplyMode,
      responseLanguage: nullableUpdate(input.responseLanguage, existing.responseLanguage),
      allowedTools: input.allowedTools ?? existing.allowedTools,
      runtimePolicy: input.runtimePolicy ? normalizeChannelRuntimePolicy({ ...existing.runtimePolicy, ...input.runtimePolicy }) : existing.runtimePolicy,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE channels
        SET
          name = ?,
          status = ?,
          bound_path = ?,
          default_provider_preset_id = ?,
          default_teammate_id = ?,
          auto_reply_mode = ?,
          response_language = ?,
          allowed_tools_json = ?,
          runtime_policy_json = ?,
          workspace_binding_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.status,
        next.boundPath ?? null,
        next.defaultProviderPresetId ?? null,
        next.defaultTeammateId ?? null,
        next.autoReplyMode,
        next.responseLanguage ?? null,
        stringifyJson(next.allowedTools),
        stringifyJson(next.runtimePolicy),
        next.workspaceBinding ? stringifyJson(next.workspaceBinding) : null,
        next.updatedAt,
        id,
      );

    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createChannelBranch(input: CreateChannelBranchInput, now: string): ChannelBranch {
    const branch: ChannelBranch = omitUndefined({
      id: input.id ?? createChannelBranchId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      name: input.name,
      status: input.status ?? "active",
      rootThreadId: input.rootThreadId,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.status === "archived" ? input.archivedAt ?? now : input.archivedAt,
      deletedAt: input.deletedAt,
    });

    this.context.database
      .prepare(`
        INSERT INTO channel_branches (
          id,
          workspace_id,
          channel_id,
          name,
          status,
          root_thread_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        branch.id,
        branch.workspaceId,
        branch.channelId,
        branch.name,
        branch.status,
        branch.rootThreadId ?? null,
        branch.createdAt,
        branch.updatedAt,
        branch.archivedAt ?? null,
        branch.deletedAt ?? null,
      );

    const created = this.getChannelBranch(branch.id);
    if (!created) {
      throw new Error(`Failed to create channel branch: ${branch.id}`);
    }
    return created;
  }

  getChannelBranch(id: string): ChannelBranch | undefined {
    const row = this.context.database.prepare(channelBranchSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelBranch(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelBranches(options: ListChannelBranchesOptions = {}): ChannelBranch[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    const whereParts = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      whereParts.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      whereParts.push("status = ?");
      params.push(options.status);
    } else if (options.archived === true) {
      whereParts.push("status = 'archived'");
    } else {
      whereParts.push("status <> 'archived'");
    }

    return this.context.database
      .prepare(`${channelBranchSelectSql(`WHERE ${whereParts.join(" AND ")}`)} ORDER BY created_at ASC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapChannelBranch(row as Record<string, SQLOutputValue>));
  }

  updateChannelBranch(id: string, input: ChannelBranchUpdateInput, now: string): ChannelBranch | undefined {
    const existing = this.getChannelBranch(id);
    if (!existing) {
      return undefined;
    }

    const status = input.status ?? existing.status;
    const archivedAt = input.archivedAt === null
      ? undefined
      : input.archivedAt ?? (status === "archived" ? existing.archivedAt ?? now : existing.archivedAt);
    const deletedAt = nullableUpdate(input.deletedAt, existing.deletedAt);
    const next: ChannelBranch = omitUndefined({
      ...existing,
      name: input.name ?? existing.name,
      status,
      rootThreadId: nullableUpdate(input.rootThreadId, existing.rootThreadId),
      archivedAt: status === "archived" ? archivedAt : undefined,
      deletedAt,
      updatedAt: now,
    });

    this.context.database
      .prepare(`
        UPDATE channel_branches
        SET
          name = ?,
          status = ?,
          root_thread_id = ?,
          updated_at = ?,
          archived_at = ?,
          deleted_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.status,
        next.rootThreadId ?? null,
        next.updatedAt,
        next.archivedAt ?? null,
        next.deletedAt ?? null,
        id,
      );

    return this.getChannelBranch(id);
  }

  deleteChannelBranch(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM channel_branches WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}

function normalizePreferredSpecialistId(teammateId: string | null | undefined): string | undefined {
  if (!teammateId || isLingAgentTeammateId(teammateId)) {
    return undefined;
  }
  return teammateId;
}
