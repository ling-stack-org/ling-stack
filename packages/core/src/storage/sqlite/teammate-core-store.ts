import type { SQLOutputValue } from "node:sqlite";
import { readOnlyRunTools } from "../../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  LING_AGENT_SYSTEM_PROMPT,
  createAiTeammateId,
  isLingAgentTeammateId,
  lingAgentAllowedTools,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type CreateAiTeammateInput,
  type ListAiTeammatesOptions,
  type TeammatePrivateAttachment,
} from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { normalizeStoredRunnerId } from "./runtime-work-mappers.js";
import { aiTeammateSelectSql } from "./select-sql.js";
import { mapAiTeammate, withSystemTeammateMetadata } from "./teammate-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteTeammateCoreStorePorts {
  readonly ensureDefaultTeammateMemoryScopes: (teammateId: string, now: string) => void;
  readonly ensureDefaultTeammateMemoryScopesForAll: (now: string) => void;
  readonly getTeammatePrivateAttachment: (id: string) => TeammatePrivateAttachment | undefined;
}

export class SqliteTeammateCoreStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTeammateCoreStorePorts,
  ) {}

  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate {
    const teammate: AiTeammate = {
      id: input.id ?? createAiTeammateId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      templateId: input.templateId,
      roleKey: input.roleKey,
      displayName: input.displayName,
      description: input.description,
      avatarTone: input.avatarTone,
      avatarImageAttachmentId: input.avatarImageAttachmentId,
      providerPresetId: input.providerPresetId,
      runnerId: normalizeStoredRunnerId(input.runnerId),
      systemPrompt: input.systemPrompt,
      appendSystemPrompt: input.appendSystemPrompt ?? [],
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      approvalProfile: input.approvalProfile,
      status: input.status ?? "active",
      pinned: input.pinned ?? false,
      hidden: input.hidden ?? false,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO ai_teammates (
          id,
          workspace_id,
          template_id,
          role_key,
          display_name,
          description,
          avatar_tone,
          avatar_image_attachment_id,
          provider_preset_id,
          runner_id,
          system_prompt,
          append_system_prompt_json,
          allowed_tools_json,
          approval_profile_json,
          status,
          pinned,
          hidden,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        teammate.id,
        teammate.workspaceId,
        teammate.templateId ?? null,
        teammate.roleKey,
        teammate.displayName,
        teammate.description,
        teammate.avatarTone ?? null,
        teammate.avatarImageAttachmentId ?? null,
        teammate.providerPresetId ?? null,
        teammate.runnerId ?? null,
        teammate.systemPrompt ?? null,
        stringifyJson(teammate.appendSystemPrompt),
        stringifyJson(teammate.allowedTools),
        stringifyJson(teammate.approvalProfile),
        teammate.status,
        teammate.pinned ? 1 : 0,
        teammate.hidden ? 1 : 0,
        teammate.createdAt,
        teammate.updatedAt,
      );

    const created = this.getAiTeammate(teammate.id);
    if (!created) {
      throw new Error(`Failed to create AI teammate: ${teammate.id}`);
    }
    this.ports.ensureDefaultTeammateMemoryScopes(teammate.id, now);
    return created;
  }

  getAiTeammate(id: string): AiTeammate | undefined {
    const row = this.context.database.prepare(aiTeammateSelectSql("WHERE id = ?")).get(id);
    return row ? mapAiTeammate(row as Record<string, SQLOutputValue>) : undefined;
  }

  listAiTeammates(options: ListAiTeammatesOptions = {}): AiTeammate[] {
    this.ports.ensureDefaultTeammateMemoryScopesForAll(new Date().toISOString());
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeDisabled) {
      clauses.push("status != 'disabled'");
    }
    if (!options.includeHidden) {
      clauses.push("hidden = 0");
    }
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${aiTeammateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned DESC, display_name ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapAiTeammate(row as Record<string, SQLOutputValue>));
  }

  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined {
    const existing = this.getAiTeammate(id);
    if (!existing) {
      return undefined;
    }
    const updateInput = isLingAgentTeammateId(id)
      ? sanitizeLingAgentUpdateInput(input)
      : input;
    if (updateInput.avatarImageAttachmentId !== undefined && updateInput.avatarImageAttachmentId !== null) {
      const avatar = this.ports.getTeammatePrivateAttachment(updateInput.avatarImageAttachmentId);
      if (!avatar || avatar.teammateId !== id || avatar.scope !== "teammate_profile_avatar" || avatar.kind !== "image") {
        throw new Error(`Avatar image attachment does not belong to teammate profile: ${updateInput.avatarImageAttachmentId}`);
      }
    }

    const candidate: AiTeammate = {
      ...existing,
      templateId: nullableUpdate(updateInput.templateId, existing.templateId),
      roleKey: updateInput.roleKey ?? existing.roleKey,
      displayName: updateInput.displayName ?? existing.displayName,
      description: updateInput.description ?? existing.description,
      avatarTone: nullableUpdate(updateInput.avatarTone, existing.avatarTone),
      avatarImageAttachmentId: nullableUpdate(updateInput.avatarImageAttachmentId, existing.avatarImageAttachmentId),
      providerPresetId: nullableUpdate(updateInput.providerPresetId, existing.providerPresetId),
      runnerId: normalizeStoredRunnerId(nullableUpdate(updateInput.runnerId, existing.runnerId)),
      systemPrompt: nullableUpdate(updateInput.systemPrompt, existing.systemPrompt),
      appendSystemPrompt: updateInput.appendSystemPrompt ?? existing.appendSystemPrompt,
      allowedTools: updateInput.allowedTools ?? existing.allowedTools,
      approvalProfile: updateInput.approvalProfile ?? existing.approvalProfile,
      status: updateInput.status ?? existing.status,
      pinned: updateInput.pinned ?? existing.pinned,
      hidden: updateInput.hidden ?? existing.hidden,
      updatedAt: now,
    };
    const next = isLingAgentTeammateId(id) ? applyLingAgentProtectedFields(candidate) : candidate;

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
          provider_preset_id = ?,
          runner_id = ?,
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
        next.providerPresetId ?? null,
        next.runnerId ?? null,
        next.systemPrompt ?? null,
        stringifyJson(next.appendSystemPrompt),
        stringifyJson(next.allowedTools),
        stringifyJson(next.approvalProfile),
        next.status,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        next.updatedAt,
        id,
      );

    return this.getAiTeammate(id);
  }

  disableAiTeammate(id: string, now: string): AiTeammate | undefined {
    if (isLingAgentTeammateId(id)) {
      throw new Error("Ling Agent cannot be disabled.");
    }
    return this.updateAiTeammate(id, { status: "disabled", hidden: true }, now);
  }
}

