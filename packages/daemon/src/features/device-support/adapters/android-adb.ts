import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceActionResultV1,
  JsonValue,
} from "@ling-stack/contracts";
import { DeviceBrokerError, type DeviceAdapter, type DeviceAdapterDiscoveryInput, type DeviceAdapterExecutionResult,
  type DeviceAdapterVerificationInput, type DeviceAdapterVerificationResult } from "@ling-stack/core";

import { createAdapterCapabilitySnapshot } from "./capability-snapshot.js";

export interface AndroidPackageInfo { readonly packageId: string; readonly versionName?: string; readonly versionCode?: string; }
export interface AndroidAdbInventory {
  readonly serial: string;
  readonly model: string;
  readonly androidVersion?: string;
  readonly connectionRevision?: string;
}

export interface AndroidAdbTargetExecutor {
  inventory(signal?: AbortSignal): Promise<AndroidAdbInventory>;
  readPackages(signal?: AbortSignal, connectionRevision?: string): Promise<readonly AndroidPackageInfo[]>;
  readLogs?(input: { readonly tag?: string; readonly signal?: AbortSignal }): Promise<string>;
  installArtifact?(input: { readonly artifactDigest: string; readonly packageId?: string; readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean; readonly packageId?: string; readonly versionName?: string }>;
  reboot?(signal?: AbortSignal): Promise<{ readonly accepted: boolean }>;
}

export type AndroidAdbExecutor = Required<AndroidAdbTargetExecutor>;

export interface AndroidAdbTarget {
  readonly connectionRef: string;
  readonly kind: "android" | "head_unit";
  readonly executor: AndroidAdbTargetExecutor;
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
  readonly #bridge?: AndroidAdbExecutor;
  readonly #targets: ReadonlyMap<string, AndroidAdbTarget>;
  readonly #now: () => string;

