import {
  decodeModbusRtuRegisterFrame, encodeModbusRtuRegisterRead, matchModbusRtuRegisterRead,
  MODBUS_RTU_BAUD_RATES, MODBUS_RTU_REGISTER_CODEC,
  type CapabilityDescriptorV1, type DeviceCapabilitySnapshotV1, type DeviceErrorCodeV1, type DeviceObservationV1,
  type DeviceProfileV1, type HardwareProtocolCaptureV1, type HardwareProtocolDecodedFrameV1, type HardwareProtocolFrameV1,
  type ModbusRtuRegisterReadV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, decodeBase64Url, encodeBase64Url, RemoteProtocolError, sha256 } from "@ling-stack/remote-protocol";
import type { MobileDeviceExecutionResult, MobileDeviceTransport } from "./execution.ts";

export interface UsbModbusPort {
  readonly portId: string;
  readonly portNumber: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly label: string;
  readonly permissionGranted: boolean;
}

export interface UsbModbusSettings extends ModbusRtuRegisterReadV1 {
  readonly baudRate: number;
  readonly parity: "none" | "even" | "odd";
  readonly stopBits: 1 | 2;
}

export interface UsbModbusTransfer {
  readonly replyHex: string;
  readonly complete: boolean;
  readonly sentAtMs: number;
  readonly receivedAtMs: number;
}

export interface UsbModbusSession {
  readonly identity: string;
  readonly stableIdentity: boolean;
  read(input: UsbModbusSettings, requestHex: string): Promise<UsbModbusTransfer>;
  close(): void;
}

export interface UsbModbusBridge {
  list(): Promise<readonly UsbModbusPort[]>;
  authorize(port: UsbModbusPort): Promise<void>;
  reserve(port: UsbModbusPort): Promise<UsbModbusSession>;
}

export interface UsbModbusReplay {
  readonly capture: HardwareProtocolCaptureV1;
  readonly frames: readonly (HardwareProtocolDecodedFrameV1 & {
    readonly direction: HardwareProtocolFrameV1["direction"];
    readonly capturedAt: string;
    readonly hex: string;
  })[];
  readonly outcome: ReturnType<typeof matchModbusRtuRegisterRead>;
}

export const usbModbusPlaybookId = "modbus-usb-register-diagnosis@1.0.0";
const captureSource = "modbus.rtu.usb_capture";
const adapterId = "modbus-rtu-android-usb";
const adapterVersion = "1.0.0";
const capability = {
  id: "protocol.read_registers", schemaVersion: "1.0", semanticVerb: "read.registers",
  inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object" },
  sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["rs485.read"], prerequisites: [],
  timeoutMs: 5_000, responseBytesLimit: 4096, idempotency: "request",
  supportedDeviceKinds: ["hardware"], supportedTransports: ["rs485"],
} satisfies CapabilityDescriptorV1;

export class UsbModbusInputError extends Error {}

export function encodeUsbModbusRequest(settings: UsbModbusSettings): Uint8Array {
  if (!MODBUS_RTU_BAUD_RATES.includes(settings.baudRate) || !["none", "even", "odd"].includes(settings.parity)
    || (settings.stopBits !== 1 && settings.stopBits !== 2)) {
    throw new UsbModbusInputError("请填写支持的波特率、校验和停止位。");
  }
  try {
    return encodeModbusRtuRegisterRead(settings);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new UsbModbusInputError("站号须为 1–247，数量须为 1–125。起始地址按设备手册换算为从 0 开始的协议地址。");
  }
}

