import type { SQLOutputValue } from "node:sqlite";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelExecutionProposalId,
  type ChannelExecutionProposal,
  type ChannelExecutionProposalClaimResult,
  type ChannelRequirementShaping,
  type CreateChannelExecutionProposalInput,
  type ListChannelExecutionProposalsOptions,
  type UpdateChannelExecutionProposalInput,
} from "../../workspace-types.js";
import { nullableUpdate, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
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
      revision: 1,
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
      blocker: input.blocker,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_execution_proposals (
          id,
          revision,
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
          blocker_json,
          confirmation_claim_id,
          confirmation_claim_expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        proposal.id,
        proposal.revision,
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
        proposal.blocker ? stringifyJson(proposal.blocker) : null,
        null,
        null,
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
    const expectedRevision = input.expectedRevision ?? existing.revision;
    if (expectedRevision !== existing.revision) {
      return undefined;
    }
    const claim = this.context.database.prepare(`
      SELECT confirmation_claim_id, confirmation_claim_expires_at
      FROM channel_execution_proposals
      WHERE id = ?
    `).get(id) as { confirmation_claim_id?: string | null; confirmation_claim_expires_at?: string | null } | undefined;
    const activeClaim = Boolean(
      claim?.confirmation_claim_id
      && claim.confirmation_claim_expires_at
      && claim.confirmation_claim_expires_at > now,
    );
    if (activeClaim && input.confirmationClaimId !== claim?.confirmation_claim_id) {
      return undefined;
    }
    const { shaping: existingShaping, ...existingWithoutShaping } = existing;
    const nextShaping = nullableUpdate(input.shaping, existingShaping);
    const next: ChannelExecutionProposal = {
      ...existingWithoutShaping,
      revision: existing.revision + 1,
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
      blocker: nullableUpdate(input.blocker, existing.blocker),
      updatedAt: now,
    };

    const result = this.context.database
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
          blocker_json = ?,
          confirmation_claim_id = NULL,
          confirmation_claim_expires_at = NULL,
          revision = revision + 1,
          updated_at = ?
        WHERE id = ?
          AND revision = ?
          ${input.confirmationClaimId
            ? "AND confirmation_claim_id = ?"
            : "AND (confirmation_claim_id IS NULL OR confirmation_claim_expires_at IS NULL OR confirmation_claim_expires_at <= ?)"}
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
        next.blocker ? stringifyJson(next.blocker) : null,
        next.updatedAt,
        next.id,
        expectedRevision,
        ...(input.confirmationClaimId ? [input.confirmationClaimId] : [now]),
      );

    if (Number(result.changes) !== 1) {
      return undefined;
    }

    return this.getChannelExecutionProposal(id);
  }

  claimChannelExecutionProposal(
    id: string,
    claimId: string,
    now: string,
    claimExpiresAt: string,
  ): ChannelExecutionProposalClaimResult {
    if (!claimId.trim()) throw new Error("Channel execution proposal claim id is required.");
    if (claimExpiresAt <= now) throw new Error("Channel execution proposal claim must expire after now.");
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getChannelExecutionProposal(id);
      if (!current) {
        this.context.database.exec("COMMIT;");
        return { kind: "not_found" };
      }
      const claim = this.context.database.prepare(`
        SELECT confirmation_claim_id, confirmation_claim_expires_at
        FROM channel_execution_proposals
        WHERE id = ?
      `).get(id) as { confirmation_claim_id?: string | null; confirmation_claim_expires_at?: string | null } | undefined;
      if (
        claim?.confirmation_claim_id
        && claim.confirmation_claim_expires_at
        && claim.confirmation_claim_expires_at > now
      ) {
        this.context.database.exec("COMMIT;");
        return { kind: "busy", proposal: current };
      }
      const result = this.context.database.prepare(`
        UPDATE channel_execution_proposals
        SET revision = revision + 1,
            confirmation_claim_id = ?,
            confirmation_claim_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND revision = ?
          AND status IN ('draft', 'blocked', 'run_failed')
          AND (
            confirmation_claim_id IS NULL
            OR confirmation_claim_expires_at IS NULL
            OR confirmation_claim_expires_at <= ?
          )
      `).run(claimId, claimExpiresAt, now, id, current.revision, now);
      if (Number(result.changes) !== 1) {
        const latest = this.getChannelExecutionProposal(id);
        this.context.database.exec("COMMIT;");
        if (!latest) return { kind: "not_found" };
        return latest.revision !== current.revision
          ? { kind: "stale", proposal: latest }
          : { kind: "busy", proposal: latest };
      }
      const claimed = this.getChannelExecutionProposal(id);
      if (!claimed) throw new Error(`Channel execution proposal disappeared after claim: ${id}`);
      this.context.database.exec("COMMIT;");
      return { kind: "claimed", proposal: claimed };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
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
