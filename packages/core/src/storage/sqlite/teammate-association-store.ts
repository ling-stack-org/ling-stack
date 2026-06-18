import type { SQLOutputValue } from "node:sqlite";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultTeammateTemplates } from "../../builtin-skill-packs.js";
import {
  DEFAULT_WORKSPACE_ID,
  createTeammateMemoryScopeId,
  defaultChannelTeammateMemoryScopeKinds,
  defaultPrivateTeammateMemoryScopeKinds,
  isLingAgentTeammateId,
  type AiTeammate,
  type Channel,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type TeammateChannelMembership,
  type TeammateMemoryScope,
  type TeammateMemoryScopeKind,
  type TeammateSkillBinding,
} from "../../workspace-types.js";
import { readNumber, readString } from "./helpers.js";
import { teammateChannelMembershipSelectSql, teammateMemoryScopeSelectSql, teammateSkillBindingSelectSql } from "./select-sql.js";
import { mapTeammateChannelMembership, mapTeammateMemoryScope, mapTeammateSkillBinding } from "./teammate-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteTeammateAssociationStorePorts {
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
  readonly getChannel: (id: string) => Channel | undefined;
  readonly hasTable: (tableName: string) => boolean;
}

export class SqliteTeammateAssociationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTeammateAssociationStorePorts,
  ) {}

  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[] {
    return this.context.database
      .prepare(`${teammateChannelMembershipSelectSql("WHERE teammate_id = ?")} ORDER BY created_at ASC`)
      .all(teammateId)
      .map((row) => mapTeammateChannelMembership(row as Record<string, SQLOutputValue>));
  }

  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[] {
    if (!this.ports.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    if (isLingAgentTeammateId(teammateId)) {
      throw new Error("Ling Agent channel membership is protected.");
    }

    const normalized = dedupeMembershipInputs(memberships);
    for (const membership of normalized) {
      if (!this.ports.getChannel(membership.channelId)) {
        throw new Error(`Channel not found: ${membership.channelId}`);
      }
    }

    this.context.database.exec("BEGIN");
    try {
      this.context.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ?").run(teammateId);
      this.context.database.prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?").run(now, teammateId);
      const insert = this.context.database.prepare(`
        INSERT INTO teammate_channel_memberships (
          teammate_id,
          channel_id,
          is_default,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const membership of normalized) {
        insert.run(teammateId, membership.channelId, membership.isDefault ? 1 : 0, now, now);
        if (membership.isDefault) {
          this.context.database.prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE id = ?").run(teammateId, now, membership.channelId);
        }
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    this.ensureDefaultTeammateMemoryScopes(teammateId, now);
    return this.listTeammateChannelMemberships(teammateId);
  }

  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[] {
    return this.context.database
      .prepare(`${teammateSkillBindingSelectSql("WHERE teammate_id = ?")} ORDER BY skill_id ASC`)
      .all(teammateId)
      .map((row) => mapTeammateSkillBinding(row as Record<string, SQLOutputValue>));
  }

  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[] {
    const teammate = this.ports.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    if (isLingAgentTeammateId(teammateId)) {
      throw new Error("Ling Agent skill bindings are protected.");
    }

    const existing = this.listTeammateSkillBindings(teammateId);
    const normalized = protectDefaultSkillBindings(teammate, existing, dedupeSkillBindingInputs(bindings));
    this.context.database.exec("BEGIN");
    try {
      this.context.database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(teammateId);
      const insert = this.context.database.prepare(`
        INSERT INTO teammate_skill_bindings (
          teammate_id,
          skill_id,
          source,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const binding of normalized) {
        insert.run(teammateId, binding.skillId, binding.source ?? "user", binding.enabled === false ? 0 : 1, now, now);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateSkillBindings(teammateId);
  }

  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[] {
    this.ensureDefaultTeammateMemoryScopes(teammateId, new Date().toISOString());
    return this.context.database
      .prepare(`${teammateMemoryScopeSelectSql("WHERE teammate_id = ?")} ORDER BY CASE WHEN channel_id IS NULL THEN 0 ELSE 1 END ASC, channel_id ASC, kind ASC, created_at ASC`)
      .all(teammateId)
      .map((row) => mapTeammateMemoryScope(row as Record<string, SQLOutputValue>));
  }

  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[] {
    if (!this.ports.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    if (isLingAgentTeammateId(teammateId)) {
      throw new Error("Ling Agent memory scopes are protected.");
    }
    if (scopes.some((scope) => scope.enabled === false)) {
      throw new Error("Teammate memory is always enabled.");
    }
    for (const scope of scopes) {
      if (scope.channelId && !this.ports.getChannel(scope.channelId)) {
        throw new Error(`Channel not found: ${scope.channelId}`);
      }
    }
    const normalized = mergeDefaultTeammateMemoryScopeInputs(
      scopes,
      this.listTeammateChannelMemberships(teammateId).map((membership) => membership.channelId),
    );

    this.context.database.exec("BEGIN");
    try {
      this.context.database.prepare("DELETE FROM teammate_memory_scopes WHERE teammate_id = ?").run(teammateId);
      const insert = this.context.database.prepare(`
        INSERT INTO teammate_memory_scopes (
          id,
          teammate_id,
          kind,
          channel_id,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const scope of normalized) {
        insert.run(scope.id ?? createTeammateMemoryScopeId(), teammateId, scope.kind, scope.channelId ?? null, 1, now, now);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateMemoryScopes(teammateId);
  }

  ensureDefaultTeammateMemoryScopesForAll(now: string): void {
    if (!this.ports.hasTable("ai_teammates") || !this.ports.hasTable("teammate_memory_scopes")) {
      return;
    }
    const teammates = this.context.database.prepare("SELECT id FROM ai_teammates").all() as Record<string, SQLOutputValue>[];
    for (const teammate of teammates) {
      this.ensureDefaultTeammateMemoryScopes(readString(teammate, "id"), now);
    }
  }

  ensureDefaultTeammateMemoryScopes(teammateId: string, now: string): void {
    if (!this.ports.hasTable("ai_teammates") || !this.ports.hasTable("teammate_memory_scopes") || !this.ports.getAiTeammate(teammateId)) {
      return;
    }
    const channelIds = this.ports.hasTable("teammate_channel_memberships")
      ? (this.context.database
        .prepare("SELECT channel_id FROM teammate_channel_memberships WHERE teammate_id = ? ORDER BY created_at ASC")
        .all(teammateId) as Record<string, SQLOutputValue>[])
        .map((row) => readString(row, "channel_id"))
      : [];
    const requiredScopes = mergeDefaultTeammateMemoryScopeInputs([], channelIds);
    const findPrivateScope = this.context.database.prepare(`
      SELECT id, enabled
      FROM teammate_memory_scopes
      WHERE teammate_id = ?
        AND kind = ?
        AND channel_id IS NULL
      LIMIT 1
    `);
    const findChannelScope = this.context.database.prepare(`
      SELECT id, enabled
      FROM teammate_memory_scopes
      WHERE teammate_id = ?
        AND kind = ?
        AND channel_id = ?
      LIMIT 1
    `);
    const existingChannelScopes = this.context.database.prepare(`
      SELECT id, channel_id, kind
      FROM teammate_memory_scopes
      WHERE teammate_id = ?
        AND channel_id IS NOT NULL
    `);
    const deleteScope = this.context.database.prepare("DELETE FROM teammate_memory_scopes WHERE id = ?");
    const insert = this.context.database.prepare(`
      INSERT INTO teammate_memory_scopes (
        id,
        teammate_id,
        kind,
        channel_id,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    const update = this.context.database.prepare("UPDATE teammate_memory_scopes SET enabled = 1, updated_at = ? WHERE id = ?");
    this.context.database.exec("BEGIN");
    try {
      const currentChannelIds = new Set(channelIds);
      for (const row of existingChannelScopes.all(teammateId) as Record<string, SQLOutputValue>[]) {
        const kind = readString(row, "kind") as TeammateMemoryScopeKind;
        const channelId = readString(row, "channel_id");
        if (defaultChannelTeammateMemoryScopeKinds.includes(kind) && !currentChannelIds.has(channelId)) {
          deleteScope.run(readString(row, "id"));
        }
      }
      for (const scope of requiredScopes) {
        const existing = scope.channelId
          ? findChannelScope.get(teammateId, scope.kind, scope.channelId)
          : findPrivateScope.get(teammateId, scope.kind);
        if (existing) {
          if (readNumber(existing as Record<string, SQLOutputValue>, "enabled") !== 1) {
            update.run(now, readString(existing as Record<string, SQLOutputValue>, "id"));
          }
          continue;
        }
        insert.run(createTeammateMemoryScopeId(), teammateId, scope.kind, scope.channelId ?? null, now, now);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mergeDefaultTeammateMemoryScopeInputs(
  scopes: readonly ReplaceTeammateMemoryScopeInput[],
  channelIds: readonly string[],
): readonly ReplaceTeammateMemoryScopeInput[] {
  const merged = new Map<string, ReplaceTeammateMemoryScopeInput>();
  const add = (scope: ReplaceTeammateMemoryScopeInput): void => {
    const channelId = scope.channelId?.trim() || undefined;
    const key = `${scope.kind}:${channelId ?? ""}`;
    if (!merged.has(key)) {
      merged.set(key, {
        id: scope.id,
        kind: scope.kind,
        channelId,
        enabled: true,
      });
    }
  };
  for (const kind of defaultPrivateTeammateMemoryScopeKinds) {
    add({ kind, enabled: true });
  }
  for (const channelId of [...new Set(channelIds.map((id) => id.trim()).filter(Boolean))]) {
    for (const kind of defaultChannelTeammateMemoryScopeKinds) {
      add({ kind, channelId, enabled: true });
    }
  }
  for (const scope of scopes) {
    add(scope);
  }
  return [...merged.values()];
}

function dedupeMembershipInputs(
  memberships: readonly ReplaceTeammateChannelMembershipInput[],
): readonly ReplaceTeammateChannelMembershipInput[] {
  const byChannel = new Map<string, ReplaceTeammateChannelMembershipInput>();
  for (const membership of memberships) {
    byChannel.set(membership.channelId, membership);
  }
  return [...byChannel.values()];
}

function dedupeSkillBindingInputs(
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }
  return [...bySkill.values()];
}

function protectDefaultSkillBindings(
  teammate: AiTeammate,
  existing: readonly TeammateSkillBinding[],
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }

  const template = teammate.templateId
    ? listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID).find((item) => item.id === teammate.templateId)
    : undefined;
  if (!template) {
    return [...bySkill.values()];
  }

  const existingBySkill = new Map(existing.map((binding) => [binding.skillId, binding]));
  for (const skillId of template.defaultSkillIds) {
    const requested = bySkill.get(skillId);
    const previous = existingBySkill.get(skillId);
    bySkill.set(skillId, {
      skillId,
      source: "template",
      enabled: requested?.enabled ?? previous?.enabled ?? true,
    });
  }
  return [...bySkill.values()];
}
