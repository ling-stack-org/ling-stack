import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  createWorkItemId,
  type ListWorkItemsOptions,
  type UpsertWorkItemInput,
  type WorkItem,
  type WorkItemClaimBlocker,
  type WorkItemClaimRequest,
  type WorkItemCompleteRequest,
  type WorkItemFailRequest,
  type WorkItemHeartbeatRequest,
  type WorkItemReleaseRequest,
  type WorkItemRouteRequest,
  type WorkItemSourceType,
} from "../../work-item-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readString, stringifyJson } from "./helpers.js";
import { mapWorkItem } from "./runtime-work-mappers.js";
import { workItemSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteWorkItemStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly hasAiTeammate: (id: string) => boolean;
}

export class SqliteWorkItemStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteWorkItemStorePorts,
  ) {}

  upsertWorkItem(input: UpsertWorkItemInput, now: string): WorkItem {
    if (input.channelId) {
      this.ports.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.ports.hasAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    const existing = this.getWorkItemBySource(input.sourceType, input.sourceId);
    const id = existing?.id ?? input.id ?? createWorkItemId();
    const createdAt = existing?.createdAt ?? now;
    const labels = input.labels ?? existing?.labels ?? [];
    const artifactIds = input.artifactIds ?? existing?.artifactIds ?? [];
    const proofArtifactIds = input.proofArtifactIds ?? existing?.proofArtifactIds ?? [];
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database
        .prepare(`
          INSERT INTO work_items (
            id,
            workspace_id,
            channel_id,
            source_type,
            source_id,
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            retry_budget = excluded.retry_budget,
            updated_at = excluded.updated_at
        `)
        .run(
          id,
          DEFAULT_WORKSPACE_ID,
          input.channelId ?? existing?.channelId ?? null,
          input.sourceType,
          input.sourceId,
          input.title,
          input.description ?? existing?.description ?? null,
          input.status ?? existing?.status ?? "ready",
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
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
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
        SET channel_id = ?, priority = ?, assignee_teammate_id = ?, updated_at = ?
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
        SET status = ?, claim_owner_id = ?, claim_token = ?, claimed_at = ?, heartbeat_at = ?, claim_expires_at = ?, attempt_count = ?, updated_at = ?
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
      .prepare("UPDATE work_items SET heartbeat_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?")
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
        SET status = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, updated_at = ?
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
        SET status = ?, proof_artifact_ids_json = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, completed_at = ?, failed_at = NULL, failure_reason = NULL, updated_at = ?
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
        SET status = ?, waiting_reason = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, failed_at = ?, failure_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(canRetry ? "ready" : "blocked", canRetry ? null : "user", now, input.reason, now, id);
    return this.getWorkItem(id);
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

function createWorkItemClaimToken(): string {
  return `work_item_claim_${randomUUID().replaceAll("-", "")}`;
}

function clampWorkItemLeaseMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(Math.max(Math.trunc(value), 5_000), 15 * 60_000);
}
