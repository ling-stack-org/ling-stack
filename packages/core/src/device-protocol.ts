import { createHash } from "node:crypto";
import type {
  DeviceKindV1,
  HardwareProtocolCaptureV1, HardwareProtocolCodecManifestV1, HardwareProtocolDecodedFrameV1, HardwareProtocolFrameV1,
  HardwareProtocolProfileV1,
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

  getCodecManifest(codecId: string): HardwareProtocolCodecManifestV1 | undefined {
    return this.#codecs.get(codecId)?.manifest;
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

/** Maps a verified codec to device models and reusable capability identities. */
export class HardwareProtocolProfileRegistry {
  readonly #workbench: HardwareProtocolWorkbench;
  readonly #profiles = new Map<string, HardwareProtocolProfileV1>();

  constructor(workbench: HardwareProtocolWorkbench) {
    this.#workbench = workbench;
  }

  register(profile: HardwareProtocolProfileV1): HardwareProtocolProfileV1 {
    validateProtocolProfile(profile);
    const codec = this.#workbench.getCodecManifest(profile.codecId);
    if (!codec || codec.transport !== profile.transport) throw new DeviceFabricError("target_missing", "protocol profile codec is unavailable or uses another transport");
    const current = this.#profiles.get(profile.profileId);
    if (current && JSON.stringify(current) !== JSON.stringify(profile)) throw new DeviceFabricError("resource_conflict", "protocol profile id is bound to another manifest");
    this.#profiles.set(profile.profileId, profile);
    return profile;
  }

  get(profileId: string): HardwareProtocolProfileV1 | undefined { return this.#profiles.get(profileId); }

  list(): readonly HardwareProtocolProfileV1[] { return [...this.#profiles.values()].sort((left, right) => left.profileId.localeCompare(right.profileId)); }

  resolve(input: { readonly profileId?: string; readonly deviceKind: DeviceKindV1; readonly model?: string; readonly firmwareVersion?: string }): HardwareProtocolProfileV1 {
    const candidates = this.list().filter(profile => (input.profileId === undefined || profile.profileId === input.profileId)
      && profile.supportedDeviceKinds.includes(input.deviceKind)
      && (profile.supportedModels === undefined || (input.model !== undefined && profile.supportedModels.includes(input.model)))
      && (profile.supportedFirmwareRanges === undefined || (input.firmwareVersion !== undefined && profile.supportedFirmwareRanges.includes(input.firmwareVersion))));
    if (candidates.length > 1) throw new DeviceFabricError("resource_conflict", "multiple protocol profiles match the target");
    if (!candidates[0]) throw new DeviceFabricError("target_missing", "no protocol profile matches the target facts");
    return candidates[0];
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

function validateProtocolProfile(profile: HardwareProtocolProfileV1): void {
  if (!profile.profileId.trim() || !profile.version.trim() || !profile.codecId.trim() || !profile.license.trim()
    || profile.supportedDeviceKinds.length === 0 || profile.capabilityIds.length === 0
    || new Set(profile.supportedDeviceKinds).size !== profile.supportedDeviceKinds.length
    || new Set(profile.capabilityIds).size !== profile.capabilityIds.length
    || profile.supportedDeviceKinds.some(kind => !kind.trim()) || profile.capabilityIds.some(id => !id.trim())) {
    throw new DeviceFabricError("revision_conflict", "protocol profile manifest is incomplete");
  }
  if (profile.supportedModels && new Set(profile.supportedModels).size !== profile.supportedModels.length) throw new DeviceFabricError("revision_conflict", "protocol profile models are repeated");
  if (profile.supportedFirmwareRanges && new Set(profile.supportedFirmwareRanges).size !== profile.supportedFirmwareRanges.length) throw new DeviceFabricError("revision_conflict", "protocol profile firmware ranges are repeated");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
