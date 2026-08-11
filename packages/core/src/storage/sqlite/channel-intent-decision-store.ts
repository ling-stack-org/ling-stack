import type { SQLOutputValue } from "node:sqlite";
import {
  isChannelIntentDecisionV2,
  isConversationContextProjectionMetadata,
  type ConversationItemV1,
  type TurnContextAssignment,
} from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID,
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
  readonly getConversationItem: (id: string) => ConversationItemV1 | undefined;
  readonly getEffectiveTurnContextAssignment: (turnId: string) => TurnContextAssignment | undefined;
}

export class SqliteChannelIntentDecisionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelIntentDecisionStorePorts,
  ) {}

  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision {
    this.ports.assertItemInChannel(input.channelId, input.sourceItemId);
    const sourceItem = this.ports.getConversationItem(input.sourceItemId);
    if (!sourceItem?.turnId || sourceItem.status !== "committed") {
      throw new Error(`Channel Intent v2 source must be a committed turn item: ${input.sourceItemId}`);
    }
    if (!isConversationContextProjectionMetadata(input.contextProjection)) {
      throw new Error("Channel Intent v2 requires valid context projection metadata.");
    }
    const assignment = this.ports.getEffectiveTurnContextAssignment(sourceItem.turnId);
    if (!assignment) {
      throw new Error(`Channel Intent v2 source turn has no context assignment: ${sourceItem.turnId}`);
    }
    if (
      input.contextProjection.threadId !== sourceItem.threadId
      || input.contextProjection.turnId !== sourceItem.turnId
      || input.contextProjection.segmentId !== assignment.segmentId
      || input.contextProjection.throughItemSequence !== sourceItem.sequence
    ) {
      throw new Error("Channel Intent v2 projection does not match the source turn assignment.");
    }
    this.assertChannelIntentDecisionRefsInChannel(input.channelId, input);
    const decision: ChannelIntentDecision = {
      schemaVersion: 2,
      id: createChannelIntentDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceTurnId: sourceItem.turnId,
      sourceItemId: sourceItem.id,
      contextSegmentId: assignment.segmentId,
      contextProjectionVersion: input.contextProjection.projectionVersion,
      action: input.action,
      selectedTeammateIds: input.selectedTeammateIds ?? [],
      proposalId: input.proposalId,
      resultItemIds: input.resultItemIds ?? [],
      workflowId: input.workflowId,
      reason: input.reason,
      clarification: input.clarification,
      execution: input.execution,
      status: input.status,
      createdBy: input.createdBy,
      errorCode: input.errorCode,
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
          source_turn_id,
          source_item_id,
          context_segment_id,
          context_projection_version,
          action,
          selected_teammate_ids_json,
          proposal_id,
          result_item_ids_json,
          workflow_id,
          reason,
          clarification_json,
          execution_json,
          status,
          created_by,
          error_code,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceTurnId,
        decision.sourceItemId,
        decision.contextSegmentId,
        decision.contextProjectionVersion,
        decision.action,
        stringifyJson(decision.selectedTeammateIds),
        decision.proposalId ?? null,
        stringifyJson(decision.resultItemIds),
        decision.workflowId ?? null,
        decision.reason,
        decision.clarification ? stringifyJson(decision.clarification) : null,
        decision.execution ? stringifyJson(decision.execution) : null,
        decision.status,
        decision.createdBy,
        decision.errorCode ?? null,
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
    if (options.sourceItemId) {
      clauses.push("source_item_id = ?");
      params.push(options.sourceItemId);
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
    input: Pick<CreateChannelIntentDecisionInput, "selectedTeammateIds" | "proposalId" | "resultItemIds" | "workflowId" | "execution">,
  ): void {
    for (const teammateId of input.selectedTeammateIds ?? []) {
      if (!this.ports.hasAiTeammate(teammateId)) {
        throw new Error(`AI teammate not found: ${teammateId}`);
      }
    }
    if (input.proposalId) {
      this.ports.assertProposalInChannel(channelId, input.proposalId);
    }
    for (const resultItemId of input.resultItemIds ?? []) {
      this.ports.assertItemInChannel(channelId, resultItemId);
    }
    if (input.workflowId) {
      this.ports.assertWorkflowInChannel(channelId, input.workflowId);
    }
    const targetRef = input.execution?.targetRef;
    if (targetRef && (targetRef.type === "conversation_item" || targetRef.type === "message")) {
      this.ports.assertItemInChannel(channelId, targetRef.id);
    }
  }
}

function validateChannelIntentDecisionInput(decision: ChannelIntentDecision): void {
  if (!isChannelIntentDecisionV2(decision)) {
    throw new Error("Channel Intent v2 decision failed schema validation.");
  }
}
