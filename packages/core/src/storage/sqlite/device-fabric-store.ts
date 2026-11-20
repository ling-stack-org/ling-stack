import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type {
  DeviceEventEnvelopeV1,
  DeviceLifecycleRecordV1,
  DeviceResourceManifestV1,
  JsonValue,
} from "@ling-stack/contracts";

import { DeviceFabricError, isAllowedDeviceLifecycleTransition } from "../../device-fabric.js";

export interface DeviceFabricStoreOptions {
  readonly databasePath?: string;
  readonly maxEventsPerStream?: number;
  readonly verifyResourceSignature?: (manifest: DeviceResourceManifestV1) => boolean;
}

export interface DeviceEventReadResult {
  readonly streamId: string;
  readonly generation: number;
  readonly events: readonly DeviceEventEnvelopeV1[];
  readonly oldestSequence?: number;
  readonly latestSequence?: number;
  readonly hasGap: boolean;
}

export interface DeviceSnapshotRecord {
  readonly streamId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly snapshot: JsonValue;
  readonly createdAt: string;
}

export interface DeviceResourceRecord {
  readonly manifest: DeviceResourceManifestV1;
  readonly payloadDigest: string;
  readonly installedAt: string;
}

export class SqliteDeviceFabricStore {
  readonly database: DatabaseSync;
  readonly #maxEventsPerStream: number;
  readonly #verifyResourceSignature?: (manifest: DeviceResourceManifestV1) => boolean;

