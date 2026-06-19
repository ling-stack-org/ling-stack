import type { SQLOutputValue } from "node:sqlite";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultTeammateTemplates } from "../../builtin-skill-packs.js";
import type { AiTeammateTemplate } from "../../skill-types.js";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  createBuiltinAiTeammateId,
  createLingAgentSystemTeammate,
  type AiTeammate,
  type CreateAiTeammateInput,
  type ReplaceTeammateSkillBindingInput,
  type TeammateSkillBinding,
} from "../../workspace-types.js";
import { readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { applyLingAgentProtectedFields } from "./teammate-core-store.js";

export interface SqliteTeammateBootstrapCoordinatorPorts {
  readonly hasTable: (tableName: string) => boolean;
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
  readonly createAiTeammate: (input: CreateAiTeammateInput, now: string) => AiTeammate;
  readonly listTeammateSkillBindings: (teammateId: string) => TeammateSkillBinding[];
  readonly replaceTeammateSkillBindings: (
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ) => TeammateSkillBinding[];
  readonly ensureDefaultTeammateMemoryScopes: (teammateId: string, now: string) => void;
  readonly ensureDefaultTeammateMemoryScopesForAll: (now: string) => void;
}

export class SqliteTeammateBootstrapCoordinator {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTeammateBootstrapCoordinatorPorts,
  ) {}

  ensureDefaultAiTeammates(): void {
    if (!this.ports.hasTable("ai_teammates")) {
      return;
    }
    const now = new Date().toISOString();
    this.ensureLingAgentSystemTeammate(now);
    this.ensureLingAgentChannelMemberships(now);
    for (const template of listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID)) {
      const teammateId = createBuiltinAiTeammateId(template.id);
      if (this.hasRetentionTombstone("ai-teammate", teammateId)) {
        continue;
      }
      const existing = this.ports.getAiTeammate(teammateId);
      if (existing) {
        this.backfillTemplateSkillBindings(teammateId, template, now);
        this.ports.ensureDefaultTeammateMemoryScopes(teammateId, now);
        this.migrateLegacyTemplateReferences(template.id, teammateId, now);
        continue;
      }

      this.ports.createAiTeammate(
        {
          id: teammateId,
          templateId: template.id,
          roleKey: template.roleKey,
          displayName: template.name,
          description: template.summary,
          systemPrompt: template.systemPrompt,
          allowedTools: template.allowedTools,
          approvalProfile: template.approvalProfile,
          status: "active",
          pinned: template.id === "engineer" || template.id === "designer",
          hidden: false,
        },
        now,
      );
      this.ports.replaceTeammateSkillBindings(
        teammateId,
        template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
        now,
      );
      this.ports.ensureDefaultTeammateMemoryScopes(teammateId, now);
      this.migrateLegacyTemplateReferences(template.id, teammateId, now);
    }
    this.ports.ensureDefaultTeammateMemoryScopesForAll(now);
  }

  ensureLingAgentChannelMemberships(now: string, channelId?: string): void {
    if (
      !this.ports.hasTable("channels") ||
      !this.ports.hasTable("teammate_channel_memberships") ||
      !this.ports.getAiTeammate(LING_AGENT_ID)
    ) {
      return;
    }
    this.context.database
      .prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?")
      .run(now, LING_AGENT_ID);
    const channels = channelId
      ? this.context.database.prepare("SELECT id FROM channels WHERE id = ?").all(channelId)
      : this.context.database.prepare("SELECT id FROM channels").all();
    const insert = this.context.database.prepare(`
      INSERT OR IGNORE INTO teammate_channel_memberships (
        teammate_id,
        channel_id,
        is_default,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, ?, ?)
    `);
    for (const row of channels as Record<string, SQLOutputValue>[]) {
      insert.run(LING_AGENT_ID, readString(row, "id"), now, now);
    }
    this.ports.ensureDefaultTeammateMemoryScopes(LING_AGENT_ID, now);
  }

  ensureDefaultTeammateMemoryScopesForAll(now: string): void {
    this.ports.ensureDefaultTeammateMemoryScopesForAll(now);
  }

  ensureDefaultTeammateMemoryScopes(teammateId: string, now: string): void {
    this.ports.ensureDefaultTeammateMemoryScopes(teammateId, now);
  }

  private backfillTemplateSkillBindings(teammateId: string, template: AiTeammateTemplate, now: string): boolean {
    const existingSkillIds = new Set(this.ports.listTeammateSkillBindings(teammateId).map((binding) => binding.skillId));
    const missingSkillIds = template.defaultSkillIds.filter((skillId) => !existingSkillIds.has(skillId));
    if (missingSkillIds.length === 0) {
      return false;
    }

    const insert = this.context.database.prepare(`
      INSERT INTO teammate_skill_bindings (
        teammate_id,
        skill_id,
        source,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, 'template', 1, ?, ?)
    `);
    this.context.database.exec("BEGIN");
    try {
      for (const skillId of missingSkillIds) {
        insert.run(teammateId, skillId, now, now);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  private ensureLingAgentSystemTeammate(now: string): AiTeammate {
    const existing = this.ports.getAiTeammate(LING_AGENT_ID);
    if (!existing) {
      const profile = createLingAgentSystemTeammate(now);
      return this.ports.createAiTeammate(
        {
          id: profile.id,
          templateId: profile.templateId,
          roleKey: profile.roleKey,
          displayName: profile.displayName,
          description: profile.description,
          avatarTone: profile.avatarTone,
          avatarImageAttachmentId: profile.avatarImageAttachmentId,
          providerPresetId: profile.providerPresetId,
          runnerId: profile.runnerId,
          systemPrompt: profile.systemPrompt,
          appendSystemPrompt: profile.appendSystemPrompt,
          allowedTools: profile.allowedTools,
          approvalProfile: profile.approvalProfile,
          status: profile.status,
          pinned: profile.pinned,
          hidden: profile.hidden,
        },
        now,
      );
    }

    const next = applyLingAgentProtectedFields(existing);
    this.context.database
      .prepare(`
        UPDATE ai_teammates
        SET
          template_id = ?,
          role_key = ?,
          display_name = ?,
          description = ?,
          avatar_tone = ?,
          avatar_image_attachment_id = ?,
          provider_preset_id = NULL,
          runner_id = NULL,
          system_prompt = ?,
          append_system_prompt_json = ?,
          allowed_tools_json = ?,
          approval_profile_json = ?,
          status = ?,
          pinned = ?,
          hidden = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.templateId ?? null,
        next.roleKey,
        next.displayName,
        next.description,
        next.avatarTone ?? null,
        next.avatarImageAttachmentId ?? null,
        next.systemPrompt ?? null,
        stringifyJson(next.appendSystemPrompt),
        stringifyJson(next.allowedTools),
        stringifyJson(next.approvalProfile),
        next.status,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        now,
        LING_AGENT_ID,
      );
    return this.ports.getAiTeammate(LING_AGENT_ID) ?? next;
  }

  private hasRetentionTombstone(entityType: string, entityId: string): boolean {
    if (!this.ports.hasTable("retention_tombstones")) {
      return false;
    }
    return Boolean(
      this.context.database
        .prepare("SELECT id FROM retention_tombstones WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
        .get(DEFAULT_WORKSPACE_ID, entityType, entityId),
    );
  }

  private migrateLegacyTemplateReferences(templateId: string, teammateId: string, now: string): void {
    this.context.database
      .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
      .run(teammateId, now, templateId);
    this.context.database
      .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
      .run(teammateId, now, templateId);
  }
}
