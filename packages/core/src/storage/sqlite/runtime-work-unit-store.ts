import type { SQLOutputValue } from "node:sqlite";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createRuntimeEventId,
  createRuntimeHeartbeatId,
  createWorkUnitAttemptId,
  createWorkUnitId,
  defaultRuntimeTimeoutPolicy,
  type AppendRuntimeEventInput,
  type CreateWorkUnitAttemptInput,
  type CreateWorkUnitInput,
  type ListRuntimeEventsOptions,
  type ListWorkUnitsOptions,
  type RecordRuntimeHeartbeatInput,
  type RuntimeEvent,
  type RuntimeHeartbeat,
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
import { readNumber, stringifyJson } from "./helpers.js";
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
  readonly renewResourceLeasesForAttempt: (attemptId: string, renewedAt: string) => number;
  readonly renewRuntimeSemaphoreSlotsForAttempt: (attemptId: string, renewedAt: string) => number;
}

export class SqliteRuntimeWorkUnitStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteRuntimeWorkUnitStorePorts,
  ) {}

  createWorkUnit(input: CreateWorkUnitInput): WorkUnit {
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
        stringifyJson(redactSecrets(input.request)),
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

  transitionWorkUnitStatus(input: {
    readonly workUnitId: string;
    readonly expectedStatus?: WorkUnitStatus;
    readonly event: WorkUnitTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly activeAttemptId?: string | null;
    readonly startedAt?: string;
    readonly endedAt?: string | null;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): TransitionResult<WorkUnitStatus> {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
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
        WHERE id = ? AND status = ?
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
    const id = input.id ?? createWorkUnitAttemptId();
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    this.context.database
      .prepare(`
        INSERT INTO work_unit_attempts (
          id,
          work_unit_id,
          attempt_number,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workUnitId,
        input.attemptNumber,
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
    this.context.database
      .prepare("UPDATE work_units SET attempt_count = MAX(attempt_count, ?), active_attempt_id = ?, updated_at = ? WHERE id = ?")
      .run(input.attemptNumber, id, input.now, input.workUnitId);
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
    if (!attempt) {
      return undefined;
    }
    this.context.database
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
      );
    return this.getWorkUnitAttempt(input.attemptId);
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    const event: RuntimeEvent = {
      id: createRuntimeEventId(),
      workUnitId: input.workUnitId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      seq: this.nextRuntimeEventSeq(input.workUnitId),
      ts: input.ts,
      type: input.type,
      actor: input.actor,
      data: redactSecrets(input.data),
    };
    this.context.database
      .prepare(`
        INSERT INTO runtime_events (id, work_unit_id, attempt_id, seq, ts, type, actor, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(event.id, event.workUnitId, event.attemptId ?? null, event.seq, event.ts, event.type, event.actor, stringifyJson(event.data));
    this.context.database
      .prepare("UPDATE work_units SET last_event_at = ?, updated_at = ? WHERE id = ?")
      .run(event.ts, event.ts, input.workUnitId);
    if (input.attemptId) {
      this.context.database
        .prepare("UPDATE work_unit_attempts SET last_event_at = ? WHERE id = ?")
        .run(event.ts, input.attemptId);
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
    const heartbeat: RuntimeHeartbeat = {
      id: createRuntimeHeartbeatId(),
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      runtimeInstanceId: input.runtimeInstanceId,
      ts: input.ts,
      source: input.source,
      ...(input.detail !== undefined ? { detail: redactSecrets(input.detail) } : {}),
    };
    this.context.database
      .prepare(`
        INSERT INTO runtime_heartbeats (id, work_unit_id, attempt_id, runtime_instance_id, ts, source, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        heartbeat.id,
        heartbeat.workUnitId,
        heartbeat.attemptId,
        heartbeat.runtimeInstanceId,
        heartbeat.ts,
        heartbeat.source,
        heartbeat.detail === undefined ? null : stringifyJson(heartbeat.detail),
      );
    this.context.database
      .prepare("UPDATE work_units SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run(input.ts, input.ts, input.workUnitId);
    this.context.database
      .prepare("UPDATE work_unit_attempts SET last_heartbeat_at = ? WHERE id = ?")
      .run(input.ts, input.attemptId);
    this.ports.renewResourceLeasesForAttempt(input.attemptId, input.ts);
    this.ports.renewRuntimeSemaphoreSlotsForAttempt(input.attemptId, input.ts);
    return heartbeat;
  }

  private nextRuntimeEventSeq(workUnitId: string): number {
    const row = this.context.database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM runtime_events WHERE work_unit_id = ?")
      .get(workUnitId);
    return readNumber(row as Record<string, SQLOutputValue>, "next_seq");
  }
}