  constructor(options: { readonly executor?: AndroidAdbExecutor; readonly targets?: readonly AndroidAdbTarget[]; readonly now?: () => string }) {
    this.#bridge = options.executor;
    this.#targets = new Map(options.targets?.map(target => [target.connectionRef, target]));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const { executor, kind } = this.#connection(input.connectionRef);
    const inventory = await executor.inventory(input.signal);
    const profileRevision = inventoryRevision(inventory);
    return {
      device: { id: `adb:${inventory.serial}`, ownerScope: input.ownerId, displayName: inventory.model || "Android device", kind,
        vendor: "Android", model: inventory.model, firmwareVersion: inventory.androidVersion, lifecycleStatus: "healthy",
        profileRevision, runtimeOwnerId: input.ownerId, lastSeenAt: this.#now() },
      adapterId: this.manifest.adapterId,
      adapterVersion: this.manifest.adapterVersion,
      transports: ["adb"],
      connectionRefs: [input.connectionRef],
      transportDeployments: this.manifest.transportDeployments,
      profileRevision,
      source: "adapter",
    };
  }

  async getCapabilities(input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string; readonly signal?: AbortSignal }): Promise<DeviceCapabilitySnapshotV1> {
    const executor = this.#connection(input.profile.connectionRefs[0]).executor;
    await this.#inventory(input.profile, executor, input.signal);
    if (input.connectionRevision !== input.profile.device.profileRevision) {
      throw new DeviceBrokerError("target_changed", "Android ADB connection revision changed");
    }
    const snapshot = createAdapterCapabilitySnapshot(this.manifest, input, this.#now());
    return { ...snapshot, capabilities: snapshot.capabilities.filter(({ id }) =>
      id === "android.inspect.device" || id === "android.inspect.packages"
      || (id === "android.capture.logs" && executor.readLogs)
      || (id === "android.install.artifact" && executor.installArtifact)
      || (id === "android.reboot" && executor.reboot)) };
  }

  async execute(input: { readonly profile: DeviceProfileV1; readonly capability: { readonly id: string }; readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const startedAt = this.#now();
    const args = asObject(input.request.normalizedInput);
    const executor = this.#connection(input.profile.connectionRefs[0]).executor;
    if (input.capability.id === "android.inspect.device" || input.capability.id === "android.inspect.packages") {
      try {
        const { model, androidVersion } = await this.#inventory(input.profile, executor, input.signal);
        if (input.capability.id === "android.inspect.device") {
          return completedObservation(input, startedAt, { model, ...(androidVersion ? { androidVersion } : {}) }, "android.device");
        }
        const packages = await executor.readPackages(input.signal, input.profile.device.profileRevision);
        return completedObservation(input, startedAt, { packages: packages.map(item => ({ ...item })) }, "android.packages");
      } catch (error) {
        if (!(error instanceof DeviceBrokerError)) throw error;
        return { actionId: input.request.actionId, status: "rejected", errorCode: error.code,
          startedAt, finishedAt: this.#now(), observationIds: [] };
      }
    }
    if (input.capability.id === "android.capture.logs" && executor.readLogs) {
      await this.#inventory(input.profile, executor, input.signal);
      const logs = await executor.readLogs({ tag: typeof args.tag === "string" ? args.tag : undefined, signal: input.signal });
      return completedObservation(input, startedAt, { text: logs.slice(0, 200_000) }, "android.logcat");
    }
    if (input.capability.id === "android.install.artifact" && executor.installArtifact) {
      const artifactDigest = requireString(args.artifactDigest, "artifactDigest");
      const packageId = requirePackageId(args.packageId);
      await this.#inventory(input.profile, executor, input.signal);
      const result = await executor.installArtifact({ artifactDigest, packageId, signal: input.signal });
      if (result.accepted && result.packageId !== undefined && result.packageId !== packageId) {
        return { actionId: input.request.actionId, status: "rejected", errorCode: "target_changed", startedAt, finishedAt: this.#now(), observationIds: [] };
      }
      return { actionId: input.request.actionId, status: result.accepted ? "completed" : "rejected", errorCode: result.accepted ? undefined : "permission_denied", startedAt, finishedAt: this.#now(), observationIds: [] };
    }
    if (input.capability.id === "android.reboot" && executor.reboot) {
      await this.#inventory(input.profile, executor, input.signal);
      const result = await executor.reboot(input.signal);
      return { actionId: input.request.actionId, status: result.accepted ? "completed" : "rejected", errorCode: result.accepted ? undefined : "service_unavailable", startedAt, finishedAt: this.#now(), observationIds: [] };
    }
    return { actionId: input.request.actionId, status: "rejected", errorCode: "unsupported_capability", startedAt, finishedAt: this.#now(), observationIds: [] };
  }

  async verify({ request, profile, evidenceId, signal }: DeviceAdapterVerificationInput): Promise<DeviceAdapterVerificationResult> {
    if (request.capabilityId !== "android.install.artifact") {
      return { verification: { actionId: request.actionId, status: "not_evaluable", rule: request.expectedVerification ?? null, observationIds: [],
        checkedAt: this.#now(), reason: "no verification rule for this action" } };
    }
    const packageId = requirePackageId(asObject(request.normalizedInput).packageId);
    const rule = request.expectedVerification ?? { packageId };
    const verificationRule = asObject(rule);
    if (Object.keys(verificationRule).length !== 1 || (verificationRule.packageId !== packageId)) {
      return { verification: { actionId: request.actionId, status: "not_evaluable", rule, observationIds: [],
        checkedAt: this.#now(), reason: "readback requires the approved package ID" } };
    }
    const executor = this.#connection(profile.connectionRefs[0]).executor;
    await this.#inventory(profile, executor, signal);
    const installed = (await executor.readPackages(signal, profile.device.profileRevision)).find(item => item.packageId === packageId);
    const checkedAt = this.#now();
    const value = { packageId, present: installed !== undefined };
    return {
      verification: { actionId: request.actionId, status: installed ? "verified" : "failed", rule,
        observationIds: [evidenceId], checkedAt },
      observations: [androidObservation(profile.device.id, evidenceId, checkedAt, value, "android.packages")],
    };
  }

  #connection(connectionRef: string | undefined): Pick<AndroidAdbTarget, "executor" | "kind"> {
    const target = connectionRef !== undefined && this.#targets.get(connectionRef);
    if (target) return target;
    if (this.#bridge && connectionRef && !connectionRef.startsWith("adb-target:")) return { executor: this.#bridge, kind: "head_unit" };
    throw new DeviceBrokerError("missing_target", "Android ADB connection is unavailable");
  }

  async #inventory(profile: DeviceProfileV1, executor: AndroidAdbTargetExecutor, signal?: AbortSignal): Promise<AndroidAdbInventory> {
    const inventory = await executor.inventory(signal);
    if (profile.device.id !== `adb:${inventory.serial}` || profile.device.profileRevision !== inventoryRevision(inventory)) {
      throw new DeviceBrokerError("target_changed", "authorized Android target or connection changed");
    }
    return inventory;
  }
}

function inventoryRevision(inventory: AndroidAdbInventory): string {
  return inventory.connectionRevision ?? `${inventory.serial}:${inventory.androidVersion ?? "unknown"}`;
}

function completedObservation(input: { readonly profile: DeviceProfileV1; readonly request: DeviceActionRequestV1 }, startedAt: string, value: JsonValue, source: string): DeviceAdapterExecutionResult {
  const observationId = `${input.request.actionId}:result`;
  const observation = androidObservation(input.profile.device.id, observationId, startedAt, value, source);
  return { action: { actionId: input.request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [observationId] }, observations: [observation] };
}

function androidObservation(deviceId: string, id: string, observedAt: string, value: JsonValue, source: string): DeviceObservationV1 {
  return { id, subjectId: deviceId, source, value, observedAt, receivedAt: observedAt,
    freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(), quality: "good",
    provenance: [source, deviceId], redactionClass: source === "android.logcat" ? "sensitive" : "public" };
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
