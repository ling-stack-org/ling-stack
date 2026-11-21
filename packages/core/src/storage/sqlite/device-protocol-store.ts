import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type { HardwareProtocolCaptureV1, HardwareProtocolCodecManifestV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "../../device-fabric.js";

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
    const current = this.getCodec(manifest.codecId);
    if (current && JSON.stringify(current) !== JSON.stringify(manifest)) throw new DeviceFabricError("resource_conflict", "protocol codec id is bound to another manifest");
    this.database.prepare("INSERT INTO device_protocol_codecs(codec_id,manifest_json) VALUES(?,?) ON CONFLICT(codec_id) DO NOTHING").run(manifest.codecId, JSON.stringify(manifest));
    return current ?? manifest;
  }

  getCodec(codecId: string): HardwareProtocolCodecManifestV1 | undefined {
    const row = this.database.prepare("SELECT manifest_json FROM device_protocol_codecs WHERE codec_id=?").get(codecId) as Row | undefined;
    return row ? parseJson<HardwareProtocolCodecManifestV1>(row.manifest_json, "protocol codec manifest") : undefined;
  }

  saveCapture(capture: HardwareProtocolCaptureV1): HardwareProtocolCaptureV1 {
    validateCapture(capture);
    const current = this.getCapture(capture.captureId);
    if (current && JSON.stringify(current) !== JSON.stringify(capture)) throw new DeviceFabricError("revision_conflict", "capture id is bound to different protocol evidence");
    this.database.prepare("INSERT INTO device_protocol_captures(capture_id,target_device_id,transport,capture_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(capture_id) DO NOTHING")
      .run(capture.captureId, capture.targetDeviceId, capture.transport, JSON.stringify(capture), capture.createdAt);
    return current ?? capture;
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

function validateCapture(capture: HardwareProtocolCaptureV1): void {
  if (!capture.captureId.trim() || !capture.targetDeviceId.trim() || !capture.createdAt.trim() || capture.frames.length === 0) throw new DeviceFabricError("revision_conflict", "protocol capture is incomplete");
  capture.frames.forEach((frame, index) => {
    if (frame.sequence !== index || !frame.digest.trim()) throw new DeviceFabricError("revision_conflict", "protocol capture sequence is invalid");
    const bytes = Buffer.from(frame.bytesBase64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== frame.digest) throw new DeviceFabricError("revision_conflict", "protocol frame digest is invalid");
  });
}

function parseJson<T>(raw: SQLOutputValue, label: string): T {
  if (typeof raw !== "string") throw new Error(`Stored ${label} is not JSON`);
  return JSON.parse(raw) as T;
}
