import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceActionResultV1,
  JsonValue,
} from "@ling-stack/contracts";
import type { DeviceAdapter, DeviceAdapterDiscoveryInput, DeviceAdapterExecutionResult } from "@ling-stack/core";

import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";

export interface ObdVehicleInfo { readonly vin?: string; readonly protocol?: string; readonly make?: string; readonly model?: string; }
export interface ObdExecutor {
  readVehicleInfo(signal?: AbortSignal): Promise<ObdVehicleInfo>;
  readPid(pid: string, signal?: AbortSignal): Promise<{ readonly pid: string; readonly value: number; readonly unit?: string }>;
  readDtc(signal?: AbortSignal): Promise<readonly string[]>;
}

const obdManifest: AdapterManifestV1 = {
  adapterId: "obd-diagnostics",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["vehicle"],
  supportedTransports: ["obd", "can"],
  transportDeployments: [{ transport: "obd", mode: "hardware_bridge", pairing: "user_confirmation", removal: "remove_hardware_bridge" }],
  requiredRuntime: "edge",
  authenticationMethods: ["hardware_bridge_pairing"],
  capabilities: [
    { id: "vehicle.inspect.info", schemaVersion: "1.0", semanticVerb: "inspect.vehicle", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["obd.read"], prerequisites: [], timeoutMs: 10_000, responseBytesLimit: 64 * 1024, idempotency: "request", supportedDeviceKinds: ["vehicle"], supportedTransports: ["obd", "can"] },
    { id: "vehicle.read.pid", schemaVersion: "1.0", semanticVerb: "read.vehicle_pid", inputSchema: { type: "object", required: ["pid"] }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["obd.read"], prerequisites: [], timeoutMs: 10_000, responseBytesLimit: 64 * 1024, idempotency: "request", supportedDeviceKinds: ["vehicle"], supportedTransports: ["obd", "can"] },
    { id: "vehicle.read.dtc", schemaVersion: "1.0", semanticVerb: "read.diagnostic_codes", inputSchema: { type: "object" }, outputSchema: { type: "array" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["obd.read"], prerequisites: [], timeoutMs: 15_000, responseBytesLimit: 64 * 1024, idempotency: "request", supportedDeviceKinds: ["vehicle"], supportedTransports: ["obd", "can"] },
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "OBD vehicle diagnostics", category: "vehicle" },
};

export class ObdVehicleAdapter implements DeviceAdapter {
  readonly manifest = obdManifest;
  readonly #executor: ObdExecutor;
  readonly #now: () => string;

  constructor(options: { readonly executor: ObdExecutor; readonly now?: () => string }) {
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const info = await this.#executor.readVehicleInfo(input.signal);
    const identity = info.vin ?? input.connectionRef;
    return { device: { id: `obd:${identity}`, ownerScope: input.ownerId, displayName: [info.make, info.model].filter(Boolean).join(" ") || "Vehicle", kind: "vehicle", vendor: info.make, model: info.model, serialHint: info.vin, lifecycleStatus: "healthy", profileRevision: `${identity}:${info.protocol ?? "unknown"}`, runtimeOwnerId: input.ownerId, lastSeenAt: this.#now() }, adapterId: this.manifest.adapterId, adapterVersion: this.manifest.adapterVersion, transports: ["obd"], connectionRefs: [input.connectionRef], transportDeployments: this.manifest.transportDeployments, profileRevision: `${identity}:${info.protocol ?? "unknown"}`, source: "adapter" };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly signal?: AbortSignal }): Promise<DeviceCapabilitySnapshotV1> {
    await this.#executor.readVehicleInfo(input.signal);
    return createAdapterCapabilitySnapshot(this.manifest, input, this.#now());
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    const args = asObject(input.request.normalizedInput);
    if (input.capability.id === "vehicle.inspect.info") return completedObservation(input, startedAt, await this.#executor.readVehicleInfo(input.signal) as unknown as JsonValue, "obd.vehicle");
    if (input.capability.id === "vehicle.read.pid") return completedObservation(input, startedAt, await this.#executor.readPid(requireString(args.pid, "pid"), input.signal) as unknown as JsonValue, "obd.pid");
    if (input.capability.id === "vehicle.read.dtc") return completedObservation(input, startedAt, { codes: await this.#executor.readDtc(input.signal) }, "obd.dtc");
    return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
  }
}

function completedObservation(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1 }, startedAt: string, value: JsonValue, source: string): DeviceAdapterExecutionResult {
  const observationId = `${input.request.actionId}:result`;
  const observation: DeviceObservationV1 = { id: observationId, subjectId: input.profile.device.id, source, value, observedAt: startedAt, receivedAt: startedAt, freshnessUntil: new Date(Date.parse(startedAt) + 30_000).toISOString(), quality: "good", provenance: [source, input.profile.device.id], redactionClass: "public" };
  return { action: { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [observationId] }, observations: [observation] };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OBD input must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
