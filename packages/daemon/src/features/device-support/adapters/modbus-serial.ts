import { createHash } from "node:crypto";
import type { AdapterManifestV1, DeviceObservationV1, DeviceProfileV1, JsonValue } from "@ling-stack/contracts";
import {
  DeviceBrokerError, modbusRtuRegisterCodec, type DeviceAdapter, type DeviceAdapterDiscoveryInput,
  type DevicePlaybookV1, type HardwareProtocolTransportRegistry, type HardwareProtocolWorkbench,
  type SqliteDeviceProtocolStore,
} from "@ling-stack/core";
import { modbusSerialAdapterId, type BoundModbusSerialTarget } from "../modbus-serial-targets.js";
import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";

const registerRead = "protocol.read_registers";
const captureBudgetMs = 4_000;
const captureSource = "modbus.rtu.read_registers";

const manifest: AdapterManifestV1 = {
  adapterId: modbusSerialAdapterId,
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["hardware"],
  supportedTransports: ["rs485"],
  transportDeployments: [{ transport: "rs485", mode: "hardware_bridge", pairing: "os_permission", removal: "disconnect_only" }],
  requiredRuntime: "pc",
  authenticationMethods: ["local_os_permission"],
  capabilities: [{
    id: registerRead, schemaVersion: "1.0", semanticVerb: "read.registers",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object" },
    sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["rs485.read"], prerequisites: [],
    timeoutMs: captureBudgetMs, responseBytesLimit: 4096, idempotency: "request",
    supportedDeviceKinds: ["hardware"], supportedTransports: ["rs485"],
  }],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "Modbus RTU serial", category: "hardware" },
};

export const modbusRegisterDiagnosis: DevicePlaybookV1 = {
  id: "modbus-register-diagnosis", version: "1.0.0", displayName: "Read configured Modbus registers",
  supportedDeviceKinds: ["hardware"], riskClass: "read_only", localFallback: true,
  steps: [{ id: "read-registers", capabilityId: registerRead, input: {} }],
};

export class ModbusSerialAdapter implements DeviceAdapter {
  readonly manifest = manifest;
  readonly #bindings: ReadonlyMap<string, BoundModbusSerialTarget>;

  constructor(private readonly options: {
    readonly targets: readonly BoundModbusSerialTarget[];
    readonly transports: HardwareProtocolTransportRegistry;
    readonly workbench: HardwareProtocolWorkbench;
    readonly protocolStore: SqliteDeviceProtocolStore;
    readonly now: () => string;
  }) {
    this.#bindings = new Map(options.targets.flatMap(binding => [
      [binding.profile.device.id, binding] as const,
      ...binding.profile.connectionRefs.map(connectionRef => [connectionRef, binding] as const),
    ]));
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const binding = this.#bindings.get(input.connectionRef);
    if (!binding || input.ownerId !== binding.profile.device.ownerScope) {
      throw new DeviceBrokerError("missing_target", "Modbus target is not configured for this owner");
    }
    input.signal?.throwIfAborted();
    return binding.profile;
  }

  async getCapabilities(input: Parameters<DeviceAdapter["getCapabilities"]>[0]) {
    const binding = this.#requireBinding(input.profile);
    if (input.connectionRevision !== binding.transport.connectionRevision) {
      throw new DeviceBrokerError("target_changed", "Modbus connection revision changed");
    }
    return createAdapterCapabilitySnapshot(this.manifest, input, this.options.now());
  }

  async execute(input: Parameters<DeviceAdapter["execute"]>[0]) {
    const { profile, request, capability, signal } = input;
    const binding = this.#requireBinding(profile);
    if (capability.id !== registerRead || request.normalizedInput === null || typeof request.normalizedInput !== "object"
      || Array.isArray(request.normalizedInput) || Object.keys(request.normalizedInput).length !== 0) {
      throw new DeviceBrokerError("invalid_request", "Modbus read uses its configured register range");
    }
    const { transports, workbench, protocolStore, now } = this.options;
    const startedAt = now();
    const captureId = `modbus:${createHash("sha256").update(JSON.stringify([request.taskId, request.actionId])).digest("hex")}`;
    const capture = protocolStore.saveCapture(await transports.capture({
      captureId, targetDeviceId: profile.device.id, transportId: binding.transport.transportId,
      createdAt: startedAt, durationMs: captureBudgetMs, maxFrames: 2, signal,
    }));
    const [requestFrame, reply] = workbench.decode(capture, modbusRtuRegisterCodec.manifest.codecId);
    const outcome = readResult(requestFrame, reply, capture.loss !== undefined);
    const { status } = outcome;
    const value: JsonValue = status === "read" ? {
      captureId, status, unitAddress: outcome.unitAddress, table: outcome.table,
      startAddress: outcome.startAddress, registers: outcome.registers,
    } : { captureId, status };
    const observedAt = now();
    const observation: DeviceObservationV1 = {
      id: `${request.actionId}:result`, subjectId: profile.device.id, source: captureSource,
      value, quality: status === "read" ? "good" : "degraded",
      observedAt, receivedAt: observedAt, freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
      provenance: [captureSource, profile.device.id, captureId], redactionClass: "public",
    };
    return {
      action: { actionId: request.actionId, startedAt, finishedAt: observedAt, observationIds: [observation.id],
        ...(status === "read" ? { status: "completed" as const } : { status: "rejected" as const }),
        ...(status === "incomplete_capture" ? { errorCode: "connection_failed" as const } : {}) },
      observations: [observation],
    };
  }

  #requireBinding(profile: DeviceProfileV1): BoundModbusSerialTarget {
    const binding = this.#bindings.get(profile.device.id);
    if (!binding || profile.profileRevision !== binding.profile.profileRevision
      || profile.connectionRefs[0] !== binding.transport.connectionRevision) {
      throw new DeviceBrokerError("target_changed", "Modbus target binding changed");
    }
    return binding;
  }
}

type DecodedFrame = ReturnType<HardwareProtocolWorkbench["decode"]>[number];

function readResult(request: DecodedFrame | undefined, reply: DecodedFrame | undefined, incomplete: boolean) {
  if (incomplete || !request || !reply) return { status: "incomplete_capture" } as const;
  if (reply.checksumValid === false) return { status: "invalid_checksum" } as const;
  if (request.messageType !== "read_registers_request" || request.fields.unitAddress !== reply.fields.unitAddress
    || request.fields.functionCode !== reply.fields.functionCode) return { status: "mismatched_response" } as const;
  if (reply.messageType === "exception_response") return { status: "device_exception" } as const;
  const { unitAddress, table, startAddress, quantity } = request.fields;
  if (reply.messageType !== "read_registers_response" || quantity !== reply.fields.quantity
    || typeof unitAddress !== "number" || (table !== "holding" && table !== "input")
    || typeof startAddress !== "number" || typeof quantity !== "number") return { status: "mismatched_response" } as const;
  const registers = Array.from({ length: quantity }, (_value, index) => reply.fields[`register${index}`]);
  if (!registers.every((value): value is number => typeof value === "number")) return { status: "mismatched_response" } as const;
  return { status: "read", unitAddress, table, startAddress, registers } as const;
}
