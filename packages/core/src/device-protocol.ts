import { createHash } from "node:crypto";
import type { HardwareProtocolCaptureV1, HardwareProtocolCodecManifestV1, HardwareProtocolDecodedFrameV1, HardwareProtocolFrameV1 } from "@ling-stack/contracts";
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

  capture(input: { readonly captureId: string; readonly targetDeviceId: string; readonly transport: HardwareProtocolCaptureV1["transport"]; readonly frames: readonly { readonly direction: HardwareProtocolFrameV1["direction"]; readonly bytes: Uint8Array; readonly capturedAt: string }[]; readonly source?: HardwareProtocolCaptureV1["source"]; readonly createdAt: string }): HardwareProtocolCaptureV1 {
    let sequence = 0;
    return {
      captureId: input.captureId,
      targetDeviceId: input.targetDeviceId,
      transport: input.transport,
      source: input.source ?? "live",
      createdAt: input.createdAt,
      frames: input.frames.map(frame => ({ sequence: sequence++, direction: frame.direction, capturedAt: frame.capturedAt, bytesBase64: Buffer.from(frame.bytes).toString("base64"), digest: createHash("sha256").update(frame.bytes).digest("hex") })),
    };
  }

  decode(capture: HardwareProtocolCaptureV1, codecId: string): readonly HardwareProtocolDecodedFrameV1[] {
    const codec = this.#codecs.get(codecId);
    if (!codec || codec.manifest.transport !== capture.transport) throw new DeviceFabricError("target_missing", "protocol codec does not support this capture transport");
    return capture.frames.map(frame => codec.decode(frame));
  }

  replay(capture: HardwareProtocolCaptureV1, send: (frame: HardwareProtocolFrameV1) => void): void {
    for (const frame of capture.frames) {
      const bytes = Buffer.from(frame.bytesBase64, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== frame.digest) throw new DeviceFabricError("revision_conflict", "protocol capture digest changed");
      send(frame);
    }
  }
}
