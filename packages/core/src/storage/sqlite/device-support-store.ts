import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceObservationV1,
  type DeviceProfileV1,
  type DeviceTaskAttemptV1,
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

import type { DeviceSupportStoreAttemptRecord } from "../../device-support.js";

export interface DeviceSupportStoreOptions {
  readonly databasePath?: string;
}

export interface DeviceTaskPatch {
  readonly currentActionId?: string;
  readonly lastVerificationId?: string;
}

export interface DeviceTaskEvent {
  readonly sequence: number;
  readonly taskId: string;
  readonly type: string;
  readonly body: Record<string, unknown>;
  readonly createdAt: string;
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

  registerDevice(profile: DeviceProfileV1, now: string): void {
    assertValid(isDeviceProfileV1(profile), "device profile");
    this.database.prepare(`
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
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).run(
      profile.device.id,
      profile.adapterId,
      profile.adapterVersion,
      profile.device.lifecycleStatus,
      profile.device.profileRevision,
      JSON.stringify(profile),
      now,
      now,
    );
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

  saveCapabilitySnapshot(snapshot: DeviceCapabilitySnapshotV1, now: string): void {
    assertValid(isDeviceCapabilitySnapshotV1(snapshot), "capability snapshot");
    if (!this.getDevice(snapshot.deviceId)) throw new Error(`Unknown device: ${snapshot.deviceId}`);
    this.database.prepare(`
      UPDATE device_registry
      SET connection_revision=?, capability_snapshot_json=?, lifecycle_status='healthy', updated_at=?
      WHERE device_id=?
    `).run(snapshot.connectionRevision, JSON.stringify(snapshot), now, snapshot.deviceId);
  }

  getCapabilitySnapshot(snapshotId: string): DeviceCapabilitySnapshotV1 | undefined {
    const row = this.database.prepare("SELECT capability_snapshot_json FROM device_registry WHERE json_extract(capability_snapshot_json,'$.snapshotId')=?")
      .get(snapshotId) as Row | undefined;
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
    this.appendEvent(task.id, "task_created", { task });
    return task;
  }

  getTask(taskId: string): DeviceTaskV1 | undefined {
    const row = this.database.prepare("SELECT task_json FROM device_tasks WHERE task_id=?").get(taskId) as Row | undefined;
    return row ? parseJson<DeviceTaskV1>(row.task_json, isDeviceTaskV1, "device task") : undefined;
  }

  transitionTask(taskId: string, status: DeviceTaskStatusV1, patch: DeviceTaskPatch, now: string): DeviceTaskV1 {
    const current = this.requireTask(taskId);
    if (!isAllowedTransition(current.status, status)) throw new Error(`Invalid device task transition: ${current.status} -> ${status}`);
    const next: DeviceTaskV1 = {
      ...current,
      ...patch,
      status,
      updatedAt: now,
    };
    this.database.prepare("UPDATE device_tasks SET revision=revision+1,status=?,task_json=?,updated_at=? WHERE task_id=?")
      .run(status, JSON.stringify(next), now, taskId);
    this.appendEvent(taskId, "task_transition", { from: current.status, to: status, task: next });
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
    this.appendEvent(record.attempt.taskId, "attempt_prepared", { attemptId: record.attempt.attemptId, actionId: record.attempt.actionId });
    return { record, replayed: false };
  }

  getAttemptByIdempotency(taskId: string, idempotencyKey: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare("SELECT attempt_json,request_json,request_digest FROM device_task_attempts WHERE task_id=? AND idempotency_key=?")
      .get(taskId, idempotencyKey) as Row | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  getActiveAttempt(taskId: string): DeviceSupportStoreAttemptRecord | undefined {
    const row = this.database.prepare("SELECT attempt_json,request_json,request_digest FROM device_task_attempts WHERE task_id=? AND json_extract(attempt_json,'$.status') IN ('prepared','dispatched','unknown') ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Row | undefined;
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
    this.appendEvent(current.attempt.taskId, "attempt_updated", { attemptId, status: next.status });
    return nextRecord;
  }

  appendObservation(taskId: string, observation: DeviceObservationV1, now: string): void {
    assertValid(isDeviceObservationV1(observation), "device observation");
    this.requireTask(taskId);
    this.database.prepare("INSERT INTO device_observations(observation_id,task_id,body_json,created_at) VALUES(?,?,?,?)")
      .run(observation.id, taskId, JSON.stringify(observation), now);
    this.appendEvent(taskId, "observation_recorded", { observationId: observation.id });
  }

  listObservations(taskId: string): readonly DeviceObservationV1[] {
    return (this.database.prepare("SELECT body_json FROM device_observations WHERE task_id=? ORDER BY created_at,observation_id").all(taskId) as Row[])
      .map(row => parseJson<DeviceObservationV1>(row.body_json, isDeviceObservationV1, "device observation"));
  }

  acquireTargetLease(targetDeviceId: string, taskId: string, ownerId: string, now: string, leaseMs: number): boolean {
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const existing = this.database.prepare("SELECT task_id,expires_at FROM device_target_leases WHERE target_device_id=?").get(targetDeviceId) as Row | undefined;
    if (existing && readString(existing, "task_id") !== taskId && Date.parse(readString(existing, "expires_at")) > Date.parse(now)) return false;
    this.database.prepare(`
      INSERT INTO device_target_leases(target_device_id,task_id,owner_id,expires_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(target_device_id) DO UPDATE SET task_id=excluded.task_id,owner_id=excluded.owner_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    `).run(targetDeviceId, taskId, ownerId, expiresAt, now);
    return true;
  }

  releaseTargetLease(targetDeviceId: string, taskId: string): void {
    if (!targetDeviceId) return;
    this.database.prepare("DELETE FROM device_target_leases WHERE target_device_id=? AND task_id=?").run(targetDeviceId, taskId);
  }

  recoverAfterRestart(now: string): readonly string[] {
    const rows = this.database.prepare("SELECT attempt_id,task_id,attempt_json FROM device_task_attempts WHERE json_extract(attempt_json,'$.status') IN ('prepared','dispatched')").all() as Row[];
    const recovered: string[] = [];
    for (const row of rows) {
      const attempt = parseJson<DeviceTaskAttemptV1>(row.attempt_json, isDeviceTaskAttemptV1, "device task attempt");
      this.updateAttempt(readString(row, "attempt_id"), { status: "unknown" }, now);
      const task = this.requireTask(attempt.taskId);
      if (task.status !== "unknown" && !["succeeded", "failed", "cancelled"].includes(task.status)) {
        this.transitionTask(task.id, "unknown", {}, now);
      }
      recovered.push(attempt.attemptId);
    }
    return recovered;
  }

  listEvents(taskId: string): readonly DeviceTaskEvent[] {
    return (this.database.prepare("SELECT sequence,task_id,type,body_json,created_at FROM device_task_events WHERE task_id=? ORDER BY sequence").all(taskId) as Row[])
      .map(row => ({
        sequence: Number(row.sequence),
        taskId: readString(row, "task_id"),
        type: readString(row, "type"),
        body: JSON.parse(readString(row, "body_json")) as Record<string, unknown>,
        createdAt: readString(row, "created_at"),
      }));
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

  private appendEvent(taskId: string, type: string, body: Record<string, unknown>): void {
    this.database.prepare("INSERT INTO device_task_events(task_id,type,body_json,created_at) VALUES(?,?,?,?)")
      .run(taskId, type, JSON.stringify(body), new Date().toISOString());
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
      CREATE TABLE IF NOT EXISTS device_tasks (
        task_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT NOT NULL,
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
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_task_attempts_task ON device_task_attempts(task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_device_task_events_task ON device_task_events(task_id,sequence);
    `);
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
    executing: ["verifying", "succeeded", "partial", "failed", "cancelled", "unknown"],
    verifying: ["succeeded", "partial", "failed", "unknown"],
    succeeded: [],
    partial: ["planning", "executing", "cancelled", "unknown"],
    failed: ["planning", "cancelled"],
    cancelled: [],
    unknown: ["planning", "executing", "cancelled", "failed"],
  };
  return allowed[from].includes(to);
}
