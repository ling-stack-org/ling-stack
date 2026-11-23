import type { DeviceKindV1 } from "./device.js";

export interface HardwareProtocolFrameV1 {
  readonly sequence: number;
  readonly direction: "tx" | "rx";
  readonly capturedAt: string;
  readonly bytesBase64: string;
  readonly digest: string;
}

export interface HardwareProtocolCaptureV1 {
  readonly captureId: string;
  readonly transport: "usb" | "ble" | "serial" | "rs485" | "can" | "obd" | "vendor";
  readonly targetDeviceId: string;
  readonly frames: readonly HardwareProtocolFrameV1[];
  readonly source: "live" | "imported" | "replay";
  readonly loss?: HardwareProtocolCaptureLossV1;
  readonly createdAt: string;
}

export interface HardwareProtocolCaptureLossV1 {
  readonly reason: "adapter_overrun" | "connection_interrupted" | "capture_limit";
  readonly droppedFrames?: number;
}

export interface HardwareProtocolCodecManifestV1 {
  readonly codecId: string;
  readonly version: string;
  readonly transport: HardwareProtocolCaptureV1["transport"];
  readonly messageTypes: readonly string[];
  readonly license: string;
}

export interface HardwareProtocolProfileV1 {
  readonly profileId: string;
  readonly version: string;
  readonly codecId: string;
  readonly transport: HardwareProtocolCaptureV1["transport"];
  readonly supportedDeviceKinds: readonly DeviceKindV1[];
  readonly supportedModels?: readonly string[];
  readonly supportedFirmwareRanges?: readonly string[];
  readonly capabilityIds: readonly string[];
  readonly license: string;
}

export const HARDWARE_PROTOCOL_PROFILE_ENTRYPOINT_V1 = "hardware-protocol-profile.json";

export interface HardwareProtocolProfileResourceV1 {
  readonly schemaVersion: 1;
  readonly codecId: string;
  readonly capabilityIds: readonly string[];
  readonly supportedModels?: readonly string[];
}

export function isHardwareProtocolProfileResourceV1(value: unknown): value is HardwareProtocolProfileResourceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { schemaVersion, codecId, capabilityIds, supportedModels } = value as Record<string, unknown>;
  return Object.keys(value).every(key => ["schemaVersion", "codecId", "capabilityIds", "supportedModels"].includes(key))
    && schemaVersion === 1 && typeof codecId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/u.test(codecId)
    && isProfileStringList(capabilityIds) && capabilityIds.every(id => /^[a-z][a-z0-9_.-]*$/u.test(id))
    && (supportedModels === undefined || isProfileStringList(supportedModels));
}

function isProfileStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && new Set(value).size === value.length
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 128 && item.trim() === item
      && !/[\u0000-\u001f\u007f]/u.test(item));
}

export interface HardwareProtocolDecodedFrameV1 {
  readonly sequence: number;
  readonly messageType: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  readonly checksumValid: boolean;
}
