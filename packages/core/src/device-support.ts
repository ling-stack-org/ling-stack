import { createHash } from "node:crypto";

import {
  DEVICE_CONTRACT_MAJOR_V1,
  type AdapterManifestV1,
  type CapabilityDescriptorV1,
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceApprovalBindingV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceErrorCodeV1,
  type DeviceObservationV1,
  type DeviceProfileV1,
  type DeviceTaskAttemptV1,
  type DeviceTaskV1,
  type DeviceVerificationResultV1,
  isAdapterManifestV1,
  isDeviceActionRequestV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceProfileV1,
} from "@ling-stack/contracts";

import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";

export interface DeviceAdapterDiscoveryInput {
  readonly connectionRef: string;
  readonly ownerId: string;
  readonly signal?: AbortSignal;
}

export interface DeviceAdapter {
  readonly manifest: AdapterManifestV1;
  discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1>;
  getCapabilities(input: {
    readonly profile: DeviceProfileV1;
    readonly connectionRevision: string;
    readonly signal?: AbortSignal;
  }): Promise<DeviceCapabilitySnapshotV1>;
  execute(input: {
    readonly profile: DeviceProfileV1;
    readonly capability: CapabilityDescriptorV1;
    readonly request: DeviceActionRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult>;
  verify?(input: {
    readonly profile: DeviceProfileV1;
    readonly capability: CapabilityDescriptorV1;
    readonly request: DeviceActionRequestV1;
    readonly action: DeviceActionResultV1;
    readonly signal?: AbortSignal;
  }): Promise<DeviceVerificationResultV1>;
}

export interface DeviceAdapterExecutionResult {
  readonly action: DeviceActionResultV1;
  readonly observations?: readonly DeviceObservationV1[];
}

export interface DeviceSupportStoreAttemptRecord {
  readonly attempt: DeviceTaskAttemptV1;
  readonly request: DeviceActionRequestV1;
  readonly requestDigest: string;
}

export interface DeviceSupportBrokerOptions {
  readonly store: SqliteDeviceSupportStore;
  readonly now?: () => string;
  readonly leaseMs?: number;
  readonly policyRevision?: string;
}

export interface DeviceExecuteOptions {
  readonly finalizeTask?: boolean;
}

export class DeviceBrokerError extends Error {
  constructor(
    readonly code: DeviceErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "DeviceBrokerError";
  }
}

export class DeviceAdapterRegistry {
  #adapters = new Map<string, DeviceAdapter>();

  register(adapter: DeviceAdapter): void {
    if (!isAdapterManifestV1(adapter.manifest)) {
      throw new DeviceBrokerError("invalid_request", "adapter manifest is invalid");
    }
    if (adapter.manifest.contractMajor !== DEVICE_CONTRACT_MAJOR_V1) {
      throw new DeviceBrokerError("unsupported_contract", "adapter contract major is unsupported");
    }
    const existing = this.#adapters.get(adapter.manifest.adapterId);
    if (existing && existing.manifest.adapterVersion !== adapter.manifest.adapterVersion) {
      throw new DeviceBrokerError("target_changed", "adapter id is already registered at another version");
    }
    this.#adapters.set(adapter.manifest.adapterId, adapter);
  }

  get(adapterId: string): DeviceAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  list(): readonly DeviceAdapter[] {
    return [...this.#adapters.values()];
  }
}

export class DeviceCapabilityBroker {
  readonly adapters: DeviceAdapterRegistry;
  readonly store: SqliteDeviceSupportStore;
  readonly leaseMs: number;
  readonly policyRevision: string;
  readonly now: () => string;

  constructor(options: DeviceSupportBrokerOptions) {
    this.adapters = new DeviceAdapterRegistry();
    this.store = options.store;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.policyRevision = options.policyRevision ?? "device-policy-v1";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  registerAdapter(adapter: DeviceAdapter): void {
    this.adapters.register(adapter);
  }

  async discover(adapterId: string, input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const adapter = this.requireAdapter(adapterId);
    const profile = await adapter.discover(input);
    this.assertProfileSupported(adapter, profile);
    this.store.registerDevice(profile, this.now());
    await this.refreshCapabilities(profile.device.id, profile.device.profileRevision);
    return this.store.getDevice(profile.device.id) ?? profile;
  }

  registerDevice(adapterId: string, profile: DeviceProfileV1): void {
    const adapter = this.requireAdapter(adapterId);
    this.assertProfileSupported(adapter, profile);
    this.store.registerDevice(profile, this.now());
  }

  async refreshCapabilities(deviceId: string, connectionRevision: string): Promise<DeviceCapabilitySnapshotV1> {
    const profile = this.requireDevice(deviceId);
    const adapter = this.requireAdapter(profile.adapterId);
    const snapshot = await adapter.getCapabilities({ profile, connectionRevision });
    if (!isDeviceCapabilitySnapshotV1(snapshot)
      || snapshot.deviceId !== deviceId
      || snapshot.adapterId !== profile.adapterId
      || snapshot.adapterVersion !== profile.adapterVersion
      || snapshot.connectionRevision !== connectionRevision) {
      throw new DeviceBrokerError("invalid_request", "adapter returned an invalid capability snapshot");
    }
    this.store.saveCapabilitySnapshot(snapshot, this.now());
    return snapshot;
  }

  createTask(task: DeviceTaskV1): DeviceTaskV1 {
    return this.store.createTask(task.policyRevision ? task : { ...task, policyRevision: this.policyRevision }, this.now());
  }

  async execute(request: DeviceActionRequestV1, signal?: AbortSignal, options: DeviceExecuteOptions = {}): Promise<DeviceSupportStoreAttemptRecord> {
    if (!isDeviceActionRequestV1(request)) {
      throw new DeviceBrokerError("invalid_request", "device action request is invalid");
    }
    const requestDigest = digestRequest(request);
    const replay = this.store.getAttemptByIdempotency(request.taskId, request.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new DeviceBrokerError("invalid_request", "idempotency key is bound to another action");
      }
      return replay;
    }

    const profile = this.requireDevice(request.targetDeviceId);
    if (["revoked", "retired", "offline"].includes(profile.device.lifecycleStatus)) {
      throw new DeviceBrokerError("device_offline", `device ${profile.device.id} is unavailable`);
    }
    const snapshot = this.store.getCapabilitySnapshot(request.capabilitySnapshotId);
    if (!snapshot || snapshot.deviceId !== profile.device.id) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot is missing or targets another device");
    }
    if (Date.parse(snapshot.freshnessUntil) <= Date.parse(this.now())) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot has expired");
    }
    const capability = snapshot.capabilities.find(item => item.id === request.capabilityId);
    if (!capability || capability.schemaVersion !== request.capabilitySchemaVersion) {
      throw new DeviceBrokerError("unsupported_capability", "requested capability is not in the current snapshot");
    }
    if (capability.sideEffect !== "read_only") {
      this.assertApproval(request, snapshot.connectionRevision, requestDigest);
    }
    if (!this.store.acquireTargetLease(profile.device.id, request.taskId, this.policyRevision, this.now(), this.leaseMs)) {
      throw new DeviceBrokerError("target_busy", "device target is leased by another task");
    }

    const attempt: DeviceTaskAttemptV1 = {
      attemptId: `${request.taskId}:${request.actionId}`,
      taskId: request.taskId,
      actionId: request.actionId,
      ownerKind: "daemon",
      ownerId: profile.device.runtimeOwnerId ?? "daemon",
      targetDeviceId: profile.device.id,
      dispatchIntentAt: this.now(),
      status: "prepared",
    };
    const created = this.store.createAttempt({ attempt, request, requestDigest }, this.now());
    if (created.replayed) {
      this.store.releaseTargetLease(profile.device.id, request.taskId);
      if (created.record.requestDigest !== requestDigest) {
        throw new DeviceBrokerError("invalid_request", "idempotency key is bound to another action");
      }
      return created.record;
    }

    this.store.transitionTask(request.taskId, "executing", { currentActionId: request.actionId }, this.now());
    try {
      this.store.updateAttempt(attempt.attemptId, { status: "dispatched" }, this.now());
      let execution: DeviceActionResultV1 | DeviceAdapterExecutionResult;
      try {
        execution = await adapterExecute(this.requireAdapter(profile.adapterId), profile, capability, request, signal);
      } catch (error) {
        execution = uncertainActionResult(request.actionId, this.now(), error);
      }
      const action = "action" in execution ? execution.action : execution;
      if ("action" in execution) {
        for (const observation of execution.observations ?? []) this.store.appendObservation(request.taskId, observation, this.now());
      }
      const attemptStatus = action.status === "completed" ? "completed"
        : action.status === "uncertain" ? "unknown" : "failed";
      this.store.updateAttempt(attempt.attemptId, { status: attemptStatus, receipt: action }, this.now());
      if (action.status === "uncertain") {
        this.store.transitionTask(request.taskId, "unknown", {}, this.now());
        return this.store.getAttemptByIdempotency(request.taskId, request.idempotencyKey)!;
      }

      const finalizeTask = options.finalizeTask ?? true;
      if (action.status === "completed" && this.shouldVerify(capability, request)) {
        if (finalizeTask) this.store.transitionTask(request.taskId, "verifying", {}, this.now());
        const verification = await this.verifyAction(this.requireAdapter(profile.adapterId), profile, capability, request, action, signal);
        this.store.updateAttempt(attempt.attemptId, { verification }, this.now());
        if (finalizeTask) {
          this.store.transitionTask(request.taskId, verification.status === "verified" ? "succeeded" : "failed", {
            lastVerificationId: `${request.actionId}:verification`,
          }, this.now());
        }
      } else if (finalizeTask) {
        this.store.transitionTask(request.taskId, action.status === "completed" ? "succeeded" : "failed", {}, this.now());
      }
      return this.store.getAttemptByIdempotency(request.taskId, request.idempotencyKey)!;
    } finally {
      this.store.releaseTargetLease(profile.device.id, request.taskId);
    }
  }

  cancelTask(taskId: string): DeviceTaskV1 {
    const attempt = this.store.getActiveAttempt(taskId);
    if (attempt && (attempt.attempt.status === "dispatched" || attempt.attempt.status === "unknown")) {
      this.store.updateAttempt(attempt.attempt.attemptId, { status: "unknown" }, this.now());
      return this.store.transitionTask(taskId, "unknown", {}, this.now());
    }
    this.store.releaseTargetLease(attempt?.attempt.targetDeviceId ?? "", taskId);
    return this.store.transitionTask(taskId, "cancelled", {}, this.now());
  }

  private assertApproval(request: DeviceActionRequestV1, connectionRevision: string, requestDigest: string): void {
    const approval = request.approval;
    if (!approval || !isApprovalForRequest(approval, request, connectionRevision, this.policyRevision, requestDigest)
      || Date.parse(approval.expiresAt) <= Date.parse(this.now())) {
      throw new DeviceBrokerError("permission_denied", "mutating device action requires a current exact approval");
    }
  }

  private assertProfileSupported(adapter: DeviceAdapter, profile: DeviceProfileV1): void {
    if (!isDeviceProfileV1(profile) || profile.adapterId !== adapter.manifest.adapterId
      || profile.adapterVersion !== adapter.manifest.adapterVersion
      || !adapter.manifest.supportedDeviceKinds.includes(profile.device.kind)
      || profile.transports.some(transport => !adapter.manifest.supportedTransports.includes(transport))) {
      throw new DeviceBrokerError("unsupported_capability", "device profile is not supported by the adapter");
    }
  }

  private requireAdapter(adapterId: string): DeviceAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new DeviceBrokerError("unsupported_capability", `adapter ${adapterId} is not registered`);
    return adapter;
  }

