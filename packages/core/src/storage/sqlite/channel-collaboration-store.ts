import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  ChannelDecisionStatusConflictError,
  ChannelDecisionSupersessionConflictError,
  createChannelBriefId,
  createChannelDecisionId,
  createChannelHandoffId,
  type ChannelBrief,
  type ChannelDecision,
  type ChannelHandoff,
  type CreateChannelDecisionInput,
  type CreateOrReuseSupersedingChannelDecisionResult,
  type CreateSupersedingChannelDecisionInput,
  type CreateChannelHandoffInput,
  type ListChannelDecisionsOptions,
  type ListChannelHandoffsOptions,
  type RejectActiveChannelDecisionInput,
  type UpdateChannelBriefInput,
  type UpdateChannelDecisionInput,
  type UpdateChannelHandoffInput,
} from "../../workspace-types.js";
import { nullableUpdate, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import {
  mapChannelBrief,
  mapChannelDecision,
  mapChannelHandoff,
} from "./channel-collaboration-mappers.js";
import {
  channelBriefSelectSql,
  channelDecisionSelectSql,
  channelHandoffSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelCollaborationStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly assertSourceRefsInChannel: (
    channelId: string,
    input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
  ) => void;
  readonly assertAttachmentInChannel: (channelId: string, attachmentId: string) => void;
  readonly assertLinkPreviewInChannel: (channelId: string, linkPreviewId: string) => void;
}

function isEquivalentSupersedingDecision(
  existing: ChannelDecision,
  input: CreateSupersedingChannelDecisionInput,
): boolean {
  return existing.channelId === input.channelId &&
    existing.supersedesDecisionId === input.supersedesDecisionId &&
    existing.sourceMessageId === input.sourceMessageId &&
    existing.sourceTaskId === input.sourceTaskId &&
    existing.sourceRunId === input.sourceRunId &&
    existing.title === input.title &&
    existing.decision === input.decision &&
    existing.rationale === (input.rationale ?? "") &&
    existing.createdBy === input.createdBy &&
    existing.alternatives.length === (input.alternatives?.length ?? 0) &&
    existing.alternatives.every((alternative, index) => alternative === input.alternatives?.[index]);
}

export class SqliteChannelCollaborationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelCollaborationStorePorts,
  ) {}

  getChannelBrief(channelId: string): ChannelBrief | undefined {
    const row = this.context.database.prepare(channelBriefSelectSql("WHERE channel_id = ?")).get(channelId);
    return row ? mapChannelBrief(row as Record<string, SQLOutputValue>) : undefined;
  }

  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief {
    this.ports.assertChannelExists(channelId);
    for (const decisionId of input.decisionIds ?? []) {
      this.assertDecisionInChannel(channelId, decisionId);
    }
    for (const attachmentId of input.attachmentIds ?? []) {
      this.ports.assertAttachmentInChannel(channelId, attachmentId);
    }
    for (const linkPreviewId of input.linkPreviewIds ?? []) {
      this.ports.assertLinkPreviewInChannel(channelId, linkPreviewId);
    }

    const existing = this.getChannelBrief(channelId);
    const brief: ChannelBrief = {
      id: existing?.id ?? createChannelBriefId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId,
      objective: input.objective,
      scope: input.scope,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      risks: input.risks ?? [],
      decisionIds: input.decisionIds ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_briefs (
          id,
          workspace_id,
          channel_id,
          objective,
          scope,
          acceptance_criteria_json,
          open_questions_json,
          risks_json,
          decision_ids_json,
          attachment_ids_json,
          link_preview_ids_json,
          updated_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          objective = excluded.objective,
          scope = excluded.scope,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          open_questions_json = excluded.open_questions_json,
          risks_json = excluded.risks_json,
          decision_ids_json = excluded.decision_ids_json,
          attachment_ids_json = excluded.attachment_ids_json,
          link_preview_ids_json = excluded.link_preview_ids_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(
        brief.id,
        brief.workspaceId,
        brief.channelId,
        brief.objective,
        brief.scope,
        stringifyJson(brief.acceptanceCriteria),
        stringifyJson(brief.openQuestions),
        stringifyJson(brief.risks),
        stringifyJson(brief.decisionIds),
        stringifyJson(brief.attachmentIds),
        stringifyJson(brief.linkPreviewIds),
        brief.updatedBy,
        brief.createdAt,
        brief.updatedAt,
      );

    const updated = this.getChannelBrief(channelId);
    if (!updated) {
      throw new Error(`Failed to update channel brief: ${channelId}`);
    }
    return updated;
  }

  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision {
    if (input.supersedesDecisionId) {
      return this.createOrReuseSupersedingChannelDecision(
        { ...input, supersedesDecisionId: input.supersedesDecisionId },
        now,
      ).decision;
    }
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertSourceRefsInChannel(input.channelId, input);
    return this.insertChannelDecision(input, now);
  }

  createOrReuseSupersedingChannelDecision(
    input: CreateSupersedingChannelDecisionInput,
    now: string,
  ): CreateOrReuseSupersedingChannelDecisionResult {
    if (input.status !== undefined && input.status !== "active") {
      throw new Error("Superseding channel decisions must be active");
    }
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertSourceRefsInChannel(input.channelId, input);
    this.assertDecisionInChannel(input.channelId, input.supersedesDecisionId);

    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const existingSuccessor = this.getSupersedingChannelDecision(input.supersedesDecisionId);
      if (existingSuccessor) {
        if (!isEquivalentSupersedingDecision(existingSuccessor, input)) {
          throw new ChannelDecisionSupersessionConflictError(input.supersedesDecisionId, existingSuccessor.id);
        }
        this.context.database.exec("COMMIT;");
        return { decision: existingSuccessor, reused: true };
      }

      const supersededDecision = this.getChannelDecision(input.supersedesDecisionId);
      if (!supersededDecision || supersededDecision.channelId !== input.channelId || supersededDecision.status !== "active") {
        throw new ChannelDecisionSupersessionConflictError(input.supersedesDecisionId);
      }

      const transition = this.context.database
        .prepare(`
          UPDATE channel_decisions
          SET status = 'superseded', updated_at = ?
          WHERE id = ? AND workspace_id = ? AND channel_id = ? AND status = 'active'
        `)
        .run(now, input.supersedesDecisionId, DEFAULT_WORKSPACE_ID, input.channelId);
      if (transition.changes !== 1) {
        const racedSuccessor = this.getSupersedingChannelDecision(input.supersedesDecisionId);
        throw new ChannelDecisionSupersessionConflictError(input.supersedesDecisionId, racedSuccessor?.id);
      }

      const decision = this.insertChannelDecision({ ...input, status: "active" }, now);
      this.context.database.exec("COMMIT;");
      return { decision, reused: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private insertChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision {

    const decision: ChannelDecision = {
      id: createChannelDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? "",
      alternatives: input.alternatives ?? [],
      status: input.supersedesDecisionId ? "active" : input.status ?? "active",
      supersedesDecisionId: input.supersedesDecisionId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_decisions (
          id,
          workspace_id,
          channel_id,
          source_item_id,
          source_task_id,
          source_run_id,
          title,
          decision,
          rationale,
          alternatives_json,
          status,
          supersedes_decision_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId ?? null,
        decision.sourceTaskId ?? null,
        decision.sourceRunId ?? null,
        decision.title,
        decision.decision,
        decision.rationale,
        stringifyJson(decision.alternatives),
        decision.status,
        decision.supersedesDecisionId ?? null,
        decision.createdBy,
        decision.createdAt,
        decision.updatedAt,
      );

    const created = this.getChannelDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel decision: ${decision.id}`);
    }
    return created;
  }

  private getSupersedingChannelDecision(supersedesDecisionId: string): ChannelDecision | undefined {
    const row = this.context.database
      .prepare(channelDecisionSelectSql("WHERE supersedes_decision_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1"))
      .get(supersedesDecisionId);
    return row ? mapChannelDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  getChannelDecision(id: string): ChannelDecision | undefined {
    const row = this.context.database.prepare(channelDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelDecision(row as Record<string, SQLOutputValue>));
  }

  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined {
    const existing = this.getChannelDecision(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelDecision = {
      ...existing,
      title: input.title ?? existing.title,
      decision: input.decision ?? existing.decision,
      rationale: input.rationale ?? existing.rationale,
      alternatives: input.alternatives ?? existing.alternatives,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE channel_decisions
        SET title = ?, decision = ?, rationale = ?, alternatives_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.decision, next.rationale, stringifyJson(next.alternatives), next.status, next.updatedAt, id);
    return this.getChannelDecision(id);
  }

  rejectActiveChannelDecision(
    id: string,
    input: RejectActiveChannelDecisionInput,
    now: string,
  ): ChannelDecision | undefined {
    const result = this.context.database
      .prepare(`
        UPDATE channel_decisions
        SET
          title = COALESCE(?, title),
          decision = COALESCE(?, decision),
          rationale = COALESCE(?, rationale),
          alternatives_json = COALESCE(?, alternatives_json),
          status = 'rejected',
          updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'active'
      `)
      .run(
        input.title ?? null,
        input.decision ?? null,
        input.rationale ?? null,
        input.alternatives === undefined ? null : stringifyJson(input.alternatives),
        now,
        id,
        DEFAULT_WORKSPACE_ID,
      );
    if (result.changes === 1) {
      return this.getChannelDecision(id);
    }
    const existing = this.getChannelDecision(id);
    if (!existing) {
      return undefined;
    }
    throw new ChannelDecisionStatusConflictError(id, "active", existing.status);
  }

  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff {
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertSourceRefsInChannel(input.channelId, input);
    const handoff: ChannelHandoff = {
      id: createChannelHandoffId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      fromParticipantId: input.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      reason: input.reason,
      requiredInput: input.requiredInput,
      expectedOutput: input.expectedOutput,
      status: input.status ?? "proposed",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_handoffs (
          id,
          workspace_id,
          channel_id,
          source_item_id,
          source_task_id,
          source_run_id,
          from_participant_id,
          from_participant_label,
          to_participant_id,
          to_participant_label,
          reason,
          required_input,
          expected_output,
          status,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        handoff.id,
        handoff.workspaceId,
        handoff.channelId,
        handoff.sourceMessageId ?? null,
        handoff.sourceTaskId ?? null,
        handoff.sourceRunId ?? null,
        handoff.fromParticipantId,
        handoff.fromParticipantLabel,
        handoff.toParticipantId,
        handoff.toParticipantLabel,
        handoff.reason,
        handoff.requiredInput,
        handoff.expectedOutput,
        handoff.status,
        handoff.createdBy,
        handoff.createdAt,
        handoff.updatedAt,
      );

    const created = this.getChannelHandoff(handoff.id);
    if (!created) {
      throw new Error(`Failed to create channel handoff: ${handoff.id}`);
    }
    return created;
  }

  getChannelHandoff(id: string): ChannelHandoff | undefined {
    const row = this.context.database.prepare(channelHandoffSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelHandoff(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelHandoffSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelHandoff(row as Record<string, SQLOutputValue>));
  }

  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined {
    const existing = this.getChannelHandoff(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelHandoff = {
      ...existing,
      fromParticipantId: input.fromParticipantId ?? existing.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel ?? existing.fromParticipantLabel,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE channel_handoffs
        SET
          from_participant_id = ?,
          from_participant_label = ?,
          to_participant_id = ?,
          to_participant_label = ?,
          reason = ?,
          required_input = ?,
          expected_output = ?,
          status = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.fromParticipantId,
        next.fromParticipantLabel,
        next.toParticipantId,
        next.toParticipantLabel,
        next.reason,
        next.requiredInput,
        next.expectedOutput,
        next.status,
        next.updatedAt,
        id,
      );
    return this.getChannelHandoff(id);
  }

  private assertDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.getChannelDecision(decisionId);
    if (!decision) {
      throw new Error(`Channel decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Decision does not belong to channel: ${decisionId}`);
    }
  }

}
