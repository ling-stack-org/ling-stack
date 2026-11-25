import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  createWorkItemId,
  type CommitWorkItemGitHubDeliveryInput,
  type CommitWorkItemGitHubDeliveryResult,
  type CreateWorkItemInput,
  type CreateWorkItemResult,
  type GitHubIntakeDispatchIntent,
  type GitHubIntakeOccurrence,
  type ListWorkItemsOptions,
  type UpsertWorkItemInput,
  type WorkItem,
  type WorkItemAcceptanceReceipt,
  type WorkItemAcceptanceRequest,
  type WorkItemAcceptanceResult,
  type WorkItemClaimBlocker,
  type WorkItemClaimRequest,
  type WorkItemCompleteRequest,
  type WorkItemControlAction,
  type WorkItemControlRequest,
  type WorkItemControlReceipt,
  type WorkItemControlResult,
  type WorkItemConversationBinding,
  type WorkItemFailRequest,
  type WorkItemHeartbeatRequest,
  type WorkItemHold,
  type WorkItemPlanChangeInput,
  type WorkItemPlanChangeResult,
  type WorkItemReleaseRequest,
  type WorkItemRouteRequest,
  type WorkItemControlState,
  type WorkItemSourceType,
} from "../../work-item-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readNumber, readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { mapWorkItem } from "./runtime-work-mappers.js";
import { workItemSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteAppServerStateStore } from "./app-server-state-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import type { LingAppServerGitHubDelivery, LingAppServerGitHubIntakeReceipt, LingAppServerWorkItemSourceReceipt, WorkItemLinkedExecution,
  LingAppServerRetainedWorkflowStageExecution, LingAppServerRetainedWorkflowStageResult,
  LingAppServerWorkItemWorkflowBindParams, LingAppServerWorkItemWorkflowBinding } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { ChannelWorkflowStep } from "../../workspace-types.js";
import { readSelectedWorkflowDecision, workItemWorkflowDecisionId } from "../../work-item-workflow-decision.js";
import { checkpointDeliberationResolutionId, deliberationWorkflowStepDigest, type WorkItemDeliberationApplication,
  type WorkItemDeliberationWorkflowBinding } from "../../work-item-deliberation-workflow.js";
import { stageHandoffAdmitsTarget } from "../../work-item-workflow-handoff.js";
import { listWorkItemStageQuestions, workItemStageQuestionExpired } from "../../work-item-workflow-question.js";
import { planStageBallotKey } from "../../proposed-plan-mutation.js";
import { normalConversationSubmissionKey } from "../../conversation-item-store-types.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { readWorkItemWorkflowUsage } from "./work-item-workflow-usage.js";
import { readWorkItemStageProgress } from "./work-item-workflow-progress.js";
import { defaultGoalSupervisionPolicy } from "../../goal-supervision.js";
import { ownsRetainableWorkflowStageExecution, readRetainedWorkflowStageExecution, readRetainedWorkflowStageResult } from "../../work-item-retained-workflow-stage.js";

export interface SqliteWorkItemStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly hasAiTeammate: (id: string) => boolean;
  readonly getProposedPlanArtifact: RunStore["getProposedPlanArtifact"];
  readonly getChannelWorkflow: RunStore["getChannelWorkflow"];
  readonly getChannelWorkflowStep: RunStore["getChannelWorkflowStep"];
  readonly listChannelWorkflowSteps: RunStore["listChannelWorkflowSteps"];
  readonly getLingThreadGoal: RunStore["getLingThreadGoal"];
  readonly getWorkItemEvidence: RunStore["getWorkItemEvidence"];
  readonly listWorkItemEvidence: RunStore["listWorkItemEvidence"];
  readonly getTask: RunStore["getTask"];
  readonly getAutomationRun: RunStore["getAutomationRun"];
  readonly getRun: RunStore["getRun"];
  readonly getArtifact: RunStore["getArtifact"];
  readonly getProviderConfigurationSnapshot: RunStore["getProviderConfigurationSnapshot"];
}

interface WorkItemCreationReceipt {
  readonly fingerprint: string;
  readonly workItemId: string;
}

interface WorkItemControlSubmission {
  readonly fingerprint: string;
  readonly receipt: WorkItemControlReceipt;
}

interface WorkItemWorkflowLink {
  readonly binding: LingAppServerWorkItemWorkflowBinding;
  readonly fingerprint: string;
  readonly progressStageIds?: readonly string[];
}

