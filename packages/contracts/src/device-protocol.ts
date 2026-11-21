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

export interface HardwareProtocolDecodedFrameV1 {
  readonly sequence: number;
  readonly messageType: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  readonly checksumValid: boolean;
}
