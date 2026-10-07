import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeAttemptFenceV1 } from "@ling-stack/core";

export type NativeInputOwner = RuntimeAttemptFenceV1 & { readonly workspaceId: string; readonly runId: string };
export interface NativeInputCaptureExpectation {
  readonly requestId: string;
  readonly nonce: string;
  readonly identity: NativeInputOwner;
  readonly path: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly maxBytes: number;
}
export interface NativeInputFileMetadata {
  readonly device: string; readonly inode: string; readonly links: string; readonly sizeBytes: number; readonly mode: number;
  readonly modifiedSec: string; readonly modifiedNsec: string; readonly changedSec: string; readonly changedNsec: string;
}
export interface NativeCapturedInput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly metadata: NativeInputFileMetadata;
}
export class NativeInputCaptureError extends Error {
  constructor(readonly code: string) { super(code); this.name = "NativeInputCaptureError"; }
}
export function requireNativeInput(value: unknown, code = "native_input_protocol_invalid"): asserts value {
  if (!value) throw new NativeInputCaptureError(code);
}
const CHUNK_BYTES = 16384;
const nativeErrors = new Set(["missing_request", "invalid_frame_length", "truncated_frame", "input_unavailable", "invalid_request",
  "unsupported_protocol_version", "unsupported_operation", "helper_version_mismatch", "parent_mismatch", "parent_unavailable",
  "unsupported_invocation", "invalid_input_request", "input_path_unavailable", "input_root_identity_changed", "input_not_regular",
  "input_hardlink_rejected", "input_budget_exceeded", "input_changed"]);
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const decimal = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/u.test(value);
const seconds = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,20}$/u.test(value);
const nanos = (value: unknown): value is string => decimal(value) && Number(value) < 1e9;

/** Bounded wire decoder. Transport success and current Host ownership are checked by the caller. */
export class NativeInputCaptureDecoder {
  private readonly expected: NativeInputCaptureExpectation;
  private pending: Buffer = Buffer.alloc(0);
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private wireSize = 0;
  private shortChunk = false;
  private state: "start" | "chunks" | "done" | "failed" | "consumed" = "start";
  private metadata: NativeInputFileMetadata | undefined;
  constructor(expected: NativeInputCaptureExpectation) {
    requireNativeInput(Number.isSafeInteger(expected.maxBytes) && expected.maxBytes > 0 && expected.maxBytes <= 67108864,
      "native_input_invalid_budget");
    this.expected = structuredClone(expected);
  }
  push(bytes: Buffer): void {
    try {
      requireNativeInput(this.state !== "failed" && this.state !== "consumed");
      if (bytes.length === 0) return;
      requireNativeInput(this.state !== "done");
      this.wireSize += bytes.length;
      requireNativeInput(this.wireSize <= this.expected.maxBytes * 2 + Math.ceil(this.expected.maxBytes / CHUNK_BYTES) * 200 + 12288);
      this.pending = Buffer.concat([this.pending, bytes]);
      while (this.pending.length >= 4) {
        const size = this.pending.readUInt32BE(0);
        requireNativeInput(size > 0 && size <= 262144);
        if (this.pending.length < size + 4) break;
        const body = this.pending.subarray(4, size + 4);
        const value: unknown = JSON.parse(body.toString("utf8"));
        // The trusted native writer emits compact UTF-8 JSON. Roundtrip equality
        // also rejects duplicate fields and invalid UTF-8 replacement characters.
        requireNativeInput(Buffer.from(JSON.stringify(value)).equals(body));
        this.consume(value);
        this.pending = this.pending.subarray(size + 4);
      }
      requireNativeInput(this.pending.length === 0 || this.acceptsFrames());
    } catch (error) {
      this.state = "failed"; this.chunks.length = 0; this.pending = Buffer.alloc(0);
      throw error instanceof NativeInputCaptureError ? error : new NativeInputCaptureError("native_input_protocol_invalid");
    }
  }
  finish(): NativeCapturedInput {
    requireNativeInput(this.state === "done" && this.pending.length === 0 && this.metadata, "native_input_incomplete");
    this.state = "consumed";
    const bytes = Buffer.concat(this.chunks, this.size); this.chunks.length = 0;
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: this.metadata };
  }
  private acceptsFrames(): boolean { return this.state === "start" || this.state === "chunks"; }
  private consume(value: unknown): void {
    if (exactRecord(value, ["type", "protocolVersion", "code", "enforcementReady"]) && value.type === "error") {
      requireNativeInput(this.state === "start" && value.protocolVersion === 1 && value.enforcementReady === false
        && typeof value.code === "string" && nativeErrors.has(value.code));
      throw new NativeInputCaptureError("native_input_helper_" + value.code);
    }
    if (this.state === "start") {
      requireNativeInput(exactRecord(value, ["type", "protocolVersion", "requestId", "nonce", "identity"])
        && value.type === "input_started" && value.protocolVersion === 1 && value.requestId === this.expected.requestId
        && value.nonce === this.expected.nonce && isDeepStrictEqual(value.identity, this.expected.identity));
      this.state = "chunks"; return;
    }
    requireNativeInput(this.state === "chunks");
    if (exactRecord(value, ["type", "index", "hex"]) && value.type === "input_chunk") {
      requireNativeInput(!this.shortChunk && value.index === this.chunks.length && typeof value.hex === "string"
        && value.hex.length <= CHUNK_BYTES * 2 && /^(?:[0-9a-f]{2})+$/u.test(value.hex));
      const bytes = Buffer.from(value.hex, "hex");
      requireNativeInput(this.size + bytes.length <= this.expected.maxBytes, "native_input_budget_exceeded");
      this.size += bytes.length; this.shortChunk = bytes.length < CHUNK_BYTES; this.chunks.push(bytes); return;
    }
    requireNativeInput(exactRecord(value, ["type", "path", "rootDevice", "rootInode", "metadata", "sizeBytes"])
      && value.type === "input_completed" && value.path === this.expected.path && value.rootDevice === this.expected.rootDevice
      && value.rootInode === this.expected.rootInode && value.sizeBytes === this.size);
    const metadata = value.metadata;
    requireNativeInput(exactRecord(metadata, ["device", "inode", "links", "sizeBytes", "mode", "modifiedSec", "modifiedNsec", "changedSec", "changedNsec"])
      && decimal(metadata.device) && decimal(metadata.inode) && metadata.links === "1" && metadata.sizeBytes === this.size
      && typeof metadata.mode === "number" && Number.isSafeInteger(metadata.mode) && metadata.mode >= 0 && metadata.mode <= 0xffff
      && (metadata.mode & 0o170000) === 0o100000 && seconds(metadata.modifiedSec) && seconds(metadata.changedSec)
      && nanos(metadata.modifiedNsec) && nanos(metadata.changedNsec));
    this.metadata = Object.freeze({ ...metadata }) as unknown as NativeInputFileMetadata; this.state = "done";
  }
}