export class SqliteWorkItemStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteWorkItemStorePorts,
  ) {}

  upsertWorkItem(input: UpsertWorkItemInput, now: string): WorkItem {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getWorkItemBySource(input.sourceType, input.sourceId);
      const workItem = this.saveWorkItem(input, now, existing);
      database.exec("COMMIT");
      return workItem;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  createWorkItem(
    input: CreateWorkItemInput,
    now: string,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
  ): CreateWorkItemResult {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.createWithinTransaction(input, now, state, events);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  createWithinTransaction(
    input: CreateWorkItemInput,
    now: string,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
  ): CreateWorkItemResult {
    if (!this.context.database.isTransaction) throw new Error("work_item_creation_requires_transaction");
    const sourceWorkItem = this.getWorkItemBySource(input.sourceType, input.sourceId);
    const sourceOwner = input.linkExistingExecution
      ? this.readSourceOwner(input.sourceType, input.sourceId, DEFAULT_WORKSPACE_ID) : undefined;
    if (input.linkExistingExecution && (!sourceOwner || input.verifiedTargetKey || input.gitHubIntake)
      || input.sourceType === "automation_run" && !sourceOwner) throw new Error("work_item_source_owner_unavailable");
    const sourceKey = createHash("sha256").update(JSON.stringify([input.sourceType, input.sourceId])).digest("hex");
    const targetKey = sourceOwner ? `execution:${sourceKey}` : input.verifiedTargetKey;
    const target = (targetKey ? state.get("work_item_target", targetKey)?.payload : undefined) as { workItemId: string } | undefined;
    const source = state.get("work_item_source", sourceKey)?.payload as LingAppServerWorkItemSourceReceipt | undefined;
    const boundId = target?.workItemId ?? source?.workItemId;
    if ((targetKey && source && source.targetKey !== targetKey)
      || (source && target && source.workItemId !== target.workItemId)
      || (boundId && sourceWorkItem && sourceWorkItem.id !== boundId)) {
      throw new Error("work_item_creation_source_conflict");
    }
    const existing = boundId ? this.getWorkItem(boundId) : sourceWorkItem;
    if (boundId && !existing) throw new Error("work_item_creation_source_conflict");
    if (sourceOwner && existing && !existing.linkedExecution) throw new Error("work_item_creation_source_conflict");
    const submission = input.idempotencyKey ? {
      recordId: createHash("sha256").update(input.idempotencyKey).digest("hex"),
      fingerprint: createHash("sha256").update(JSON.stringify([
        input.id, input.sourceType, input.sourceId, input.title, input.description, input.priority, input.labels,
        ...(targetKey ? [targetKey] : []),
      ])).digest("hex"),
    } : undefined;
    const prior = submission ? state.get("work_item_creation", submission.recordId)?.payload as WorkItemCreationReceipt | undefined : undefined;
    if (prior && (prior.fingerprint !== submission?.fingerprint || prior.workItemId !== existing?.id)) {
      throw new Error("work_item_creation_idempotency_conflict");
    }
    if (input.id && (existing ? existing.id !== input.id : Boolean(this.getWorkItem(input.id)))) {
      throw new Error("work_item_creation_source_conflict");
    }
    const workItem = existing ?? (sourceOwner ? this.saveWorkItem({
      ...input, initialStatus: "waiting", waitingReason: "external", channelId: sourceOwner.channelId,
      ...(sourceOwner.execution.kind === "channel_task" ? { taskId: sourceOwner.execution.id } : {}),
    }, now, undefined, sourceOwner.execution.id) : this.saveWorkItem(input, now));
    let sourceReceipt = source;
    if (targetKey && !source) {
      sourceReceipt = { workItemId: workItem.id, targetKey, sourceType: input.sourceType, sourceId: input.sourceId };
      if (!target) state.putWithinTransaction({
        kind: "work_item_target", recordId: targetKey, expectedRevision: 0, payload: { workItemId: workItem.id },
      }, now);
      state.putWithinTransaction({
        kind: "work_item_source", recordId: sourceKey, expectedRevision: 0, payload: sourceReceipt,
      }, now);
    }
    if (submission && !prior) {
      state.putWithinTransaction({ kind: "work_item_creation", recordId: submission.recordId, expectedRevision: 0,
        payload: { fingerprint: submission.fingerprint, workItemId: workItem.id } satisfies WorkItemCreationReceipt }, now);
    }
    const action = !existing ? "work_item.created" : sourceReceipt && !source ? "work_item.source_linked" : undefined;
    const event = action ? events.store.appendControlPlaneEventWithinTransaction({
      workspaceId: workItem.workspaceId, cwd: events.cwd, domain: "work_items",
      entityType: "work_item", entityId: workItem.id, action,
      data: { workItemId: workItem.id, revision: workItem.revision, status: workItem.status },
    }, now) : undefined;
    let gitHubIntakeReceipt: LingAppServerGitHubIntakeReceipt | undefined;
    if (input.gitHubIntake) {
      const { automatic, ...intake } = input.gitHubIntake;
      const prior = state.get("github_intake_receipt", intake.receiptId)?.payload as LingAppServerGitHubIntakeReceipt | undefined;
      if (prior && prior.workItemId !== workItem.id) throw new Error("github_intake_conflict");
      const decision = prior ?? (automatic ? this.reserveGitHubIntake({ ...intake, automatic }, workItem, state, now)
        : existing ? { outcome: "deduplicated" as const, reasonCode: "existing_target" }
          : { outcome: "suggested" as const, reasonCode: "suggested_for_acceptance" });
      gitHubIntakeReceipt = { ...intake, ...decision, workItemId: workItem.id };
      if (!prior && !state.putWithinTransaction({
        kind: "github_intake_receipt", recordId: intake.receiptId, expectedRevision: 0, payload: gitHubIntakeReceipt,
      }, now)) throw new Error("github_intake_conflict");
    }
    return { workItem, event, sourceReceipt, gitHubIntakeReceipt };
  }

  private reserveGitHubIntake(
    { repository, receiptId, policyRevision, automatic }: GitHubIntakeOccurrence & { automatic: NonNullable<GitHubIntakeOccurrence["automatic"]> },
    workItem: WorkItem, state: SqliteAppServerStateStore, now: string,
  ): Pick<LingAppServerGitHubIntakeReceipt, "outcome" | "reasonCode"> {
    if (state.get("github_intake_dispatch", workItem.id) || state.get("work_item_acceptance", workItem.id)
      || workItem.runId || workItem.taskId || workItem.workflowId || workItem.claim) {
      return { outcome: "deduplicated", reasonCode: "existing_execution" };
    }
    if (workItem.control.state !== "active" || workItem.holds.some(hold => hold.blocksNewAdmission)) {
      return { outcome: "paused", reasonCode: "work_item_held" };
    }
    if (!["intake", "triage", "backlog", "ready"].includes(workItem.status)) {
      return { outcome: "suppressed", reasonCode: "work_item_ineligible" };
    }
    const { repositoryId, budget, webhook } = automatic;
    const windowStart = new Date(Date.parse(now) - budget.windowMs).toISOString();
    const counts = this.context.database.prepare(`
      SELECT COUNT(CASE WHEN dispatch.created_at >= ? THEN 1 END) AS starts,
        COUNT(CASE WHEN json_extract(dispatch.payload_json, '$.status') = 'pending'
          OR run.status IN ('queued', 'running', 'waiting_for_approval', 'yielded') THEN 1 END) AS concurrent
      FROM app_server_state dispatch
      LEFT JOIN work_items item ON item.id = dispatch.record_id AND item.workspace_id = dispatch.workspace_id
      LEFT JOIN run_sessions run ON run.id = item.run_id
      WHERE dispatch.workspace_id = ? AND dispatch.kind = 'github_intake_dispatch'
        AND json_extract(dispatch.payload_json, '$.repositoryId') = ?
    `).get(windowStart, workItem.workspaceId, repositoryId);
    if (Number(counts?.starts) >= budget.maxStartsPerWindow) return { outcome: "suppressed", reasonCode: "start_budget_exhausted" };
    if (Number(counts?.concurrent) >= budget.maxConcurrent) return { outcome: "suppressed", reasonCode: "concurrency_limit" };
    const intent: GitHubIntakeDispatchIntent = {
      workItemId: workItem.id, receiptId, repository, repositoryId, policyRevision, webhook, status: "pending",
    };
    state.putWithinTransaction({ kind: "github_intake_dispatch", recordId: workItem.id, expectedRevision: 0, payload: intent }, now);
    return { outcome: "accepted", reasonCode: "automatic_intake_reserved" };
  }

  commitGitHubDelivery(
    { delivery, targetKey, expectedWorkItemRevision, expectedDeliveryRevision }: CommitWorkItemGitHubDeliveryInput,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
    retainReceipt?: (delivery: LingAppServerGitHubDelivery) => void,
  ): CommitWorkItemGitHubDeliveryResult {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const { workItemId, deliveryId, observedAt } = delivery;
      const workItem = this.getWorkItem(workItemId);
      const acceptance = state.get("work_item_acceptance", workItemId)?.payload as WorkItemAcceptanceReceipt | undefined;
      const existingTarget = state.get("work_item_target", targetKey)?.payload as { workItemId: string } | undefined;
      const current = state.get("github_delivery_current", workItemId);
      const prior = current?.payload as LingAppServerGitHubDelivery | undefined;
      if (existingTarget && existingTarget.workItemId !== workItemId
        || prior && (prior.threadId !== delivery.threadId || prior.subject.repositoryId !== delivery.subject.repositoryId
          || prior.subject.number !== delivery.subject.number)) throw new Error("github_delivery_binding_conflict");
      if (!workItem || workItem.revision !== expectedWorkItemRevision || acceptance?.id !== delivery.acceptanceId
        || acceptance.dispatch && acceptance.dispatch.threadId !== delivery.threadId
        || !database.prepare("SELECT 1 FROM ling_threads WHERE id=? AND archived_at IS NULL").get(delivery.threadId)) {
        throw new Error("github_delivery_stale");
      }
      if (prior?.deliveryId === deliveryId) {
        retainReceipt?.(prior);
        database.exec("COMMIT");
        return { delivery: prior };
      }
      if (expectedDeliveryRevision !== (current?.revision ?? 0)) throw new Error("github_delivery_stale");
      if (!existingTarget) state.putWithinTransaction({
        kind: "work_item_target", recordId: targetKey, expectedRevision: 0, payload: { workItemId },
      }, observedAt);
      const retained = state.get("github_delivery", deliveryId)?.payload as LingAppServerGitHubDelivery | undefined;
      if (!retained) state.putWithinTransaction({
        kind: "github_delivery", recordId: deliveryId, expectedRevision: 0, payload: delivery,
      }, observedAt);
      const committed = retained ?? delivery;
      state.putWithinTransaction({
        kind: "github_delivery_current", recordId: workItemId, expectedRevision: expectedDeliveryRevision, payload: committed,
      }, observedAt);
      const event = events.store.appendControlPlaneEventWithinTransaction({
        workspaceId: workItem.workspaceId, cwd: events.cwd, domain: "work_items", entityType: "work_item", entityId: workItemId,
        action: "work_item.delivery.reconciled",
        data: { workItemId, deliveryId, status: delivery.status, revision: workItem.revision },
      }, observedAt);
      retainReceipt?.(committed);
      database.exec("COMMIT");
      return { delivery: committed, event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private saveWorkItem(input: UpsertWorkItemInput, now: string, existing?: WorkItem, linkedOwnerId?: string): WorkItem {
    if (input.channelId) {
      this.ports.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.ports.hasAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    const id = existing?.id ?? input.id ?? createWorkItemId();
    const holds: readonly WorkItemHold[] = existing?.holds ?? (linkedOwnerId ? [{
      id: sourceOwnerHoldId(id), kind: "scope", ownerRef: linkedOwnerId, blocksNewAdmission: true,
      reason: "The source owner controls the existing execution.",
    }] : []);
    const createdAt = existing?.createdAt ?? now;
    const labels = input.labels ?? existing?.labels ?? [];
    const artifactIds = input.artifactIds ?? existing?.artifactIds ?? [];
    const proofArtifactIds = input.proofArtifactIds ?? existing?.proofArtifactIds ?? [];
    const revision = (existing?.revision ?? 0) + 1;
    this.context.database
      .prepare(`
        INSERT INTO work_items (
          id,
          workspace_id,
          channel_id,
          source_type,
          source_id,
          revision,
          title,
          description,
          status,
          waiting_reason,
          priority,
          labels_json,
          assignee_teammate_id,
          task_id,
          run_id,
          workflow_id,
          workflow_step_id,
          external_work_id,
          external_work_action_id,
          approval_id,
          artifact_ids_json,
          proof_artifact_ids_json,
          plan_revision,
          control_state,
          control_generation,
          control_receipt_json,
          control_unresolved_effect_ids_json,
          control_recovery_owner,
          holds_json,
          claim_owner_id,
          claim_token,
          claimed_at,
          heartbeat_at,
          claim_expires_at,
          attempt_count,
          retry_budget,
          completed_at,
          failed_at,
          failure_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, source_type, source_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          waiting_reason = excluded.waiting_reason,
          priority = excluded.priority,
          labels_json = excluded.labels_json,
          assignee_teammate_id = excluded.assignee_teammate_id,
          task_id = excluded.task_id,
          run_id = excluded.run_id,
          workflow_id = excluded.workflow_id,
          workflow_step_id = excluded.workflow_step_id,
          external_work_id = excluded.external_work_id,
          external_work_action_id = excluded.external_work_action_id,
          approval_id = excluded.approval_id,
          artifact_ids_json = excluded.artifact_ids_json,
          proof_artifact_ids_json = excluded.proof_artifact_ids_json,
          revision = excluded.revision,
          plan_revision = excluded.plan_revision,
          control_state = excluded.control_state,
          control_generation = excluded.control_generation,
          control_receipt_json = excluded.control_receipt_json,
          control_unresolved_effect_ids_json = excluded.control_unresolved_effect_ids_json,
          control_recovery_owner = excluded.control_recovery_owner,
          holds_json = excluded.holds_json,
          retry_budget = excluded.retry_budget,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.channelId ?? existing?.channelId ?? null,
        input.sourceType,
        input.sourceId,
        revision,
        input.title,
        input.description ?? existing?.description ?? null,
        input.status ?? existing?.status ?? input.initialStatus ?? "ready",
        input.waitingReason ?? existing?.waitingReason ?? null,
        input.priority ?? existing?.priority ?? "normal",
        stringifyJson(labels),
        input.assigneeTeammateId ?? existing?.assigneeTeammateId ?? null,
        input.taskId ?? existing?.taskId ?? null,
        input.runId ?? existing?.runId ?? null,
        input.workflowId ?? existing?.workflowId ?? null,
        input.workflowStepId ?? existing?.workflowStepId ?? null,
        input.externalWorkId ?? existing?.externalWorkId ?? null,
        input.externalWorkActionId ?? existing?.externalWorkActionId ?? null,
        input.approvalId ?? existing?.approvalId ?? null,
        stringifyJson(artifactIds),
        stringifyJson(proofArtifactIds),
        existing?.planRevision ?? null,
        existing?.control.state ?? "active",
        existing?.control.generation ?? 0,
        existing?.control.receipt ? stringifyJson(existing.control.receipt) : null,
        stringifyJson(existing?.control.unresolvedEffectIds ?? []),
        existing?.control.recoveryOwner ?? null,
        stringifyJson(holds),
        existing?.claim?.ownerId ?? null,
        existing?.claim?.token ?? null,
        existing?.claim?.claimedAt ?? null,
        existing?.claim?.heartbeatAt ?? null,
        existing?.claim?.expiresAt ?? null,
        existing?.attemptCount ?? 0,
        input.retryBudget ?? existing?.retryBudget ?? 3,
        existing?.completedAt ?? null,
        existing?.failedAt ?? null,
        existing?.failureReason ?? null,
        createdAt,
        now,
      );
    this.replaceWorkItemDependencies(id, input.dependencyIds ?? existing?.dependencyIds ?? [], now);
    const item = this.getWorkItem(id);
    if (!item) {
      throw new Error(`Failed to upsert work item: ${id}`);
    }
    return item;
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.context.database.prepare(workItemSelectSql("WHERE id = ?")).get(id);
    return row ? this.withLinkedExecution(mapWorkItem(row, this.getWorkItemDependencyIds(id))) : undefined;
  }

  listWorkItems(options: ListWorkItemsOptions = {}, now?: string): WorkItem[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.sourceType) {
      clauses.push("source_type = ?");
      params.push(options.sourceType);
    }
    if (options.assigneeTeammateId) {
      clauses.push("assignee_teammate_id = ?");
      params.push(options.assigneeTeammateId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${workItemSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => {
        const typedRow = row as Record<string, SQLOutputValue>;
        return this.withLinkedExecution(mapWorkItem(typedRow, this.getWorkItemDependencyIds(readString(typedRow, "id")), now));
      });
  }

  routeWorkItem(id: string, input: WorkItemRouteRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) {
      return undefined;
    }
    if (existing.linkedExecution && (input.channelId !== undefined && input.channelId !== existing.channelId
      || input.assigneeTeammateId !== undefined && input.assigneeTeammateId !== existing.assigneeTeammateId)) {
      throw new Error("The source owner controls the existing execution.");
    }
    if (existing.workflowId && existing.planRevision && input.channelId !== undefined && input.channelId !== existing.channelId) {
      throw new Error("Work item is assigned to a Workflow in its current channel.");
    }
    if (input.channelId) {
      this.ports.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.ports.hasAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    this.context.database
      .prepare(`
        UPDATE work_items
        SET channel_id = ?, priority = ?, assignee_teammate_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.channelId === undefined ? existing.channelId ?? null : input.channelId,
        input.priority ?? existing.priority,
        input.assigneeTeammateId === undefined ? existing.assigneeTeammateId ?? null : input.assigneeTeammateId,
        now,
        id,
      );
    return this.getWorkItem(id);
  }

  acceptWorkItem(
    id: string,
    input: WorkItemAcceptanceRequest,
    now: string,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
  ): WorkItemAcceptanceResult | undefined {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.acceptWithinTransaction(id, input, now, state);
      if (!result || result.replayed) {
        database.exec("COMMIT");
        return result;
      }
      const { workItem, receipt } = result;
      const event = events.store.appendControlPlaneEventWithinTransaction({
        workspaceId: workItem.workspaceId, cwd: events.cwd, domain: "work_items",
        entityType: "work_item", entityId: id, action: receipt.dispatch ? "work_item.thread.linked" : "work_item.accepted", idempotencyKey: receipt.id,
        data: { workItemId: id, revision: receipt.workItemRevision, actorId: receipt.actorId, acceptanceId: receipt.id,
          ...(receipt.dispatch ? { threadId: receipt.dispatch.threadId } : {}) },
      }, now);
      database.exec("COMMIT");
      return { ...result, event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private acceptWithinTransaction(id: string, input: WorkItemAcceptanceRequest, now: string, state: SqliteAppServerStateStore): WorkItemAcceptanceResult | undefined {
    const workItem = this.getWorkItem(id);
    if (!workItem) return undefined;
    const prior = state.get("work_item_acceptance", id)?.payload as WorkItemAcceptanceReceipt | undefined;
    if (prior) {
      if (prior.idempotencyKey !== input.idempotencyKey) {
        if (prior.dispatch && input.dispatch) return { workItem, receipt: prior, replayed: true };
        throw new Error("work_item_acceptance_already_committed");
      }
      if (prior.actorId !== input.actorId || prior.acceptedRevision !== input.expectedRevision
        || !sameConversationDispatch(prior.dispatch, input.dispatch)) {
        throw new Error("work_item_acceptance_idempotency_conflict");
      }
      return { workItem, receipt: prior, replayed: true };
    }
    if (workItem.revision !== input.expectedRevision || workItem.control.state !== "active"
      || workItem.holds.some(hold => hold.blocksNewAdmission)
      || workItem.claim && workItem.claim.expiresAt > now
      || !["intake", "triage", "backlog", "ready"].includes(workItem.status)) return undefined;
    const acceptanceId = `work_item_acceptance_${randomUUID()}`;
    const dispatch = input.dispatch ? { ...input.dispatch, submissionKey: `work-item:${acceptanceId}` } : undefined;
    if (dispatch) {
      const thread = this.context.database.prepare(`SELECT active_run_id FROM ling_threads
        WHERE id=? AND workspace_id=? AND kind='conversation' AND channel_id IS NULL AND archived_at IS NULL AND status!='archived'`)
        .get(dispatch.threadId, workItem.workspaceId);
      if (!thread || thread.active_run_id || state.get("work_item_thread", dispatch.threadId)
        || this.context.database.prepare(`SELECT 1 FROM ling_turns WHERE thread_id=? AND status IN ('queued','running','waiting_for_approval','waiting_for_input') LIMIT 1`)
          .get(dispatch.threadId)) throw new Error("work_item_dispatch_thread_unavailable");
      const binding: WorkItemConversationBinding = { workItemId: id, acceptanceId, submissionKey: dispatch.submissionKey };
      state.putWithinTransaction({ kind: "work_item_thread", recordId: dispatch.threadId, expectedRevision: 0, payload: binding }, now);
    }
    const receipt: WorkItemAcceptanceReceipt = {
      id: acceptanceId,
      workItemId: id,
      acceptedRevision: workItem.revision,
      workItemRevision: workItem.revision + 1,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      acceptedAt: now,
      ...(dispatch ? { dispatch } : {}),
    };
    this.context.database.prepare("UPDATE work_items SET status='ready', waiting_reason=NULL, revision=revision+1, updated_at=? WHERE workspace_id=? AND id=?")
      .run(now, workItem.workspaceId, id);
    state.putWithinTransaction({ kind: "work_item_acceptance", recordId: id, expectedRevision: 0, payload: receipt }, now);
    return { workItem: this.getWorkItem(id)!, receipt, replayed: false };
  }

  getConversationBinding(threadId: string, state: SqliteAppServerStateStore): WorkItemConversationBinding | undefined {
    return state.get("work_item_thread", threadId)?.payload as WorkItemConversationBinding | undefined;
  }

  applyPlanChange(input: WorkItemPlanChangeInput, now: string, state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string }): WorkItemPlanChangeResult {
    const { action, workItemId, expectedWorkItemRevision, planRevision, idempotencyKey } = input;
    const operationId = createHash("sha256").update(JSON.stringify([workItemId, idempotencyKey])).digest("hex");
    const changeRequest = action === "request" ? [input.affectedStageIds, input.reason] : [input.changeId];
    const fingerprint = createHash("sha256").update(JSON.stringify([action, planRevision, expectedWorkItemRevision, changeRequest])).digest("hex");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(workItemId);
      if (!item) throw new Error("work_item_plan_change_unavailable");
      const prior = state.get("work_item_plan_change", operationId)?.payload as {
        readonly fingerprint: string; readonly receipt: WorkItemPlanChangeResult["receipt"];
      } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("work_item_plan_change_conflict");
        database.exec("COMMIT");
        return { workItem: item, receipt: prior.receipt, replayed: true };
      }
      if (!item.workflowId || item.planRevision !== planRevision || item.revision !== expectedWorkItemRevision) {
        throw new Error("work_item_plan_change_stale");
      }
      const holds = [...item.holds];
      let affectedStepIds: readonly string[];
      let changeId: string;
      if (action === "request") {
        if (this.getWorkflowAdmissionBlocker(item.workflowId, state)) throw new Error("work_item_plan_change_unavailable");
        const steps = this.ports.listChannelWorkflowSteps({ workflowId: item.workflowId, complete: true });
        affectedStepIds = affectedWorkflowStages(steps, input.affectedStageIds);
        changeId = `work_item_change_${operationId}`;
        holds.push({ id: changeId, ownerRef: changeId, kind: "plan", reason: input.reason,
          blocksNewAdmission: true, workflowStepIds: affectedStepIds });
      } else {
        changeId = input.changeId;
        const index = holds.findIndex(hold => hold.id === changeId && hold.kind === "plan" && hold.workflowStepIds?.length);
        if (index < 0) throw new Error("work_item_plan_change_stale");
        affectedStepIds = holds[index]!.workflowStepIds!;
        holds.splice(index, 1);
      }
      const receipt = { changeId, status: action === "request" ? "pending" as const : "withdrawn" as const, planRevision, affectedStepIds };
      database.prepare("UPDATE work_items SET holds_json=?, revision=revision+1, updated_at=? WHERE id=?")
        .run(stringifyJson(holds), now, workItemId);
      if (!state.putWithinTransaction({ kind: "work_item_plan_change", recordId: operationId, expectedRevision: 0, payload: { receipt, fingerprint } }, now)) {
        throw new Error("work_item_plan_change_conflict");
      }
      const event = events.store.appendControlPlaneEventWithinTransaction({
        workspaceId: item.workspaceId, cwd: events.cwd, domain: "work_items", entityType: "work_item", entityId: workItemId,
        action: `work_item.plan_change.${receipt.status}`,
        data: { workItemId, changeId, planRevision, workItemRevision: item.revision + 1 },
      }, now);
      const workItem = this.getWorkItem(workItemId)!;
      database.exec("COMMIT");
      return { workItem, receipt, replayed: false, event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  bindWorkflow(input: LingAppServerWorkItemWorkflowBindParams, now: string, state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
    previousWorkflowSettled?: (workflowId: string, retainedRunIds: ReadonlySet<string>) => boolean) {
    const { workItemId, planId, expectedPlanRevision, expectedWorkItemRevision, idempotencyKey, previousWorkflowId,
      resolvedPlanChangeIds, retainStageResults, retainStageExecutions } = input;
    const fingerprint = createHash("sha256").update(JSON.stringify([workItemId, planId, expectedPlanRevision, expectedWorkItemRevision,
      ...(previousWorkflowId === undefined ? [] : [previousWorkflowId]),
      ...(resolvedPlanChangeIds?.length ? [[...resolvedPlanChangeIds].sort()] : []),
      ...(retainStageResults?.length ? [retainStageResults.map(result => [result.sourceStepId, result.expectedSourceRevision, result.targetStepId])] : []),
      ...(retainStageExecutions?.length ? [{ retainStageExecutions: retainStageExecutions.map(source =>
        [source.sourceStepId, source.expectedSourceRevision, source.targetStepId, source.sourceRunId]) }] : [])])).digest("hex");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const retained = state.findByIdempotencyKey("work_item_workflow", idempotencyKey)?.payload as WorkItemWorkflowLink | undefined;
      const item = this.getWorkItem(workItemId);
      if (!item) throw new Error("work_item_workflow_not_found");
      if (retained) {
        if (retained.fingerprint !== fingerprint) throw new Error("work_item_workflow_idempotency_conflict");
        database.exec("COMMIT");
        return { binding: retained.binding, workItem: item, replayed: true };
      }
      const plan = this.ports.getProposedPlanArtifact(planId);
      const workflow = plan?.acceptedWorkflowId && this.ports.getChannelWorkflow(plan.acceptedWorkflowId);
      const acceptance = state.get("work_item_acceptance", item.id)?.payload as WorkItemAcceptanceReceipt | undefined;
      if (!plan || !workflow || plan.workspaceId !== item.workspaceId || workflow.workspaceId !== item.workspaceId
        || plan.status !== "accepted" || item.channelId && workflow.channelId !== item.channelId
        || !acceptance) throw new Error("work_item_workflow_not_found");
      if (item.revision !== expectedWorkItemRevision || plan.revision !== expectedPlanRevision
        || item.workflowId !== previousWorkflowId || state.get("work_item_workflow", workflow.id)) throw new Error("work_item_workflow_stale");
      const prior = previousWorkflowId ? state.get("work_item_workflow", previousWorkflowId)?.payload as WorkItemWorkflowLink | undefined : undefined;
      if (previousWorkflowId) {
        const parent = prior && this.ports.getProposedPlanArtifact(prior.binding.planId);
        if (!prior || prior.binding.workItemId !== item.id || !parent || parent.supersededByPlanId !== plan.id
          || plan.parentPlanId !== parent.id || parent.acceptedWorkflowId !== previousWorkflowId
          || plan.threadId !== parent.threadId || item.planRevision !== `${parent.id}:${prior.binding.planRevision}`) {
          throw new Error("work_item_workflow_stale");
        }
      }
      const resolvedChanges = new Set(resolvedPlanChangeIds);
      if (resolvedChanges.size && (!previousWorkflowId || [...resolvedChanges].some(id =>
        !item.holds.some(hold => hold.id === id && hold.kind === "plan" && hold.workflowStepIds?.length)))) {
        throw new Error("work_item_workflow_stale");
      }
      const retainedHolds = item.holds.filter(hold => !resolvedChanges.has(hold.id));
      if (item.control.state !== (previousWorkflowId ? "paused" : "active") || retainedHolds.some(hold => hold.blocksNewAdmission)
        || item.control.unresolvedEffectIds.length || item.taskId || item.claim && item.claim.expiresAt > now
        || acceptance.dispatch && !this.conversationDispatchSettled(acceptance, item)
        || !["ready", "running", "waiting", "review"].includes(item.status)
        || !["draft", "ready"].includes(workflow.status)) throw new Error("work_item_workflow_held");
      const affected = new Set(item.holds.filter(hold => resolvedChanges.has(hold.id)).flatMap(hold => hold.workflowStepIds ?? []));
      const stageResults: LingAppServerRetainedWorkflowStageResult[] = [];
      const stageExecutions: LingAppServerRetainedWorkflowStageExecution[] = [];
      const priorExecutions = prior?.binding.retainedStageExecutions ?? [];
      const priorSources = [...prior?.binding.retainedStageResults ?? [], ...priorExecutions];
      const currentSource = (stepId: string, targetId: string, revision: string): ChannelWorkflowStep => {
        const source = this.ports.getChannelWorkflowStep(stepId);
        const target = this.ports.getChannelWorkflowStep(targetId);
        if (!previousWorkflowId || !resolvedChanges.size || !source || !source.runId || source.updatedAt !== revision
          || (source.workflowId === previousWorkflowId ? affected.has(source.id) : !priorSources.some(candidate =>
            candidate.sourceStepId === source.id && candidate.sourceRunId === source.runId && !affected.has(candidate.targetStepId)))
          || target?.workflowId !== workflow.id || target.status !== "queued") throw new Error("work_item_workflow_retained_result_stale");
        return source;
      };
      for (const input of retainStageResults ?? []) {
        const source = currentSource(input.sourceStepId, input.targetStepId, input.expectedSourceRevision);
        const result = readRetainedWorkflowStageResult(this.ports, source.workflowId, input);
        if (!result) throw new Error("work_item_workflow_retained_result_stale");
        stageResults.push(result);
      }
      if (retainStageExecutions?.length) {
        const successorStageIds = new Set(this.ports.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true })
          .map(step => step.metadata?.planStageId));
        for (const input of retainStageExecutions) {
          const source = currentSource(input.sourceStepId, input.targetStepId, input.expectedSourceRevision);
          const sourceStageId = source.metadata?.planStageId;
          if (!sourceStageId || successorStageIds.has(sourceStageId) || source.metadata?.planBallotKey
            || !ownsRetainableWorkflowStageExecution(this.ports, source, input.sourceRunId)) {
            throw new Error("work_item_workflow_retained_result_stale");
          }
          stageExecutions.push({ ...input, sourceWorkflowId: source.workflowId, sourceStageId });
        }
      }
      if (previousWorkflowId) {
        const carriedRuns = new Set(stageExecutions.map(execution => execution.sourceRunId));
        const predecessors = new Set([previousWorkflowId, ...priorExecutions.map(execution => execution.sourceWorkflowId)]);
        if (!readSqliteWithinTransaction(database, () => [...predecessors].every(id => previousWorkflowSettled?.(id, carriedRuns)))) {
          throw new Error("work_item_workflow_predecessor_unsettled");
        }
      }
      const binding: LingAppServerWorkItemWorkflowBinding = { workItemId, workflowId: workflow.id, threadId: plan.threadId,
        planId, planRevision: plan.revision, linkedAt: now, ...(previousWorkflowId ? { previousWorkflowId } : {}),
        ...(stageResults.length ? { retainedStageResults: stageResults } : {}),
        ...(stageExecutions.length ? { retainedStageExecutions: stageExecutions } : {}) };
      const progressStageIds = previousWorkflowId && affected.size
        ? this.ports.listChannelWorkflowSteps({ workflowId: previousWorkflowId, complete: true }).flatMap(step =>
            affected.has(step.id) && step.metadata?.planStageId ? [step.metadata.planStageId] : []) : [];
      state.putWithinTransaction({ kind: "work_item_workflow", recordId: workflow.id, idempotencyKey, expectedRevision: 0,
        payload: { binding, fingerprint, progressStageIds } satisfies WorkItemWorkflowLink }, now);
      database.prepare(`UPDATE work_items SET workflow_id=?, plan_revision=?, channel_id=?, holds_json=?, revision=revision+1, updated_at=?,
        claim_owner_id=NULL, claim_token=NULL, claimed_at=NULL, heartbeat_at=NULL, claim_expires_at=NULL
        WHERE workspace_id=? AND id=?`).run(workflow.id, `${planId}:${plan.revision}`, workflow.channelId, stringifyJson(retainedHolds), now, item.workspaceId, item.id);
      const event = events.store.appendControlPlaneEventWithinTransaction({
        workspaceId: item.workspaceId, cwd: events.cwd, domain: "work_items", entityType: "work_item", entityId: item.id,
        action: "work_item.workflow.linked", data: { workItemId, workflowId: workflow.id, threadId: plan.threadId,
          revision: item.revision + 1, ...(previousWorkflowId ? { previousWorkflowId } : {}),
          ...(resolvedChanges.size ? { resolvedPlanChangeIds: [...resolvedChanges] } : {}) },
      }, now);
      const workItem = this.getWorkItem(workItemId)!;
      database.exec("COMMIT");
      return { binding, workItem, replayed: false, event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private conversationDispatchSettled(acceptance: WorkItemAcceptanceReceipt, item: WorkItem): boolean {
    const run = item.runId ? this.ports.getRun(item.runId) : undefined;
    const threadId = acceptance.dispatch?.threadId;
    return Boolean(run && threadId && run.threadId === threadId && ["succeeded", "failed", "cancelled"].includes(run.status)
      && !this.context.database.prepare(`SELECT 1 FROM ling_turns WHERE thread_id=?
        AND status IN ('queued','running','waiting_for_approval','waiting_for_input') LIMIT 1`).get(threadId));
  }

  getWorkflowAdmissionBlocker(workflowId: string, state: SqliteAppServerStateStore, step?: ChannelWorkflowStep, executionRunId?: string): string | undefined {
    const deliberation = this.readDeliberationWorkflowBinding(workflowId, state);
    if (deliberation) return this.getDeliberationWorkflowAdmissionBlocker(deliberation, state, step);
    const link = state.get("work_item_workflow", workflowId)?.payload as WorkItemWorkflowLink | undefined;
    if (!link) {
      const planId = this.ports.getChannelWorkflow(workflowId)?.metadata?.sourceProposedPlanId;
      const parentId = planId ? this.ports.getProposedPlanArtifact(planId)?.parentPlanId : undefined;
      const previousWorkflowId = parentId ? this.ports.getProposedPlanArtifact(parentId)?.acceptedWorkflowId : undefined;
      return step?.metadata?.requiredPlanDecision || step?.metadata?.planBallotKey || step?.metadata?.requiredPlanHandoffStepIds?.length
        || previousWorkflowId && state.get("work_item_workflow", previousWorkflowId)
        ? "work_item_workflow_unbound" : undefined;
    }
    const binding = link.binding;
    const item = this.getWorkItem(binding.workItemId);
    if (item?.workflowId && item.workflowId !== workflowId && executionRunId && step
      && ownsRetainableWorkflowStageExecution(this.ports, step, executionRunId)) {
      const current = state.get("work_item_workflow", item.workflowId)?.payload as WorkItemWorkflowLink | undefined;
      const executions = current?.binding.retainedStageExecutions?.filter(execution =>
        execution.sourceWorkflowId === workflowId && execution.sourceStepId === step.id && execution.sourceRunId === executionRunId);
      if (current?.binding.workItemId === item.id && executions?.length) {
        return this.getWorkflowAdmissionBlocker(item.workflowId, state);
      }
    }
    const plan = this.ports.getProposedPlanArtifact(binding.planId);
    if (!item || item.workflowId !== workflowId || item.planRevision !== `${binding.planId}:${binding.planRevision}`
      || !plan?.acceptedAt || plan.status !== "accepted" || plan.acceptedWorkflowId !== workflowId) return "work_item_workflow_stale";
    if (item.control.state !== "active" || item.holds.some(hold => hold.blocksNewAdmission && !hold.workflowStepIds)
      || item.control.unresolvedEffectIds.length || ["done", "cancelled", "archived", "superseded"].includes(item.status)) {
      return "work_item_workflow_held";
    }
    const scopedHolds = item.holds.filter(hold => hold.blocksNewAdmission && hold.workflowStepIds);
    if (step && scopedHolds.some(hold => hold.workflowStepIds!.includes(step.id))) return "work_item_plan_change_pending";
    if (step?.metadata?.planStageId && item.planRevision) {
      const unanswered = listWorkItemStageQuestions(this.ports, item.id, item.planRevision, step.id)
        .filter(result => !result.reply && !result.question.askingExecution);
      if (unanswered.some(result => workItemStageQuestionExpired(result.question, Date.now()))) return "work_item_stage_question_overdue";
      if (unanswered.length) return "work_item_stage_question_pending";
    }
    if (step && binding.retainedStageResults?.some(retained => {
      if (retained.targetStepId !== step.id) return false;
      const current = readRetainedWorkflowStageResult(this.ports, retained.sourceWorkflowId, retained);
      return current?.sourceRunId !== retained.sourceRunId || current.sourceArtifactId !== retained.sourceArtifactId;
    })) return "work_item_retained_stage_stale";
    for (const execution of binding.retainedStageExecutions ?? []) {
      if (execution.targetStepId !== step?.id) continue;
      const progress = readRetainedWorkflowStageExecution(this.ports, execution);
      if (progress.status !== "available") return progress.status === "pending"
        ? "work_item_retained_stage_pending" : "work_item_retained_stage_unavailable";
    }
    const successor = plan.supersededByPlanId ? this.ports.getProposedPlanArtifact(plan.supersededByPlanId) : undefined;
    if (successor?.status === "accepted" && successor.acceptedWorkflowId
      && !(scopedHolds.length && step?.runId && ["running", "waiting_for_input", "waiting_for_approval"].includes(step.status))) {
      return "work_item_workflow_replan_pending";
    }
    if (this.incompleteWorkItemDependencyIds(item).length) return "work_item_workflow_dependency_blocked";
    if (step?.metadata?.planBallotKey) {
      const { planBallotKey, planStageId } = step.metadata;
      const target = this.ports.listChannelWorkflowSteps({ workflowId, complete: true }).find(candidate => {
        const stageId = candidate.metadata?.planStageId;
        const decision = candidate.metadata?.requiredPlanDecision;
        return stageId && planStageId && decision?.ballot?.voterStageIds.includes(planStageId)
          && planStageBallotKey(binding.planId, stageId, decision) === planBallotKey;
      });
      if (!target) return "work_item_ballot_pending";
      const subject = { workItemId: item.id, planRevision: item.planRevision, workflowStepId: target.id };
      if (this.ports.getWorkItemEvidence(workItemWorkflowDecisionId(subject, "resolution"))) return "work_item_ballot_closed";
      if (!this.ports.getWorkItemEvidence(workItemWorkflowDecisionId(subject, "round"))) return "work_item_ballot_pending";
    }
    if (step?.metadata?.requiredPlanDecision && !this.getWorkflowStepDecision(step, state)) return "work_item_decision_pending";
    for (const sourceStepId of step?.metadata?.requiredPlanHandoffStepIds ?? []) {
      const source = this.ports.getChannelWorkflowStep(sourceStepId);
      if (!source || !step || source.workflowId !== workflowId || !stageHandoffAdmitsTarget(this.ports, {
        workItemId: item.id, planRevision: item.planRevision, sourceStepId, sourceRevision: source.updatedAt, targetStepId: step.id,
      }, source, step)) return "work_item_handoff_pending";
    }
    // Recheck before the Task reservation and again before Run ownership links.
    if (step && (["queued", "blocked", "claimed"].includes(step.status) || step.metadata?.startOwner?.phase === "preparing")) {
      const goal = this.readWorkflowGoal(item, binding, state);
      if (goal && (goal.tokenBudget !== undefined || goal.supervisionPolicy?.maxTimeSeconds !== undefined)) {
        const blocker = readWorkItemWorkflowUsage(this.context, item, goal, new Date().toISOString()).goalBudget?.blocker;
        if (blocker) return blocker;
      }
      const stageId = step.metadata?.planStageId;
      const policy = goal && (goal.supervisionPolicy ?? defaultGoalSupervisionPolicy);
      if (policy?.autoContinue && stageId && readWorkItemStageProgress(this.context, item, step, stageId,
        policy.maxNoEvidenceContinuations).blocker?.status === "stalled") {
        return "work_item_stage_same_blocker_threshold";
      }
    }
    return undefined;
  }

  getWorkflowUsage(item: WorkItem, state: SqliteAppServerStateStore, now: string) {
    const link = item.workflowId ? state.get("work_item_workflow", item.workflowId)?.payload as WorkItemWorkflowLink | undefined : undefined;
    if (link?.binding.workItemId !== item.id) return undefined;
    return readWorkItemWorkflowUsage(this.context, item, this.readWorkflowGoal(item, link.binding, state), now);
  }

  getWorkflowProviderAdmissionBlocker(rootRunId: string, requestedTokens: number | undefined, now: string,
    state: SqliteAppServerStateStore): string | undefined {
    const run = this.ports.getRun(rootRunId);
    const step = run?.workflowStepId ? this.ports.getChannelWorkflowStep(run.workflowStepId) : undefined;
    const link = step && state.get("work_item_workflow", step.workflowId)?.payload as WorkItemWorkflowLink | undefined;
    const deliberation = step && this.readDeliberationWorkflowBinding(step.workflowId, state);
    if (!step || !link && !deliberation) return undefined;
    const blocker = this.getWorkflowAdmissionBlocker(step.workflowId, state, step, rootRunId);
    if (blocker) return blocker;
    const item = this.getWorkItem((link?.binding ?? deliberation!).workItemId);
    if (!item?.workflowId) return "work_item_workflow_stale";
    const current = item.workflowId === step.workflowId
      ? link : state.get("work_item_workflow", item.workflowId)?.payload as WorkItemWorkflowLink | undefined;
    if (!current) return "work_item_workflow_stale";
    const goal = this.readWorkflowGoal(item, current.binding, state);
    if (!goal || goal.tokenBudget === undefined && goal.supervisionPolicy?.maxTimeSeconds === undefined) return undefined;
    const budget = readWorkItemWorkflowUsage(this.context, item, goal, now).goalBudget;
    if (!budget) return undefined;
    if (budget.blocker) return budget.blocker;
    if (budget.tokenBudget === undefined) return undefined;
    if (requestedTokens === undefined) return "work_item_goal_usage_unconfirmed";
    if (requestedTokens > budget.tokenBudget - budget.accountedTokens - (budget.reservedTokens ?? 0)) {
      return "work_item_goal_token_budget_exhausted";
    }
    return undefined;
  }

  private readDeliberationWorkflowBinding(workflowId: string, state: SqliteAppServerStateStore) {
    return (state.get("work_item_deliberation_workflow", workflowId)?.payload as
      { readonly binding: WorkItemDeliberationWorkflowBinding } | undefined)?.binding;
  }

  private getDeliberationWorkflowAdmissionBlocker(binding: WorkItemDeliberationWorkflowBinding, state: SqliteAppServerStateStore,
    step?: ChannelWorkflowStep): string | undefined {
    const item = this.getWorkItem(binding.workItemId);
    const origin = this.ports.getChannelWorkflowStep(binding.originStepId);
    if (!item || item.workflowId !== binding.originWorkflowId || item.planRevision !== binding.planRevision
      || origin?.workflowId !== binding.originWorkflowId || origin.updatedAt !== binding.originStepRevision
      || item.control.generation !== binding.controlGeneration) return "work_item_deliberation_workflow_stale";
    if (binding.deadlineAt <= new Date().toISOString()) return "work_item_deliberation_deadline_expired";
    if (this.ports.getWorkItemEvidence(checkpointDeliberationResolutionId(binding.roundId))) return "work_item_deliberation_closed";
    const parentBlocker = this.getWorkflowAdmissionBlocker(binding.originWorkflowId, state);
    if (parentBlocker) return parentBlocker;
    if (item.holds.some(hold => hold.blocksNewAdmission && hold.workflowStepIds?.includes(origin.id))) return "work_item_plan_change_pending";
    if (step) {
      if (step.metadata?.sideEffectClass !== "analysis_readonly" || binding.steps[step.id] !== deliberationWorkflowStepDigest(step)) {
        return "work_item_deliberation_step_changed";
      }
      const presetId = step.metadata.providerPresetId;
      const preset = presetId ? this.ports.getProviderConfigurationSnapshot(presetId) : undefined;
      if (!preset || preset.configRevision !== binding.providerRevisions[preset.provider.id]) {
        return "work_item_deliberation_provider_changed";
      }
    }
    const link = state.get("work_item_workflow", binding.originWorkflowId)?.payload as WorkItemWorkflowLink | undefined;
    if (!link) return "work_item_deliberation_workflow_stale";
    const goal = this.readWorkflowGoal(item, link.binding, state);
    if (goal && (goal.tokenBudget !== undefined || goal.supervisionPolicy?.maxTimeSeconds !== undefined)) {
      return readWorkItemWorkflowUsage(this.context, item, goal, new Date().toISOString()).goalBudget?.blocker;
    }
    return undefined;
  }

  getStageProgress(item: WorkItem, step: ChannelWorkflowStep, state: SqliteAppServerStateStore) {
    const stageId = step.metadata?.planStageId;
    const link = state.get("work_item_workflow", step.workflowId)?.payload as WorkItemWorkflowLink | undefined;
    if (!stageId || link?.binding.workItemId !== item.id || item.workflowId !== step.workflowId) return undefined;
    const goal = this.readWorkflowGoal(item, link.binding, state);
    const policy = goal && (goal.supervisionPolicy ?? defaultGoalSupervisionPolicy);
    const progress = readWorkItemStageProgress(this.context, item, step, stageId, policy?.autoContinue ? policy.maxNoEvidenceContinuations : undefined);
    return progress.blocker || progress.lastVerified ? progress : undefined;
  }

  private readWorkflowGoal(item: WorkItem, binding: LingAppServerWorkItemWorkflowBinding, state: SqliteAppServerStateStore) {
    const planGoal = this.ports.getLingThreadGoal(binding.threadId);
    if (planGoal) return planGoal;
    const acceptance = state.get("work_item_acceptance", item.id)?.payload as WorkItemAcceptanceReceipt | undefined;
    const dispatchThread = acceptance?.dispatch?.threadId;
    return dispatchThread ? this.ports.getLingThreadGoal(dispatchThread) : undefined;
  }

  getWorkflowStepDecision(step: ChannelWorkflowStep, state: SqliteAppServerStateStore) {
    const required = step.metadata?.requiredPlanDecision;
    if (!required) return undefined;
    const link = state.get("work_item_workflow", step.workflowId)?.payload as WorkItemWorkflowLink | undefined;
    if (!link) return undefined;
    const { workItemId, planId, planRevision } = link.binding;
    if (required.receiptSource === "checkpoint") {
      const application = state.get("work_item_deliberation_application", step.id)?.payload as WorkItemDeliberationApplication | undefined;
      if (!application) return undefined;
      const item = this.getWorkItem(workItemId);
      if (!item || application.workItemId !== item.id || application.planRevision !== `${planId}:${planRevision}`
        || application.workflowId !== step.workflowId || application.stepId !== step.id
        || application.controlGeneration !== item.control.generation || application.stepDigest !== deliberationWorkflowStepDigest(step)
        || !required.options.includes(application.option)
        || !this.ports.getWorkItemEvidence(application.resolutionId)) return undefined;
      return { id: application.resolutionId, option: application.option };
    }
    const selected = readSelectedWorkflowDecision(this.ports, { workItemId, planRevision: `${planId}:${planRevision}`, workflowStepId: step.id });
    return selected && required.options.includes(selected.option) ? selected : undefined;
  }

  getStageRetryBudget(step: ChannelWorkflowStep, state: SqliteAppServerStateStore):
    import("@ling-stack/contracts").LingAppServerWorkItemStageRetryBudget | undefined {
    const stageId = step.metadata?.planStageId;
    if (!stageId) return undefined;
    const link = state.get("work_item_workflow", step.workflowId)?.payload as WorkItemWorkflowLink | undefined;
    const item = link && this.getWorkItem(link.binding.workItemId);
    if (!item || item.workflowId !== step.workflowId) return undefined;

    // A preparing owner reserves capacity during the interval before Run creation.
    const counts = this.context.database.prepare(`
      WITH stage_starts AS (
        SELECT json_extract(s.metadata_json, '$.planStageId') AS stage_id,
          (SELECT COUNT(DISTINCT r.task_id) FROM run_sessions r WHERE r.workflow_step_id=s.id) +
          CASE WHEN s.status='running' AND json_extract(s.metadata_json, '$.startOwner.phase')='preparing'
            AND NOT EXISTS (SELECT 1 FROM run_sessions r WHERE r.workflow_step_id=s.id AND r.task_id=s.task_id)
          THEN 1 ELSE 0 END AS attempts
        FROM app_server_state link
        JOIN channel_workflow_steps s ON s.workspace_id=link.workspace_id AND s.workflow_id=link.record_id
        WHERE link.workspace_id=? AND link.kind='work_item_workflow'
          AND json_extract(link.payload_json, '$.binding.workItemId')=?
          AND json_type(s.metadata_json, '$.planStageId')='text'
      ), stage_totals AS (SELECT stage_id, SUM(attempts) AS starts FROM stage_starts GROUP BY stage_id)
      SELECT COALESCE(MAX(CASE WHEN stage_id=? THEN starts END), 0) AS starts,
        COALESCE(SUM(MAX(starts-1, 0)), 0) AS retries
      FROM stage_totals
    `).get(item.workspaceId, item.id, stageId)!;
    const starts = readNumber(counts, "starts");
    const goal = this.readWorkflowGoal(item, link.binding, state);
    const supervision = goal?.supervisionPolicy ?? defaultGoalSupervisionPolicy;
    const workItemLimit = goal && supervision.autoContinue
      ? Math.min(item.retryBudget, supervision.maxContinuations) : item.retryBudget;
    const workItemRetriesRemaining = Math.max(0, workItemLimit - readNumber(counts, "retries"));
    const policy = step.metadata?.policy;
    const stageLimit = policy?.retryable === false ? 0 : policy?.maxRetries ?? item.retryBudget;
    const stageRetriesRemaining = Math.max(0, stageLimit - Math.max(0, starts - 1));
    return { starts, workItemRetriesRemaining, stageRetriesRemaining,
      exhausted: starts > 0 && (workItemRetriesRemaining === 0 || stageRetriesRemaining === 0) };
  }

  listActiveWorkflowIds(limit: number): readonly string[] {
    return this.context.database.prepare(`
      SELECT workflow.id AS id, workflow.updated_at AS updated_at FROM channel_workflows workflow
      JOIN app_server_state binding ON binding.workspace_id=workflow.workspace_id
        AND binding.kind='work_item_workflow' AND binding.record_id=workflow.id
      JOIN work_items item ON item.id=json_extract(binding.payload_json, '$.binding.workItemId')
        AND item.workspace_id=workflow.workspace_id AND item.workflow_id=workflow.id
      JOIN ling_thread_proposed_plans plan ON plan.id=json_extract(binding.payload_json, '$.binding.planId')
        AND plan.workspace_id=workflow.workspace_id AND plan.accepted_workflow_id=workflow.id
      WHERE workflow.workspace_id=? AND workflow.status IN ('ready','running','waiting_for_approval')
        AND plan.status='accepted' AND item.control_state='active'
        AND NOT EXISTS (
          SELECT 1 FROM ling_thread_proposed_plans successor
          WHERE successor.id=plan.superseded_by_plan_id AND successor.workspace_id=plan.workspace_id
            AND successor.status='accepted' AND successor.accepted_workflow_id IS NOT NULL
        )
        AND item.status NOT IN ('done','cancelled','archived','superseded')
        AND json_array_length(item.control_unresolved_effect_ids_json)=0
        AND NOT EXISTS (SELECT 1 FROM json_each(item.holds_json)
          WHERE json_extract(value,'$.blocksNewAdmission')=1 AND json_type(value,'$.workflowStepIds') IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM work_item_dependencies edge
          LEFT JOIN work_items dependency ON dependency.id=edge.depends_on_work_item_id
          WHERE edge.work_item_id=item.id AND coalesce(dependency.status,'missing')!='done'
        )
      UNION ALL
      SELECT workflow.id AS id, workflow.updated_at AS updated_at FROM channel_workflows workflow
      JOIN app_server_state binding ON binding.workspace_id=workflow.workspace_id
        AND binding.kind='work_item_deliberation_workflow' AND binding.record_id=workflow.id
      WHERE workflow.workspace_id=? AND workflow.status IN ('ready','running','waiting_for_approval')
      ORDER BY updated_at ASC, id ASC LIMIT ?
    `).all(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, limit).map(row => readString(row, "id"));
  }

  checkConversationAdmission(threadId: string, submissionKey: unknown, state: SqliteAppServerStateStore, automaticIntakeReceiptId?: string): WorkItem | undefined {
    const binding = this.getConversationBinding(threadId, state);
    if (!binding) return undefined;
    const workItem = this.getWorkItem(binding.workItemId);
    if (!workItem || (workItem.workflowId && state.get("work_item_workflow", workItem.workflowId))
      || workItem.control.state !== "active" || workItem.control.unresolvedEffectIds.length > 0
      || workItem.holds.some(hold => hold.blocksNewAdmission)
      || ["done", "cancelled", "superseded", "archived"].includes(workItem.status)) throw new Error("work_item_dispatch_held");
    if (!workItem.runId && binding.submissionKey !== submissionKey
      && normalConversationSubmissionKey(threadId, binding.submissionKey) !== submissionKey) throw new Error("work_item_dispatch_intent_required");
    if (!workItem.runId) {
      const intent = state.get("github_intake_dispatch", workItem.id)?.payload as GitHubIntakeDispatchIntent | undefined;
      const acceptance = intent ? state.get("work_item_acceptance", workItem.id)?.payload as WorkItemAcceptanceReceipt | undefined : undefined;
      if (intent && acceptance?.idempotencyKey === intent.receiptId && (intent.status !== "pending" || automaticIntakeReceiptId !== intent.receiptId
        || intent.webhook && !this.context.database.prepare(`
          SELECT 1 FROM automation_event_sources WHERE id=? AND revision=? AND json_extract(source_json, '$.enabled')=1
        `).get(intent.webhook.sourceId, intent.webhook.sourceRevision))) {
        throw new Error("work_item_dispatch_held");
      }
    }
    return workItem;
  }

  linkFirstConversationRun(
    workItem: WorkItem, runId: string, now: string, events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
  ): void {
    if (workItem.runId) return;
    this.context.database.prepare("UPDATE work_items SET run_id=?, revision=revision+1, updated_at=? WHERE id=?")
      .run(runId, now, workItem.id);
    events.store.appendControlPlaneEventWithinTransaction({
      workspaceId: workItem.workspaceId, cwd: events.cwd, domain: "work_items", entityType: "work_item", entityId: workItem.id,
      action: "work_item.dispatch.admitted", idempotencyKey: `work-item-dispatch:${workItem.id}`,
      data: { workItemId: workItem.id, revision: workItem.revision + 1, dispatchStatus: "admitted" },
    }, now);
  }

  claimWorkItem(
    id: string,
    input: WorkItemClaimRequest,
    now: string,
    state: SqliteAppServerStateStore,
  ): { readonly workItem: WorkItem; readonly claimToken?: string; readonly blocker?: WorkItemClaimBlocker } | undefined {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.claimWithinTransaction(id, input, now, state);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private claimWithinTransaction(id: string, input: WorkItemClaimRequest, now: string, state: SqliteAppServerStateStore) {
    const existing = this.getWorkItem(id);
    if (!existing) return undefined;
    const acceptance = state.get("work_item_acceptance", id)?.payload as WorkItemAcceptanceReceipt | undefined;
    const intake = state.get("github_intake_dispatch", id)?.payload as GitHubIntakeDispatchIntent | undefined;
    if (existing.workflowId && state.get("work_item_workflow", existing.workflowId)) {
      return { workItem: existing, blocker: { code: "control_blocked" as const, message: "Work item has an assigned Workflow owner." } };
    }
    if (acceptance?.dispatch || intake?.status === "pending") {
      return { workItem: existing, blocker: { code: "control_blocked" as const, message: "Work item has an assigned conversation owner." } };
    }
    const blocker = this.workItemClaimBlocker(existing, now);
    if (blocker) return { workItem: existing, blocker };
    const claimToken = createWorkItemClaimToken();
    const expiresAt = new Date(Date.parse(now) + clampWorkItemLeaseMs(input.leaseMs)).toISOString();
    this.context.database
      .prepare(`
        UPDATE work_items
        SET status = ?, claim_owner_id = ?, claim_token = ?, claimed_at = ?, heartbeat_at = ?, claim_expires_at = ?, attempt_count = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run("running", input.ownerId, claimToken, now, now, expiresAt, existing.attemptCount + 1, now, id);
    const workItem = this.getWorkItem(id);
    if (!workItem) {
      throw new Error(`Failed to claim work item: ${id}`);
    }
    return { workItem, claimToken };
  }

  heartbeatWorkItem(id: string, input: WorkItemHeartbeatRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const expiresAt = new Date(Date.parse(now) + clampWorkItemLeaseMs(input.leaseMs)).toISOString();
    this.context.database
      .prepare("UPDATE work_items SET heartbeat_at = ?, claim_expires_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(now, expiresAt, now, id);
    return this.getWorkItem(id);
  }

  releaseWorkItem(id: string, input: WorkItemReleaseRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE work_items
        SET status = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run("ready", now, id);
    return this.getWorkItem(id);
  }

  completeWorkItem(id: string, input: WorkItemCompleteRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const proofArtifactIds = input.proofArtifactIds ?? existing.proofArtifactIds;
    this.context.database
      .prepare(`
        UPDATE work_items
        SET status = ?, proof_artifact_ids_json = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, completed_at = ?, failed_at = NULL, failure_reason = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run("done", stringifyJson(proofArtifactIds), now, now, id);
    return this.getWorkItem(id);
  }

  failWorkItem(id: string, input: WorkItemFailRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const canRetry = input.retry === true && existing.attemptCount < existing.retryBudget;
    this.context.database
      .prepare(`
        UPDATE work_items
        SET status = ?, waiting_reason = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, failed_at = ?, failure_reason = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(canRetry ? "ready" : "blocked", canRetry ? null : "user", now, input.reason, now, id);
    return this.getWorkItem(id);
  }

  pauseWorkItem(id: string, input: WorkItemControlRequest, now: string): WorkItem | undefined {
    return this.controlWorkItem(id, "pause", input, now);
  }

  resumeWorkItem(id: string, input: WorkItemControlRequest, now: string): WorkItem | undefined {
    return this.controlWorkItem(id, "resume", input, now);
  }

  cancelWorkItem(id: string, input: WorkItemControlRequest, now: string): WorkItem | undefined {
    return this.controlWorkItem(id, "cancel", input, now);
  }

  applyWorkItemControl(
    id: string,
    action: WorkItemControlAction,
    input: WorkItemControlRequest,
    now: string,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
  ): WorkItemControlResult {
    const recordId = createHash("sha256").update(JSON.stringify([id, input.idempotencyKey])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify([
      action, input.expectedRevision, input.expectedControlGeneration, input.actorId, input.reason,
    ])).digest("hex");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.applyControlWithinTransaction(id, action, input, now, state, events, recordId, fingerprint);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private applyControlWithinTransaction(
    id: string, action: WorkItemControlAction, input: WorkItemControlRequest, now: string,
    state: SqliteAppServerStateStore, events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
    recordId: string, fingerprint: string,
  ): WorkItemControlResult {
    const existing = this.getWorkItem(id);
    if (!existing) return { status: "not_found" };
    const prior = state.get("work_item_control", recordId)?.payload as WorkItemControlSubmission | undefined;
    if (prior) {
      return prior.fingerprint === fingerprint
        ? { status: "replayed", workItem: existing, receipt: prior.receipt }
        : { status: "idempotency_conflict" };
    }
    const lastReceipt = existing.control.receipt;
    if (lastReceipt?.idempotencyKey === input.idempotencyKey) {
      return lastReceipt.action === action && lastReceipt.actorId === input.actorId && lastReceipt.reason === input.reason
        ? { status: "replayed", workItem: existing, receipt: lastReceipt }
        : { status: "idempotency_conflict" };
    }
    const workItem = this.updateWorkItemControl(existing, action, input, now);
    if (!workItem) return { status: "stale_revision" };
    if (workItem.control.generation === existing.control.generation) return { status: "blocked", workItem };
    const receipt = workItem.control.receipt!;
    state.putWithinTransaction({ kind: "work_item_control", recordId, expectedRevision: 0,
      payload: { fingerprint, receipt } satisfies WorkItemControlSubmission }, now);
    const event = events.store.appendControlPlaneEventWithinTransaction({
      workspaceId: workItem.workspaceId, cwd: events.cwd, domain: "work_items",
      entityType: "work_item", entityId: id, action: `work_item.control.${action}`, idempotencyKey: receipt.id,
      data: {
        workItemId: id, revision: String(workItem.revision), controlState: workItem.control.state,
        controlGeneration: String(workItem.control.generation), receiptId: receipt.id,
      },
    }, now);
    return { status: "applied", workItem, receipt, event };
  }

  private controlWorkItem(id: string, action: WorkItemControlAction, input: WorkItemControlRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) return undefined;
    const priorReceipt = existing.control.receipt;
    if (priorReceipt?.idempotencyKey === input.idempotencyKey && priorReceipt.action === action) {
      return existing;
    }
    return this.updateWorkItemControl(existing, action, input, now);
  }

  private updateWorkItemControl(existing: WorkItem, action: WorkItemControlAction, input: WorkItemControlRequest, now: string): WorkItem | undefined {
    if (existing.revision !== input.expectedRevision || existing.control.generation !== input.expectedControlGeneration) {
      return undefined;
    }
    if (existing.linkedExecution) return existing;
    const nextState = nextWorkItemControlState(existing.control.state, action, existing.control.unresolvedEffectIds.length);
    if (!nextState) return existing;
    const generation = existing.control.generation + 1;
    const receipt: WorkItemControlReceipt = {
      id: `work_item_control_${randomUUID().replaceAll("-", "")}`,
      action,
      generation,
      requestedAt: now,
      actorId: input.actorId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      outcome: action === "cancel"
        ? (existing.control.unresolvedEffectIds.length > 0 ? "settling" : "settled")
        : "accepted",
    };
    const update = this.context.database
      .prepare(`
        UPDATE work_items
        SET control_state = ?, control_generation = ?, control_receipt_json = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND control_generation = ?
      `)
      .run(
        nextState,
        generation,
        stringifyJson(receipt),
        now,
        existing.id,
        existing.revision,
        existing.control.generation,
      );
    return update.changes === 1 ? this.getWorkItem(existing.id) : undefined;
  }

  private getWorkItemBySource(sourceType: WorkItemSourceType, sourceId: string): WorkItem | undefined {
    const row = this.context.database
      .prepare(workItemSelectSql("WHERE workspace_id = ? AND source_type = ? AND source_id = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceType, sourceId);
    return row
      ? this.withLinkedExecution(mapWorkItem(row, this.getWorkItemDependencyIds(readString(row, "id"))))
      : undefined;
  }

  private withLinkedExecution(item: WorkItem): WorkItem {
    const { sourceType, sourceId } = item;
    if ((sourceType !== "channel_task" && sourceType !== "automation_run")
      || !item.holds.some(hold => hold.id === sourceOwnerHoldId(item.id) && hold.ownerRef === sourceId)) return item;
    const owner = this.readSourceOwner(sourceType, sourceId, item.workspaceId);
    const linkedExecution = owner && owner.channelId === item.channelId ? owner.execution
      : { kind: sourceType, id: sourceId, status: "unavailable" };
    return { ...item, linkedExecution, ...(linkedExecution.runId ? { runId: linkedExecution.runId } : {}) };
  }

  private readSourceOwner(sourceType: WorkItemSourceType, id: string, workspaceId: string):
    { readonly execution: WorkItemLinkedExecution; readonly channelId?: string } | undefined {
    if (sourceType === "channel_task") {
      const task = this.ports.getTask(id);
      if (task?.workspaceId !== workspaceId) return undefined;
      return { channelId: task.channelId, execution: { kind: sourceType, id, status: task.status, runId: task.currentRunId } };
    }
    if (sourceType === "automation_run") {
      const run = this.ports.getAutomationRun(id);
      if (run?.workspaceId !== workspaceId) return undefined;
      return { channelId: run.channelId, execution: { kind: sourceType, id, status: run.status, runId: run.runId } };
    }
    return undefined;
  }

  private getWorkItemDependencyIds(id: string): string[] {
    return this.context.database
      .prepare("SELECT depends_on_work_item_id FROM work_item_dependencies WHERE work_item_id = ? ORDER BY depends_on_work_item_id ASC")
      .all(id)
      .map((row) => readString(row as Record<string, SQLOutputValue>, "depends_on_work_item_id"));
  }

  private replaceWorkItemDependencies(id: string, dependencyIds: readonly string[], now: string): void {
    this.context.database.prepare("DELETE FROM work_item_dependencies WHERE work_item_id = ?").run(id);
    const insert = this.context.database.prepare("INSERT OR IGNORE INTO work_item_dependencies (work_item_id, depends_on_work_item_id, created_at) VALUES (?, ?, ?)");
    for (const dependencyId of [...new Set(dependencyIds)].filter((dependencyId) => dependencyId !== id)) {
      insert.run(id, dependencyId, now);
    }
  }

  private workItemClaimBlocker(item: WorkItem, now: string): WorkItemClaimBlocker | undefined {
    if (item.control.state !== "active" || item.holds.some(hold => hold.blocksNewAdmission)) {
      return { code: "control_blocked", message: `Work item control is ${item.control.state}.` };
    }
    if (item.status === "done" || item.status === "archived") {
      return { code: "terminal", message: `Work item is terminal: ${item.status}` };
    }
    if (item.attemptCount >= item.retryBudget) {
      return { code: "retry_budget_exhausted", message: "Work item retry budget is exhausted." };
    }
    if (item.claim && item.claim.expiresAt > now) {
      return {
        code: "already_claimed",
        message: "Work item already has an active claim.",
        claimedBy: item.claim.ownerId,
        claimExpiresAt: item.claim.expiresAt,
      };
    }
    const incompleteDependencies = this.incompleteWorkItemDependencyIds(item);
    if (incompleteDependencies.length > 0) {
      return {
        code: "dependency_blocked",
        message: "Work item dependencies are not complete.",
        dependencyIds: incompleteDependencies,
      };
    }
    return undefined;
  }

  private incompleteWorkItemDependencyIds(item: WorkItem): readonly string[] {
    return item.dependencyIds.filter(id => this.getWorkItem(id)?.status !== "done");
  }
}

function sameConversationDispatch(left: WorkItemAcceptanceReceipt["dispatch"], right: WorkItemAcceptanceRequest["dispatch"]): boolean {
  return left?.threadId === right?.threadId && left?.message === right?.message && left?.providerPresetId === right?.providerPresetId;
}

function sourceOwnerHoldId(workItemId: string): string {
  return `work_item_source_owner:${workItemId}`;
}

function affectedWorkflowStages(steps: readonly ChannelWorkflowStep[], requested: readonly string[]): readonly string[] {
  const stageIds = new Set(requested);
  const roots = steps.filter(step => step.metadata?.planStageId && stageIds.has(step.metadata.planStageId));
  if (!roots.length || roots.length !== stageIds.size || stageIds.size !== requested.length) throw new Error("work_item_plan_change_stage_invalid");
  const affected = new Set(roots.map(step => step.id));
  for (const id of affected) {
    for (const step of steps) {
      if (step.metadata?.dependsOnStepIds?.includes(id)) affected.add(step.id);
    }
  }
  return [...affected];
}

function nextWorkItemControlState(state: WorkItemControlState, action: WorkItemControlAction, unresolvedEffectCount: number): WorkItemControlState | undefined {
  if (action === "pause") {
    return state === "active" || state === "blocked" ? "paused" : undefined;
  }
  if (action === "resume") {
    return state === "paused" || state === "blocked" ? "active" : undefined;
  }
  if (state !== "active" && state !== "paused" && state !== "blocked") return undefined;
  return unresolvedEffectCount > 0 ? "cancelling" : "cancelled";
}

function createWorkItemClaimToken(): string {
  return `work_item_claim_${randomUUID().replaceAll("-", "")}`;
}

function clampWorkItemLeaseMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(Math.max(Math.trunc(value), 5_000), 15 * 60_000);
}
