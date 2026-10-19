import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQLOutputValue } from "node:sqlite";
import { isRunEventData } from "@ling-stack/contracts";
import { createResourceLeaseId, type CreateResourceLeaseInput, type ResourceLease } from "../../channel-runtime-types.js";
import { redactSecrets } from "../../redaction.js";
import type { RunSession } from "../../run-types.js";
import {
  createRuntimeSemaphoreSlotId,
  type AcquireRuntimeSemaphoreSlotInput,
  type RuntimeSemaphoreSlot,
} from "../../runtime-supervisor-types.js";
import {
  type ClaimUserInputContinuationRecovery,
  type ClaimUserInputContinuationRecoveryResult,
  type DeferUserInputContinuationRecovery,
  type PublishUserInputContinuationRunCreated,
  type PublishUserInputContinuationRunCreatedResult,
  type RecoverUserInputContinuationPrestart,
  type RecoverUserInputContinuationPrestartResult,
  type RenewUserInputContinuationLease,
  type RenewUserInputContinuationLeaseResult,
  type UserInputContinuationBinding,
  UserInputRunCreatedDeferredError,
} from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { ensureEventLogLine, RunEventLogIntegrityError, RunEventLogIoError } from "../event-log.js";
import { mapRunEvent } from "./run-mappers.js";
import { mapResourceLease, mapRuntimeEvent, mapRuntimeSemaphoreSlot } from "./runtime-work-mappers.js";
import { rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { resourceLeaseSelectSql, runtimeEventSelectSql, runtimeSemaphoreSlotSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { userInputTimestamp } from "./user-input-records.js";
import { validDeliveryKey, validDeliveryRevision } from "./user-input-delivery-records.js";
import { isUserInputRunCreatedReplay } from "./user-input-run-created-replay.js";

type BindingReader = (threadId: string, deliveryId: string) => UserInputContinuationBinding | undefined;
type RunReader = (runId: string) => RunSession | undefined;

/** One writer transaction owns recovery claim, exact resources and pre-start evidence. */
export class SqliteUserInputPrestartRecoveryStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly readBinding: BindingReader,
    private readonly getRun: RunReader,
  ) {}

  claim(input: ClaimUserInputContinuationRecovery, now: string): ClaimUserInputContinuationRecoveryResult {
    const nowMs = userInputTimestamp(now);
    if (!validDeliveryKey(input.ownerId) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1
      || input.leaseMs > 60_000 || nowMs > 8_640_000_000_000_000 - input.leaseMs) {
      throw new UserInputStoreError("invalid_input");
    }
    const token = randomUUID(), expiresAt = new Date(nowMs + input.leaseMs).toISOString();
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      const binding = this.readBinding(input.threadId, input.deliveryId);
      if (!binding || !sameBinding(input, binding)) return this.rollbackResult({ status: "changed" });
      const row = this.deliveryRow(input.deliveryId);
      if (!row || row.status !== "claimed" || Number(row.status_revision) !== binding.deliveryRevision) {
        return this.rollbackResult({ status: "changed" });
      }
      const claimExpiresAt = text(row.claim_expires_at), retryAt = text(row.retry_at);
      if (claimExpiresAt && userInputTimestamp(claimExpiresAt) > nowMs || retryAt && userInputTimestamp(retryAt) > nowMs) {
        return this.rollbackResult({ status: "busy" });
      }
      const changed = this.context.database.prepare(`UPDATE user_input_deliveries
        SET updated_at=?,claim_owner_id=?,claim_token=?,claim_expires_at=?,retry_at=NULL,last_error_code=NULL
        WHERE delivery_id=? AND status='claimed' AND status_revision=?
          AND (claim_expires_at IS NULL OR claim_expires_at<=?) AND (retry_at IS NULL OR retry_at<=?)`)
        .run(now, input.ownerId, token, expiresAt, input.deliveryId, binding.deliveryRevision, now, now);
      if (Number(changed.changes) !== 1) return this.rollbackResult({ status: "busy" });
      this.context.database.exec("COMMIT");
      return { status: "claimed", expiresAt, claim: { threadId: input.threadId, deliveryId: input.deliveryId,
        expectedRevision: binding.deliveryRevision, ownerId: input.ownerId, claimToken: token } };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (isSqliteBusy(error)) return { status: "busy" };
      throw error;
    }
  }

  renew(input: RenewUserInputContinuationLease, now: string): RenewUserInputContinuationLeaseResult {
    const nowMs = userInputTimestamp(now);
    if (!validDeliveryKey(input.ownerId) || !validDeliveryKey(input.claimToken)
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 60_000
      || nowMs > 8_640_000_000_000_000 - input.leaseMs) throw new UserInputStoreError("invalid_input");
    const expiresAt = new Date(nowMs + input.leaseMs).toISOString();
    try {
      const changed = this.context.database.prepare(`UPDATE user_input_deliveries
        SET updated_at=?,claim_expires_at=? WHERE delivery_id=? AND status='claimed'
          AND EXISTS (SELECT 1 FROM user_input_answers a JOIN user_input_requests r ON r.request_id=a.request_id
            WHERE a.answer_id=user_input_deliveries.answer_id AND r.thread_id=? AND r.workspace_id=?)
          AND claim_owner_id=? AND claim_token=? AND claim_expires_at>? AND retry_at IS NULL`)
        .run(now, expiresAt, input.deliveryId, input.threadId, DEFAULT_WORKSPACE_ID, input.ownerId, input.claimToken, now);
      return Number(changed.changes) === 1 ? { status: "renewed", expiresAt } : { status: "lost" };
    } catch (error) {
      if (isSqliteBusy(error)) return { status: "lost" };
      throw error;
    }
  }

  defer(input: DeferUserInputContinuationRecovery, now: string): boolean {
    const nowMs = userInputTimestamp(now), retryMs = userInputTimestamp(input.retryAt);
    if (!validDeliveryRevision(input.expectedRevision) || !validDeliveryKey(input.ownerId)
      || !validDeliveryKey(input.claimToken) || input.errorCode !== "recoverable_failure"
      || retryMs <= nowMs || retryMs - nowMs > 3_600_000) {
      throw new UserInputStoreError("invalid_input");
    }
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      const binding = this.readBinding(input.threadId, input.deliveryId);
      if (!binding || !sameBinding(input, binding) || binding.deliveryRevision !== input.expectedRevision) {
        return this.rollbackResult(false);
      }
      const changed = this.context.database.prepare(`UPDATE user_input_deliveries
        SET updated_at=?,claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=?,last_error_code=?
        WHERE delivery_id=? AND status='claimed' AND status_revision=?
          AND claim_owner_id=? AND claim_token=? AND claim_expires_at>?`)
        .run(now, input.retryAt, input.errorCode, input.deliveryId, input.expectedRevision,
          input.ownerId, input.claimToken, now);
      if (Number(changed.changes) !== 1) return this.rollbackResult(false);
      this.context.database.exec("COMMIT");
      return true;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (isSqliteBusy(error)) return false;
      throw error;
    }
  }

  recover(input: RecoverUserInputContinuationPrestart): RecoverUserInputContinuationPrestartResult {
    userInputTimestamp(input.now);
    userInputTimestamp(input.expiresAt);
    if (input.expiresAt <= input.now || input.claim.expectedRevision < 1) throw new UserInputStoreError("invalid_input");
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      const binding = this.readBinding(input.claim.threadId, input.claim.deliveryId);
      if (!binding || !sameBinding(input, binding) || binding.runId !== input.runId
        || binding.deliveryRevision !== input.claim.expectedRevision || !this.hasCurrentClaim(input, input.now)
        || !this.hasCurrentPrestartOwner(binding)) return this.rollbackResult({ status: "changed" });
      const leases = this.recoverLeases(input, binding);
      if (!Array.isArray(leases)) return this.rollbackResult(leases);
      const semaphores = this.recoverSemaphores(input, binding);
      if (!Array.isArray(semaphores)) return this.rollbackResult(semaphores);
      if (!this.ensureSemaphoreEvidence(binding, input.semaphores, semaphores, input.now)) {
        return this.rollbackResult({ status: "changed" });
      }
      this.context.database.exec("COMMIT");
      return { status: "ready", leases, semaphores };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (isSqliteBusy(error)) return { status: "busy", kind: "sqlite" };
      throw error;
    }
  }

  publishRunCreated(input: PublishUserInputContinuationRunCreated, now: string): PublishUserInputContinuationRunCreatedResult {
    userInputTimestamp(now);
    // Compare and mirror exactly the JSON shape committed to SQLite, not optional
    // in-memory properties that serialization omits (including nested values).
    const data: unknown = JSON.parse(stringifyJson(redactSecrets(input.data)));
    if (!isRunEventData("run_created", data)) throw new UserInputStoreError("invalid_input");
    let event: PublishUserInputContinuationRunCreatedResult["event"] | undefined;
    let run: RunSession | undefined;
    let replayed = false;
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      const binding = this.readBinding(input.claim.threadId, input.claim.deliveryId);
      if (!binding || !sameBinding(input, binding) || binding.runId !== input.runId
        || binding.deliveryRevision !== input.claim.expectedRevision || !this.hasCurrentClaim(input, now)
        || !this.hasCurrentPrestartOwner(binding)) throw new UserInputStoreError("delivery_conflict");
      run = this.getRun(input.runId);
      if (!run) throw new UserInputStoreError("source_conflict");
      const rows = this.context.database.prepare(`SELECT id,run_id,seq,ts,type,data_json FROM run_events
        WHERE run_id=? AND type='run_created' ORDER BY seq`).all(input.runId) as Record<string, SQLOutputValue>[];
      if (rows.length > 1) throw new UserInputStoreError("invalid_record");
      if (!isUserInputRunCreatedReplay(this.context, binding, data, data)) throw new UserInputStoreError("source_conflict");
      if (rows.length === 1) {
        event = mapRunEvent(rows[0]!) as PublishUserInputContinuationRunCreatedResult["event"];
        if (event.id !== `evt_user_input_run_created_${binding.deliveryId}`
          || !isUserInputRunCreatedReplay(this.context, binding, event.data, data)) {
          throw new UserInputStoreError("source_conflict");
        }
        replayed = true;
      } else {
        event = {
          id: `evt_user_input_run_created_${binding.deliveryId}`,
          runId: input.runId,
          seq: Number(this.context.database.prepare("SELECT COALESCE(MAX(seq)+1,1) AS seq FROM run_events WHERE run_id=?")
            .get(input.runId)?.seq),
          ts: now,
          type: "run_created" as const,
          data,
        };
        const inserted = this.context.database.prepare(`INSERT INTO run_events (id,run_id,seq,ts,type,data_json)
          VALUES (?,?,?,?,?,?)`).run(event.id, event.runId, event.seq, event.ts, event.type, stringifyJson(event.data));
        if (Number(inserted.changes) !== 1) throw new UserInputStoreError("source_conflict");
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (isSqliteBusy(error)) throw new UserInputRunCreatedDeferredError("commit");
      throw error;
    }
    if (!event || !run) throw new UserInputStoreError("invalid_record");
    try {
      this.ensureRunCreatedMirror(run, event);
    } catch (error) {
      if (error instanceof RunEventLogIntegrityError) throw new UserInputStoreError("source_conflict");
      if (isSqliteBusy(error) || error instanceof RunEventLogIoError) throw new UserInputRunCreatedDeferredError("mirror");
      throw error;
    }
    return { event, replayed };
  }

  /** Serialize replay repair with all SQLite writers so one committed fact has one JSONL mirror row. */
  private ensureRunCreatedMirror(run: RunSession, event: PublishUserInputContinuationRunCreatedResult["event"]): void {
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      const row = this.context.database.prepare(`SELECT id,run_id,seq,ts,type,data_json FROM run_events
        WHERE id=? AND run_id=? AND type='run_created'`).get(event.id, event.runId) as Record<string, SQLOutputValue> | undefined;
      if (!row || !isDeepStrictEqual(mapRunEvent(row), event)) throw new UserInputStoreError("invalid_record");
      ensureEventLogLine(run.eventLogPath, event);
      this.context.database.exec("COMMIT");
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private recoverLeases(input: RecoverUserInputContinuationPrestart, binding: UserInputContinuationBinding):
    ResourceLease[] | Extract<RecoverUserInputContinuationPrestartResult, { status: "busy" | "changed" }> {
    if (!uniqueResourceInputs(input.leases) || input.leases.some((lease) => lease.ownerType !== "run"
      || !sameFence(lease, binding.fence) || lease.ownerId !== binding.runId)) return { status: "changed" };
    const owned = this.context.database.prepare(`${resourceLeaseSelectSql("WHERE attempt_id=?")} ORDER BY id`)
      .all(binding.fence.attemptId).map(row => mapResourceLease(row as Record<string, SQLOutputValue>));
    const expected = new Map(input.leases.map(value => [resourceKey(value), value]));
    if (owned.some(value => {
      const candidate = expected.get(resourceKey(value));
      return !candidate || !sameLease(value, candidate) || !validResourceHistoryStatus(value);
    })) return { status: "changed" };
    const recovered: ResourceLease[] = [];
    for (const candidate of input.leases) {
      const row = this.context.database.prepare(resourceLeaseSelectSql(
        "WHERE workspace_id=? AND resource_type=? AND resource_key=? AND status='active'"))
        .get(candidate.workspaceId, candidate.resourceType, candidate.resourceKey) as Record<string, SQLOutputValue> | undefined;
      if (row) {
        const lease = mapResourceLease(row);
        if (!sameLease(lease, candidate)) return { status: "busy", kind: "resource",
          resourceType: candidate.resourceType, resourceKey: candidate.resourceKey };
        this.context.database.prepare("UPDATE resource_leases SET last_renewed_at=?,expires_at=? WHERE id=? AND status='active'")
          .run(input.now, input.expiresAt, lease.id);
        recovered.push({ ...lease, lastRenewedAt: input.now, expiresAt: input.expiresAt });
        continue;
      }
      const lease: ResourceLease = { ...candidate, id: createResourceLeaseId(), status: "active",
        lastRenewedAt: input.now, expiresAt: input.expiresAt };
      const inserted = this.context.database.prepare(`INSERT INTO resource_leases
        (id,workspace_id,resource_type,resource_key,owner_type,owner_id,status,acquired_at,expires_at,last_renewed_at,
          released_at,release_reason,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`).run(lease.id, lease.workspaceId, lease.resourceType,
          lease.resourceKey, lease.ownerType, lease.ownerId, lease.acquiredAt, lease.expiresAt,
          lease.lastRenewedAt ?? lease.acquiredAt,
          null, null, lease.workUnitId ?? null, lease.attemptId ?? null, lease.runtimeInstanceId ?? null, lease.fencingToken ?? null);
      if (Number(inserted.changes) !== 1) return { status: "changed" };
      recovered.push(lease);
    }
    return recovered;
  }

  private recoverSemaphores(input: RecoverUserInputContinuationPrestart, binding: UserInputContinuationBinding):
    RuntimeSemaphoreSlot[] | Extract<RecoverUserInputContinuationPrestartResult, { status: "busy" | "changed" }> {
    if (!uniqueResourceInputs(input.semaphores) || input.semaphores.some((slot) => !sameFence(slot, binding.fence)
      || slot.ownerType !== "work_unit_attempt" || slot.ownerId !== binding.fence.attemptId
      || !Number.isSafeInteger(slot.limit) || slot.limit < 1)) return { status: "changed" };
    const owned = this.context.database.prepare(`${runtimeSemaphoreSlotSelectSql("WHERE owner_id=? OR attempt_id=?")} ORDER BY id`)
      .all(binding.fence.attemptId, binding.fence.attemptId).map(row => mapRuntimeSemaphoreSlot(row as Record<string, SQLOutputValue>));
    const expected = new Map(input.semaphores.map(value => [resourceKey(value), value]));
    if (owned.some(value => {
      const candidate = expected.get(resourceKey(value));
      return !candidate || !sameSemaphore(value, candidate) || !validResourceHistoryStatus(value);
    })) return { status: "changed" };
    const recovered: RuntimeSemaphoreSlot[] = [];
    for (const candidate of input.semaphores) {
      const rows = this.context.database.prepare(`${runtimeSemaphoreSlotSelectSql(
        "WHERE workspace_id=? AND resource_type=? AND resource_key=? AND status='active'")} ORDER BY id`)
        .all(candidate.workspaceId, candidate.resourceType, candidate.resourceKey)
        .map(row => mapRuntimeSemaphoreSlot(row as Record<string, SQLOutputValue>));
      const exact = rows.filter(slot => sameSemaphore(slot, candidate));
      if (exact.length > 1 || rows.some(slot => slot.ownerId === candidate.ownerId && !sameSemaphore(slot, candidate))) {
        return { status: "changed" };
      }
      if (exact.length === 1) {
        const slot = exact[0]!;
        this.context.database.prepare("UPDATE runtime_semaphore_slots SET last_renewed_at=?,expires_at=? WHERE id=? AND status='active'")
          .run(input.now, input.expiresAt, slot.id);
        recovered.push({ ...slot, lastRenewedAt: input.now, expiresAt: input.expiresAt });
        continue;
      }
      if (rows.length >= candidate.limit) return { status: "busy", kind: "semaphore",
        resourceType: candidate.resourceType, resourceKey: candidate.resourceKey };
      const slot: RuntimeSemaphoreSlot = { ...candidate, id: createRuntimeSemaphoreSlotId(), status: "active",
        acquiredAt: input.now, lastRenewedAt: input.now, expiresAt: input.expiresAt };
      const inserted = this.context.database.prepare(`INSERT INTO runtime_semaphore_slots
        (id,workspace_id,resource_type,resource_key,owner_type,owner_id,work_unit_id,attempt_id,runtime_instance_id,
          fencing_token,status,acquired_at,last_renewed_at,expires_at,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`).run(slot.id, slot.workspaceId, slot.resourceType,
          slot.resourceKey, slot.ownerType, slot.ownerId, slot.workUnitId, slot.attemptId, slot.runtimeInstanceId,
          slot.fencingToken, slot.acquiredAt, slot.lastRenewedAt, slot.expiresAt, null, null);
      if (Number(inserted.changes) !== 1) return { status: "changed" };
      recovered.push(slot);
    }
    return recovered;
  }

  private ensureSemaphoreEvidence(binding: UserInputContinuationBinding, inputs: readonly AcquireRuntimeSemaphoreSlotInput[],
    slots: readonly RuntimeSemaphoreSlot[], now: string): boolean {
    const rows = this.context.database.prepare(`${runtimeEventSelectSql(
      "WHERE work_unit_id=? AND attempt_id=? AND type='semaphore_acquired'")} ORDER BY seq`)
      .all(binding.fence.workUnitId, binding.fence.attemptId)
      .map(row => mapRuntimeEvent(row as Record<string, SQLOutputValue>));
    const slotsById = new Map(slots.map(slot => [slot.id, slot]));
    const observedIds = new Set<string>();
    let appended = false;
    for (const event of rows) {
      const data = record(event.data), id = data && typeof data.id === "string" ? data.id : undefined;
      if (!id || observedIds.has(id)) return false;
      observedIds.add(id);
      const historical = this.context.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE id=?")).get(id);
      const slot = historical ? mapRuntimeSemaphoreSlot(historical as Record<string, SQLOutputValue>) : undefined;
      const expected = slot && inputs.find(value => resourceKey(value) === resourceKey(slot));
      // Acquisitions are immutable history. Shutdown may have released a slot;
      // recovery creates a new slot rather than rewriting that historical row.
      if (!slot || !expected || !sameSemaphore(slot, expected)
        || (slot.status === "active" ? !slotsById.has(slot.id)
          : !["released", "expired"].includes(slot.status) || !slot.releasedAt)
        || event.workUnitId !== binding.fence.workUnitId || event.attemptId !== binding.fence.attemptId
        || event.actor !== "system" || event.runtimeInstanceId !== binding.fence.runtimeInstanceId
        || event.fencingToken !== binding.fence.fencingToken || data?.resourceType !== slot.resourceType
        || data.resourceKey !== slot.resourceKey || data.limit !== expected.limit) return false;
    }
    const history = this.context.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE owner_id=? OR attempt_id=?"))
      .all(binding.fence.attemptId, binding.fence.attemptId)
      .map(row => mapRuntimeSemaphoreSlot(row as Record<string, SQLOutputValue>));
    // Missing history is not silently repaired. Only a currently active slot
    // admitted by this transaction may still need its first acquisition event.
    if (history.some(slot => slot.status !== "active" && !observedIds.has(slot.id))) return false;
    for (const slot of slots) {
      const matching = rows.filter(event => record(event.data)?.id === slot.id);
      if (matching.length > 1) return false;
      if (matching.length === 1) continue;
      const expected = inputs.find(value => resourceKey(value) === resourceKey(slot));
      if (!expected) return false;
      const id = `runtime_event_user_input_semaphore_${slot.id}`;
      const inserted = this.context.database.prepare(`INSERT OR IGNORE INTO runtime_events
        (id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,seq,ts,type,actor,data_json)
        VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(seq)+1,1) FROM runtime_events WHERE work_unit_id=?),?,'semaphore_acquired','system',?)`)
        .run(id, binding.fence.workUnitId, binding.fence.attemptId, binding.fence.runtimeInstanceId,
          binding.fence.fencingToken, binding.fence.workUnitId, now,
          stringifyJson({ id: slot.id, resourceType: slot.resourceType, resourceKey: slot.resourceKey, limit: expected.limit }));
      if (Number(inserted.changes) !== 1) return false;
      appended = true;
    }
    if (appended) {
      this.context.database.prepare("UPDATE work_units SET last_event_at=?,updated_at=? WHERE id=? AND active_attempt_id=?")
        .run(now, now, binding.fence.workUnitId, binding.fence.attemptId);
      this.context.database.prepare("UPDATE work_unit_attempts SET last_event_at=? WHERE id=? AND fencing_token=?")
        .run(now, binding.fence.attemptId, binding.fence.fencingToken);
    }
    return true;
  }

  private hasCurrentClaim(input: { readonly claim: RecoverUserInputContinuationPrestart["claim"] }, now: string): boolean {
    const row = this.deliveryRow(input.claim.deliveryId);
    return Boolean(row && row.status === "claimed" && Number(row.status_revision) === input.claim.expectedRevision
      && row.claim_owner_id === input.claim.ownerId && row.claim_token === input.claim.claimToken
      && typeof row.claim_expires_at === "string" && row.claim_expires_at > now && row.retry_at === null);
  }

  private hasCurrentPrestartOwner(binding: UserInputContinuationBinding): boolean {
    const row = this.context.database.prepare(`SELECT run.status AS run_status,run.started_at,run.ended_at,run.channel_id,
      unit.status AS unit_status,unit.ended_at AS unit_ended_at,unit.active_attempt_id,unit.linked_run_id,
      attempt.status AS attempt_status,attempt.started_at AS attempt_started_at,attempt.ended_at AS attempt_ended_at,
      attempt.abort_requested_at,attempt.work_unit_id,attempt.runtime_instance_id,attempt.fencing_token,
      task.id AS task_row_id,task.status AS task_status,task.current_run_id,channel.id AS channel_row_id,channel.status AS channel_status
      FROM run_sessions AS run JOIN work_units AS unit ON unit.id=run.work_unit_id
      JOIN work_unit_attempts AS attempt ON attempt.id=unit.active_attempt_id
      LEFT JOIN tasks AS task ON task.id=run.task_id LEFT JOIN channels AS channel ON channel.id=run.channel_id WHERE run.id=?`)
      .get(binding.runId) as Record<string, SQLOutputValue> | undefined;
    return Boolean(row && row.run_status === "queued" && row.started_at === null && row.ended_at === null
      && row.unit_status === "claimed" && row.unit_ended_at === null && row.active_attempt_id === binding.fence.attemptId
      && row.linked_run_id === binding.runId && row.attempt_status === "created" && row.attempt_started_at === null
      && row.attempt_ended_at === null && row.abort_requested_at === null && row.work_unit_id === binding.fence.workUnitId
      && row.runtime_instance_id === binding.fence.runtimeInstanceId && row.fencing_token === binding.fence.fencingToken
      && (row.task_row_id === null || (["claimed", "running"].includes(String(row.task_status))
        && row.current_run_id === binding.runId))
      && (row.channel_id === null || (row.channel_row_id === row.channel_id && row.channel_status === "active")));
  }

  private deliveryRow(deliveryId: string): Record<string, SQLOutputValue> | undefined {
    return this.context.database.prepare(`SELECT status,status_revision,claim_owner_id,claim_token,claim_expires_at,retry_at
      FROM user_input_deliveries WHERE delivery_id=?`).get(deliveryId) as Record<string, SQLOutputValue> | undefined;
  }

  private rollbackResult<T>(result: T): T {
    rollbackOwnedSqliteTransaction(this.context.database);
    return result;
  }
}

