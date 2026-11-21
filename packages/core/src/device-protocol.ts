import { createHash } from "node:crypto";
import type {
  HardwareProtocolCaptureV1, HardwareProtocolCodecManifestV1, HardwareProtocolDecodedFrameV1, HardwareProtocolFrameV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";

export interface HardwareProtocolCodec {
  readonly manifest: HardwareProtocolCodecManifestV1;
  decode(frame: HardwareProtocolFrameV1): HardwareProtocolDecodedFrameV1;
}

export class HardwareProtocolWorkbench {
  readonly #codecs = new Map<string, HardwareProtocolCodec>();

  registerCodec(codec: HardwareProtocolCodec): void {
    if (this.#codecs.has(codec.manifest.codecId)) throw new DeviceFabricError("resource_conflict", "protocol codec is already registered");
    this.#codecs.set(codec.manifest.codecId, codec);
  }

  capture(input: {
    readonly captureId: string;
    readonly targetDeviceId: string;
    readonly transport: HardwareProtocolCaptureV1["transport"];
    readonly frames: readonly { readonly direction: HardwareProtocolFrameV1["direction"]; readonly bytes: Uint8Array; readonly capturedAt: string }[];
    readonly source?: HardwareProtocolCaptureV1["source"];
    readonly loss?: HardwareProtocolCaptureV1["loss"];
    readonly createdAt: string;
  }): HardwareProtocolCaptureV1 {
    const capture: HardwareProtocolCaptureV1 = {
      captureId: input.captureId,
      targetDeviceId: input.targetDeviceId,
      transport: input.transport,
      source: input.source ?? "live",
      ...(input.loss ? { loss: input.loss } : {}),
      createdAt: input.createdAt,
      frames: input.frames.map((frame, sequence) => ({
        sequence, direction: frame.direction, capturedAt: frame.capturedAt,
        bytesBase64: Buffer.from(frame.bytes).toString("base64"), digest: digest(frame.bytes),
      })),
    };
    assertValidHardwareProtocolCapture(capture);
    return capture;
  }

  decode(capture: HardwareProtocolCaptureV1, codecId: string): readonly HardwareProtocolDecodedFrameV1[] {
    const codec = this.#codecs.get(codecId);
    if (!codec || codec.manifest.transport !== capture.transport) throw new DeviceFabricError("target_missing", "protocol codec does not support this capture transport");
    assertValidHardwareProtocolCapture(capture);
    return capture.frames.map(frame => codec.decode(frame));
  }

  replay(capture: HardwareProtocolCaptureV1, onFrame: (frame: HardwareProtocolFrameV1) => void): void {
    assertValidHardwareProtocolCapture(capture);
    for (const frame of capture.frames) {
      onFrame(frame);
    }
  }
}

export function assertValidHardwareProtocolCapture(capture: HardwareProtocolCaptureV1): void {
  if (!capture.captureId.trim() || !capture.targetDeviceId.trim() || !Number.isFinite(Date.parse(capture.createdAt))
    || !["usb", "ble", "serial", "rs485", "can", "obd", "vendor"].includes(capture.transport)
    || !["live", "imported", "replay"].includes(capture.source)
    || (capture.frames.length === 0 && !capture.loss)) {
    throw new DeviceFabricError("revision_conflict", "protocol capture is incomplete");
  }
  const loss = capture.loss;
  if (loss && (!["adapter_overrun", "connection_interrupted", "capture_limit"].includes(loss.reason)
    || (loss.droppedFrames !== undefined && (!Number.isSafeInteger(loss.droppedFrames) || loss.droppedFrames < 1)))) {
    throw new DeviceFabricError("revision_conflict", "protocol capture loss is invalid");
  }
  for (const [index, frame] of capture.frames.entries()) {
    if (frame.sequence !== index || !["tx", "rx"].includes(frame.direction) || !Number.isFinite(Date.parse(frame.capturedAt))) {
      throw new DeviceFabricError("revision_conflict", "protocol capture frame metadata is invalid");
    }
    const bytes = Buffer.from(frame.bytesBase64, "base64");
    if (bytes.toString("base64") !== frame.bytesBase64 || digest(bytes) !== frame.digest) {
      throw new DeviceFabricError("revision_conflict", "protocol frame digest or encoding is invalid");
    }
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