export function applyLingAgentProtectedFields(teammate: AiTeammate): AiTeammate {
  return withSystemTeammateMetadata({
    ...teammate,
    templateId: LING_AGENT_ID,
    roleKey: "custom",
    providerPresetId: undefined,
    runnerId: undefined,
    systemPrompt: LING_AGENT_SYSTEM_PROMPT,
    allowedTools: lingAgentAllowedTools,
    approvalProfile: { mode: "standard", risk: "medium" },
    status: "active",
    pinned: true,
    hidden: false,
  });
}

function sanitizeLingAgentUpdateInput(input: AiTeammateUpdateInput): AiTeammateUpdateInput {
  const forbiddenFields: (keyof AiTeammateUpdateInput)[] = [
    "templateId",
    "roleKey",
    "providerPresetId",
    "runnerId",
    "systemPrompt",
    "allowedTools",
    "approvalProfile",
    "status",
    "pinned",
    "hidden",
  ];
  const requestedForbidden = forbiddenFields.filter((field) => input[field] !== undefined);
  if (requestedForbidden.length > 0) {
    throw new Error(`Ling Agent protected fields cannot be changed: ${requestedForbidden.join(", ")}`);
  }
  return {
    displayName: input.displayName,
    description: input.description,
    avatarTone: input.avatarTone,
    avatarImageAttachmentId: input.avatarImageAttachmentId,
    appendSystemPrompt: input.appendSystemPrompt,
  };
}
