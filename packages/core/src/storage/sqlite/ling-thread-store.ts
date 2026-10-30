import type { SQLOutputValue } from "node:sqlite";
import {
  createProposedPlanArtifactId,
  createLingThreadGoalId,
  createLingThreadId,
  type CreateLingThreadGoalInput,
  type ConversationModeState,
  type CreateLingThreadInput,
  type CreateProposedPlanArtifactInput,
  type LingThread,
  type LingThreadGoal,
  type LingThreadGoalStatus,
  type LingThreadKind,
  type ListProposedPlanArtifactsOptions,
  type ProposedPlanArtifact,
  type ListLingThreadsOptions,
  type UpdateLingThreadGoalInput,
  type UpdateLingThreadConversationModeInput,
  type UpdateLingThreadInput,
  type UpdateProposedPlanArtifactInput,
} from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapLingThread, mapLingThreadGoal, mapProposedPlanArtifact } from "./run-mappers.js";
import { lingThreadSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { UserInputWait } from "../../user-input-wait-types.js";
import { projectThreadUserInputWait } from "./user-input-wait-projection.js";
import { assertNewProposedPlan, assertProposedPlanPublicUpdate, ProposedPlanMutationError } from "../../proposed-plan-mutation.js";

export interface SqliteLingThreadStorePorts {
  readonly rebuildLingThreadMetadata: (threadId: string, now: string) => void;
  readonly getUserInputWait: (threadId: string, requestId: string) => UserInputWait | undefined;
}

export class SqliteLingThreadStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingThreadStorePorts,
  ) {}

  createLingThread(input: CreateLingThreadInput, now: string): LingThread {
    const id = input.id ?? createLingThreadId();
    this.context.database
      .prepare(`
        INSERT INTO ling_threads (
          id,
          workspace_id,
          kind,
          channel_id,
          task_id,
          teammate_id,
          workflow_id,
          workflow_step_id,
          external_work_id,
          title,
          objective,
          status,
          active_run_id,
          last_run_id,
          parent_thread_id,
          parent_turn_id,
          forked_from_run_id,
          metadata_json,
          conversation_mode,
          conversation_mode_updated_at,
          created_at,
          updated_at,
          pinned_at,
          archived_at,
          archived_reason,
          surface_kind,
          relation_kind,
          anchor_item_id,
          fork_context_snapshot_id,
          next_item_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.kind,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.workflowId ?? null,
        input.workflowStepId ?? null,
        input.externalWorkId ?? null,
        input.title,
        input.objective,
        input.status ?? "open",
        input.activeRunId ?? null,
        input.lastRunId ?? null,
        input.parentThreadId ?? null,
        input.parentTurnId ?? null,
        input.forkedFromRunId ?? null,
        null,
        input.conversationMode?.mode ?? "default",
        input.conversationMode?.updatedAt ?? null,
        now,
        now,
        input.pinnedAt ?? null,
        input.archivedAt ?? null,
        input.archivedReason ?? null,
        input.surfaceKind ?? defaultThreadSurfaceKind(input.kind),
        input.relationKind ?? "root",
        input.anchorItemId ?? null,
        input.forkContextSnapshotId ?? null,
      );
    this.ports.rebuildLingThreadMetadata(id, now);
    const thread = this.getLingThread(id);
    if (!thread) {
      throw new Error(`Failed to create Ling thread: ${id}`);
    }
    return thread;
  }

  getLingThread(threadId: string): LingThread | undefined {
    const row = this.context.database.prepare(lingThreadSelectSql("WHERE id = ?")).get(threadId);
    return row ? mapLingThread(row as Record<string, SQLOutputValue>) : undefined;
  }

  findLingThreadByOwner(input: {
    readonly kind: LingThreadKind;
    readonly surfaceKind?: LingThread["surfaceKind"];
    readonly anchorItemId?: string;
    readonly taskId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly teammateId?: string;
    readonly channelId?: string;
  }): LingThread | undefined {
    const clauses = ["workspace_id = ?", "kind = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID, input.kind];
    if (input.surfaceKind) {
      clauses.push("surface_kind = ?");
      params.push(input.surfaceKind);
    }
    appendNullableOwnerClause(clauses, params, "anchor_item_id", input.anchorItemId);
    appendNullableOwnerClause(clauses, params, "task_id", input.taskId);
    appendNullableOwnerClause(clauses, params, "workflow_step_id", input.workflowStepId);
    appendNullableOwnerClause(clauses, params, "external_work_id", input.externalWorkId);
    appendNullableOwnerClause(clauses, params, "teammate_id", input.teammateId);
    appendNullableOwnerClause(clauses, params, "channel_id", input.channelId);
    const row = this.context.database.prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC LIMIT 1`).get(...params);
    return row ? mapLingThread(row as Record<string, SQLOutputValue>) : undefined;
  }

  listLingThreads(options: ListLingThreadsOptions = {}): LingThread[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const archivedFilter = options.archived ?? (options.includeArchived || options.status ? "include" : "exclude");
    if (archivedFilter === "exclude") {
      clauses.push("(archived_at IS NULL AND status != 'archived')");
    } else if (archivedFilter === "only") {
      clauses.push("(archived_at IS NOT NULL OR status = 'archived')");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned_at IS NULL ASC, pinned_at DESC, updated_at DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapLingThread(row as Record<string, SQLOutputValue>));
  }

  updateLingThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    if (input.status !== "succeeded" && input.status !== "failed" && input.status !== "cancelled") {
      return this.applyLingThreadUpdate(threadId, input, now);
    }
    // A savepoint participates in an outer wait/cancellation transaction without
    // committing it. Read the checkpoints and write their Thread projection in
    // the same snapshot; a competing writer fails safely instead of hiding a wait.
    const { database } = this.context;
    database.exec("SAVEPOINT ling_thread_terminal_projection");
    try {
      const thread = this.getLingThread(threadId);
      const archived = input.archivedAt !== null && (thread?.status === "archived" || Boolean(thread?.archivedAt));
      const projection = thread && !archived
        ? projectThreadUserInputWait(database, this.ports.getUserInputWait, thread, input.lastRunId ?? undefined) : undefined;
      const result = archived ? thread : this.applyLingThreadUpdate(threadId, { ...input, ...projection }, now);
      database.exec("RELEASE ling_thread_terminal_projection");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK TO ling_thread_terminal_projection; RELEASE ling_thread_terminal_projection");
      } catch { /* Preserve the original storage error if SQLite already rolled back. */ }
      throw error;
    }
  }

  private applyLingThreadUpdate(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    const existing = this.getLingThread(threadId);
    if (!existing) {
      return undefined;
    }
    const next: LingThread = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      activeRunId: nullableUpdate(input.activeRunId, existing.activeRunId),
      lastRunId: nullableUpdate(input.lastRunId, existing.lastRunId),
      pinnedAt: nullableUpdate(input.pinnedAt, existing.pinnedAt),
      archivedAt: nullableUpdate(input.archivedAt, existing.archivedAt),
      archivedReason: nullableUpdate(input.archivedReason, existing.archivedReason),
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE ling_threads
        SET title = ?,
            objective = ?,
            status = ?,
            active_run_id = ?,
            last_run_id = ?,
            updated_at = ?,
            pinned_at = ?,
            archived_at = ?,
            archived_reason = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.objective,
        next.status,
        next.activeRunId ?? null,
        next.lastRunId ?? null,
        next.updatedAt,
        next.pinnedAt ?? null,
        next.archivedAt ?? null,
        next.archivedReason ?? null,
        threadId,
      );
    this.ports.rebuildLingThreadMetadata(threadId, now);
    return this.getLingThread(threadId);
  }

  getLingThreadConversationMode(threadId: string): ConversationModeState | undefined {
    return this.getLingThread(threadId)?.conversationMode;
  }

  updateLingThreadConversationMode(
    threadId: string,
    input: UpdateLingThreadConversationModeInput,
    now: string,
  ): ConversationModeState | undefined {
    const existing = this.getLingThread(threadId);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE ling_threads
        SET conversation_mode = ?,
            conversation_mode_updated_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(input.mode, now, now, threadId);
    return this.getLingThreadConversationMode(threadId);
  }

  getLingThreadGoal(threadId: string): LingThreadGoal | undefined {
    const row = this.context.database
      .prepare(`
        SELECT *
        FROM ling_thread_goals
        WHERE workspace_id = ?
          AND thread_id = ?
          AND status IN (${activeGoalStatusPlaceholders()})
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `)
      .get(DEFAULT_WORKSPACE_ID, threadId, ...activeLingThreadGoalStatuses);
    return row ? mapLingThreadGoal(row as Record<string, SQLOutputValue>) : undefined;
  }

  createLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal {
    const id = input.id ?? createLingThreadGoalId();
    this.context.database
      .prepare(`
        INSERT INTO ling_thread_goals (
          id,
          workspace_id,
          thread_id,
          objective,
          status,
          token_budget,
          tokens_used,
          time_used_seconds,
          created_at,
          updated_at,
          completed_at,
          cleared_at,
          replaced_by_goal_id,
          last_run_id,
          blocked_reason,
          completion_evidence_refs_json,
          completed_by,
          completed_reason,
          completion_verification_summary,
          usage_source,
          continuation_chain_id,
          continuation_depth,
          no_evidence_continuation_count,
          last_blocker_fingerprint,
          same_blocker_count,
          last_continuation_stop_reason,
          last_continuation_stopped_at,
          last_continuation_evidence_delta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.objective,
        input.status ?? "active",
        input.tokenBudget ?? null,
        0,
        0,
        now,
        now,
        null,
        null,
        null,
        null,
        null,
        "[]",
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        0,
        null,
        null,
        null,
      );
    const goal = this.getLingThreadGoalById(id);
    if (!goal) {
      throw new Error(`Failed to create Ling thread goal: ${id}`);
    }
    return goal;
  }

  replaceLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal {
    const id = input.id ?? createLingThreadGoalId();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getLingThreadGoal(input.threadId);
      if (existing) {
        this.context.database
          .prepare(`
            UPDATE ling_thread_goals
            SET status = 'replaced',
                replaced_by_goal_id = ?,
                updated_at = ?
            WHERE id = ?
          `)
          .run(id, now, existing.id);
      }
      this.context.database
        .prepare(`
          INSERT INTO ling_thread_goals (
            id,
            workspace_id,
            thread_id,
            objective,
            status,
            token_budget,
            tokens_used,
            time_used_seconds,
            created_at,
            updated_at,
            completed_at,
            cleared_at,
            replaced_by_goal_id,
            last_run_id,
            blocked_reason,
            completion_evidence_refs_json,
            completed_by,
            completed_reason,
            completion_verification_summary,
            usage_source,
            continuation_chain_id,
            continuation_depth,
            no_evidence_continuation_count,
            last_blocker_fingerprint,
            same_blocker_count,
            last_continuation_stop_reason,
            last_continuation_stopped_at,
            last_continuation_evidence_delta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          DEFAULT_WORKSPACE_ID,
          input.threadId,
          input.objective,
          input.status ?? "active",
          input.tokenBudget ?? null,
          0,
          0,
          now,
          now,
          null,
          null,
          null,
          null,
          null,
          "[]",
          null,
          null,
          null,
          null,
          null,
          0,
          0,
          null,
          0,
          null,
          null,
          null,
        );
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    const goal = this.getLingThreadGoalById(id);
    if (!goal) {
      throw new Error(`Failed to replace Ling thread goal: ${id}`);
    }
    return goal;
  }

  updateLingThreadGoal(goalId: string, input: UpdateLingThreadGoalInput, now: string): LingThreadGoal | undefined {
    const existing = this.getLingThreadGoalById(goalId);
    if (!existing) {
      return undefined;
    }
    const nextStatus = input.status ?? existing.status;
    const completedAt = nextStatus === "complete" ? existing.completedAt ?? now : existing.completedAt;
    const clearedAt = nextStatus === "cleared" ? existing.clearedAt ?? now : existing.clearedAt;
    this.context.database
      .prepare(`
        UPDATE ling_thread_goals
        SET objective = ?,
            status = ?,
            token_budget = ?,
            tokens_used = ?,
            time_used_seconds = ?,
            updated_at = ?,
            completed_at = ?,
            cleared_at = ?,
            last_run_id = ?,
            blocked_reason = ?,
            completion_evidence_refs_json = ?,
            completed_by = ?,
            completed_reason = ?,
            completion_verification_summary = ?,
            usage_source = ?,
            continuation_chain_id = ?,
            continuation_depth = ?,
            no_evidence_continuation_count = ?,
            last_blocker_fingerprint = ?,
            same_blocker_count = ?,
            last_continuation_stop_reason = ?,
            last_continuation_stopped_at = ?,
            last_continuation_evidence_delta_json = ?
        WHERE id = ?
      `)
      .run(
        input.objective ?? existing.objective,
        nextStatus,
        nullableUpdate(input.tokenBudget, existing.tokenBudget) ?? null,
        input.tokensUsed ?? existing.tokensUsed,
        input.timeUsedSeconds ?? existing.timeUsedSeconds,
        now,
        completedAt ?? null,
        clearedAt ?? null,
        nullableUpdate(input.lastRunId, existing.lastRunId) ?? null,
        nullableUpdate(input.blockedReason, existing.blockedReason) ?? null,
        stringifyJson(input.completionEvidenceRefs ?? existing.completionEvidenceRefs),
        nullableUpdate(input.completedBy, existing.completedBy) ?? null,
        nullableUpdate(input.completedReason, existing.completedReason) ?? null,
        nullableUpdate(input.completionVerificationSummary, existing.completionVerificationSummary) ?? null,
        nullableUpdate(input.usageSource, existing.usageSource) ?? null,
        nullableUpdate(input.continuationChainId, existing.continuationChainId) ?? null,
        input.continuationDepth ?? existing.continuationDepth,
        input.noEvidenceContinuationCount ?? existing.noEvidenceContinuationCount,
        nullableUpdate(input.lastBlockerFingerprint, existing.lastBlockerFingerprint) ?? null,
        input.sameBlockerCount ?? existing.sameBlockerCount,
        nullableUpdate(input.lastContinuationStopReason, existing.lastContinuationStopReason) ?? null,
        nullableUpdate(input.lastContinuationStoppedAt, existing.lastContinuationStoppedAt) ?? null,
        stringifyNullableJson(nullableUpdate(input.lastContinuationEvidenceDelta, existing.lastContinuationEvidenceDelta)),
        goalId,
      );
    return this.getLingThreadGoalById(goalId);
  }

  clearLingThreadGoal(threadId: string, now: string): LingThreadGoal | undefined {
    const existing = this.getLingThreadGoal(threadId);
    if (!existing) {
      return undefined;
    }
    return this.updateLingThreadGoal(existing.id, { status: "cleared" }, now);
  }

  getProposedPlanArtifact(planId: string): ProposedPlanArtifact | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM ling_thread_proposed_plans WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, planId);
    return row ? mapProposedPlanArtifact(row as Record<string, SQLOutputValue>) : undefined;
  }

  listProposedPlanArtifacts(options: ListProposedPlanArtifactsOptions): ProposedPlanArtifact[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const clauses = ["plans.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.threadId) {
      clauses.push("plans.thread_id = ?");
      params.push(options.threadId);
    }
    if (options.channelId) {
      clauses.push("(plans.channel_id = ? OR threads.channel_id = ?)");
      params.push(options.channelId, options.channelId);
    }
    if (options.goalId) {
      clauses.push("plans.goal_id = ?");
      params.push(options.goalId);
    }
    if (options.agentId) {
      clauses.push("(plans.source_agent_id = ? OR plans.owner_agent_id = ?)");
      params.push(options.agentId, options.agentId);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`plans.status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    params.push(limit);
    return this.context.database
      .prepare(`
        SELECT plans.*
        FROM ling_thread_proposed_plans plans
        LEFT JOIN ling_threads threads
          ON threads.workspace_id = plans.workspace_id
         AND threads.id = plans.thread_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY plans.updated_at DESC, plans.created_at DESC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => mapProposedPlanArtifact(row as Record<string, SQLOutputValue>));
  }

  upsertProposedPlanArtifact(input: CreateProposedPlanArtifactInput, now: string): ProposedPlanArtifact {
    const id = input.id ?? createProposedPlanArtifactId();
    const existing = this.getProposedPlanArtifact(id);
    if (existing) {
      if (existing.threadId !== input.threadId) throw new ProposedPlanMutationError("proposed_plan_not_found", "The proposed plan does not belong to this thread.", 404);
      const updated = this.updateProposedPlanArtifact(id, { ...input, expectedThreadId: input.threadId }, now);
      if (!updated) {
        throw new ProposedPlanMutationError("proposed_plan_revision_conflict", `Proposed plan changed while editing: ${id}`);
      }
      return updated;
    }
    assertNewProposedPlan(input);
    const planContext = this.resolveProposedPlanContext(input.threadId, input.channelId, input.goalId);
    this.context.database
      .prepare(`
        INSERT INTO ling_thread_proposed_plans (
          id,
          workspace_id,
          thread_id,
          channel_id,
          goal_id,
          source_agent_id,
          owner_agent_id,
          source_turn_id,
          source_message_id,
          source_run_id,
          parent_plan_id,
          superseded_by_plan_id,
          plan_group_id,
          version,
          title,
          body_markdown,
          status,
          saved_at,
          accepted_at,
          converted_at,
          archived_at,
          archived_reason,
          accepted_task_id,
          accepted_workflow_id,
          accepted_workflow_step_id,
          accepted_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.channelId ?? planContext.channelId ?? null,
        input.goalId ?? planContext.goalId ?? null,
        input.sourceAgentId ?? null,
        input.ownerAgentId ?? null,
        input.sourceTurnId ?? null,
        input.sourceMessageId ?? null,
        input.sourceRunId ?? null,
        input.parentPlanId ?? null,
        input.supersededByPlanId ?? null,
        input.planGroupId ?? id,
        input.version ?? 1,
        input.title,
        input.bodyMarkdown,
        input.status ?? "draft",
        input.savedAt ?? null,
        input.acceptedAt ?? null,
        input.convertedAt ?? null,
        input.archivedAt ?? null,
        input.archivedReason ?? null,
        input.acceptedTaskId ?? null,
        input.acceptedWorkflowId ?? null,
        input.acceptedWorkflowStepId ?? null,
        input.acceptedRunId ?? null,
        now,
        now,
      );
    const plan = this.getProposedPlanArtifact(id);
    if (!plan) {
      throw new Error(`Failed to create proposed plan artifact: ${id}`);
    }
    return plan;
  }

  updateProposedPlanArtifact(planId: string, input: UpdateProposedPlanArtifactInput, now: string): ProposedPlanArtifact | undefined {
    const existing = this.getProposedPlanArtifact(planId);
    if (!existing) {
      return undefined;
    }
    if (input.expectedThreadId !== undefined && input.expectedThreadId !== existing.threadId) {
      throw new ProposedPlanMutationError("proposed_plan_not_found", "The proposed plan does not belong to this thread.", 404);
    }
    assertProposedPlanPublicUpdate(existing, input);
    const changes = (Object.keys(proposedPlanColumns) as (keyof typeof proposedPlanColumns)[])
      .filter(field => input[field] !== undefined && (input[field] ?? undefined) !== existing[field]);
    if (!changes.length) return existing;
    if (!Number.isSafeInteger(existing.revision) || existing.revision >= Number.MAX_SAFE_INTEGER) {
      throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "The proposed-plan revision cannot be advanced safely.");
    }
    const result = this.context.database.prepare(`UPDATE ling_thread_proposed_plans
      SET ${changes.map(field => `${proposedPlanColumns[field]} = ?`).join(", ")}, revision = revision + 1, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND thread_id = ? AND revision = ? AND status = ?`)
      .run(...changes.map(field => input[field] ?? null), now, DEFAULT_WORKSPACE_ID, planId, existing.threadId, existing.revision, existing.status);
    if (Number(result.changes) !== 1) throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "The proposed plan changed while editing.");
    return this.getProposedPlanArtifact(planId);
  }

  private resolveProposedPlanContext(
    threadId: string,
    channelId: string | undefined,
    goalId: string | undefined,
  ): { readonly channelId?: string; readonly goalId?: string } {
    const thread = channelId ? undefined : this.getLingThread(threadId);
    const goal = goalId ? undefined : this.getLingThreadGoal(threadId);
    return {
      channelId: channelId ?? thread?.channelId,
      goalId: goalId ?? goal?.id,
    };
  }

  private getLingThreadGoalById(goalId: string): LingThreadGoal | undefined {
    const row = this.context.database
      .prepare("SELECT * FROM ling_thread_goals WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, goalId);
    return row ? mapLingThreadGoal(row as Record<string, SQLOutputValue>) : undefined;
  }
}

const proposedPlanColumns = {
  channelId: "channel_id", goalId: "goal_id", sourceAgentId: "source_agent_id", ownerAgentId: "owner_agent_id",
  sourceTurnId: "source_turn_id", sourceMessageId: "source_message_id", sourceRunId: "source_run_id",
  parentPlanId: "parent_plan_id", supersededByPlanId: "superseded_by_plan_id", planGroupId: "plan_group_id",
  version: "version", title: "title", bodyMarkdown: "body_markdown", status: "status", savedAt: "saved_at",
  acceptedAt: "accepted_at", convertedAt: "converted_at", archivedAt: "archived_at", archivedReason: "archived_reason",
  acceptedTaskId: "accepted_task_id", acceptedWorkflowId: "accepted_workflow_id",
  acceptedWorkflowStepId: "accepted_workflow_step_id", acceptedRunId: "accepted_run_id",
} as const;

function defaultThreadSurfaceKind(kind: LingThreadKind): "direct" | "work" {
  return kind === "conversation" || kind === "teammate_direct" ? "direct" : "work";
}

const activeLingThreadGoalStatuses = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
] as const satisfies readonly LingThreadGoalStatus[];

function activeGoalStatusPlaceholders(): string {
  return activeLingThreadGoalStatuses.map(() => "?").join(", ");
}

function stringifyNullableJson(value: unknown | undefined): string | null {
  return value === undefined ? null : stringifyJson(value);
}

function appendNullableOwnerClause(clauses: string[], params: string[], column: string, value: string | undefined): void {
  if (value === undefined) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(value);
}