  constructor(options: DeviceFabricStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#maxEventsPerStream = options.maxEventsPerStream ?? 2_000;
    if (!Number.isInteger(this.#maxEventsPerStream) || this.#maxEventsPerStream < 1) {
      throw new Error("maxEventsPerStream must be a positive integer");
    }
    this.#verifyResourceSignature = options.verifyResourceSignature;
    this.applySchema();
  }

  appendEvent(event: DeviceEventEnvelopeV1, now = new Date().toISOString()): { readonly event: DeviceEventEnvelopeV1; readonly replayed: boolean } {
    const streamId = event.streamId ?? `${event.sourceKind}:${event.sourceId}`;
    const generation = event.generation ?? 1;
    validateEvent(event, streamId, generation);
    const normalized = { ...event, streamId, generation } satisfies DeviceEventEnvelopeV1;

    const byId = this.database.prepare("SELECT stream_id,generation,sequence,envelope_json FROM device_fabric_events WHERE event_id=?").get(event.eventId) as Row | undefined;
    if (byId) {
      const existing = parseJson<DeviceEventEnvelopeV1>(byId.envelope_json, "device event");
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new DeviceFabricError("revision_conflict", "event id is already bound to a different envelope");
      }
      return { event: existing, replayed: true };
    }

    const existingSequence = this.database.prepare("SELECT event_id,envelope_json FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence=?")
      .get(streamId, generation, event.sequence) as Row | undefined;
    if (existingSequence) {
      const existing = parseJson<DeviceEventEnvelopeV1>(existingSequence.envelope_json, "device event");
      if (existing.eventId === normalized.eventId && JSON.stringify(existing) === JSON.stringify(normalized)) return { event: existing, replayed: true };
      throw new DeviceFabricError("revision_conflict", "event sequence is already occupied");
    }

    const latest = this.database.prepare("SELECT MAX(sequence) AS sequence FROM device_fabric_events WHERE stream_id=? AND generation=?").get(streamId, generation) as Row | undefined;
    const latestSequence = latest?.sequence === null || latest?.sequence === undefined ? 0 : Number(latest.sequence);
    if (event.sequence <= latestSequence) throw new DeviceFabricError("revision_conflict", "event sequence must advance within its stream");

    this.database.prepare("INSERT INTO device_fabric_events(stream_id,generation,sequence,event_id,envelope_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(streamId, generation, event.sequence, event.eventId, JSON.stringify(normalized), event.occurredAt, now);
    this.database.prepare("DELETE FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence <= ?")
      .run(streamId, generation, event.sequence - this.#maxEventsPerStream);
    return { event: normalized, replayed: false };
  }

  readEvents(streamId: string, generation = 1, afterSequence = 0, limit = 100): DeviceEventReadResult {
    if (!streamId.trim()) throw new Error("streamId is required");
    if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be between 1 and 10000");

    const bounds = this.database.prepare("SELECT MIN(sequence) AS oldest,MAX(sequence) AS latest FROM device_fabric_events WHERE stream_id=? AND generation=?")
      .get(streamId, generation) as Row | undefined;
    const oldestSequence = bounds?.oldest === null || bounds?.oldest === undefined ? undefined : Number(bounds.oldest);
    const latestSequence = bounds?.latest === null || bounds?.latest === undefined ? undefined : Number(bounds.latest);
    if (oldestSequence !== undefined && afterSequence < oldestSequence - 1) {
      throw new DeviceFabricError("revision_conflict", "event cursor is older than the retained range");
    }
    const rows = this.database.prepare("SELECT envelope_json FROM device_fabric_events WHERE stream_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(streamId, generation, afterSequence, limit) as Row[];
    const events = rows.map(row => parseJson<DeviceEventEnvelopeV1>(row.envelope_json, "device event"));
    const hasGap = events.length > 0
      ? events[0]!.sequence > afterSequence + 1
      : latestSequence !== undefined && latestSequence > afterSequence;
    return { streamId, generation, events, oldestSequence, latestSequence, hasGap };
  }

  saveSnapshot(input: Omit<DeviceSnapshotRecord, "createdAt"> & { readonly createdAt?: string }): DeviceSnapshotRecord {
    if (!input.streamId.trim()) throw new Error("streamId is required");
    if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error("generation must be a positive integer");
    if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new Error("snapshot sequence must be a non-negative integer");
    const record: DeviceSnapshotRecord = { ...input, createdAt: input.createdAt ?? new Date().toISOString() };
    this.database.prepare("INSERT INTO device_fabric_snapshots(stream_id,generation,sequence,snapshot_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(stream_id,generation) DO UPDATE SET sequence=excluded.sequence,snapshot_json=excluded.snapshot_json,created_at=excluded.created_at")
      .run(record.streamId, record.generation, record.sequence, JSON.stringify(record.snapshot), record.createdAt);
    return record;
  }

  getSnapshot(streamId: string, generation = 1): DeviceSnapshotRecord | undefined {
    const row = this.database.prepare("SELECT sequence,snapshot_json,created_at FROM device_fabric_snapshots WHERE stream_id=? AND generation=?")
      .get(streamId, generation) as Row | undefined;
    if (!row) return undefined;
    return {
      streamId,
      generation,
      sequence: Number(row.sequence),
      snapshot: parseJson<JsonValue>(row.snapshot_json, "device snapshot"),
      createdAt: readString(row, "created_at"),
    };
  }

  installResource(manifest: DeviceResourceManifestV1, payload: Uint8Array, installedAt = new Date().toISOString()): { readonly record: DeviceResourceRecord; readonly replayed: boolean } {
    validateResourceManifest(manifest);
    const payloadDigest = createHash("sha256").update(payload).digest("hex");
    if (payloadDigest !== manifest.digest) throw new DeviceFabricError("resource_conflict", "resource digest does not match manifest");
    if (this.#verifyResourceSignature && !this.#verifyResourceSignature(manifest)) throw new DeviceFabricError("resource_conflict", "resource signature is not valid");
    const current = this.getResource(manifest.resourceId);
    if (current?.manifest.version === manifest.version && current.payloadDigest === payloadDigest) return { record: current, replayed: true };
    if (current) {
      this.database.prepare("INSERT INTO device_resource_history(resource_id,manifest_json,payload_digest,installed_at) VALUES(?,?,?,?)")
        .run(manifest.resourceId, JSON.stringify(current.manifest), current.payloadDigest, current.installedAt);
    }
    const record = { manifest, payloadDigest, installedAt } satisfies DeviceResourceRecord;
    this.database.prepare("INSERT INTO device_resource_active(resource_id,manifest_json,payload_digest,installed_at) VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET manifest_json=excluded.manifest_json,payload_digest=excluded.payload_digest,installed_at=excluded.installed_at")
      .run(manifest.resourceId, JSON.stringify(manifest), payloadDigest, installedAt);
    return { record, replayed: false };
  }

  rollbackResource(resourceId: string): DeviceResourceRecord {
    const row = this.database.prepare("SELECT manifest_json,payload_digest,installed_at FROM device_resource_history WHERE resource_id=? ORDER BY revision_id DESC LIMIT 1").get(resourceId) as Row | undefined;
    if (!row) throw new DeviceFabricError("resource_conflict", "resource has no rollback revision");
    const record = { manifest: parseJson<DeviceResourceManifestV1>(row.manifest_json, "resource manifest"), payloadDigest: readString(row, "payload_digest"), installedAt: readString(row, "installed_at") } satisfies DeviceResourceRecord;
    this.database.prepare("INSERT INTO device_resource_active(resource_id,manifest_json,payload_digest,installed_at) VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET manifest_json=excluded.manifest_json,payload_digest=excluded.payload_digest,installed_at=excluded.installed_at")
      .run(resourceId, JSON.stringify(record.manifest), record.payloadDigest, record.installedAt);
    this.database.prepare("DELETE FROM device_resource_history WHERE revision_id=(SELECT revision_id FROM device_resource_history WHERE resource_id=? ORDER BY revision_id DESC LIMIT 1)").run(resourceId);
    return record;
  }

  getResource(resourceId: string): DeviceResourceRecord | undefined {
    const row = this.database.prepare("SELECT manifest_json,payload_digest,installed_at FROM device_resource_active WHERE resource_id=?").get(resourceId) as Row | undefined;
    if (!row) return undefined;
    return { manifest: parseJson<DeviceResourceManifestV1>(row.manifest_json, "resource manifest"), payloadDigest: readString(row, "payload_digest"), installedAt: readString(row, "installed_at") };
  }

  transitionLifecycle(record: DeviceLifecycleRecordV1): DeviceLifecycleRecordV1 {
    const current = this.getLifecycle(record.deviceId);
    if (!current && record.status !== "discovered") throw new DeviceFabricError("lifecycle_invalid", "device lifecycle must start at discovered");
    if (current && (record.revision <= current.revision || !isAllowedDeviceLifecycleTransition(current.status, record.status))) {
      throw new DeviceFabricError("lifecycle_invalid", "device lifecycle transition is invalid");
    }
    this.database.prepare("INSERT INTO device_lifecycle_state(device_id,revision,record_json,changed_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,changed_at=excluded.changed_at")
      .run(record.deviceId, record.revision, JSON.stringify(record), record.changedAt);
    return record;
  }

  getLifecycle(deviceId: string): DeviceLifecycleRecordV1 | undefined {
    const row = this.database.prepare("SELECT record_json FROM device_lifecycle_state WHERE device_id=?").get(deviceId) as Row | undefined;
    return row ? parseJson<DeviceLifecycleRecordV1>(row.record_json, "device lifecycle record") : undefined;
  }

  close(): void { this.database.close(); }

  private applySchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_fabric_events (
        stream_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(stream_id,generation,sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_device_fabric_events_stream ON device_fabric_events(stream_id,generation,sequence);
      CREATE TABLE IF NOT EXISTS device_fabric_snapshots (
        stream_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(stream_id,generation)
      );
      CREATE TABLE IF NOT EXISTS device_resource_active (
        resource_id TEXT PRIMARY KEY NOT NULL,
        manifest_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_resource_history (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_resource_history_resource ON device_resource_history(resource_id,revision_id);
      CREATE TABLE IF NOT EXISTS device_lifecycle_state (
        device_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
  }
}

function validateEvent(event: DeviceEventEnvelopeV1, streamId: string, generation: number): void {
  if (!event.eventId.trim() || !event.traceId.trim() || !streamId.trim() || !Number.isInteger(generation) || generation < 1 || !Number.isInteger(event.sequence) || event.sequence < 1 || !event.kind.trim()) {
    throw new DeviceFabricError("revision_conflict", "device event identity or sequence is invalid");
  }
}

function validateResourceManifest(manifest: DeviceResourceManifestV1): void {
  if (!manifest.resourceId.trim() || !manifest.version.trim() || !manifest.license.trim() || !manifest.signature.trim() || !manifest.entrypoint.trim() || !manifest.digest.trim()) {
    throw new DeviceFabricError("resource_conflict", "resource manifest is incomplete");
  }
  if (manifest.dependencies.includes(manifest.resourceId) || new Set(manifest.dependencies).size !== manifest.dependencies.length) {
    throw new DeviceFabricError("resource_conflict", "resource manifest has invalid dependencies");
  }
}

type Row = Record<string, SQLOutputValue>;

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