function sameBinding(input: { readonly bindingRef: { readonly id: string; readonly fingerprint: string };
  readonly sourceFence: UserInputContinuationBinding["fence"] }, binding: UserInputContinuationBinding): boolean {
  return input.bindingRef.id === binding.id && input.bindingRef.fingerprint === binding.fingerprint
    && isDeepStrictEqual(input.sourceFence, binding.fence);
}

function sameFence(value: { readonly workUnitId: string; readonly attemptId: string;
  readonly runtimeInstanceId: string; readonly fencingToken: string }, fence: UserInputContinuationBinding["fence"]): boolean {
  return value.workUnitId === fence.workUnitId && value.attemptId === fence.attemptId
    && value.runtimeInstanceId === fence.runtimeInstanceId && value.fencingToken === fence.fencingToken;
}

function sameLease(actual: ResourceLease, expected: CreateResourceLeaseInput): boolean {
  return actual.workspaceId === expected.workspaceId && actual.resourceType === expected.resourceType
    && actual.resourceKey === expected.resourceKey && actual.ownerType === expected.ownerType
    && actual.ownerId === expected.ownerId && actual.workUnitId === expected.workUnitId
    && actual.attemptId === expected.attemptId && actual.runtimeInstanceId === expected.runtimeInstanceId
    && actual.fencingToken === expected.fencingToken;
}

