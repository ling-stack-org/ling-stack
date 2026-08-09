import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  channelIntentDecisionActions,
  channelIntentDecisionCreatedByValues,
  channelIntentDecisionStatuses,
  createChannelIntentDecisionId,
  type ChannelIntentDecision,
  type CreateChannelIntentDecisionInput,
  type ListChannelIntentDecisionsOptions,
} from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapChannelIntentDecision } from "./channel-routing-mappers.js";
import { channelIntentDecisionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelIntentDecisionStorePorts {
  readonly assertItemInChannel: (channelId: string, itemId: string) => void;
  readonly assertProposalInChannel: (channelId: string, proposalId: string) => void;
  readonly assertWorkflowInChannel: (channelId: string, workflowId: string) => void;
  readonly hasAiTeammate: (id: string) => boolean;
}

export class SqliteChannelIntentDecisionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelIntentDecisionStorePorts,
  ) {}

  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision {
    this.ports.assertItemInChannel(input.channelId, input.sourceMessageId);
    this.assertChannelIntentDecisionRefsInChannel(input.channelId, input);
    const decision: ChannelIntentDecision = {
      schemaVersion: 1,
      id: createChannelIntentDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      action: input.action,
      selectedTeammateId: input.selectedTeammateId,
      selectedTeammateIds: input.selectedTeammateIds,
      proposalId: input.proposalId,
      replyMessageId: input.replyMessageId,
      replyMessageIds: input.replyMessageIds,
      workflowId: input.workflowId,
      reason: input.reason,
      status: input.status,
      createdBy: input.createdBy,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    validateChannelIntentDecisionInput(decision);
    this.context.database
      .prepare(`
        INSERT INTO channel_intent_decisions (
          id,
          schema_version,
          workspace_id,
          channel_id,
          source_item_id,
          action,
          selected_teammate_id,
          selected_teammate_ids_json,
          proposal_id,
          reply_item_id,
          reply_item_ids_json,
          workflow_id,
          reason,
          status,
          created_by,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId,
        decision.action,
        decision.selectedTeammateId ?? null,
        stringifyJson(decision.selectedTeammateIds ?? []),
        decision.proposalId ?? null,
        decision.replyMessageId ?? null,
        stringifyJson(decision.replyMessageIds ?? []),
        decision.workflowId ?? null,
        decision.reason,
        decision.status,
        decision.createdBy,
        decision.errorMessage ?? null,
        decision.createdAt,
        decision.updatedAt,
      );
    const created = this.getChannelIntentDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel intent decision: ${decision.id}`);
    }
    return created;
  }

  getChannelIntentDecision(id: string): ChannelIntentDecision | undefined {
    const row = this.context.database.prepare(channelIntentDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelIntentDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelIntentDecisions(options: ListChannelIntentDecisionsOptions = {}): ChannelIntentDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceMessageId) {
      clauses.push("source_item_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.action) {
      clauses.push("action = ?");
      params.push(options.action);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelIntentDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelIntentDecision(row as Record<string, SQLOutputValue>));
  }

  private assertChannelIntentDecisionRefsInChannel(
    channelId: string,
    input: Pick<CreateChannelIntentDecisionInput, "selectedTeammateId" | "selectedTeammateIds" | "proposalId" | "replyMessageId" | "replyMessageIds" | "workflowId">,
  ): void {
    if (input.selectedTeammateId && !this.ports.hasAiTeammate(input.selectedTeammateId)) {
      throw new Error(`AI teammate not found: ${input.selectedTeammateId}`);
    }
    for (const teammateId of input.selectedTeammateIds ?? []) {
      if (!this.ports.hasAiTeammate(teammateId)) {
        throw new Error(`AI teammate not found: ${teammateId}`);
      }
    }
    if (input.proposalId) {
      this.ports.assertProposalInChannel(channelId, input.proposalId);
    }
    if (input.replyMessageId) {
      this.ports.assertItemInChannel(channelId, input.replyMessageId);
    }
    for (const replyMessageId of input.replyMessageIds ?? []) {
      this.ports.assertItemInChannel(channelId, replyMessageId);
    }
    if (input.workflowId) {
      this.ports.assertWorkflowInChannel(channelId, input.workflowId);
    }
  }
}

function validateChannelIntentDecisionInput(
  decision: Pick<CreateChannelIntentDecisionInput, "action" | "reason" | "status" | "createdBy">,
): void {
  if (!channelIntentDecisionActions.includes(decision.action)) {
    throw new Error("channel intent decision action is not supported");
  }
  if (!channelIntentDecisionStatuses.includes(decision.status)) {
    throw new Error("channel intent decision status is not supported");
  }
  if (!channelIntentDecisionCreatedByValues.includes(decision.createdBy)) {
    throw new Error("channel intent decision createdBy is not supported");
  }
  validateNonEmptyString(decision.reason, "channel intent decision reason");
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}
