import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  createWorkItemId,
  type CommitWorkItemGitHubDeliveryInput,
  type CommitWorkItemGitHubDeliveryResult,
  type CreateWorkItemInput,
  type CreateWorkItemResult,
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
  type WorkItemReleaseRequest,
  type WorkItemRouteRequest,
  type WorkItemControlState,
  type WorkItemSourceType,
} from "../../work-item-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { mapWorkItem } from "./runtime-work-mappers.js";
import { workItemSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteAppServerStateStore } from "./app-server-state-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import type { LingAppServerGitHubDelivery, LingAppServerGitHubIntakeReceipt, LingAppServerWorkItemSourceReceipt } from "@ling-stack/contracts";
import { normalConversationSubmissionKey } from "../../conversation-item-store-types.js";

export interface SqliteWorkItemStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly hasAiTeammate: (id: string) => boolean;
}

interface WorkItemCreationReceipt {
  readonly fingerprint: string;
  readonly workItemId: string;
}

interface WorkItemControlSubmission {
  readonly fingerprint: string;
  readonly receipt: WorkItemControlReceipt;
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
      const sourceWorkItem = this.getWorkItemBySource(input.sourceType, input.sourceId);
      const targetKey = input.verifiedTargetKey;
      const sourceKey = createHash("sha256").update(JSON.stringify([input.sourceType, input.sourceId])).digest("hex");
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
      const workItem = existing ?? this.saveWorkItem(input, now);
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
        const intake = input.gitHubIntake;
        const prior = state.get("github_intake_receipt", intake.receiptId)?.payload as LingAppServerGitHubIntakeReceipt | undefined;
        if (prior && prior.workItemId !== workItem.id) throw new Error("github_intake_conflict");
        gitHubIntakeReceipt = prior ?? { ...intake, workItemId: workItem.id, outcome: existing ? "deduplicated" : "suggested",
          reasonCode: existing ? "existing_target" : "suggested_for_acceptance" };
        if (!prior && !state.putWithinTransaction({
          kind: "github_intake_receipt", recordId: intake.receiptId, expectedRevision: 0, payload: gitHubIntakeReceipt,
        }, now)) throw new Error("github_intake_conflict");
      }
      database.exec("COMMIT");
      return { workItem, event, sourceReceipt, gitHubIntakeReceipt };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  commitGitHubDelivery(
    { delivery, targetKey, expectedWorkItemRevision, expectedDeliveryRevision }: CommitWorkItemGitHubDeliveryInput,
    state: SqliteAppServerStateStore,
    events: { readonly store: SqliteControlPlaneStore; readonly cwd: string },
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
      database.exec("COMMIT");
      return { delivery: committed, event };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private saveWorkItem(input: UpsertWorkItemInput, now: string, existing?: WorkItem): WorkItem {
    if (input.channelId) {
      this.ports.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.ports.hasAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    const id = existing?.id ?? input.id ?? createWorkItemId();
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
        stringifyJson(existing?.holds ?? []),
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
    return row ? mapWorkItem(row as Record<string, SQLOutputValue>, this.getWorkItemDependencyIds(id)) : undefined;
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
        return mapWorkItem(typedRow, this.getWorkItemDependencyIds(readString(typedRow, "id")), now);
      });
  }

  routeWorkItem(id: string, input: WorkItemRouteRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) {
      return undefined;
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
        data: { workItemId: id, revision: receipt.workItemRevision, actorId: receipt.actorId, acceptanceId: receipt.id },
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

  checkConversationAdmission(threadId: string, submissionKey: unknown, state: SqliteAppServerStateStore): WorkItem | undefined {
    const binding = this.getConversationBinding(threadId, state);
    if (!binding) return undefined;
    const workItem = this.getWorkItem(binding.workItemId);
    if (!workItem || workItem.control.state !== "active" || workItem.control.unresolvedEffectIds.length > 0
      || workItem.holds.some(hold => hold.blocksNewAdmission)
      || ["done", "cancelled", "superseded", "archived"].includes(workItem.status)) throw new Error("work_item_dispatch_held");
    if (!workItem.runId && binding.submissionKey !== submissionKey
      && normalConversationSubmissionKey(threadId, binding.submissionKey) !== submissionKey) throw new Error("work_item_dispatch_intent_required");
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
  ): { readonly workItem: WorkItem; readonly claimToken?: string; readonly blocker?: WorkItemClaimBlocker } | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) {
      return undefined;
    }
    const blocker = this.workItemClaimBlocker(existing, now);
    if (blocker) {
      return { workItem: existing, blocker };
    }
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
      ? mapWorkItem(row as Record<string, SQLOutputValue>, this.getWorkItemDependencyIds(readString(row as Record<string, SQLOutputValue>, "id")))
      : undefined;
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
    if (item.control.state !== "active") {
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
    const incompleteDependencies = item.dependencyIds.filter((dependencyId) => {
      const dependency = this.getWorkItem(dependencyId);
      return !dependency || dependency.status !== "done";
    });
    if (incompleteDependencies.length > 0) {
      return {
        code: "dependency_blocked",
        message: "Work item dependencies are not complete.",
        dependencyIds: incompleteDependencies,
      };
    }
    return undefined;
  }
}

function sameConversationDispatch(left: WorkItemAcceptanceReceipt["dispatch"], right: WorkItemAcceptanceRequest["dispatch"]): boolean {
  return left?.threadId === right?.threadId && left?.message === right?.message && left?.providerPresetId === right?.providerPresetId;
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