function sameSemaphore(actual: RuntimeSemaphoreSlot, expected: AcquireRuntimeSemaphoreSlotInput): boolean {
  return actual.workspaceId === expected.workspaceId && actual.resourceType === expected.resourceType
    && actual.resourceKey === expected.resourceKey && actual.ownerType === expected.ownerType
    && actual.ownerId === expected.ownerId && sameFence(actual, expected);
}

function uniqueResourceInputs(values: readonly { readonly resourceType: string; readonly resourceKey: string }[]): boolean {
  return new Set(values.map(resourceKey)).size === values.length;
}

function validResourceHistoryStatus(value: { readonly status: string; readonly releasedAt?: string }): boolean {
  return value.status === "active" ? value.releasedAt === undefined
    : (value.status === "released" || value.status === "expired") && Boolean(value.releasedAt);
}

function resourceKey(value: { readonly resourceType: string; readonly resourceKey: string }): string {
  return `${value.resourceType}\0${value.resourceKey}`;
}

function text(value: SQLOutputValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isSqliteBusy(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code === "ERR_SQLITE_BUSY" || code === "ERR_SQLITE_LOCKED") return true;
  // node:sqlite uses ERR_SQLITE_ERROR plus SQLite's numeric (possibly extended)
  // result code. Do not classify arbitrary messages as retryable lock failures.
  const result = code === "ERR_SQLITE_ERROR" ? Reflect.get(error as object, "errcode") : undefined;
  return typeof result === "number" && Number.isSafeInteger(result) && result > 0
    && ((result & 0xff) === 5 || (result & 0xff) === 6);
}

