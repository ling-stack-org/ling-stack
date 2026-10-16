import type { SQLOutputValue } from "node:sqlite";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createRuntimeEventId,
  createRuntimeHeartbeatId,
  createWorkUnitAttemptId,
  createWorkUnitId,
  defaultRuntimeTimeoutPolicy,
  toRuntimeAttemptFence,
  type AppendRuntimeDiagnosticEventInput,
  type AppendRuntimeEventInput,
  type AppendTerminalRuntimeAuditInput,
  type CreateWorkUnitAttemptInput,
  type CreateWorkUnitInput,
  type ListRuntimeEventsOptions,
  type ListWorkUnitsOptions,
  type RecordRuntimeHeartbeatInput,
  type RuntimeEvent,
  type RuntimeHeartbeat,
  type RuntimeAttemptFenceV1,
  type RuntimeResourceRenewal,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitStatus,
} from "../../runtime-supervisor-types.js";
import {
  transitionWorkUnit,
  type StateTransitionActor,
  type TransitionResult,
  type WorkUnitTransitionEvent,
} from "../../state-machines.js";
import { redactSecrets } from "../../redaction.js";
import { assertRuntimeResourceRenewal } from "../../runtime-resource-renewal.js";
import type { CreateOrReuseConversationMediaJobInput } from "../../media-generation-routing-types.js";
import { redactConversationMediaWorkUnitRequest } from "./conversation-media-execution-admission.js";
import { readNumber, readString, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { assertRecoveryDiscoveryId, assertRecoveryDiscoveryTimestamp } from "./recovery-discovery-validation.js";
import {
  mapRuntimeEvent,
  mapWorkUnit,
  mapWorkUnitAttempt,
  normalizeStoredRunnerId,
} from "./runtime-work-mappers.js";
import {
  runtimeEventSelectSql,
  workUnitAttemptSelectSql,
  workUnitSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteRuntimeWorkUnitStorePorts {
  readonly findStateTransitionByIdempotency: (
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ) => StateTransitionEvent | undefined;
  readonly recordStateTransitionEvent: (input: CreateStateTransitionEventInput) => StateTransitionEvent;
  readonly renewResourceLeasesForAttempt: (fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal) => number;
  readonly renewRuntimeSemaphoreSlotsForAttempt: (fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal) => number;
  readonly releaseResourceLeasesForAttempt: (
    fence: RuntimeAttemptFenceV1,
    releasedAt: string,
    releaseReason: string,
  ) => number;
  readonly releaseRuntimeSemaphoreSlotsForAttempt: (
    fence: RuntimeAttemptFenceV1,
    releasedAt: string,
    releaseReason: string,
  ) => number;
}

export class SqliteRuntimeWorkUnitStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteRuntimeWorkUnitStorePorts,
  ) {}

  createWorkUnit(
    input: CreateWorkUnitInput,
    mediaAdmission?: NonNullable<CreateOrReuseConversationMediaJobInput["executionAdmission"]>,
  ): WorkUnit {
    const id = input.id ?? createWorkUnitId();
    const timeoutPolicy = input.timeoutPolicy ?? defaultRuntimeTimeoutPolicy;
    const status = input.status ?? "queued";
    this.context.database
      .prepare(`
        INSERT INTO work_units (
          id,
          workspace_id,
          kind,
          owner_type,
          owner_id,
          channel_id,
          task_id,
          teammate_id,
          provider_preset_id,
          runner_id,
          requested_runner_id,
          effective_runner_id,
          runner_fallback_reason_json,
          idempotency_key,
          status,
          priority,
          attempt_count,
          active_attempt_id,
          created_by_client_id,
          created_by_actor,
          request_json,
          timeout_policy_json,
          linked_run_id,
          linked_message_id,
          linked_media_job_id,
          linked_external_work_id,
          created_at,
          updated_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workspaceId,
        input.kind,
        input.ownerType,
        input.ownerId,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.providerPresetId ?? null,
        normalizeStoredRunnerId(input.runnerId ?? input.effectiveRunnerId) ?? null,
        normalizeStoredRunnerId(input.requestedRunnerId) ?? null,
        normalizeStoredRunnerId(input.effectiveRunnerId ?? input.runnerId) ?? null,
        input.fallbackReason ? stringifyJson(input.fallbackReason) : null,
        input.idempotencyKey,
        status,
        input.priority ?? 0,
        0,
        null,
        input.createdByClientId ?? null,
        input.createdByActor,
        stringifyJson(mediaAdmission
          ? redactConversationMediaWorkUnitRequest(this.context.database, input, mediaAdmission)
          : redactSecrets(input.request)),
        stringifyJson(timeoutPolicy),
        input.linkedRunId ?? null,
        input.linkedMessageId ?? null,
        input.linkedMediaJobId ?? null,
        input.linkedExternalWorkId ?? null,
        input.now,
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
      );

    const workUnit = this.getWorkUnit(id);
    if (!workUnit) {
      throw new Error(`Failed to create work unit: ${id}`);
    }
    return workUnit;
  }

  getWorkUnit(workUnitId: string): WorkUnit | undefined {
    const row = this.context.database.prepare(workUnitSelectSql("WHERE id = ?")).get(workUnitId);
    return row ? mapWorkUnit(row as Record<string, SQLOutputValue>) : undefined;
  }

  listWorkUnits(options: ListWorkUnitsOptions = {}): WorkUnit[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    if (options.linkedRunId) {
      clauses.push("linked_run_id = ?");
      params.push(options.linkedRunId);
    }
    if (options.linkedMessageId) {
      clauses.push("linked_message_id = ?");
      params.push(options.linkedMessageId);
    }
    if (options.linkedMediaJobId) {
      clauses.push("linked_media_job_id = ?");
      params.push(options.linkedMediaJobId);
    }
    if (options.createdAtOrBefore !== undefined) {
      assertRecoveryDiscoveryTimestamp(options.createdAtOrBefore, "creation cutoff");
      clauses.push("created_at <= ?");
      params.push(options.createdAtOrBefore);
    }
    if (options.after !== undefined) {
      if (!options.after || typeof options.after !== "object") {
        throw new Error("Invalid recovery discovery WorkUnit cursor.");
      }
      assertRecoveryDiscoveryTimestamp(options.after.createdAt, "cursor creation time");
      assertRecoveryDiscoveryId(options.after.id);
      clauses.push("(created_at, id) < (?, ?)");
      params.push(options.after.createdAt, options.after.id);
    }
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${workUnitSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapWorkUnit(row as Record<string, SQLOutputValue>));
  }

  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined {
    const row = this.context.database
      .prepare(workUnitSelectSql("WHERE workspace_id = ? AND kind = ? AND owner_type = ? AND owner_id = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, input.kind, input.ownerType, input.ownerId, input.idempotencyKey);
    return row ? mapWorkUnit(row as Record<string, SQLOutputValue>) : undefined;
  }

  updateLinkedRunId(workUnitId: string, runId: string, now: string): number {
    const result = this.context.database
      .prepare("UPDATE work_units SET linked_run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, now, workUnitId);
    return Number(result.changes);
  }

  transitionWorkUnitStatus(
    input: Parameters<import("../../run-types.js").RunStore["transitionWorkUnitStatus"]>[0],
  ): TransitionResult<WorkUnitStatus> {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.attemptId) {
      const attempt = this.getWorkUnitAttempt(input.attemptId);
      const mayReconcileLostAttempt = input.terminalAttemptOwnership?.kind === "lost_attempt_reconciliation"
        && attempt?.status === "lost"
        && input.event === "runner_failed"
        && input.actor === "system";
      if (
        !attempt ||
        !this.matchesCurrentAttemptFence(attempt, input, mayReconcileLostAttempt)
      ) {
        return { ok: false, code: "stale_transition", currentStatus: workUnit.status };
      }
    }
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("work_unit", input.workUnitId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: workUnit.status, to: workUnit.status, duplicate: true };
      }
    }

    const result = transitionWorkUnit({
      entityId: input.workUnitId,
      currentStatus: workUnit.status,
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
        UPDATE work_units
        SET
          status = ?,
          active_attempt_id = ?,
          updated_at = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ?
          AND status = ?
          AND (? IS NULL OR active_attempt_id = ?)
      `)
      .run(
        result.to,
        input.activeAttemptId === undefined ? workUnit.activeAttemptId ?? null : input.activeAttemptId,
        input.now,
        input.startedAt ?? workUnit.startedAt ?? null,
        input.endedAt === undefined ? workUnit.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? workUnit.lastEventAt ?? null,
        input.lastHeartbeatAt ?? workUnit.lastHeartbeatAt ?? null,
        input.errorCode === undefined ? workUnit.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? workUnit.errorMessage ?? null : input.errorMessage,
        input.workUnitId,
        result.from,
        input.attemptId ?? null,
        input.attemptId ?? null,
      );
    if (Number(update.changes) === 0) {
      const current = this.getWorkUnit(input.workUnitId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workUnit.status };
    }

    this.ports.recordStateTransitionEvent({
      workspaceId: workUnit.workspaceId,
      entityType: "work_unit",
      entityId: input.workUnitId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const attempt = this.createWorkUnitAttemptWithinTransaction(input);
      this.context.database.exec("COMMIT;");
      return attempt;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  /**
   * Creates and claims one Attempt while the caller owns the SQLite transaction.
   * Aggregate stores such as approval resume must use this joined capability so they
   * do not open a nested transaction.
   */
  createWorkUnitAttemptWithinTransaction(input: CreateWorkUnitAttemptInput): WorkUnitAttempt {
    const id = input.id ?? createWorkUnitAttemptId();
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    const fencingToken = this.nextAttemptFencingToken(input.workUnitId, input.fencingToken);

    const priorAttempt = workUnit.activeAttemptId
      ? this.getWorkUnitAttempt(workUnit.activeAttemptId)
      : undefined;
    if (priorAttempt) {
      const priorFence = toRuntimeAttemptFence(priorAttempt);
      this.ports.releaseResourceLeasesForAttempt(priorFence, input.now, "runtime-attempt-replaced");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(priorFence, input.now, "runtime-attempt-replaced");
    }

    // The claim transaction is the only authority allowed to replace an active Attempt.
    // A late callback can still reference the old row, but the active pointer and fence
    // below prevent it from mutating canonical state.
    this.context.database
      .prepare(`
        UPDATE work_unit_attempts
        SET
          status = 'lost',
          ended_at = COALESCE(ended_at, ?),
          error_code = COALESCE(error_code, 'runtime_attempt_replaced'),
          error_message = COALESCE(error_message, 'A newer Attempt owns the Work Unit fence.')
        WHERE work_unit_id = ?
          AND status IN ('created', 'started', 'waiting_for_approval', 'cancelling')
      `)
      .run(input.now, input.workUnitId);
    this.context.database
      .prepare(`
        INSERT INTO work_unit_attempts (
          id,
          work_unit_id,
          attempt_number,
          fencing_token,
          runtime_instance_id,
          runner_id,
          requested_runner_id,
          effective_runner_id,
          runner_fallback_reason_json,
          provider_preset_id,
          status,
          created_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          abort_requested_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workUnitId,
        input.attemptNumber,
        fencingToken,
        input.runtimeInstanceId,
        normalizeStoredRunnerId(input.runnerId) ?? input.runnerId,
        normalizeStoredRunnerId(input.requestedRunnerId) ?? null,
        normalizeStoredRunnerId(input.effectiveRunnerId ?? input.runnerId) ?? input.runnerId,
        input.fallbackReason ? stringifyJson(input.fallbackReason) : null,
        input.providerPresetId ?? null,
        input.status ?? "created",
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    const claimed = this.context.database
      .prepare(`
        UPDATE work_units
        SET attempt_count = MAX(attempt_count, ?), active_attempt_id = ?, updated_at = ?
        WHERE id = ?
          AND ((active_attempt_id IS NULL AND ? IS NULL) OR active_attempt_id = ?)
      `)
      .run(
        input.attemptNumber,
        id,
        input.now,
        input.workUnitId,
        workUnit.activeAttemptId ?? null,
        workUnit.activeAttemptId ?? null,
      );
    if (Number(claimed.changes) !== 1) {
      throw new Error(`Work unit attempt claim became stale: ${input.workUnitId}`);
    }
    this.appendRuntimeEventWithinTransaction({
      workUnitId: input.workUnitId,
      attemptId: id,
      runtimeInstanceId: input.runtimeInstanceId,
      fencingToken,
      type: "work_unit_claimed",
      actor: "system",
      ts: input.now,
      data: {
        attemptNumber: input.attemptNumber,
        priorAttemptId: workUnit.activeAttemptId,
      },
    });
    const attempt = this.getWorkUnitAttempt(id);
    if (!attempt) {
      throw new Error(`Failed to create work unit attempt: ${id}`);
    }
    return attempt;
  }

  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined {
    const row = this.context.database.prepare(workUnitAttemptSelectSql("WHERE id = ?")).get(attemptId);
    return row ? mapWorkUnitAttempt(row as Record<string, SQLOutputValue>) : undefined;
  }

  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[] {
    return this.context.database
      .prepare(`${workUnitAttemptSelectSql("WHERE work_unit_id = ?")} ORDER BY attempt_number ASC, created_at ASC`)
      .all(workUnitId)
      .map((row) => mapWorkUnitAttempt(row as Record<string, SQLOutputValue>));
  }

  updateWorkUnitAttemptStatus(input: {
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly runtimeInstanceId: string;
    readonly fencingToken: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly abortRequestedAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): WorkUnitAttempt | undefined {
    const attempt = this.getWorkUnitAttempt(input.attemptId);
    if (!attempt || !this.matchesCurrentAttemptFence(attempt, input)) {
      return undefined;
    }
    const updated = this.context.database
      .prepare(`
        UPDATE work_unit_attempts
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          abort_requested_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ?
          AND work_unit_id = ?
          AND runtime_instance_id = ?
          AND fencing_token = ?
          AND status = ?
          AND EXISTS (
            SELECT 1 FROM work_units
            WHERE work_units.id = work_unit_attempts.work_unit_id
              AND work_units.active_attempt_id = work_unit_attempts.id
          )
      `)
      .run(
        input.status,
        input.startedAt ?? attempt.startedAt ?? null,
        input.endedAt === undefined ? attempt.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? attempt.lastEventAt ?? null,
        input.lastHeartbeatAt ?? attempt.lastHeartbeatAt ?? null,
        input.abortRequestedAt ?? attempt.abortRequestedAt ?? null,
        input.errorCode === undefined ? attempt.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? attempt.errorMessage ?? null : input.errorMessage,
        input.attemptId,
        attempt.workUnitId,
        attempt.runtimeInstanceId,
        attempt.fencingToken,
        attempt.status,
      );
    if (Number(updated.changes) !== 1) return undefined;
    return this.getWorkUnitAttempt(input.attemptId);
  }

  transitionWorkUnitAttemptTerminal(
    input: Parameters<import("../../run-types.js").RunStore["transitionWorkUnitAttemptTerminal"]>[0],
  ): boolean {
    const workUnit = this.getWorkUnit(input.workUnitId);
    const attempt = this.getWorkUnitAttempt(input.attemptId);
    if (
      !workUnit ||
      !attempt ||
      workUnit.activeAttemptId !== attempt.id ||
      !this.matchesCurrentAttemptFence(attempt, input) ||
      isAttemptTerminal(attempt.status)
    ) {
      return false;
    }

    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const transition = this.transitionWorkUnitStatus({
        ...input,
        activeAttemptId: attempt.id,
        expectedStatus: workUnit.status,
        endedAt: input.now,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
      if (!transition.ok) {
        rollbackOwnedSqliteTransaction(this.context.database);
        return false;
      }
      const terminalAttempt = this.updateWorkUnitAttemptStatus({
        ...input,
        status: input.attemptStatus,
        endedAt: input.now,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
      if (!terminalAttempt) {
        throw new Error(`Runtime terminal Attempt transition became stale: ${input.workUnitId}/${input.attemptId}`);
      }
      this.appendTerminalRuntimeAudit({
        capability: {
          workUnitId: terminalAttempt.workUnitId,
          attemptId: terminalAttempt.id,
          runtimeInstanceId: terminalAttempt.runtimeInstanceId,
          fencingToken: terminalAttempt.fencingToken,
          attemptStatus: input.attemptStatus,
          transitionedAt: input.now,
        },
        type: input.runtimeEventType,
        actor: input.actor === "runner" ? "runner" : input.actor === "provider" ? "provider" : "system",
        data: {
          fromStatus: transition.from,
          toStatus: transition.to,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
        },
      });
      this.context.database.exec("COMMIT;");
      return true;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    if (input.attemptId) {
      const attempt = this.getWorkUnitAttempt(input.attemptId);
      if (!attempt || !this.matchesCurrentAttemptFence(attempt, input)) {
        throw new Error(`Stale runtime attempt fence: ${input.workUnitId}/${input.attemptId}`);
      }
      return this.appendRuntimeEventWithinTransaction(input);
    }
    return this.appendRuntimeEventWithinTransaction(input);
  }

  appendTerminalRuntimeAudit(input: AppendTerminalRuntimeAuditInput): RuntimeEvent {
    const capability = input.capability;
    const attempt = this.getWorkUnitAttempt(capability.attemptId);
    if (!attempt || !this.matchesCurrentAttemptFence(attempt, capability, true)) {
      throw new Error(`Stale terminal audit fence: ${capability.workUnitId}/${capability.attemptId}`);
    }
    if (attempt.status !== capability.attemptStatus || attempt.endedAt !== capability.transitionedAt) {
      throw new Error(`Terminal audit ownership mismatch: ${capability.workUnitId}/${capability.attemptId}`);
    }
    const expectedType = terminalRuntimeEventTypeForAttemptStatus(attempt.status);
    if (input.type !== expectedType) {
      throw new Error(`Terminal audit event mismatch: ${capability.workUnitId}/${capability.attemptId}/${input.type}`);
    }
    const existingRows = this.context.database
      .prepare(`${runtimeEventSelectSql(`
        WHERE work_unit_id = ?
          AND attempt_id = ?
          AND fencing_token = ?
          AND type IN ('work_unit_succeeded', 'work_unit_failed', 'work_unit_cancelled', 'work_unit_stale')
      `)} ORDER BY seq ASC`)
      .all(capability.workUnitId, capability.attemptId, capability.fencingToken)
      .map((row) => mapRuntimeEvent(row as Record<string, SQLOutputValue>));
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      if (existing.type !== input.type || existing.ts !== capability.transitionedAt) {
        throw new Error(`Terminal audit capability already consumed: ${capability.workUnitId}/${capability.attemptId}`);
      }
      return existing;
    }
    return this.appendRuntimeEventWithinTransaction({
      workUnitId: capability.workUnitId,
      attemptId: capability.attemptId,
      runtimeInstanceId: capability.runtimeInstanceId,
      fencingToken: capability.fencingToken,
      type: input.type,
      actor: input.actor,
      data: input.data,
      ts: capability.transitionedAt,
    }, true, capability.attemptStatus === "lost");
  }

  appendRuntimeDiagnosticEvent(input: AppendRuntimeDiagnosticEventInput): RuntimeEvent {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    if (!input.attemptId) {
      return this.appendRuntimeEventWithinTransaction(input, false);
    }
    const attempt = this.getWorkUnitAttempt(input.attemptId);
    if (!attempt || attempt.workUnitId !== input.workUnitId) {
      throw new Error(`Runtime diagnostic Attempt lineage mismatch: ${input.workUnitId}/${input.attemptId}`);
    }
    if (input.runtimeInstanceId !== undefined && input.runtimeInstanceId !== attempt.runtimeInstanceId) {
      throw new Error(`Runtime diagnostic instance mismatch: ${input.workUnitId}/${input.attemptId}`);
    }
    if (input.fencingToken !== undefined && input.fencingToken !== attempt.fencingToken) {
      throw new Error(`Runtime diagnostic fence mismatch: ${input.workUnitId}/${input.attemptId}`);
    }
    return this.appendRuntimeEventWithinTransaction({
      ...input,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    }, false, true);
  }

  private appendRuntimeEventWithinTransaction(
    input: AppendRuntimeEventInput | AppendRuntimeDiagnosticEventInput,
    updateCanonicalActivity = true,
    allowNonCurrentAttempt = false,
  ): RuntimeEvent {
    const eventFields = {
      id: createRuntimeEventId(),
      workUnitId: input.workUnitId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.runtimeInstanceId ? { runtimeInstanceId: input.runtimeInstanceId } : {}),
      ...(input.fencingToken ? { fencingToken: input.fencingToken } : {}),
      ts: input.ts,
      type: input.type,
      actor: input.actor,
      data: redactSecrets(input.data),
    };
    const inserted = eventFields.attemptId
      ? this.context.database
          .prepare(`
            INSERT INTO runtime_events (id, work_unit_id, attempt_id, runtime_instance_id, fencing_token, seq, ts, type, actor, data_json)
            SELECT ?, ?, ?, ?, ?,
              COALESCE((SELECT MAX(seq) + 1 FROM runtime_events WHERE work_unit_id = ?), 1),
              ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1
              FROM work_unit_attempts AS attempts
              JOIN work_units AS units ON units.id = attempts.work_unit_id
              WHERE attempts.id = ?
                AND attempts.work_unit_id = ?
                AND attempts.runtime_instance_id = ?
                AND attempts.fencing_token = ?
                ${allowNonCurrentAttempt ? "" : "AND units.active_attempt_id = attempts.id"}
            )
            RETURNING seq
          `)
          .get(
            eventFields.id,
            eventFields.workUnitId,
            eventFields.attemptId,
            eventFields.runtimeInstanceId ?? null,
            eventFields.fencingToken ?? null,
            eventFields.workUnitId,
            eventFields.ts,
            eventFields.type,
            eventFields.actor,
            stringifyJson(eventFields.data),
            eventFields.attemptId,
            eventFields.workUnitId,
            input.runtimeInstanceId ?? null,
            eventFields.fencingToken ?? null,
          )
      : this.context.database
          .prepare(`
            INSERT INTO runtime_events (id, work_unit_id, attempt_id, runtime_instance_id, fencing_token, seq, ts, type, actor, data_json)
            SELECT ?, ?, ?, ?, ?,
              COALESCE((SELECT MAX(seq) + 1 FROM runtime_events WHERE work_unit_id = ?), 1),
              ?, ?, ?, ?
            RETURNING seq
          `)
          .get(
            eventFields.id,
            eventFields.workUnitId,
            null,
            null,
            null,
            eventFields.workUnitId,
            eventFields.ts,
            eventFields.type,
            eventFields.actor,
            stringifyJson(eventFields.data),
          );
    if (!inserted) {
      throw new Error(`Stale runtime attempt fence: ${input.workUnitId}/${input.attemptId ?? "unbound"}`);
    }
    const event: RuntimeEvent = {
      ...eventFields,
      seq: readNumber(inserted as Record<string, SQLOutputValue>, "seq"),
    };
    if (updateCanonicalActivity) {
      if (input.attemptId) {
        this.context.database
          .prepare(`
            UPDATE work_units
            SET last_event_at = ?, updated_at = ?
            WHERE id = ? AND active_attempt_id = ?
          `)
          .run(event.ts, event.ts, input.workUnitId, input.attemptId);
        this.context.database
          .prepare(`
            UPDATE work_unit_attempts
            SET last_event_at = ?
            WHERE id = ?
              AND fencing_token = ?
              AND EXISTS (
                SELECT 1 FROM work_units
                WHERE id = ? AND active_attempt_id = ?
              )
          `)
          .run(event.ts, input.attemptId, input.fencingToken ?? null, input.workUnitId, input.attemptId);
      } else {
        this.context.database
          .prepare("UPDATE work_units SET last_event_at = ?, updated_at = ? WHERE id = ?")
          .run(event.ts, event.ts, input.workUnitId);
      }
    }
    return event;
  }

  listRuntimeEvents(workUnitId: string, options: ListRuntimeEventsOptions = {}): RuntimeEvent[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.context.database
      .prepare(`${runtimeEventSelectSql("WHERE work_unit_id = ? AND seq > ?")} ORDER BY seq ASC LIMIT ?`)
      .all(workUnitId, afterSeq, limit)
      .map((row) => mapRuntimeEvent(row as Record<string, SQLOutputValue>));
  }

  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const attempt = this.getWorkUnitAttempt(input.attemptId);
      if (!attempt || !this.matchesCurrentAttemptFence(attempt, input)) {
        throw new Error(`Stale runtime heartbeat fence: ${input.workUnitId}/${input.attemptId}`);
      }
      const renewal = { renewedAt: input.ts, expiresAt: input.resourceExpiresAt };
      assertRuntimeResourceRenewal(renewal);
      const heartbeat: RuntimeHeartbeat = {
        id: createRuntimeHeartbeatId(),
        workUnitId: input.workUnitId,
        attemptId: input.attemptId,
        runtimeInstanceId: input.runtimeInstanceId,
        fencingToken: input.fencingToken,
        ts: input.ts,
        source: input.source,
        ...(input.detail !== undefined ? { detail: redactSecrets(input.detail) } : {}),
      };
      this.context.database
        .prepare(`
          INSERT INTO runtime_heartbeats (id, work_unit_id, attempt_id, runtime_instance_id, fencing_token, ts, source, detail_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          heartbeat.id,
          heartbeat.workUnitId,
          heartbeat.attemptId,
          heartbeat.runtimeInstanceId,
          heartbeat.fencingToken,
          heartbeat.ts,
          heartbeat.source,
          heartbeat.detail === undefined ? null : stringifyJson(heartbeat.detail),
        );
      const canonicalUpdate = this.context.database
        .prepare(`
          UPDATE work_units
          SET last_heartbeat_at = MAX(COALESCE(last_heartbeat_at, ?), ?), updated_at = MAX(updated_at, ?)
          WHERE id = ? AND active_attempt_id = ?
        `)
        .run(input.ts, input.ts, input.ts, input.workUnitId, input.attemptId);
      const attemptUpdate = this.context.database
        .prepare(`
          UPDATE work_unit_attempts
          SET last_heartbeat_at = MAX(COALESCE(last_heartbeat_at, ?), ?)
          WHERE id = ?
            AND runtime_instance_id = ?
            AND fencing_token = ?
            AND EXISTS (
              SELECT 1 FROM work_units
              WHERE id = ? AND active_attempt_id = ?
            )
        `)
        .run(
          input.ts,
          input.ts,
          input.attemptId,
          input.runtimeInstanceId,
          input.fencingToken,
          input.workUnitId,
          input.attemptId,
        );
      if (Number(canonicalUpdate.changes) !== 1 || Number(attemptUpdate.changes) !== 1) {
        throw new Error(`Stale runtime heartbeat fence: ${input.workUnitId}/${input.attemptId}`);
      }
      this.ports.renewResourceLeasesForAttempt(input, renewal);
      this.ports.renewRuntimeSemaphoreSlotsForAttempt(input, renewal);
      this.context.database.exec("COMMIT;");
      return heartbeat;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private nextAttemptFencingToken(workUnitId: string, requestedToken?: string): string {
    const rows = this.context.database
      .prepare("SELECT fencing_token FROM work_unit_attempts WHERE work_unit_id = ?")
      .all(workUnitId) as unknown as readonly Record<string, SQLOutputValue>[];
    let latest = 0n;
    for (const row of rows) {
      const token = readString(row, "fencing_token");
      if (!/^[1-9][0-9]*$/u.test(token)) {
        throw new Error(`Invalid runtime Attempt fencing token: ${workUnitId}/${token}`);
      }
      const generation = BigInt(token);
      if (generation > latest) latest = generation;
    }
    if (requestedToken !== undefined) {
      if (!/^[1-9][0-9]*$/u.test(requestedToken) || BigInt(requestedToken) <= latest) {
        throw new Error(`Runtime Attempt fencing token is not monotonic: ${workUnitId}/${requestedToken}`);
      }
      return requestedToken;
    }
    return (latest + 1n).toString(10);
  }

  private matchesCurrentAttemptFence(
    attempt: WorkUnitAttempt,
    input: {
      readonly workUnitId: string;
      readonly runtimeInstanceId: string;
      readonly fencingToken: string;
    },
    allowTerminalAttempt = false,
  ): boolean {
    const workUnit = this.getWorkUnit(attempt.workUnitId);
    if (!workUnit || workUnit.activeAttemptId !== attempt.id || (!allowTerminalAttempt && isAttemptTerminal(attempt.status))) return false;
    return input.workUnitId === attempt.workUnitId
      && input.runtimeInstanceId === attempt.runtimeInstanceId
      && input.fencingToken === attempt.fencingToken;
  }
}

function isAttemptTerminal(status: WorkUnitAttempt["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost" || status === "yielded";
}

function terminalRuntimeEventTypeForAttemptStatus(
  status: Extract<WorkUnitAttempt["status"], "succeeded" | "failed" | "cancelled" | "lost">,
): Extract<RuntimeEvent["type"], "work_unit_succeeded" | "work_unit_failed" | "work_unit_cancelled" | "work_unit_stale"> {
  if (status === "succeeded") return "work_unit_succeeded";
  if (status === "failed") return "work_unit_failed";
  if (status === "cancelled") return "work_unit_cancelled";
  return "work_unit_stale";
}