  private requireDevice(deviceId: string): DeviceProfileV1 {
    const profile = this.store.getDevice(deviceId);
    if (!profile) throw new DeviceBrokerError("missing_target", `device ${deviceId} is not registered`);
    return profile;
  }

  private shouldVerify(capability: CapabilityDescriptorV1, request: DeviceActionRequestV1): boolean {
    return Boolean(capability.verificationCapabilityId || request.expectedVerification);
  }

  private async verifyAction(
    adapter: DeviceAdapter,
    profile: DeviceProfileV1,
    capability: CapabilityDescriptorV1,
    request: DeviceActionRequestV1,
    action: DeviceActionResultV1,
    signal?: AbortSignal,
  ): Promise<DeviceVerificationResultV1> {
    if (!adapter.verify) {
      return {
        actionId: request.actionId,
        status: "not_evaluable",
        rule: request.expectedVerification ?? null,
        observationIds: action.observationIds,
        checkedAt: this.now(),
        reason: "adapter does not expose a verification operation",
      };
    }
    return adapter.verify({ profile, capability, request, action, signal });
  }
}

async function adapterExecute(
  adapter: DeviceAdapter,
  profile: DeviceProfileV1,
  capability: CapabilityDescriptorV1,
  request: DeviceActionRequestV1,
  signal?: AbortSignal,
): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
  return adapter.execute({ profile, capability, request, signal });
}

