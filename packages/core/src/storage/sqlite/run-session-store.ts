import { assertChannelSessionThreadWritable } from "./channel-session-admission.js";
import { realpathSync } from "node:fs";
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
import { DEFAULT_WORKSPACE_ID, type ChannelWorkspaceBinding } from "../../workspace-types.js";
import {
  transitionRun,
  type RunTransitionEvent,
  type StateTransitionActor,
  type TransitionResult,
} from "../../state-machines.js";
import { redactSecrets } from "../../redaction.js";
import { isRecord, readNullableString, readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { mapRunSession } from "./run-mappers.js";
import { runSessionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { isCurrentRunExecutionOwner, runExecutionOwnerParameters, runExecutionOwnerSql } from "./run-execution-admission.js";
import { assertDelegationCompletionSatisfied } from "../../delegation-completion-barrier.js";
import { normalizeRunnerIdsInSnapshot } from "../../runner-ids.js";
import { parseNullableChannelWorkspaceBinding, parseNullableDirectWorkspaceBinding } from "./workspace-binding-parsers.js";
import type { WorkItem } from "../../work-item-types.js";

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
  readonly getDelegationCompletionEvidence: RunStore["getDelegationCompletionEvidence"];
  readonly checkWorkItemAdmission?: (threadId: string, turnId: string | undefined, request: unknown, automaticIntakeReceiptId?: string) => WorkItem | undefined;
  readonly linkWorkItemRun?: (workItem: WorkItem, runId: string, now: string) => void;
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
        taskJson: stringifyJson(normalizeRunnerIdsInSnapshot(redactSecrets(values.taskSnapshot))),
        providerJson: stringifyJson(normalizeRunnerIdsInSnapshot(redactSecrets(values.providerSnapshot))),
        requestJson: stringifyJson(normalizeRunnerIdsInSnapshot(redactSecrets(values.requestSnapshot))),
      };
    });
    const captured = prepared.values;
    this.ports.assertWorkspaceSnapshotFence?.(captured.cwd);
    this.assertCreationTransactionActive();
    const sourceThreadId = captured.threadId ?? (captured.turnId
      ? this.context.database.prepare("SELECT thread_id FROM ling_turns WHERE id = ?").get(captured.turnId)?.thread_id as string | undefined
      : undefined);
    const sourceThread = sourceThreadId
      ? this.context.database.prepare("SELECT id, kind, channel_id, teammate_id FROM ling_threads WHERE id = ?").get(sourceThreadId)
      : undefined;
    if (sourceThreadId && sourceThread?.channel_id) {
      assertChannelSessionThreadWritable(this.context.database, sourceThreadId);
    }
    const requestSnapshot: unknown = JSON.parse(prepared.requestJson);
    const workItem = sourceThreadId
      ? readSqliteWithinTransaction(this.context.database, () => this.ports.checkWorkItemAdmission?.(sourceThreadId, captured.turnId, requestSnapshot, captured.automaticIntakeReceiptId))
      : undefined;
    this.assertManagedWorkspaceBinding(captured, requestSnapshot, sourceThread);
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
        sourceThreadId ?? null,
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
    if (workItem) this.ports.linkWorkItemRun?.(workItem, session.id, session.createdAt);
    return session;
  }

  private assertManagedWorkspaceBinding(
    input: CreateRunInput,
    request: unknown,
    sourceThread: Record<string, SQLOutputValue> | undefined,
  ): void {
    if (!isRecord(request)) return;
    const channelSnapshot = isRecord(request.channelWorkspaceBinding) ? request.channelWorkspaceBinding : undefined;
    const directSnapshot = isRecord(request.directWorkspaceSnapshot) ? request.directWorkspaceSnapshot : undefined;
    const directBinding = isRecord(request.directWorkspaceBinding) ? request.directWorkspaceBinding : undefined;
    const channelManaged = channelSnapshot?.mode === "managed_worktree";
    const directManaged = directSnapshot?.mode === "managed_worktree" || directBinding?.mode === "managed_worktree";
    if (!channelManaged && !directManaged) return;

    const fail = (): never => { throw new Error("Managed workspace binding is no longer current for Run creation"); };
    if (request.threadId !== undefined && request.threadId !== sourceThread?.id
      || request.cwd !== undefined && request.cwd !== input.cwd
      || request.executionCwd !== undefined && request.executionCwd !== input.cwd) fail();
    // A request can await provider/input preparation after its cleanup fence is
    // released. The current binding and its captured identity join the Run write.
    if (channelManaged) {
      if (!input.channelId || sourceThread?.channel_id && sourceThread.channel_id !== input.channelId
        || isRecord(request.task) && request.task.channelId !== undefined && request.task.channelId !== input.channelId) fail();
      const channel = this.context.database.prepare("SELECT workspace_binding_json FROM channels WHERE id = ? AND workspace_id = ?")
        .get(input.channelId!, DEFAULT_WORKSPACE_ID);
      const current = parseNullableChannelWorkspaceBinding(readNullableString(channel ?? {}, "workspace_binding_json"));
      if (!managedWorkspaceMatches(current, channelSnapshot, input.cwd)) fail();
    }
    if (directManaged) {
      if (!input.teammateId || request.teammateId !== undefined && request.teammateId !== input.teammateId
        || sourceThread && (sourceThread.kind !== "teammate_direct" || sourceThread.teammate_id !== input.teammateId)) fail();
      const thread = this.context.database.prepare("SELECT workspace_binding_json FROM teammate_direct_threads WHERE workspace_id = ? AND teammate_id = ?")
        .get(DEFAULT_WORKSPACE_ID, input.teammateId!);
      const current = parseNullableDirectWorkspaceBinding(readNullableString(thread ?? {}, "workspace_binding_json"));
      if (!managedWorkspaceMatches(current, directSnapshot, input.cwd)
        || directBinding && (directBinding.mode !== current?.mode || directBinding.status !== "ready"
          || directBinding.worktreePath !== current?.worktreePath || directBinding.branchName !== current?.branchName)) fail();
    }
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
    this.withCompletionTransaction(() => {
      if (this.getRun(runId)) this.assertDescendantsComplete(runId);
      this.updateRunStatus(runId, "succeeded", undefined, endedAt, null, summaryPath, endedAt);
    });
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
    return input.event === "runner_succeeded"
      ? this.withCompletionTransaction(() => this.transitionWithinTransaction(input, admission))
      : this.transitionWithinTransaction(input, admission);
  }

  private transitionWithinTransaction(input: Parameters<RunStore["transitionRunStatus"]>[0], admission:
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
    if (result.to === "succeeded") this.assertDescendantsComplete(run.id);
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

  private assertDescendantsComplete(runId: string): void {
    assertDelegationCompletionSatisfied(this.ports.getDelegationCompletionEvidence({ rootRunIds: [runId] }));
  }

  /** Owns an immediate transaction unless an approval/lifecycle caller already owns one. */
  private withCompletionTransaction<T>(write: () => T): T {
    const db = this.context.database;
    let ownsTransaction = true;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!(error instanceof Error)
        || (error as NodeJS.ErrnoException).code !== "ERR_SQLITE_ERROR"
        || error.message !== "cannot start a transaction within a transaction") throw error;
      ownsTransaction = false;
      db.exec("SAVEPOINT run_success_delegation_barrier");
    }
    try {
      const result = write();
      db.exec(ownsTransaction ? "COMMIT" : "RELEASE run_success_delegation_barrier");
      return result;
    } catch (error) {
      if (ownsTransaction) rollbackOwnedSqliteTransaction(db);
      else {
        db.exec("ROLLBACK TO run_success_delegation_barrier");
        db.exec("RELEASE run_success_delegation_barrier");
      }
      throw error;
    }
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

function managedWorkspaceMatches(
  current: ChannelWorkspaceBinding | undefined,
  snapshot: Record<string, unknown> | undefined,
  cwd: string,
): boolean {
  return current?.mode === "managed_worktree" && current.status === "ready"
    && Boolean(current.worktreePath) && Boolean(current.branchName)
    && snapshot?.mode === "managed_worktree" && snapshot.status === "ready"
    && sameWorkspacePath(snapshot.worktreePath, current.worktreePath)
    && snapshot.branchName === current.branchName
    && sameWorkspacePath(snapshot.executionCwd, current.worktreePath)
    && sameWorkspacePath(cwd, current.worktreePath);
}

function sameWorkspacePath(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return canonicalWorkspacePath(left) === canonicalWorkspacePath(right);
}

function canonicalWorkspacePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}