export function prepareUsbModbusDiagnosis(input: {
  readonly port: UsbModbusPort;
  readonly settings: UsbModbusSettings;
  readonly bytes: Uint8Array;
  readonly session: UsbModbusSession;
  readonly ownerId: string;
  readonly connectionRevision: string;
  readonly now: () => string;
}) {
  const { port, settings, bytes, session, ownerId, connectionRevision, now } = input;
  const deviceId = "modbus:" + encodeBase64Url(sha256(canonicalJsonBytes([ownerId, session.identity, settings.unitAddress])));
  const profileRevision = encodeBase64Url(sha256(canonicalJsonBytes([deviceId, settings])));
  const observedAt = now();
  const profile: DeviceProfileV1 = {
    device: {
      id: deviceId, ownerScope: ownerId, runtimeOwnerId: ownerId, displayName: port.label + " · " + settings.unitAddress,
      kind: "hardware", lifecycleStatus: "identified", profileRevision, lastSeenAt: observedAt,
    },
    adapterId, adapterVersion, transports: ["rs485"], connectionRefs: [connectionRevision],
    transportDeployments: [{ transport: "rs485", mode: "hardware_bridge", pairing: "os_permission", removal: "disconnect_only" }],
    profileRevision, source: "adapter",
  };
  const snapshot: DeviceCapabilitySnapshotV1 = {
    snapshotId: deviceId + ":" + connectionRevision,
    deviceId, adapterId, adapterVersion, contractMajor: 1, connectionRevision,
    capabilities: [capability], observedAt, freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
  };
  const transport: MobileDeviceTransport = {
    deviceId,
    connectionRevision,
    permissions: capability.requiredPermissions,
    async execute({ request, signal }) {
      const startedAt = now();
      const rejected = (errorCode: DeviceErrorCodeV1): MobileDeviceExecutionResult => ({
        action: { actionId: request.actionId, status: "rejected", errorCode, startedAt, finishedAt: now(), observationIds: [] },
      });
      if (request.targetDeviceId !== deviceId || request.capabilitySnapshotId !== snapshot.snapshotId
        || request.capabilityId !== capability.id || request.capabilitySchemaVersion !== capability.schemaVersion) {
        return rejected("invalid_request");
      }
      let transfer: UsbModbusTransfer;
      try {
        transfer = await session.read(settings, toHex(bytes));
      } catch (error) {
        if (signal?.aborted) throw error;
        return rejected(mapUsbError(error));
      }
      if (!/^(?:[a-f0-9]{2}){0,256}$/u.test(transfer.replyHex) || typeof transfer.complete !== "boolean"
        || !validTimestamp(transfer.sentAtMs) || !validTimestamp(transfer.receivedAtMs)) return rejected("invalid_request");
      const reply = fromHex(transfer.replyHex);
      const outcome = matchModbusRtuRegisterRead(decodeModbusRtuRegisterFrame(bytes, "tx"),
        reply.length > 0 ? decodeModbusRtuRegisterFrame(reply, "rx") : undefined, !transfer.complete);
      const id = request.taskId + ":modbus-capture";
      const finishedAt = now();
      const frames = [captureFrame(bytes, 0, "tx", transfer.sentAtMs)];
      if (reply.length > 0) frames.push(captureFrame(reply, 1, "rx", transfer.receivedAtMs));
      const observation: DeviceObservationV1 = {
        id, subjectId: deviceId, source: captureSource,
        value: {
          captureId: id, transport: "rs485", targetDeviceId: deviceId, source: "live", createdAt: startedAt,
          codecId: MODBUS_RTU_REGISTER_CODEC.codecId, codecVersion: MODBUS_RTU_REGISTER_CODEC.version,
          identityScope: session.stableIdentity ? "adapter_port" : "attachment",
          settings: { ...settings }, frames,
          ...(!transfer.complete ? { loss: { reason: "connection_interrupted" } } : {}),
        },
        observedAt: finishedAt, receivedAt: finishedAt, freshnessUntil: new Date(Date.parse(finishedAt) + 30_000).toISOString(),
        provenance: [captureSource, deviceId, id], redactionClass: "sensitive",
        quality: outcome.status === "read" ? "good" : "degraded",
      };
      return {
        action: {
          actionId: request.actionId, status: outcome.status === "read" ? "completed" : "rejected",
          startedAt, finishedAt, observationIds: [id],
          ...(outcome.status === "incomplete_capture" ? { errorCode: "connection_failed" } : {}),
        },
        observations: [observation],
      };
    },
  };
  const step = { stepId: "read-registers", capabilityId: capability.id, capabilitySchemaVersion: capability.schemaVersion, normalizedInput: {} };
  return { profile, snapshot, transport, step };
}

