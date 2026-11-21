import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import type { HardwareProtocolCaptureV1, HardwareProtocolCodecManifestV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "../../device-fabric.js";
import { assertValidHardwareProtocolCapture } from "../../device-protocol.js";

export interface DeviceProtocolStoreOptions {
  readonly databasePath?: string;
}

export class SqliteDeviceProtocolStore {
  readonly database: DatabaseSync;

  constructor(options: DeviceProtocolStoreOptions = {}) {
    const path = options.databasePath ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_protocol_codecs (codec_id TEXT PRIMARY KEY NOT NULL, manifest_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_protocol_captures (capture_id TEXT PRIMARY KEY NOT NULL, target_device_id TEXT NOT NULL, transport TEXT NOT NULL, capture_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_device_protocol_captures_target ON device_protocol_captures(target_device_id,created_at,capture_id);
    `);
  }

  registerCodec(manifest: HardwareProtocolCodecManifestV1): HardwareProtocolCodecManifestV1 {
    const serialized = JSON.stringify(manifest);
    this.database.prepare("INSERT INTO device_protocol_codecs(codec_id,manifest_json) VALUES(?,?) ON CONFLICT(codec_id) DO NOTHING").run(manifest.codecId, serialized);
    const stored = this.getCodec(manifest.codecId);
    if (!stored || !isDeepStrictEqual(stored, JSON.parse(serialized))) throw new DeviceFabricError("resource_conflict", "protocol codec id is bound to another manifest");
    return stored;
  }

  getCodec(codecId: string): HardwareProtocolCodecManifestV1 | undefined {
    const row = this.database.prepare("SELECT manifest_json FROM device_protocol_codecs WHERE codec_id=?").get(codecId) as Row | undefined;
    return row ? parseJson<HardwareProtocolCodecManifestV1>(row.manifest_json, "protocol codec manifest") : undefined;
  }

  saveCapture(capture: HardwareProtocolCaptureV1): HardwareProtocolCaptureV1 {
    assertValidHardwareProtocolCapture(capture);
    const serialized = JSON.stringify(capture);
    this.database.prepare("INSERT INTO device_protocol_captures(capture_id,target_device_id,transport,capture_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(capture_id) DO NOTHING")
      .run(capture.captureId, capture.targetDeviceId, capture.transport, serialized, capture.createdAt);
    const stored = this.getCapture(capture.captureId);
    if (!stored || !isDeepStrictEqual(stored, JSON.parse(serialized))) throw new DeviceFabricError("revision_conflict", "capture id is bound to different protocol evidence");
    return stored;
  }

  getCapture(captureId: string): HardwareProtocolCaptureV1 | undefined {
    const row = this.database.prepare("SELECT capture_json FROM device_protocol_captures WHERE capture_id=?").get(captureId) as Row | undefined;
    return row ? parseJson<HardwareProtocolCaptureV1>(row.capture_json, "protocol capture") : undefined;
  }

  listCaptures(targetDeviceId: string): readonly HardwareProtocolCaptureV1[] {
    return (this.database.prepare("SELECT capture_json FROM device_protocol_captures WHERE target_device_id=? ORDER BY created_at,capture_id").all(targetDeviceId) as Row[])
      .map(row => parseJson<HardwareProtocolCaptureV1>(row.capture_json, "protocol capture"));
  }

  close(): void { this.database.close(); }
}

type Row = Record<string, SQLOutputValue>;

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
