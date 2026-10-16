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
  type RunStore,
} from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  transitionRun,
  type RunTransitionEvent,
  type StateTransitionActor,
  type TransitionResult,
} from "../../state-machines.js";
import { redactSecrets } from "../../redaction.js";
import { readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { mapRunSession } from "./run-mappers.js";
import { runSessionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { isCurrentRunExecutionOwner, runExecutionOwnerParameters, runExecutionOwnerSql } from "./run-execution-admission.js";

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
  /** SQLite-only selection audit; joins Run creation rather than following COMMIT. */
  readonly recordRunSelection: (run: RunSession) => void;
  /** Reject new/promoted execution while an explicit workspace restore owns the fence. */
  readonly assertWorkspaceSnapshotFence?: (cwd: string) => void;
}

export class SqliteRunSessionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly paths: LingStackRuntimePaths,
    private readonly ports: SqliteRunSessionStorePorts,
  ) {}

  createRun(input: CreateRunInput): RunSession {
    // BEGIN is outside the catch: a nested caller's transaction is not ours to roll back.
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.createRunWithinTransaction(input);
      this.context.database.exec("COMMIT");
      return run;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  /**
   * Creates a Run, Turn link/projection and selection audit within the caller's
   * transaction. Never begins/commits it or starts a Runner. The caller must
   * abort its transaction if this operation throws.
   *
   * Continuation admission will combine this with its own answer, Attempt,
   * prepared-input and fence checks; this primitive is not a receiver ACK.
   */
  createRunWithinTransaction(input: CreateRunInput): RunSession {
    this.assertCreationTransactionActive();
    const prepared = readSqliteWithinTransaction(this.context.database, () => {
      // Capture scalar identity once. Getters/toJSON cannot write SQLite while
      // credential-free snapshot strings are being materialized.
      const values = { ...input };
      return {
        values,
        taskJson: stringifyJson(redactSecrets(values.taskSnapshot)),
        providerJson: stringifyJson(redactSecrets(values.providerSnapshot)),
        requestJson: stringifyJson(redactSecrets(values.requestSnapshot)),
      };
    });
    const captured = prepared.values;
    this.ports.assertWorkspaceSnapshotFence?.(captured.cwd);
    this.assertCreationTransactionActive();
    const eventLogPath = getRunEventLogPath(this.paths, captured.id);
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
          context_view_id,
          context_view_created_at,
          summary_path,
          error_message,
          created_at,
          started_at,
          ended_at,
          updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)
      .run(
        captured.id,
        "queued",
        captured.cwd,
        captured.taskId,
        captured.channelId ?? null,
        captured.teammateId ?? null,
        captured.workflowStepId ?? null,
        captured.selectedSkillId ?? null,
        captured.providerPresetId ?? null,
        captured.providerName,
        captured.providerModel,
        prepared.taskJson,
        prepared.providerJson,
        prepared.requestJson,
        eventLogPath,
        captured.threadId ?? null,
        captured.workUnitId ?? null,
        captured.parentRunId ?? null,
        captured.interventionId ?? null,
        captured.continuationReason ?? null,
        captured.contextViewId ?? null,
        captured.contextViewCreatedAt ?? null,
        null,
        null,
        captured.createdAt,
        null,
        null,
        captured.createdAt,
      );
    if (captured.turnId) {
      this.ports.insertLingTurnRun(captured.turnId, captured.id, captured.turnRunRole ?? "primary", captured.createdAt);
      this.ports.reconcileLingTurnStatus(captured.turnId, captured.createdAt);
    }
    // A rebuildable cache may swallow an error. If SQLite also rolled back,
    // no subsequent write may accidentally become an autocommitted orphan.
    this.assertCreationTransactionActive();
    const session = this.getRun(captured.id);
    if (!session) {
      throw new Error(`Failed to create run session: ${captured.id}`);
    }
    this.ports.rebuildLingThreadMetadata(session.threadId, session.createdAt);
    this.assertCreationTransactionActive();
    this.ports.recordRunSelection(session);
    this.assertCreationTransactionActive();
    return session;
  }

  private assertCreationTransactionActive(): void {
    // Use SQLite's own transaction state. DatabaseSync.isTransaction is absent
    // or unreliable in some runtimes allowed by this workspace's Node range.
    // A rejected nested BEGIN changes neither the transaction nor its data.
    try {
      this.context.database.exec("BEGIN DEFERRED");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR"
        && error.message === "cannot start a transaction within a transaction") return;
      throw error;
    }
    // BEGIN succeeded, so there was no caller transaction (or it was lost).
    // Roll back only the empty transaction this check itself just created.
    this.context.database.exec("ROLLBACK");
    throw new Error("Run creation requires an active SQLite transaction; caller transaction was lost");
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
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.context.database
      .prepare(`${runSessionSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapRunSession(row as Record<string, SQLOutputValue>));
  }

  listRecoverableRunIds(): string[] {
    return this.listActiveRunScopes().map((run) => run.id);
  }

  listActiveRunScopes(): Pick<RunSession, "id" | "cwd">[] {
    return this.context.database
      .prepare("SELECT id, cwd FROM run_sessions WHERE status IN ('queued', 'running', 'waiting_for_approval')")
      .all()
      .map((row) => ({
        id: readString(row as Record<string, SQLOutputValue>, "id"),
        cwd: readString(row as Record<string, SQLOutputValue>, "cwd"),
      }));
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

  transitionRunStatus(input: Parameters<RunStore["transitionRunStatus"]>[0]): TransitionResult<RunStatus> {
    return this.transition(input, { kind: "host" });
  }

  transitionRunExecutionStatus(input: Parameters<RunStore["transitionRunExecutionStatus"]>[0]): TransitionResult<RunStatus> {
    return this.transition(input, { kind: "execution", sourceFence: input.sourceFence });
  }

  private transition(input: Parameters<RunStore["transitionRunStatus"]>[0], admission:
    { readonly kind: "host" } | { readonly kind: "execution"; readonly sourceFence: RuntimeAttemptFenceV1 }): TransitionResult<RunStatus> {
    const run = this.getRun(input.runId);
    if (!run) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    const allowCleanup = input.event === "runner_failed" || input.event === "cancel";
    if (admission.kind === "execution" && !isCurrentRunExecutionOwner(this.context, run.id, admission.sourceFence, allowCleanup)) {
      return { ok: false, code: "stale_transition", currentStatus: run.status };
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
    if (["queued", "running", "waiting_for_approval"].includes(result.to)) {
      this.ports.assertWorkspaceSnapshotFence?.(run.cwd);
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
          ${admission.kind === "execution" ? `AND ${runExecutionOwnerSql}` : ""}
      `)
      .run(
        result.to,
        input.startedAt ?? run.startedAt ?? null,
        input.endedAt === undefined ? run.endedAt ?? null : input.endedAt,
        input.errorMessage === undefined ? run.errorMessage ?? null : input.errorMessage,
        input.summaryPath === undefined ? run.summaryPath ?? null : input.summaryPath,
        input.now,
        input.runId,
        result.from,
        ...(admission.kind === "execution" ? runExecutionOwnerParameters(run.id, admission.sourceFence, allowCleanup) : []),
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
    const result = this.context.database
      .prepare(`
        UPDATE run_sessions
        SET status = ?,
            started_at = ?,
            ended_at = ?,
            error_message = ?,
            summary_path = ?,
            updated_at = ?
        WHERE id = ? AND status <> 'yielded'
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
    if (Number(result.changes) !== 1) return;
    this.ports.reconcileLingTurnStatusForRun(runId, updatedAt ?? endedAt ?? startedAt ?? new Date().toISOString());
    this.ports.rebuildLingThreadMetadata(existing?.threadId, updatedAt ?? endedAt ?? startedAt ?? new Date().toISOString());
  }
}