export function replayUsbModbusObservation(observation: DeviceObservationV1, targetDeviceId: string): UsbModbusReplay | undefined {
  const { value } = observation;
  if (observation.subjectId !== targetDeviceId || observation.source !== captureSource || observation.redactionClass !== "sensitive"
    || !observation.provenance.includes(targetDeviceId) || !object(value) || value.captureId !== observation.id
    || value.targetDeviceId !== targetDeviceId || value.transport !== "rs485" || value.source !== "live"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || value.codecId !== MODBUS_RTU_REGISTER_CODEC.codecId
    || value.codecVersion !== MODBUS_RTU_REGISTER_CODEC.version || !Array.isArray(value.frames)
    || value.frames.length < 1 || value.frames.length > 2) return undefined;
  const loss = value.loss;
  if (loss !== undefined && (!object(loss) || loss.reason !== "connection_interrupted")) return undefined;
  const capturedFrames: Array<{ readonly frame: HardwareProtocolFrameV1; readonly bytes: Uint8Array }> = [];
  for (const [sequence, frame] of value.frames.entries()) {
    const direction = sequence === 0 ? "tx" : "rx";
    if (!object(frame) || frame.sequence !== sequence || frame.direction !== direction
      || typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt))
      || typeof frame.bytesBase64 !== "string" || frame.bytesBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]{2,344}={0,2}$/u.test(frame.bytesBase64)) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Url(frame.bytesBase64.replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_"));
    } catch (error) {
      if (!(error instanceof RemoteProtocolError)) throw error;
      return undefined;
    }
    const digest = toHex(sha256(bytes));
    if (bytes.length > 256 || toBase64(bytes) !== frame.bytesBase64 || digest !== frame.digest) return undefined;
    capturedFrames.push({ frame: { sequence, direction, capturedAt: frame.capturedAt, bytesBase64: frame.bytesBase64, digest }, bytes });
  }
  const capture: HardwareProtocolCaptureV1 = {
    captureId: value.captureId, transport: value.transport, targetDeviceId, source: value.source, createdAt: value.createdAt,
    frames: capturedFrames.map(({ frame }) => frame),
    ...(loss ? { loss: { reason: "connection_interrupted" } } : {}),
  };
  const frames = capturedFrames.map(({ frame: { sequence, direction, capturedAt }, bytes }) => ({
    sequence, direction, capturedAt, hex: toHex(bytes), ...decodeModbusRtuRegisterFrame(bytes, direction),
  }));
  return { capture, frames, outcome: matchModbusRtuRegisterRead(frames[0], frames[1], capture.loss !== undefined) };
}

export function mapUsbError(error: unknown): DeviceErrorCodeV1 {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("usb_permission_denied")) return "permission_denied";
  if (message.includes("usb_target_missing")) return "missing_target";
  if (message.includes("usb_target_changed") || message.includes("usb_operation_cancelled")) return "target_changed";
  if (message.includes("usb_target_busy")) return "target_busy";
  if (message.includes("usb_invalid_request")) return "invalid_request";
  return "connection_failed";
}

function captureFrame(bytes: Uint8Array, sequence: number, direction: HardwareProtocolFrameV1["direction"], timestamp: number) {
  return { sequence, direction, capturedAt: new Date(timestamp).toISOString(), bytesBase64: toBase64(bytes), digest: toHex(sha256(bytes)) };
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  const value = encodeBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
  return value.padEnd(Math.ceil(value.length / 4) * 4, "=");
}