function isApprovalForRequest(
  approval: DeviceApprovalBindingV1,
  request: DeviceActionRequestV1,
  connectionRevision: string,
  policyRevision: string,
  requestDigest: string,
): boolean {
  return approval.approvalId === request.approvalId
    && approval.taskId === request.taskId
    && approval.actionId === request.actionId
    && approval.targetDeviceId === request.targetDeviceId
    && approval.capabilitySnapshotId === request.capabilitySnapshotId
    && approval.connectionRevision === connectionRevision
    && approval.policyRevision === policyRevision
    && approval.normalizedInputDigest === requestDigest;
}

function uncertainActionResult(actionId: string, now: string, error: unknown): DeviceActionResultV1 {
  const detail = error instanceof Error ? error.message : "adapter execution failed";
  const errorCode: DeviceErrorCodeV1 = /timeout/i.test(detail) ? "timeout" : "unknown_outcome";
  return {
    actionId,
    status: "uncertain",
    errorCode,
    redactedDetails: detail.slice(0, 512),
    startedAt: now,
    finishedAt: now,
    observationIds: [],
  };
}

export function digestRequest(request: DeviceActionRequestV1): string {
  return createHash("sha256").update(canonicalJson({
    taskId: request.taskId,
    actionId: request.actionId,
    targetDeviceId: request.targetDeviceId,
    capabilityId: request.capabilityId,
    capabilitySchemaVersion: request.capabilitySchemaVersion,
    capabilitySnapshotId: request.capabilitySnapshotId,
    normalizedInput: request.normalizedInput,
    expectedVerification: request.expectedVerification ?? null,
  })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
