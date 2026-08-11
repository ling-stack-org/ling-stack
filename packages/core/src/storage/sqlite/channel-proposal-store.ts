import type { SQLOutputValue } from "node:sqlite";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelExecutionProposalId,
  type ChannelExecutionProposal,
  type ChannelRequirementShaping,
  type CreateChannelExecutionProposalInput,
  type ListChannelExecutionProposalsOptions,
  type UpdateChannelExecutionProposalInput,
} from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapChannelExecutionProposal } from "./channel-proposal-mappers.js";
import { channelExecutionProposalSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelProposalStorePorts {
  readonly hasChannel: (id: string) => boolean;
  readonly getConversationItem: (id: string) => ConversationItemV1 | undefined;
}

export class SqliteChannelProposalStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelProposalStorePorts,
  ) {}

  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal {
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const sourceItem = this.ports.getConversationItem(input.sourceMessageId);
    if (!sourceItem || sourceItem.channelId !== input.channelId) {
      throw new Error(`Source item does not belong to channel: ${input.sourceMessageId}`);
    }
    const shaping = input.shaping ?? defaultChannelRequirementShaping(input, now);
    const proposal: ChannelExecutionProposal = {
      id: createChannelExecutionProposalId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      proposedByTeammateId: input.proposedByTeammateId,
      title: input.title,
      prompt: input.prompt,
      assigneeTeammateId: input.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      collaborationSteps: input.collaborationSteps ?? [],
      requiredTools: input.requiredTools ?? [],
      riskSummary: input.riskSummary,
      responseLanguage: input.responseLanguage,
      ...(shaping ? { shaping } : {}),
      status: input.status ?? "draft",
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      linkedWorkflowId: input.linkedWorkflowId,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_execution_proposals (
          id,
          workspace_id,
          channel_id,
          source_item_id,
          proposed_by_teammate_id,
          title,
          prompt,
          assignee_teammate_id,
          acceptance_criteria_json,
          collaboration_steps_json,
          required_tools_json,
          risk_summary,
          response_language,
          shaping_json,
          status,
          linked_task_id,
          linked_run_id,
          linked_workflow_id,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        proposal.id,
        proposal.workspaceId,
        proposal.channelId,
        proposal.sourceMessageId,
        proposal.proposedByTeammateId,
        proposal.title,
        proposal.prompt,
        proposal.assigneeTeammateId,
        stringifyJson(proposal.acceptanceCriteria),
        stringifyJson(proposal.collaborationSteps),
        stringifyJson(proposal.requiredTools),
        proposal.riskSummary ?? null,
        proposal.responseLanguage ?? null,
        proposal.shaping ? stringifyJson(proposal.shaping) : null,
        proposal.status,
        proposal.linkedTaskId ?? null,
        proposal.linkedRunId ?? null,
        proposal.linkedWorkflowId ?? null,
        proposal.errorMessage ?? null,
        proposal.createdAt,
        proposal.updatedAt,
      );

    const created = this.getChannelExecutionProposal(proposal.id);
    if (!created) {
      throw new Error(`Failed to create channel execution proposal: ${proposal.id}`);
    }
    return created;
  }

  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined {
    const row = this.context.database.prepare(channelExecutionProposalSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelExecutionProposal(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.sourceMessageId) {
      clauses.push("source_item_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelExecutionProposalSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelExecutionProposal(row as Record<string, SQLOutputValue>));
  }

  updateChannelExecutionProposal(
    id: string,
    input: UpdateChannelExecutionProposalInput,
    now: string,
  ): ChannelExecutionProposal | undefined {
    const existing = this.getChannelExecutionProposal(id);
    if (!existing) {
      return undefined;
    }
    const { shaping: existingShaping, ...existingWithoutShaping } = existing;
    const nextShaping = nullableUpdate(input.shaping, existingShaping);
    const next: ChannelExecutionProposal = {
      ...existingWithoutShaping,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      assigneeTeammateId: input.assigneeTeammateId ?? existing.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      collaborationSteps: input.collaborationSteps ?? existing.collaborationSteps,
      requiredTools: input.requiredTools ?? existing.requiredTools,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      responseLanguage: nullableUpdate(input.responseLanguage, existing.responseLanguage),
      ...(nextShaping ? { shaping: nextShaping } : {}),
      status: input.status ?? existing.status,
      linkedTaskId: nullableUpdate(input.linkedTaskId, existing.linkedTaskId),
      linkedRunId: nullableUpdate(input.linkedRunId, existing.linkedRunId),
      linkedWorkflowId: nullableUpdate(input.linkedWorkflowId, existing.linkedWorkflowId),
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE channel_execution_proposals
        SET
          title = ?,
          prompt = ?,
          assignee_teammate_id = ?,
          acceptance_criteria_json = ?,
          collaboration_steps_json = ?,
          required_tools_json = ?,
          risk_summary = ?,
          response_language = ?,
          shaping_json = ?,
          status = ?,
          linked_task_id = ?,
          linked_run_id = ?,
          linked_workflow_id = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.prompt,
        next.assigneeTeammateId,
        stringifyJson(next.acceptanceCriteria),
        stringifyJson(next.collaborationSteps),
        stringifyJson(next.requiredTools),
        next.riskSummary ?? null,
        next.responseLanguage ?? null,
        next.shaping ? stringifyJson(next.shaping) : null,
        next.status,
        next.linkedTaskId ?? null,
        next.linkedRunId ?? null,
        next.linkedWorkflowId ?? null,
        next.errorMessage ?? null,
        next.updatedAt,
        next.id,
      );

    return this.getChannelExecutionProposal(id);
  }
}

function defaultChannelRequirementShaping(input: CreateChannelExecutionProposalInput, now: string): ChannelRequirementShaping | undefined {
  if ((input.status ?? "draft") !== "draft") {
    return undefined;
  }
  return {
    status: "ready_for_confirmation",
    summary: input.title.trim() || input.prompt.trim(),
    openQuestions: [],
    clarifications: [],
    sourceRefs: [{ type: "message", id: input.sourceMessageId }],
    updatedAt: now,
  };
}
