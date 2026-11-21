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
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceProfileV1,
  isDeviceVerificationResultV1,
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
  readonly requireCurrentProposal?: boolean;
  readonly onlyUnattendedReads?: boolean;
}

type DeviceDispatchAdmission =
  | { readonly kind: "replay"; readonly record: DeviceSupportStoreAttemptRecord }
  | {
      readonly kind: "dispatch";
      readonly attempt: DeviceTaskAttemptV1;
      readonly adapter: DeviceAdapter;
      readonly profile: DeviceProfileV1;
      readonly capability: CapabilityDescriptorV1;
    };

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
  private readonly activeDispatches = new Map<string, AbortController>();

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
    if (!isDeviceProfileV1(profile) || profile.device.ownerScope !== input.ownerId) {
      throw new DeviceBrokerError("permission_denied", "discovered device is outside the requested workspace");
    }
    this.registerDevice(adapterId, profile);
    await this.refreshCapabilities(profile.device.id, profile.device.profileRevision);
    return this.store.getDevice(profile.device.id) ?? profile;
  }

  registerDevice(adapterId: string, profile: DeviceProfileV1): void {
    const adapter = this.requireAdapter(adapterId);
    this.assertProfileSupported(adapter, profile);
    if (!this.store.registerDevice(profile, this.now())) {
      throw new DeviceBrokerError("permission_denied", "device registration is revoked or belongs to another workspace");
    }
  }

  async refreshCapabilities(deviceId: string, connectionRevision: string): Promise<DeviceCapabilitySnapshotV1> {
    const profile = this.requireDevice(deviceId);
    this.assertCapabilityRefreshAllowed(profile);
    const adapter = this.requireAdapter(profile.adapterId);
    const previousSnapshotId = this.store.getCurrentCapabilitySnapshot(deviceId)?.snapshotId;
    const snapshot = await adapter.getCapabilities({ profile, connectionRevision });
    if (!isDeviceCapabilitySnapshotV1(snapshot)
      || snapshot.deviceId !== deviceId
      || snapshot.adapterId !== profile.adapterId
      || snapshot.adapterVersion !== profile.adapterVersion
      || snapshot.connectionRevision !== connectionRevision) {
      throw new DeviceBrokerError("invalid_request", "adapter returned an invalid capability snapshot");
    }
    this.store.withWriteTransaction(() => {
      const current = this.requireDevice(deviceId);
      this.assertCapabilityRefreshAllowed(current);
      if (current.profileRevision !== profile.profileRevision
        || current.device.profileRevision !== profile.device.profileRevision
        || current.adapterId !== profile.adapterId || current.adapterVersion !== profile.adapterVersion
        || canonicalJson(current.connectionRefs) !== canonicalJson(profile.connectionRefs)
        || this.store.getCurrentCapabilitySnapshot(deviceId)?.snapshotId !== previousSnapshotId) {
        throw new DeviceBrokerError("target_changed", "device registration changed during capability refresh");
      }
      this.store.saveCapabilitySnapshot(snapshot, this.now());
    });
    return snapshot;
  }

  createTask(task: DeviceTaskV1): DeviceTaskV1 {
    return this.store.createTask(task.policyRevision ? task : { ...task, policyRevision: this.policyRevision }, this.now());
  }

  proposeAction(request: DeviceActionRequestV1): void {
    if (!isDeviceActionRequestV1(request)) throw new DeviceBrokerError("invalid_request", "device action request is invalid");
    this.requireTaskTarget(request);
    this.store.saveActionProposal(request, digestRequest(request), this.now());
  }

  async execute(request: DeviceActionRequestV1, signal?: AbortSignal, options: DeviceExecuteOptions = {}): Promise<DeviceSupportStoreAttemptRecord> {
    if (!isDeviceActionRequestV1(request)) {
      throw new DeviceBrokerError("invalid_request", "device action request is invalid");
    }
    const admission = this.store.withWriteTransaction(() => this.admitDispatch(request, signal, options));
    if (admission.kind === "replay") return admission.record;

    const { attempt, adapter, profile, capability } = admission;
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.activeDispatches.set(attempt.taskId, controller);
    try {
      let execution: DeviceActionResultV1 | DeviceAdapterExecutionResult;
      try {
        execution = await adapter.execute({ profile, capability, request, signal: operationSignal });
      } catch (error) {
        execution = uncertainActionResult(request.actionId, this.now(), error);
      }
      const result = execution && typeof execution === "object" && "action" in execution ? execution : undefined;
      const reported = result?.action ?? execution;
      const valid = isDeviceActionResultV1(reported) && reported.actionId === request.actionId;
      const action = valid ? reported : uncertainActionResult(request.actionId, this.now(), undefined);
      const observations = valid ? result?.observations ?? [] : [];
      const finalize = options.finalizeTask ?? true;
      const receipt = this.recordActionResult(attempt, action, observations, finalize, this.shouldVerify(capability, request));
      if (!receipt.verify) return receipt.record;

      const verification = await this.verifyAction(adapter, profile, capability, request, action, operationSignal);
      return this.store.withWriteTransaction(() => {
        const now = this.now();
        const record = this.store.updateAttempt(attempt.attemptId, { verification }, now);
        if (!this.isCurrentDispatch(attempt)) return record;
        const status = verification.status === "not_evaluable" && capability.sideEffect !== "read_only"
          ? "unknown"
          : verification.status === "verified" ? "succeeded" : "failed";
        if (finalize || status === "unknown") {
          this.store.transitionTask(attempt.taskId, status, { lastVerificationId: `${attempt.actionId}:verification` }, now);
        }
        return record;
      });
    } finally {
      this.activeDispatches.delete(attempt.taskId);
      this.store.releaseTargetLease(attempt.targetDeviceId, attempt.taskId, attempt.attemptId);
    }
  }

  cancelTask(taskId: string): DeviceTaskV1 {
    const task = this.store.stopDaemonTask(taskId, this.now());
    if (task.status === "unknown") this.activeDispatches.get(taskId)?.abort();
    return task;
  }

  private admitDispatch(request: DeviceActionRequestV1, signal: AbortSignal | undefined, options: DeviceExecuteOptions): DeviceDispatchAdmission {
    const task = this.requireTaskTarget(request);
    const requestDigest = digestRequest(request);
    const replay = this.store.getAttemptByIdempotency(request.taskId, request.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new DeviceBrokerError("invalid_request", "idempotency key is bound to another action");
      }
      if (options.requireCurrentProposal && (!request.approval
        || request.approvalId !== replay.attempt.approvalId
        || !replay.attempt.connectionRevision
        || !isApprovalForRequest(request.approval, request, replay.attempt.connectionRevision,
          replay.request.approval?.policyRevision ?? this.policyRevision, requestDigest))) {
        throw new DeviceBrokerError("permission_denied", "approval does not match the recorded device attempt");
      }
      return { kind: "replay", record: replay };
    }

    if (task.status === "unknown") throw new DeviceBrokerError("unknown_outcome", "task outcome requires reconciliation");
    if (!["planning", "awaiting_approval", "executing", "partial"].includes(task.status)) {
      throw new DeviceBrokerError("invalid_request", "task is not ready to dispatch");
    }
    const pending = this.store.getActiveAttempt(task.id);
    if (pending?.attempt.status === "unknown") {
      throw new DeviceBrokerError("unknown_outcome", "an earlier device attempt requires reconciliation");
    }
    if (this.store.getLeasedAttempt(task.id) || pending) {
      throw new DeviceBrokerError("target_busy", "task has an unresolved dispatch attempt");
    }
    signal?.throwIfAborted();
    const profile = this.requireDevice(request.targetDeviceId);
    if (["revoked", "retired", "offline"].includes(profile.device.lifecycleStatus)) {
      throw new DeviceBrokerError("device_offline", `device ${profile.device.id} is unavailable`);
    }
    const snapshot = this.store.getCurrentCapabilitySnapshot(profile.device.id);
    if (!snapshot || snapshot.snapshotId !== request.capabilitySnapshotId
      || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot is outside the current device registration");
    }
    if (Date.parse(snapshot.freshnessUntil) <= Date.parse(this.now())) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot has expired");
    }
    const capability = snapshot.capabilities.find(item => item.id === request.capabilityId);
    if (!capability || capability.schemaVersion !== request.capabilitySchemaVersion) {
      throw new DeviceBrokerError("unsupported_capability", "requested capability is not in the current snapshot");
    }
    if (options.onlyUnattendedReads && (capability.sideEffect !== "read_only" || capability.approvalClass !== "allow")) {
      throw new DeviceBrokerError("permission_denied", "the playbook requires an unattended read capability");
    }
    const adapter = this.requireAdapter(profile.adapterId);
    if (options.requireCurrentProposal) {
      const proposal = this.store.getActionProposal(task.id);
      if (task.status !== "awaiting_approval" || capability.sideEffect === "read_only"
        || proposal?.requestDigest !== requestDigest || proposal.request.idempotencyKey !== request.idempotencyKey) {
        throw new DeviceBrokerError("target_changed", "device action no longer awaits this approval");
      }
    }
    if (capability.sideEffect !== "read_only") {
      if (task.policyRevision && task.policyRevision !== this.policyRevision) {
        throw new DeviceBrokerError("target_changed", "device task policy has changed");
      }
      this.assertApproval(request, snapshot.connectionRevision, requestDigest);
    }

    const now = this.now();
    const attempt: DeviceTaskAttemptV1 = {
      attemptId: `${request.taskId}:${request.actionId}`,
      taskId: request.taskId,
      actionId: request.actionId,
      ownerKind: "daemon",
      ownerId: task.ownerId,
      targetDeviceId: profile.device.id,
      dispatchIntentAt: now,
      connectionRevision: snapshot.connectionRevision,
      requestDigest,
      ...(request.approvalId ? { approvalId: request.approvalId } : {}),
      status: "prepared",
    };
    if (!this.store.acquireTargetLease(profile.device.id, task.id, task.ownerId, now, this.leaseMs, attempt.attemptId)) {
      throw new DeviceBrokerError("target_busy", "device target is leased by another task");
    }
    this.store.createAttempt({ attempt, request, requestDigest }, now);
    this.store.transitionTask(task.id, "executing", { currentActionId: request.actionId }, now);
    const dispatched = this.store.updateAttempt(attempt.attemptId, { status: "dispatched" }, now);
    return { kind: "dispatch", attempt: dispatched.attempt, adapter, profile, capability };
  }

  private recordActionResult(
    attempt: DeviceTaskAttemptV1,
    action: DeviceActionResultV1,
    observations: readonly DeviceObservationV1[],
    finalize: boolean,
    requiresVerification: boolean,
  ): { readonly record: DeviceSupportStoreAttemptRecord; readonly verify: boolean } {
    return this.store.withWriteTransaction(() => {
      const now = this.now();
      for (const observation of observations) this.store.appendObservation(attempt.taskId, observation, now);
      if (!this.isCurrentDispatch(attempt)) {
        return { record: this.store.updateAttempt(attempt.attemptId, { receipt: action }, now), verify: false };
      }

      const status = action.status === "completed" ? "completed" : action.status === "rejected" ? "failed" : "unknown";
      const record = this.store.updateAttempt(attempt.attemptId, { status, receipt: action }, now);
      const verify = status === "completed" && requiresVerification;
      if (status === "unknown") {
        this.store.transitionTask(attempt.taskId, status, {}, now);
      } else if (finalize) {
        const outcome = verify ? "verifying" : status === "completed" ? "succeeded" : "failed";
        this.store.transitionTask(attempt.taskId, outcome, {}, now);
      }
      return { record, verify };
    });
  }

  private isCurrentDispatch(attempt: DeviceTaskAttemptV1): boolean {
    const task = this.store.getTask(attempt.taskId);
    return (task?.status === "executing" || task?.status === "verifying")
      && task.currentActionId === attempt.actionId
      && task.ownerKind === attempt.ownerKind
      && task.ownerId === attempt.ownerId
      && this.store.getLeasedAttempt(task.id)?.attempt.attemptId === attempt.attemptId;
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

  private assertCapabilityRefreshAllowed(profile: DeviceProfileV1): void {
    if (profile.device.lifecycleStatus === "revoked" || profile.device.lifecycleStatus === "retired") {
      throw new DeviceBrokerError("permission_denied", "device registration is no longer active");
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

  private requireTaskTarget(request: DeviceActionRequestV1): DeviceTaskV1 {
    const task = this.store.getTask(request.taskId);
    if (!task) throw new DeviceBrokerError("missing_target", "device task is missing");
    if (task.ownerKind !== "daemon" || !task.targetDeviceIds.includes(request.targetDeviceId)) {
      throw new DeviceBrokerError("permission_denied", "action exceeds the task's execution owner or target scope");
    }
    return task;
  }

  private shouldVerify(capability: CapabilityDescriptorV1, request: DeviceActionRequestV1): boolean {
    return capability.sideEffect !== "read_only" || capability.verificationCapabilityId !== undefined || request.expectedVerification !== undefined;
  }

  private async verifyAction(
    adapter: DeviceAdapter,
    profile: DeviceProfileV1,
    capability: CapabilityDescriptorV1,
    request: DeviceActionRequestV1,
    action: DeviceActionResultV1,
    signal?: AbortSignal,
  ): Promise<DeviceVerificationResultV1> {
    let reason = "adapter does not expose a verification operation";
    if (adapter.verify) {
      try {
        const verification = await adapter.verify({ profile, capability, request, action, signal });
        if (isDeviceVerificationResultV1(verification) && verification.actionId === request.actionId) return verification;
        reason = "adapter verification did not match the dispatched action";
      } catch {
        reason = "adapter verification did not return a result";
      }
    }
    return {
      actionId: request.actionId,
      status: "not_evaluable",
      rule: request.expectedVerification ?? null,
      observationIds: action.observationIds,
      checkedAt: this.now(),
      reason,
    };
  }
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
  const timeout = error instanceof Error && (error.name === "TimeoutError"
    || (error instanceof DeviceBrokerError && error.code === "timeout"));
  return {
    actionId,
    status: "uncertain",
    errorCode: timeout ? "timeout" : "unknown_outcome",
    redactedDetails: timeout ? "device action timed out" : "adapter did not return a valid action result",
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
