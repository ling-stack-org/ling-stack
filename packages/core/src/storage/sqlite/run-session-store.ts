import type { SQLOutputValue } from "node:sqlite";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import { getRunEventLogPath, type LingStackRuntimePaths } from "../../runtime-paths.js";
import {
  type CreateRunInput,
  type LingTurn,
  type LingTurnRun,
  type LingTurnRunRole,
  type ListRunsOptions,
  type RunSession,
  type RunStatus,
} from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  transitionRun,
  type RunTransitionEvent,
  type StateTransitionActor,
  type TransitionResult,
} from "../../state-machines.js";
import { redactSecrets } from "../../redaction.js";
import { stringifyJson } from "./helpers.js";
import { mapRunSession } from "./run-mappers.js";
import { runSessionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteRunSessionStorePorts {
  readonly insertLingTurnRun: (turnId: string, runId: string, role: LingTurnRunRole, createdAt: string) => LingTurnRun;
  readonly reconcileLingTurnStatus: (turnId: string, now: string) => LingTurn | undefined;
  readonly rebuildLingThreadMetadata: (threadId: string | undefined, now: string) => void;
  readonly findStateTransitionByIdempotency: (
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ) => StateTransitionEvent | undefined;
  readonly recordStateTransitionEvent: (input: CreateStateTransitionEventInput) => StateTransitionEvent;
  readonly reconcileLingTurnStatusForRun: (runId: string, now: string) => void;
  readonly updateLinkedWorkUnitRunId: (workUnitId: string, runId: string, now: string) => number;
}

export class SqliteRunSessionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly paths: LingStackRuntimePaths,
    private readonly ports: SqliteRunSessionStorePorts,
  ) {}

  createRun(input: CreateRunInput): RunSession {
    const eventLogPath = getRunEventLogPath(this.paths, input.id);
    const redactedTaskSnapshot = redactSecrets(input.taskSnapshot);
    const redactedProviderSnapshot = redactSecrets(input.providerSnapshot);
    const redactedRequestSnapshot = redactSecrets(input.requestSnapshot);

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database
        .prepare(`
          INSERT INTO run_sessions (
            id,
            status,
            cwd,
            task_id,
            channel_id,
            teammate_id,
            workflow_step_id,
            selected_skill_id,
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
            request_snapshot_json,
            event_log_path,
            thread_id,
            work_unit_id,
            parent_run_id,
            intervention_id,
            continuation_reason,
            summary_path,
            error_message,
            created_at,
            started_at,
            ended_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          "queued",
          input.cwd,
          input.taskId,
          input.channelId ?? null,
          input.teammateId ?? null,
          input.workflowStepId ?? null,
          input.selectedSkillId ?? null,
          input.providerPresetId ?? null,
          input.providerName,
          input.providerModel,
          stringifyJson(redactedTaskSnapshot),
          stringifyJson(redactedProviderSnapshot),
          stringifyJson(redactedRequestSnapshot),
          eventLogPath,
          input.threadId ?? null,
          input.workUnitId ?? null,
          input.parentRunId ?? null,
          input.interventionId ?? null,
          input.continuationReason ?? null,
          null,
          null,
          input.createdAt,
          null,
          null,
          input.createdAt,
        );
      if (input.turnId) {
        this.ports.insertLingTurnRun(input.turnId, input.id, input.turnRunRole ?? "primary", input.createdAt);
        this.ports.reconcileLingTurnStatus(input.turnId, input.createdAt);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    const session = this.getRun(input.id);
    if (!session) {
      throw new Error(`Failed to create run session: ${input.id}`);
    }
    this.ports.rebuildLingThreadMetadata(session.threadId, session.createdAt);
    return session;
  }

  getRun(runId: string): RunSession | undefined {
    const row = this.context.database.prepare(runSessionSelectSql("WHERE id = ?")).get(runId);
    return row ? mapRunSession(row as Record<string, SQLOutputValue>) : undefined;
  }

  listRuns(options: ListRunsOptions = {}): RunSession[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.context.database
      .prepare(`${runSessionSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapRunSession(row as Record<string, SQLOutputValue>));
  }

  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined {
    this.context.database
      .prepare("UPDATE run_sessions SET work_unit_id = ?, updated_at = ? WHERE id = ?")
      .run(workUnitId, now, runId);
    this.ports.updateLinkedWorkUnitRunId(workUnitId, runId, now);
    return this.getRun(runId);
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.updateRunStatus(runId, "running", startedAt, null, undefined, undefined, startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "waiting_for_approval", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "running", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "succeeded", undefined, endedAt, null, summaryPath, endedAt);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "failed", undefined, endedAt, errorMessage, summaryPath, endedAt);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "cancelled", undefined, endedAt, null, summaryPath, endedAt);
  }

  transitionRunStatus(input: {
    readonly runId: string;
    readonly expectedStatus?: RunStatus;
    readonly event: RunTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly summaryPath?: string;
    readonly errorMessage?: string | null;
  }): TransitionResult<RunStatus> {
    const run = this.getRun(input.runId);
    if (!run) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("run", input.runId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: run.status, to: run.status, duplicate: true };
      }
    }

    const result = transitionRun({
      entityId: input.runId,
      currentStatus: run.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }

    const update = this.context.database
      .prepare(`
        UPDATE run_sessions
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          error_message = ?,
          summary_path = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.startedAt ?? run.startedAt ?? null,
        input.endedAt === undefined ? run.endedAt ?? null : input.endedAt,
        input.errorMessage === undefined ? run.errorMessage ?? null : input.errorMessage,
        input.summaryPath ?? run.summaryPath ?? null,
        input.now,
        input.runId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getRun(input.runId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? run.status };
    }

    this.ports.recordStateTransitionEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entityType: "run",
      entityId: input.runId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    this.ports.reconcileLingTurnStatusForRun(input.runId, input.now);
    this.ports.rebuildLingThreadMetadata(run.threadId, input.now);
    return result;
  }

  private updateRunStatus(
    runId: string,
    status: RunStatus,
    startedAt?: string,
    endedAt?: string | null,
    errorMessage?: string | null,
    summaryPath?: string,
    updatedAt?: string,
  ): void {
    const existing = this.getRun(runId);
    this.context.database
      .prepare(`
        UPDATE run_sessions
        SET status = ?,
            started_at = ?,
            ended_at = ?,
            error_message = ?,
            summary_path = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        startedAt ?? existing?.startedAt ?? null,
        endedAt === undefined ? existing?.endedAt ?? null : endedAt,
        errorMessage === undefined ? existing?.errorMessage ?? null : errorMessage,
        summaryPath ?? existing?.summaryPath ?? null,
        updatedAt ?? endedAt ?? startedAt ?? existing?.updatedAt ?? new Date().toISOString(),
        runId,
      );
    this.ports.reconcileLingTurnStatusForRun(runId, updatedAt ?? endedAt ?? startedAt ?? new Date().toISOString());
    this.ports.rebuildLingThreadMetadata(existing?.threadId, updatedAt ?? endedAt ?? startedAt ?? new Date().toISOString());
  }
}
