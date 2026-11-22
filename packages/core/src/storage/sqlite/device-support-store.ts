import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceApprovalBindingV1,
  type DeviceApprovalPrincipalV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceDispatchStopV1,
  type DeviceObservationV1,
  type DevicePlannerAcceptanceV1,
  type DeviceProfileV1,
  type DeviceTaskAttemptV1,
  type DeviceTaskReconciliationV1,
  type DeviceTaskStatusV1,
  type DeviceTaskV1,
  type DeviceVerificationResultV1,
  isDeviceActionRequestV1,
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceProfileV1,
  isDeviceTaskAttemptV1,
  isDeviceTaskV1,
  isDeviceVerificationResultV1,
} from "@ling-stack/contracts";

import { DeviceBrokerError, type DeviceSupportStoreAttemptRecord } from "../../device-support.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { withSqliteSnapshotParentTransaction } from "./read-snapshot.js";

export interface DeviceSupportStoreOptions {
  readonly databasePath?: string;
}

export interface DeviceTaskPatch {
  readonly currentActionId?: string;
  readonly lastVerificationId?: string;
}

export interface DeviceTaskEvent {
  readonly sequence: number;
  readonly rowSequence: number;
  readonly taskId: string;
  readonly type: string;
  readonly body: Record<string, unknown>;
  readonly createdAt: string;
}

export type RecordedDevicePlan = DevicePlannerAcceptanceV1 & {
  readonly source: "runner" | "local_playbook";
  readonly fallbackReason?: "runner_unavailable";
};

export interface RecordedDeviceCapabilitySnapshot {
  readonly workspaceId: string;
  readonly profileRevision: string;
  readonly snapshot: DeviceCapabilitySnapshotV1;
}

export interface DeviceAttemptPatch {
  readonly status?: DeviceTaskAttemptV1["status"];
  readonly receipt?: DeviceActionResultV1;
  readonly verification?: DeviceVerificationResultV1;
}

export class SqliteDeviceSupportStore {
  readonly database: DatabaseSync;

  constructor(options: DeviceSupportStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.applySchema();
  }

  withWriteTransaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = withSqliteSnapshotParentTransaction(this.database, write);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.database);
      throw error;
    }
  }

  registerDevice(profile: DeviceProfileV1, now: string): boolean {
    assertValid(isDeviceProfileV1(profile), "device profile");
    const result = this.database.prepare(`
      INSERT INTO device_registry (
        device_id, adapter_id, adapter_version, lifecycle_status, connection_revision,
        profile_json, capability_snapshot_json, registered_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      ON CONFLICT(device_id) DO UPDATE SET
        adapter_id = excluded.adapter_id,
        adapter_version = excluded.adapter_version,
        lifecycle_status = excluded.lifecycle_status,
        connection_revision = excluded.connection_revision,
        profile_json = excluded.profile_json,
        capability_snapshot_json = NULL,
        updated_at = excluded.updated_at,
        revoked_at = NULL
      WHERE device_registry.lifecycle_status NOT IN ('revoked', 'retired')
        AND json_extract(device_registry.profile_json, '$.device.ownerScope') = ?
    `).run(
      profile.device.id,
      profile.adapterId,
      profile.adapterVersion,
      profile.device.lifecycleStatus,
      profile.device.profileRevision,
      JSON.stringify(profile),
      now,
      now,
      profile.device.ownerScope,
    );
    return result.changes === 1;
  }

  getDevice(deviceId: string): DeviceProfileV1 | undefined {
    const row = this.database.prepare("SELECT profile_json,lifecycle_status FROM device_registry WHERE device_id=?").get(deviceId) as Row | undefined;
    if (!row) return undefined;
    const profile = parseJson<DeviceProfileV1>(row.profile_json, isDeviceProfileV1, "device profile");
    if (profile.device.lifecycleStatus === row.lifecycle_status) return profile;
    return { ...profile, device: { ...profile.device, lifecycleStatus: readString(row, "lifecycle_status") as DeviceProfileV1["device"]["lifecycleStatus"] } };
  }

  listDevices(): readonly DeviceProfileV1[] {
    return (this.database.prepare("SELECT device_id FROM device_registry ORDER BY device_id").all() as Row[])
      .map(row => this.getDevice(readString(row, "device_id")))
      .filter((profile): profile is DeviceProfileV1 => profile !== undefined);
  }

  revokeDevice(deviceId: string, now: string): DeviceProfileV1 {
    const profile = this.requireDevice(deviceId);
    const revoked = { ...profile, device: { ...profile.device, lifecycleStatus: "revoked" as const, lastSeenAt: now } };
    this.database.prepare("UPDATE device_registry SET lifecycle_status='revoked', profile_json=?, revoked_at=?, updated_at=? WHERE device_id=?")
      .run(JSON.stringify(revoked), now, now, deviceId);
    return revoked;
  }

  markDeviceOffline(deviceId: string, now: string): void {
    this.database.prepare(`
      UPDATE device_registry SET lifecycle_status='offline', capability_snapshot_json=NULL, updated_at=?
      WHERE device_id=? AND lifecycle_status NOT IN ('revoked', 'retired')
    `).run(now, deviceId);
  }

  saveCapabilitySnapshot(snapshot: DeviceCapabilitySnapshotV1, now: string): void {
    assertValid(isDeviceCapabilitySnapshotV1(snapshot), "capability snapshot");
    this.database.exec("SAVEPOINT device_capability_snapshot");
    try {
      const profile = this.requireDevice(snapshot.deviceId);
      const workspaceId = profile.device.ownerScope;
      const profileRevision = profile.profileRevision;
      const json = JSON.stringify(snapshot);
      const previous = this.getRecordedCapabilitySnapshot(snapshot.deviceId, snapshot.snapshotId);
      if (previous && (previous.workspaceId !== workspaceId || previous.profileRevision !== profileRevision
        || !isDeepStrictEqual(previous.snapshot, JSON.parse(json))
        || this.getCurrentCapabilitySnapshot(snapshot.deviceId)?.snapshotId !== snapshot.snapshotId)) {
        throw new DeviceBrokerError("stale_snapshot", "capability snapshot id is already bound to historical evidence");
      }
      const result = this.database.prepare(`
        UPDATE device_registry
        SET connection_revision=?, capability_snapshot_json=?, lifecycle_status='healthy', updated_at=?
        WHERE device_id=? AND adapter_id=? AND adapter_version=?
          AND lifecycle_status NOT IN ('revoked', 'retired')
      `).run(snapshot.connectionRevision, json, now, snapshot.deviceId, snapshot.adapterId, snapshot.adapterVersion);
      if (result.changes !== 1) throw new DeviceBrokerError("target_changed", "device capability snapshot no longer matches an active registration");
      if (!previous) {
        this.database.prepare(`
          INSERT INTO device_capability_snapshots(device_id,snapshot_id,workspace_id,profile_revision,snapshot_json)
          VALUES (?,?,?,?,?)
        `).run(snapshot.deviceId, snapshot.snapshotId, workspaceId, profileRevision, json);
      }
      this.database.exec("RELEASE device_capability_snapshot");
    } catch (error) {
      this.database.exec("ROLLBACK TO device_capability_snapshot; RELEASE device_capability_snapshot");
      throw error;
    }
  }

  getRecordedCapabilitySnapshot(deviceId: string, snapshotId: string): RecordedDeviceCapabilitySnapshot | undefined {
    const row = this.database.prepare(`
      SELECT workspace_id,profile_revision,snapshot_json FROM device_capability_snapshots WHERE device_id=? AND snapshot_id=?
    `).get(deviceId, snapshotId) as Row | undefined;
    if (!row) return undefined;
    return {
      workspaceId: readString(row, "workspace_id"),
      profileRevision: readString(row, "profile_revision"),
      snapshot: parseJson(row.snapshot_json, isDeviceCapabilitySnapshotV1, "capability snapshot"),
    };
  }

  getCurrentCapabilitySnapshot(deviceId: string): DeviceCapabilitySnapshotV1 | undefined {
    const row = this.database.prepare("SELECT capability_snapshot_json FROM device_registry WHERE device_id=?")
      .get(deviceId) as Row | undefined;
    if (!row || row.capability_snapshot_json === null) return undefined;
    return parseJson<DeviceCapabilitySnapshotV1>(row.capability_snapshot_json, isDeviceCapabilitySnapshotV1, "capability snapshot");
  }

  createTask(task: DeviceTaskV1, now: string): DeviceTaskV1 {
    assertValid(isDeviceTaskV1(task), "device task");
    if (this.database.prepare("SELECT 1 FROM device_tasks WHERE task_id=?").get(task.id)) {
      throw new Error(`Device task already exists: ${task.id}`);
    }
    this.database.prepare("INSERT INTO device_tasks(task_id,revision,status,task_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(task.id, 0, task.status, JSON.stringify(task), task.createdAt, now);
    this.appendEvent(task.id, "task_created", { task }, now);
    return task;
  }

  recordPlanningAcceptance(
    acceptance: DevicePlannerAcceptanceV1, source: RecordedDevicePlan["source"], fallbackReason?: RecordedDevicePlan["fallbackReason"],
  ): void {
    this.withWriteTransaction(() => {
      const task = this.requireTask(acceptance.taskId);
      if (task.status !== "planning" || acceptance.graph.graphId !== task.id
        || acceptance.graph.nodes.some(node => node.ownerKind !== task.ownerKind || node.ownerId !== task.ownerId
          || !task.targetDeviceIds.includes(node.targetDeviceId) || !task.capabilitySnapshotIds.includes(node.capabilitySnapshotId))) {
        throw new Error("Device plan is outside the task's current owner and target binding");
      }
      const acceptedAt = Date.parse(acceptance.acceptedAt);
      for (const node of acceptance.graph.nodes) {
        const profile = this.getDevice(node.targetDeviceId);
        const snapshot = this.getCurrentCapabilitySnapshot(node.targetDeviceId);
        if (!profile || ["offline", "retired", "revoked"].includes(profile.device.lifecycleStatus)
          || !snapshot || snapshot.snapshotId !== node.capabilitySnapshotId || !snapshot.capabilities.some(cap => cap.id === node.capabilityId)
          || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion
          || !(Date.parse(snapshot.observedAt) <= acceptedAt && acceptedAt < Date.parse(snapshot.freshnessUntil))) {
          throw new DeviceBrokerError("target_changed", "device target changed before the plan was recorded");
        }
      }
      const record = { source, ...acceptance, ...(fallbackReason ? { fallbackReason } : {}) } satisfies RecordedDevicePlan;
      const prior = this.listPlanningAcceptances(task.id).find(plan => plan.proposalId === acceptance.proposalId);
      if (prior) {
        if (!isDeepStrictEqual(prior, record)) throw new Error("Device plan proposal id is already bound");
        return;
      }
      this.appendEvent(task.id, "device_plan_accepted", record, record.acceptedAt);
    });
  }

  listPlanningAcceptances(taskId: string): readonly RecordedDevicePlan[] {
    const rows = this.database.prepare(`
      SELECT body_json FROM device_task_events WHERE task_id=? AND type='device_plan_accepted' ORDER BY sequence
    `).all(taskId) as Row[];
    return rows.map(row => JSON.parse(readString(row, "body_json")) as RecordedDevicePlan);
  }

  saveActionProposal(request: DeviceActionRequestV1, requestDigest: string, now: string): void {
    assertValid(isDeviceActionRequestV1(request), "device action request");
    this.requireTask(request.taskId);
    this.database.prepare(`
      INSERT INTO device_task_proposals(task_id,action_id,idempotency_key,request_digest,request_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET action_id=excluded.action_id,idempotency_key=excluded.idempotency_key,request_digest=excluded.request_digest,request_json=excluded.request_json,updated_at=excluded.updated_at
    `).run(request.taskId, request.actionId, request.idempotencyKey, requestDigest, JSON.stringify(request), now, now);
  }

  recordApproval(approval: DeviceApprovalBindingV1, principal: DeviceApprovalPrincipalV1 | undefined, now: string): void {
    const { taskId, ...binding } = approval;
    this.appendEvent(taskId, "approval_recorded", {
      ...binding,
      ...(approval.recoveryScope === undefined ? {} : { recoveryScope: approval.recoveryScope }),
      ...(principal ? { principal } : {}),
      recordedAt: now,
    }, now);
  }

  getActionProposal(taskId: string): { readonly request: DeviceActionRequestV1; readonly requestDigest: string } | undefined {
    const row = this.database.prepare("SELECT request_json,request_digest FROM device_task_proposals WHERE task_id=?").get(taskId) as Row | undefined;
    if (!row) return undefined;
    return { request: parseJson<DeviceActionRequestV1>(row.request_json, isDeviceActionRequestV1, "device action request"), requestDigest: readString(row, "request_digest") };
  }

  getTask(taskId: string): DeviceTaskV1 | undefined {
    const row = this.database.prepare("SELECT task_json FROM device_tasks WHERE task_id=?").get(taskId) as Row | undefined;
    return row ? parseJson<DeviceTaskV1>(row.task_json, isDeviceTaskV1, "device task") : undefined;
  }

  listRecentDaemonTasks(workspaceId: string, limit: number): readonly DeviceTaskV1[] {
    const rows = this.database.prepare(`
      SELECT task_json FROM device_tasks
      WHERE json_extract(task_json, '$.ownerKind') = 'daemon'
        AND json_array_length(task_json, '$.targetDeviceIds') > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(task_json, '$.targetDeviceIds') AS target
          LEFT JOIN device_registry AS device ON device.device_id = target.value
          WHERE json_extract(device.profile_json, '$.device.ownerScope') IS NOT ?
        )
      ORDER BY updated_at DESC, task_id
      LIMIT ?
    `).all(workspaceId, limit) as Row[];
    return rows.map(row => parseJson<DeviceTaskV1>(row.task_json, isDeviceTaskV1, "device task"));
  }

  transitionTask(taskId: string, status: DeviceTaskStatusV1, patch: DeviceTaskPatch, now: string): DeviceTaskV1 {
    const current = this.requireTask(taskId);
    if (!isAllowedTransition(current.status, status)) throw new Error(`Invalid device task transition: ${current.status} -> ${status}`);
    return this.writeTaskTransition(current, status, patch, now);
  }

  private writeTaskTransition(current: DeviceTaskV1, status: DeviceTaskStatusV1, patch: DeviceTaskPatch, now: string): DeviceTaskV1 {
    const next: DeviceTaskV1 = {
      ...current,
      ...patch,
      status,
      updatedAt: now,
    };
    this.database.prepare("UPDATE device_tasks SET revision=revision+1,status=?,task_json=?,updated_at=? WHERE task_id=?")
      .run(status, JSON.stringify(next), now, current.id);
    this.appendEvent(current.id, "task_transition", { from: current.status, to: status, task: next }, now);
    return next;
  }

  createAttempt(record: DeviceSupportStoreAttemptRecord, now: string): { readonly record: DeviceSupportStoreAttemptRecord; readonly replayed: boolean } {
    assertValid(isDeviceTaskAttemptV1(record.attempt), "device task attempt");
    assertValid(isDeviceActionRequestV1(record.request), "device action request");
    const existing = this.getAttemptByIdempotency(record.request.taskId, record.request.idempotencyKey);
    if (existing) return { record: existing, replayed: true };
    this.database.prepare(`
      INSERT INTO device_task_attempts (
        attempt_id, task_id, action_id, idempotency_key, request_digest, target_device_id,
        attempt_json, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.attempt.attemptId,
      record.attempt.taskId,
      record.attempt.actionId,
      record.request.idempotencyKey,
      record.requestDigest,
      record.attempt.targetDeviceId,
      JSON.stringify(record.attempt),
      JSON.stringify(record.request),
      now,
      now,
    );
    this.appendEvent(record.attempt.taskId, "attempt_prepared", { attemptId: record.attempt.attemptId, actionId: record.attempt.actionId }, now);
    return { record, replayed: false };
  }

  getAttemptByIdempotency(taskId: string, idempotencyKey: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare("SELECT attempt_json,request_json,request_digest FROM device_task_attempts WHERE task_id=? AND idempotency_key=?")
      .get(taskId, idempotencyKey) as Row | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  getAttempt(taskId: string, attemptId: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare("SELECT attempt_json, request_json, request_digest FROM device_task_attempts WHERE task_id=? AND attempt_id=?")
      .get(taskId, attemptId) as Row | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  getActiveAttempt(taskId: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare(`
      SELECT attempt_json, request_json, request_digest FROM device_task_attempts
      WHERE task_id=? AND json_extract(attempt_json,'$.status') IN ('prepared','dispatched','unknown')
      ORDER BY json_extract(attempt_json,'$.status')='unknown', created_at DESC, attempt_id DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  getLeasedAttempt(taskId: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare(`
      SELECT a.attempt_json, a.request_json, a.request_digest FROM device_target_leases AS l
      JOIN device_task_attempts AS a ON a.attempt_id=l.attempt_id
      WHERE l.task_id=?
    `).get(taskId) as Row | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  listAttempts(taskId: string): readonly DeviceSupportStoreAttemptRecord[] {
    return (this.database.prepare("SELECT attempt_json,request_json,request_digest FROM device_task_attempts WHERE task_id=? ORDER BY created_at,attempt_id").all(taskId) as Row[])
      .map(row => this.parseAttempt(row));
  }

  updateAttempt(attemptId: string, patch: DeviceAttemptPatch, now: string): DeviceSupportStoreAttemptRecord {
    const row = this.database.prepare("SELECT attempt_json,request_json,request_digest FROM device_task_attempts WHERE attempt_id=?").get(attemptId) as Row | undefined;
    if (!row) throw new Error(`Unknown device attempt: ${attemptId}`);
    const current = this.parseAttempt(row);
    if (patch.receipt) assertValid(isDeviceActionResultV1(patch.receipt), "device action result");
    if (patch.verification) assertValid(isDeviceVerificationResultV1(patch.verification), "device verification result");
    const next: DeviceTaskAttemptV1 = {
      ...current.attempt,
      ...patch,
    };
    const nextRecord = { ...current, attempt: next };
    this.database.prepare("UPDATE device_task_attempts SET attempt_json=?,updated_at=? WHERE attempt_id=?")
      .run(JSON.stringify(next), now, attemptId);
    this.appendEvent(current.attempt.taskId, "attempt_updated", {
      attemptId, status: next.status,
      ...(patch.receipt ? { receiptStatus: patch.receipt.status } : {}),
      ...(patch.verification ? { verificationStatus: patch.verification.status } : {}),
    }, now);
    return nextRecord;
  }

  appendObservation(taskId: string, observation: DeviceObservationV1, now: string): void {
    assertValid(isDeviceObservationV1(observation), "device observation");
    this.requireTask(taskId);
    this.database.prepare("INSERT INTO device_observations(observation_id,task_id,body_json,created_at) VALUES(?,?,?,?)")
      .run(observation.id, taskId, JSON.stringify(observation), now);
    this.appendEvent(taskId, "observation_recorded", { observationId: observation.id }, now);
  }

  listObservations(taskId: string, page?: { readonly recentLimit: number }): readonly DeviceObservationV1[] {
    const statement = this.database.prepare(page
      ? "SELECT body_json FROM device_observations WHERE task_id=? ORDER BY created_at DESC, observation_id DESC LIMIT ?"
      : "SELECT body_json FROM device_observations WHERE task_id=? ORDER BY created_at, observation_id");
    const observations = (page ? statement.all(taskId, page.recentLimit) : statement.all(taskId))
      .map(row => parseJson<DeviceObservationV1>(row.body_json, isDeviceObservationV1, "device observation"));
    return page ? observations.reverse() : observations;
  }

  getObservation(taskId: string, observationId: string): DeviceObservationV1 | undefined {
    const row = this.database.prepare("SELECT body_json FROM device_observations WHERE task_id=? AND observation_id=?")
      .get(taskId, observationId) as Row | undefined;
    return row ? parseJson<DeviceObservationV1>(row.body_json, isDeviceObservationV1, "device observation") : undefined;
  }

  acquireTargetLease(targetDeviceId: string, taskId: string, ownerId: string, now: string, leaseMs: number, attemptId?: string): boolean {
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = this.database.prepare(`
      INSERT INTO device_target_leases(target_device_id,task_id,owner_id,expires_at,updated_at,attempt_id)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(target_device_id) DO UPDATE SET task_id=excluded.task_id,owner_id=excluded.owner_id,
        expires_at=excluded.expires_at,updated_at=excluded.updated_at,attempt_id=excluded.attempt_id
      WHERE device_target_leases.attempt_id IS NULL
        AND (device_target_leases.task_id=excluded.task_id OR device_target_leases.expires_at<=?)
    `).run(targetDeviceId, taskId, ownerId, expiresAt, now, attemptId ?? null, new Date(Date.parse(now)).toISOString());
    return result.changes === 1;
  }

  releaseTargetLease(targetDeviceId: string, taskId: string, attemptId?: string): boolean {
    if (!targetDeviceId) return false;
    return this.database.prepare("DELETE FROM device_target_leases WHERE target_device_id=? AND task_id=? AND attempt_id IS ?")
      .run(targetDeviceId, taskId, attemptId ?? null).changes === 1;
  }

  getDispatchStop(deviceId: string): DeviceDispatchStopV1 {
    const row = this.database.prepare("SELECT active,revision,changed_at FROM device_dispatch_stops WHERE device_id=?")
      .get(deviceId) as Row | undefined;
    return row ? { deviceId, active: row.active === 1, revision: Number(row.revision), changedAt: readString(row, "changed_at") }
      : { deviceId, active: false, revision: 0 };
  }

  setDispatchStop(input: {
    readonly deviceId: string;
    readonly workspaceId: string;
    readonly active: boolean;
    readonly expectedRevision: number;
    readonly now: string;
  }): { readonly stop: DeviceDispatchStopV1; readonly stoppingTaskId?: string } {
    return this.withWriteTransaction(() => {
      if (this.getDevice(input.deviceId)?.device.ownerScope !== input.workspaceId) {
        throw new DeviceBrokerError("missing_target", "device is unavailable in this workspace");
      }
      const current = this.getDispatchStop(input.deviceId);
      if (current.revision !== input.expectedRevision) throw new DeviceBrokerError("target_changed", "device dispatch stop revision changed");
      if (typeof input.active !== "boolean" || !Number.isFinite(Date.parse(input.now))) {
        throw new DeviceBrokerError("invalid_request", "device dispatch stop is invalid");
      }
      const stop = current.active === input.active ? current : {
        deviceId: input.deviceId, active: input.active, revision: current.revision + 1, changedAt: input.now,
      };
      if (stop !== current) {
        this.database.prepare(`
          INSERT INTO device_dispatch_stops(device_id,active,revision,changed_at) VALUES(?,?,?,?)
          ON CONFLICT(device_id) DO UPDATE SET active=excluded.active,revision=excluded.revision,changed_at=excluded.changed_at
        `).run(stop.deviceId, stop.active ? 1 : 0, stop.revision, input.now);
      }
      if (!stop.active) return { stop };
      const row = this.database.prepare("SELECT task_id FROM device_target_leases WHERE target_device_id=? AND attempt_id IS NOT NULL")
        .get(stop.deviceId) as Row | undefined;
      const task = row ? this.getTask(readString(row, "task_id")) : undefined;
      if (task?.ownerKind !== "daemon") return { stop };
      this.stopDaemonTaskInTransaction(task, input.now);
      return { stop, stoppingTaskId: task.id };
    });
  }

  stopDaemonTask(taskId: string, now: string): DeviceTaskV1 {
    return this.withWriteTransaction(() => this.stopDaemonTaskInTransaction(this.requireTask(taskId), now));
  }

  private stopDaemonTaskInTransaction(task: DeviceTaskV1, now: string): DeviceTaskV1 {
    if (task.ownerKind !== "daemon") throw new Error("Device task belongs to another runtime");
    if (["succeeded", "failed", "cancelled", "unknown"].includes(task.status)) return task;
    const leased = this.getLeasedAttempt(task.id);
    const attempt = leased?.attempt ?? this.getActiveAttempt(task.id)?.attempt;
    const intentRecorded = attempt?.status === "prepared" || attempt?.status === "dispatched";
    const status = leased || intentRecorded || attempt?.status === "unknown" || task.status === "verifying" ? "unknown" : "cancelled";
    if (intentRecorded) this.updateAttempt(attempt.attemptId, { status: "unknown" }, now);
    this.appendEvent(task.id, "task_stop_requested", { attemptId: attempt?.attemptId, status }, now);
    return this.writeTaskTransition(task, status, {}, now);
  }

  recordReconciliation(record: DeviceTaskReconciliationV1): void {
    const task = this.requireTask(record.taskId);
    this.appendEvent(task.id, "attempt_reconciled", { ...record }, record.recordedAt);
    if (task.status === "unknown") {
      this.writeTaskTransition(task, record.status === "verified" ? "succeeded" : "unknown", {
        lastVerificationId: record.reconciliationId,
      }, record.recordedAt);
    }
  }

  listReconciliations(taskId: string): readonly DeviceTaskReconciliationV1[] {
    const rows = this.database.prepare(`
      SELECT body_json FROM device_task_events WHERE task_id=? AND type='attempt_reconciled' ORDER BY sequence
    `).all(taskId) as Row[];
    return rows.map(row => JSON.parse(readString(row, "body_json")) as DeviceTaskReconciliationV1);
  }

  recoverAfterRestart(now: string): readonly string[] {
    return this.withWriteTransaction(() => {
      const pendingAttempts = this.database.prepare(`
        SELECT attempt.attempt_id, attempt.task_id FROM device_task_attempts AS attempt
        JOIN device_tasks AS task ON task.task_id = attempt.task_id
        WHERE json_extract(task.task_json, '$.ownerKind') = 'daemon'
          AND json_extract(attempt.attempt_json, '$.status') IN ('prepared', 'dispatched')
        ORDER BY attempt.attempt_id
      `).all() as Row[];
      const activeTasks = this.database.prepare(`
        SELECT task_id FROM device_tasks WHERE status IN ('executing', 'verifying')
        AND json_extract(task_json, '$.ownerKind') = 'daemon'
      `).all() as Row[];
      const interruptedTaskIds = new Set(activeTasks.map(row => readString(row, "task_id")));
      const recovered: string[] = [];
      for (const row of pendingAttempts) {
        const attemptId = readString(row, "attempt_id");
        this.updateAttempt(attemptId, { status: "unknown" }, now);
        interruptedTaskIds.add(readString(row, "task_id"));
        recovered.push(attemptId);
      }
      for (const taskId of interruptedTaskIds) {
        const task = this.requireTask(taskId);
        if (!["unknown", "succeeded", "failed", "cancelled"].includes(task.status)) {
          this.writeTaskTransition(task, "unknown", {}, now);
        }
      }
      // Attempt leases are held until the adapter settles or its daemon restarts.
      this.database.prepare(`
        DELETE FROM device_target_leases WHERE attempt_id IS NOT NULL AND task_id IN (
          SELECT task_id FROM device_tasks WHERE json_extract(task_json, '$.ownerKind') = 'daemon'
        )
      `).run();
      return recovered;
    });
  }

  listEvents(taskId: string, page?: { readonly offset: number; readonly limit: number }): readonly DeviceTaskEvent[] {
    const statement = this.database.prepare(
      `SELECT sequence,task_id,type,body_json,created_at FROM device_task_events WHERE task_id=? ORDER BY sequence${page ? " LIMIT ? OFFSET ?" : ""}`,
    );
    const rows = (page ? statement.all(taskId, page.limit, page.offset) : statement.all(taskId)) as Row[];
    return rows.map((row, index) => ({
      sequence: (page?.offset ?? 0) + index + 1,
      rowSequence: Number(row.sequence),
      taskId: readString(row, "task_id"),
      type: readString(row, "type"),
      body: JSON.parse(readString(row, "body_json")) as Record<string, unknown>,
      createdAt: readString(row, "created_at"),
    }));
  }

  countEvents(taskId: string): number {
    return Number(this.database.prepare("SELECT count(*) AS count FROM device_task_events WHERE task_id=?").get(taskId)?.count ?? 0);
  }

  hasPublicObservation(taskId: string, observationId: string): boolean {
    return !!this.database.prepare(`
      SELECT 1 FROM device_observations
      WHERE task_id=? AND observation_id=? AND json_extract(body_json,'$.redactionClass')='public'
    `).get(taskId, observationId);
  }

  close(): void {
    this.database.close();
  }

  private parseAttempt(row: Row): DeviceSupportStoreAttemptRecord {
    return {
      attempt: parseJson<DeviceTaskAttemptV1>(row.attempt_json, isDeviceTaskAttemptV1, "device task attempt"),
      request: parseJson<DeviceActionRequestV1>(row.request_json, isDeviceActionRequestV1, "device action request"),
      requestDigest: readString(row, "request_digest"),
    };
  }

  private requireDevice(deviceId: string): DeviceProfileV1 {
    const profile = this.getDevice(deviceId);
    if (!profile) throw new Error(`Unknown device: ${deviceId}`);
    return profile;
  }

  private requireTask(taskId: string): DeviceTaskV1 {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown device task: ${taskId}`);
    return task;
  }

  private appendEvent(taskId: string, type: string, body: Record<string, unknown>, createdAt: string): void {
    this.database.prepare("INSERT INTO device_task_events(task_id,type,body_json,created_at) VALUES(?,?,?,?)")
      .run(taskId, type, JSON.stringify(body), createdAt);
  }

  private applySchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_registry (
        device_id TEXT PRIMARY KEY NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        connection_revision TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        capability_snapshot_json TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS device_capability_snapshots (
        device_id TEXT NOT NULL REFERENCES device_registry(device_id),
        snapshot_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        profile_revision TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(device_id,snapshot_id)
      );
      CREATE TABLE IF NOT EXISTS device_tasks (
        task_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_task_proposals (
        task_id TEXT PRIMARY KEY NOT NULL REFERENCES device_tasks(task_id),
        action_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_task_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES device_tasks(task_id),
        action_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        attempt_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS device_observations (
        observation_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES device_tasks(task_id),
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES device_tasks(task_id),
        type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_target_leases (
        target_device_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_id TEXT
      );
      CREATE TABLE IF NOT EXISTS device_dispatch_stops (
        device_id TEXT PRIMARY KEY NOT NULL REFERENCES device_registry(device_id),
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        revision INTEGER NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_task_attempts_task ON device_task_attempts(task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_device_task_events_task ON device_task_events(task_id,sequence);
      CREATE INDEX IF NOT EXISTS idx_device_tasks_recent ON device_tasks(updated_at DESC,task_id);
    `);
    this.withWriteTransaction(() => {
      if (!this.database.prepare("SELECT 1 FROM pragma_table_info('device_target_leases') WHERE name='attempt_id'").get()) {
        this.database.exec("ALTER TABLE device_target_leases ADD COLUMN attempt_id TEXT");
      }
      this.database.exec("CREATE INDEX IF NOT EXISTS idx_device_target_leases_task ON device_target_leases(task_id)");
      this.database.exec(`
        INSERT INTO device_capability_snapshots(device_id,snapshot_id,workspace_id,profile_revision,snapshot_json)
        SELECT device_id, json_extract(capability_snapshot_json, '$.snapshotId'),
          json_extract(profile_json, '$.device.ownerScope'), json_extract(profile_json, '$.profileRevision'), capability_snapshot_json
        FROM device_registry
        WHERE capability_snapshot_json IS NOT NULL
        ON CONFLICT(device_id,snapshot_id) DO NOTHING
      `);
    });
  }
}

type Row = Record<string, SQLOutputValue>;

function assertValid(condition: boolean, label: string): void {
  if (!condition) throw new Error(`Invalid ${label}`);
}

function parseJson<T>(raw: SQLOutputValue, validator: (value: unknown) => value is T, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  const value: unknown = JSON.parse(raw);
  assertValid(validator(value), label);
  return value as T;
}

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function isAllowedTransition(from: DeviceTaskStatusV1, to: DeviceTaskStatusV1): boolean {
  if (from === to) return true;
  const allowed: Record<DeviceTaskStatusV1, readonly DeviceTaskStatusV1[]> = {
    created: ["target_resolved", "planning", "cancelled"],
    target_resolved: ["capabilities_loaded", "planning", "cancelled"],
    capabilities_loaded: ["planning", "awaiting_approval", "cancelled"],
    planning: ["awaiting_approval", "executing", "cancelled", "failed", "unknown"],
    awaiting_approval: ["executing", "cancelled", "failed"],
    executing: ["awaiting_approval", "verifying", "succeeded", "partial", "failed", "cancelled", "unknown"],
    verifying: ["succeeded", "partial", "failed", "unknown"],
    succeeded: [],
    partial: ["planning", "awaiting_approval", "executing", "cancelled", "unknown"],
    failed: ["planning", "cancelled"],
    cancelled: [],
    unknown: ["planning", "executing", "cancelled", "failed"],
  };
  return allowed[from].includes(to);
}
