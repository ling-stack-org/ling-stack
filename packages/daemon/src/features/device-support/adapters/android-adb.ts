import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceActionResultV1,
  DeviceVerificationResultV1,
  JsonValue,
} from "@ling-stack/contracts";
import type { DeviceAdapter, DeviceAdapterDiscoveryInput, DeviceAdapterExecutionResult } from "@ling-stack/core";

import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";

export interface AndroidPackageInfo { readonly packageId: string; readonly versionName?: string; readonly versionCode?: string; }
export interface AndroidAdbExecutor {
  inventory(signal?: AbortSignal): Promise<{ readonly serial: string; readonly model: string; readonly androidVersion?: string }>;
  readPackages(signal?: AbortSignal): Promise<readonly AndroidPackageInfo[]>;
  readLogs(input: { readonly tag?: string; readonly signal?: AbortSignal }): Promise<string>;
  installArtifact(input: { readonly artifactDigest: string; readonly packageId?: string; readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean; readonly packageId?: string; readonly versionName?: string }>;
  reboot(signal?: AbortSignal): Promise<{ readonly accepted: boolean }>;
}

const androidAdbManifest: AdapterManifestV1 = {
  adapterId: "android-adb",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["android", "head_unit"],
  supportedTransports: ["adb"],
  transportDeployments: [{ transport: "adb", mode: "none", pairing: "os_permission", removal: "disconnect_only" }],
  requiredRuntime: "pc",
  authenticationMethods: ["adb_user_authorization"],
  capabilities: [
    { id: "android.inspect.device", schemaVersion: "1.0", semanticVerb: "inspect.device", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["adb.read"], prerequisites: [], timeoutMs: 10_000, responseBytesLimit: 64 * 1024, idempotency: "request", supportedDeviceKinds: ["android", "head_unit"], supportedTransports: ["adb"] },
    { id: "android.inspect.packages", schemaVersion: "1.0", semanticVerb: "inspect.packages", inputSchema: { type: "object" }, outputSchema: { type: "array" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["adb.read"], prerequisites: [], timeoutMs: 15_000, responseBytesLimit: 256 * 1024, idempotency: "request", supportedDeviceKinds: ["android", "head_unit"], supportedTransports: ["adb"] },
    { id: "android.capture.logs", schemaVersion: "1.0", semanticVerb: "capture.logs", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["adb.read"], prerequisites: [], timeoutMs: 15_000, responseBytesLimit: 256 * 1024, idempotency: "request", supportedDeviceKinds: ["android", "head_unit"], supportedTransports: ["adb"] },
    { id: "android.install.artifact", schemaVersion: "1.0", semanticVerb: "deploy.artifact", inputSchema: { type: "object", required: ["artifactDigest", "packageId"] }, outputSchema: { type: "object" }, sideEffect: "reversible", approvalClass: "ask", requiredPermissions: ["adb.install"], prerequisites: [], timeoutMs: 60_000, responseBytesLimit: 64 * 1024, idempotency: "target_revision", verificationCapabilityId: "android.inspect.packages", supportedDeviceKinds: ["android", "head_unit"], supportedTransports: ["adb"] },
    { id: "android.reboot", schemaVersion: "1.0", semanticVerb: "restart.device", inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "mutating", approvalClass: "ask", requiredPermissions: ["adb.reboot"], prerequisites: [], timeoutMs: 30_000, responseBytesLimit: 16 * 1024, idempotency: "request", supportedDeviceKinds: ["android", "head_unit"], supportedTransports: ["adb"] },
  ],
  removalBehavior: "revoke_and_disconnect",
  displayMetadata: { label: "Android / head-unit ADB", category: "vehicle" },
};

export class AndroidAdbAdapter implements DeviceAdapter {
  readonly manifest = androidAdbManifest;
  readonly #executor: AndroidAdbExecutor;
  readonly #now: () => string;

  constructor(options: { readonly executor: AndroidAdbExecutor; readonly now?: () => string }) {
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const inventory = await this.#executor.inventory(input.signal);
    return {
      device: { id: `adb:${inventory.serial}`, ownerScope: input.ownerId, displayName: inventory.model || "Android head unit", kind: "head_unit", vendor: "Android", model: inventory.model, firmwareVersion: inventory.androidVersion, lifecycleStatus: "healthy", profileRevision: `${inventory.serial}:${inventory.androidVersion ?? "unknown"}`, runtimeOwnerId: input.ownerId, lastSeenAt: this.#now() },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["adb"],
      connectionRefs: [input.connectionRef],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision: `${inventory.serial}:${inventory.androidVersion ?? "unknown"}`,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly signal?: AbortSignal }): Promise<DeviceCapabilitySnapshotV1> {
    await this.#executor.inventory(input.signal);
    return createAdapterCapabilitySnapshot(this.manifest, input, this.#now());
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    const args = asObject(input.request.normalizedInput);
    if (input.capability.id === "android.inspect.device") {
      const value = await this.#executor.inventory(input.signal);
      return completedObservation(input, startedAt, value as unknown as JsonValue, "android.device");
    }
    if (input.capability.id === "android.inspect.packages") {
      const value = await this.#executor.readPackages(input.signal);
      return completedObservation(input, startedAt, { packages: value } as unknown as JsonValue, "android.packages");
    }
    if (input.capability.id === "android.capture.logs") {
      const logs = await this.#executor.readLogs({ tag: typeof args.tag === "string" ? args.tag : undefined, signal: input.signal });
      return completedObservation(input, startedAt, { text: logs.slice(0, 200_000) }, "android.logcat");
    }
    if (input.capability.id === "android.install.artifact") {
      const artifactDigest = requireString(args.artifactDigest, "artifactDigest");
      const packageId = requirePackageId(args.packageId);
      const result = await this.#executor.installArtifact({ artifactDigest, packageId, signal: input.signal });
      if (result.accepted && result.packageId !== undefined && result.packageId !== packageId) {
        return { actionId: input.request.actionId, status: "rejected", errorCode: "target_changed", startedAt, finishedAt: this.#now(), observationIds: [] };
      }
      return { actionId: input.request.actionId, status: result.accepted ? "completed" : "rejected", errorCode: result.accepted ? undefined : "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    }
    if (input.capability.id === "android.reboot") {
      const result = await this.#executor.reboot(input.signal);
      return { actionId: input.request.actionId, status: result.accepted ? "completed" : "rejected", errorCode: result.accepted ? undefined : "service_unavailable", startedAt, finishedAt: this.#now(), observationIds: [] };
    }
    return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1 }): Promise<DeviceVerificationResultV1> {
    if (input.request.capabilityId !== "android.install.artifact") return { actionId: input.request.actionId, status: "not_evaluable", rule: input.request.expectedVerification ?? null, observationIds: input.action.observationIds, checkedAt: this.#now(), reason: "no verification rule for this action" };
    const packages = await this.#executor.readPackages();
    const args = asObject(input.request.normalizedInput);
    const packageId = requirePackageId(args.packageId);
    const found = packages.some(item => item.packageId === packageId);
    const rule = input.request.expectedVerification ?? { packageId };
    return { actionId: input.request.actionId, status: found ? "verified" : "failed", rule, observationIds: [], checkedAt: this.#now(), reason: found ? undefined : "installed package was not found" };
  }
}

function completedObservation(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1 }, startedAt: string, value: JsonValue, source: string): DeviceAdapterExecutionResult {
  const observationId = `${input.request.actionId}:result`;
  const observation: DeviceObservationV1 = { id: observationId, subjectId: input.profile.device.id, source, value, observedAt: startedAt, receivedAt: startedAt, freshnessUntil: new Date(Date.parse(startedAt) + 30_000).toISOString(), quality: "good", provenance: [source, input.profile.device.id], redactionClass: "public" };
  return { action: { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [observationId] }, observations: [observation] };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Android ADB input must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function requirePackageId(value: unknown): string {
  const packageId = requireString(value, "packageId");
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,}$/.test(packageId)) throw new Error("packageId is invalid");
  return packageId;
}
