import { createHash, randomUUID } from "node:crypto";

import {
  DEVICE_CONTRACT_MAJOR_V1,
  type AdapterManifestV1,
  type CapabilityDescriptorV1,
  type DeviceAccessGrantV1,
  type DeviceActionAuthorityV1,
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceApprovalBindingV1,
  type DeviceApprovalPrincipalV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceDispatchStopV1,
  type DeviceErrorCodeV1,
  type DeviceObservationV1,
  type DevicePlanningNodeRefV1,
  type DeviceProfileV1,
  type DeviceTaskAttemptV1,
  type DeviceTaskReconciliationV1,
  type DeviceTaskV1,
  type DeviceVerificationResultV1,
  isAdapterManifestV1,
  isDeviceActionRequestV1,
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceProfileV1,
  isDeviceVerificationResultV1,
} from "@ling-stack/contracts";

import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";
import type { DeviceAccessManager } from "./device-access.js";
import { DeviceFabricError } from "./device-fabric.js";

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
  verify?(input: DeviceAdapterVerificationInput): Promise<DeviceVerificationResultV1 | DeviceAdapterVerificationResult>;
}

export interface DeviceAdapterVerificationInput {
  readonly profile: DeviceProfileV1;
  readonly capability: CapabilityDescriptorV1;
  readonly request: DeviceActionRequestV1;
  readonly action: DeviceActionResultV1;
  readonly evidenceId: string;
  readonly signal?: AbortSignal;
}

export interface DeviceAdapterVerificationResult {
  readonly verification: DeviceVerificationResultV1;
  readonly observations?: readonly DeviceObservationV1[];
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
  readonly accessManager?: DeviceAccessManager;
  readonly now?: () => string;
  readonly leaseMs?: number;
  readonly policyRevision?: string;
}

export interface DeviceExecuteOptions {
  readonly finalizeTask?: boolean;
  readonly requireCurrentProposal?: boolean;
  readonly onlyUnattendedReads?: boolean;
  readonly planningNode?: DevicePlanningNodeRefV1;
  readonly approvalPrincipal?: DeviceApprovalPrincipalV1;
}

type DeviceDispatchAdmission =
  | { readonly kind: "replay"; readonly record: DeviceSupportStoreAttemptRecord }
  | (DeviceCapabilityBinding & {
      readonly kind: "dispatch";
      readonly attempt: DeviceTaskAttemptV1;
    });

interface DeviceCapabilityBinding {
  readonly adapter: DeviceAdapter;
  readonly profile: DeviceProfileV1;
  readonly capability: CapabilityDescriptorV1;
  readonly snapshot: DeviceCapabilitySnapshotV1;
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
  readonly accessManager?: DeviceAccessManager;
  private readonly activeDispatches = new Map<string, AbortController>();

  constructor(options: DeviceSupportBrokerOptions) {
    this.adapters = new DeviceAdapterRegistry();
    this.store = options.store;
    this.accessManager = options.accessManager;
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

  async refreshCapabilities(deviceId: string, connectionRevision: string, signal?: AbortSignal): Promise<DeviceCapabilitySnapshotV1> {
    const profile = this.requireDevice(deviceId);
    this.assertCapabilityRefreshAllowed(profile);
    const adapter = this.requireAdapter(profile.adapterId);
    const previousSnapshotId = this.store.getCurrentCapabilitySnapshot(deviceId)?.snapshotId;
    signal?.throwIfAborted();
    const snapshot = await adapter.getCapabilities({ profile, connectionRevision, signal });
    signal?.throwIfAborted();
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
        || current.device.ownerScope !== profile.device.ownerScope
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
        operationSignal.throwIfAborted();
        if (capability.sideEffect !== "read_only" && this.store.getDispatchStop(attempt.targetDeviceId).active) {
          throw new DeviceBrokerError("permission_denied", "device dispatch is stopped");
        }
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
      const receipt = this.recordActionResult(attempt, request.capabilitySnapshotId, capability, action, observations, finalize, this.shouldVerify(capability, request));
      if (!receipt.verify) return receipt.record;

      const evidenceId = `${attempt.actionId}:verification`;
      const { verification, observations: readback } = await this.verifyAction({
        adapter, profile, capability, request, action, evidenceId, signal: operationSignal,
      });
      return this.store.withWriteTransaction(() => {
        const now = this.now();
        for (const observation of readback ?? []) this.store.appendObservation(attempt.taskId, observation, now);
        const current = this.retainDispatchAuthority(attempt, request.capabilitySnapshotId, capability, now);
        const record = this.store.updateAttempt(attempt.attemptId, { verification, ...(current ? {} : { status: "unknown" }) }, now);
        if (!current) return record;
        const status = verification.status === "not_evaluable" && capability.sideEffect !== "read_only"
          ? "unknown"
          : verification.status === "verified" ? "succeeded" : "failed";
        if (finalize || status === "unknown") {
          this.store.transitionTask(attempt.taskId, status, { lastVerificationId: evidenceId }, now);
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

  setDispatchStop(input: {
    readonly deviceId: string;
    readonly workspaceId: string;
    readonly active: boolean;
    readonly expectedRevision: number;
  }): DeviceDispatchStopV1 {
    const { stop, stoppingTaskId } = this.store.setDispatchStop({ ...input, now: this.now() });
    if (stoppingTaskId) this.activeDispatches.get(stoppingTaskId)?.abort();
    return stop;
  }

  getReconciliationPreview(taskId: string): { attemptId: string; targetDeviceId: string; capabilitySnapshotId: string } | undefined {
    const task = this.store.getTask(taskId);
    if (task?.status !== "unknown" || task.ownerKind !== "daemon" || this.store.getLeasedAttempt(taskId)) return undefined;
    const record = task.currentActionId
      ? this.store.getAttempt(taskId, `${taskId}:${task.currentActionId}`)
      : this.store.getActiveAttempt(taskId);
    if (!record || record.attempt.ownerId !== task.ownerId || !task.targetDeviceIds.includes(record.attempt.targetDeviceId)) return undefined;
    const snapshot = this.store.getCurrentCapabilitySnapshot(record.attempt.targetDeviceId);
    if (!snapshot) return undefined;
    try {
      const binding = this.resolveCapability({ ...record.request, capabilitySnapshotId: snapshot.snapshotId }, true);
      const reader = this.requireReconciliationReader(binding);
      this.taskAccessGrant(task, record.attempt.targetDeviceId, reader);
    } catch (error) {
      if (error instanceof DeviceBrokerError) return undefined;
      throw error;
    }
    return { attemptId: record.attempt.attemptId, targetDeviceId: record.attempt.targetDeviceId, capabilitySnapshotId: snapshot.snapshotId };
  }

  async reconcileTask(input: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly capabilitySnapshotId: string;
    readonly signal?: AbortSignal;
    readonly refreshExpiredSnapshot?: boolean;
  }): Promise<DeviceTaskReconciliationV1> {
    const { attempt, request: admittedRequest, binding: admittedBinding, reader: admittedReader, grantRevision } = this.store.withWriteTransaction(() => {
      const record = this.store.getAttempt(input.taskId, input.attemptId);
      if (!record) throw new DeviceBrokerError("invalid_request", "the device attempt does not belong to this task");
      const task = this.requireTaskTarget(record.request);
      const actionId = task.currentActionId ?? this.store.getActiveAttempt(task.id)?.attempt.actionId;
      if (task.status !== "unknown" || record.attempt.actionId !== actionId || record.attempt.ownerId !== task.ownerId) {
        throw new DeviceBrokerError("invalid_request", "task has no matching outcome to reconcile");
      }
      const request = { ...record.request, capabilitySnapshotId: input.capabilitySnapshotId };
      const binding = this.resolveCapability(request, input.refreshExpiredSnapshot);
      const reader = this.requireReconciliationReader(binding);
      const grantRevision = this.taskAccessGrant(task, request.targetDeviceId, reader)?.revision;
      input.signal?.throwIfAborted();
      if (this.store.getLeasedAttempt(task.id)
        || !this.store.acquireTargetLease(request.targetDeviceId, task.id, task.ownerId, this.now(), this.leaseMs, record.attempt.attemptId)) {
        throw new DeviceBrokerError("target_busy", "device target is busy");
      }
      return { attempt: record.attempt, request, binding, reader, grantRevision };
    });

    const controller = new AbortController();
    const deadline = AbortSignal.timeout(admittedReader.timeoutMs);
    const signal = AbortSignal.any(input.signal ? [input.signal, controller.signal, deadline] : [controller.signal, deadline]);
    this.activeDispatches.set(attempt.taskId, controller);
    const reconciliationId = `device_reconciliation_${randomUUID()}`;
    try {
      let request = admittedRequest;
      let binding = admittedBinding;
      let reader = admittedReader;
      if (Date.parse(binding.snapshot.freshnessUntil) <= Date.parse(this.now())) {
        if (!input.refreshExpiredSnapshot) throw new DeviceBrokerError("stale_snapshot", "capability snapshot has expired");
        const snapshot = await this.refreshCapabilities(attempt.targetDeviceId, binding.snapshot.connectionRevision, signal);
        request = { ...request, capabilitySnapshotId: snapshot.snapshotId };
        binding = this.resolveCapability(request);
        reader = this.requireReconciliationReader(binding);
      }
      signal.throwIfAborted();
      const task = this.requireTaskTarget(request);
      const grant = this.taskAccessGrant(task, attempt.targetDeviceId, reader);
      if (grant?.revision !== grantRevision) {
        throw new DeviceBrokerError("permission_denied", "device readback access grant changed");
      }
      const authority = this.actionAuthority(binding.profile.device.ownerScope, this.store.getDispatchStop(attempt.targetDeviceId), grant);
      const readbackStartedAt = this.now();
      const result = await this.verifyAction({
        ...binding,
        request,
        action: attempt.receipt ?? uncertainActionResult(attempt.actionId, attempt.dispatchIntentAt, undefined),
        evidenceId: reconciliationId,
        signal,
      });
      return this.store.withWriteTransaction(() => {
        const now = this.now();
        const current = this.store.getTask(attempt.taskId);
        const profile = this.store.getDevice(attempt.targetDeviceId);
        const observations = result.observations ?? [];
        const observed = observations.some(observation => observation.id === reconciliationId
          && observation.redactionClass === "public" && (observation.quality === "good" || observation.quality === "degraded")
          && Date.parse(observation.observedAt) >= Date.parse(readbackStartedAt)
          && Date.parse(observation.observedAt) <= Date.parse(now) && Date.parse(observation.freshnessUntil) > Date.parse(now));
        const verified = !signal.aborted && observed && result.verification.status === "verified"
          && current?.status === "unknown" && profile !== undefined
          && current.ownerKind === attempt.ownerKind && current.ownerId === attempt.ownerId
          && this.taskAccessIsCurrent(current, attempt.targetDeviceId, reader, grantRevision)
          && (current.currentActionId === undefined || current.currentActionId === attempt.actionId)
          && profile.device.ownerScope === binding.profile.device.ownerScope
          && !["offline", "revoked", "retired"].includes(profile.device.lifecycleStatus)
          && Date.parse(binding.snapshot.freshnessUntil) > Date.parse(now)
          && this.store.getCurrentCapabilitySnapshot(attempt.targetDeviceId)?.snapshotId === binding.snapshot.snapshotId
          && this.store.getLeasedAttempt(attempt.taskId)?.attempt.attemptId === attempt.attemptId;
        const verification = verified || result.verification.status !== "verified"
          ? result.verification
          : {
              ...result.verification,
              status: "not_evaluable" as const,
              reason: "fresh readback evidence was not accepted",
            };
        const record: DeviceTaskReconciliationV1 = {
          reconciliationId,
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          capabilitySnapshotId: binding.snapshot.snapshotId,
          connectionRevision: binding.snapshot.connectionRevision,
          readCapabilityId: reader.id,
          authority,
          verification,
          status: verified ? "verified" : "unresolved",
          recordedAt: now,
        };
        for (const observation of observations) this.store.appendObservation(attempt.taskId, observation, now);
        this.store.recordReconciliation(record);
        return record;
      });
    } finally {
      this.activeDispatches.delete(attempt.taskId);
      this.store.releaseTargetLease(attempt.targetDeviceId, attempt.taskId, attempt.attemptId);
    }
  }

  private requireReconciliationReader(binding: DeviceCapabilityBinding): CapabilityDescriptorV1 {
    const reader = binding.snapshot.capabilities.find(item => item.id === binding.capability.verificationCapabilityId);
    if (!binding.adapter.verify || !reader || reader.sideEffect !== "read_only" || reader.approvalClass !== "allow") {
      throw new DeviceBrokerError("unsupported_capability", "device action has no current authorized verification capability");
    }
    return reader;
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
    const binding = this.resolveCapability(request);
    const { profile, snapshot, capability } = binding;
    const dispatchStop = this.store.getDispatchStop(profile.device.id);
    if (capability.sideEffect !== "read_only" && dispatchStop.active) {
      throw new DeviceBrokerError("permission_denied", "device dispatch is stopped");
    }
    const planningNode = options.planningNode;
    if (planningNode) {
      const plan = this.store.listPlanningAcceptances(task.id).at(-1);
      const node = plan?.graph.nodes.find(candidate => candidate.nodeId === planningNode.nodeId);
      if (!node || plan?.proposalId !== planningNode.proposalId || node.targetDeviceId !== profile.device.id
        || node.ownerId !== task.ownerId || node.ownerKind !== task.ownerKind
        || node.capabilityId !== capability.id || node.capabilitySnapshotId !== snapshot.snapshotId) {
        throw new DeviceBrokerError("target_changed", "device action does not match the accepted plan node");
      }
    }
    const accessGrant = this.taskAccessGrant(task, profile.device.id, capability);
    if (accessGrant && capability.verificationCapabilityId) {
      this.taskAccessGrant(task, profile.device.id, this.requireReconciliationReader(binding));
    }
    if (options.onlyUnattendedReads && (capability.sideEffect !== "read_only" || capability.approvalClass !== "allow")) {
      throw new DeviceBrokerError("permission_denied", "the playbook requires an unattended read capability");
    }
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
      this.store.recordApproval(request.taskId, {
        approvalId: request.approval!.approvalId,
        actionId: request.actionId,
        targetDeviceId: request.targetDeviceId,
        capabilitySnapshotId: request.capabilitySnapshotId,
        connectionRevision: snapshot.connectionRevision,
        policyRevision: request.approval!.policyRevision,
        normalizedInputDigest: request.approval!.normalizedInputDigest,
        expiresAt: request.approval!.expiresAt,
        ...(options.approvalPrincipal?.deviceId ? { principalDeviceId: options.approvalPrincipal.deviceId } : {}),
        ...(options.approvalPrincipal?.sessionId ? { principalSessionId: options.approvalPrincipal.sessionId } : {}),
      }, this.now());
    }

    const now = this.now();
    const approval = capability.sideEffect !== "read_only" ? request.approval : undefined;
    const approvalPrincipal = approval ? options.approvalPrincipal : undefined;
    const attempt: DeviceTaskAttemptV1 = {
      attemptId: `${request.taskId}:${request.actionId}`,
      taskId: request.taskId,
      actionId: request.actionId,
      ownerKind: "daemon",
      ownerId: task.ownerId,
      targetDeviceId: profile.device.id,
      dispatchIntentAt: now,
      authority: {
        ...this.actionAuthority(profile.device.ownerScope, dispatchStop, accessGrant),
        ...(approvalPrincipal ? { approvalPrincipal } : {}),
      },
      ...(accessGrant ? { accessGrantRevision: accessGrant.revision } : {}),
      connectionRevision: snapshot.connectionRevision,
      requestDigest,
      adapterBinding: { adapterId: snapshot.adapterId, adapterVersion: snapshot.adapterVersion, profileRevision: profile.profileRevision },
      ...(planningNode ? { planningNode } : {}),
      ...(approval ? { approvalId: approval.approvalId } : {}),
      status: "prepared",
    };
    if (!this.store.acquireTargetLease(profile.device.id, task.id, task.ownerId, now, this.leaseMs, attempt.attemptId)) {
      throw new DeviceBrokerError("target_busy", "device target is leased by another task");
    }
    this.store.createAttempt({ attempt, request, requestDigest }, now);
    this.store.transitionTask(task.id, "executing", { currentActionId: request.actionId }, now);
    const dispatched = this.store.updateAttempt(attempt.attemptId, { status: "dispatched" }, now);
    return { kind: "dispatch", attempt: dispatched.attempt, ...binding };
  }

  private resolveCapability(request: DeviceActionRequestV1, allowExpired = false): DeviceCapabilityBinding {
    const profile = this.requireDevice(request.targetDeviceId);
    if (["revoked", "retired", "offline"].includes(profile.device.lifecycleStatus)) {
      throw new DeviceBrokerError("device_offline", `device ${profile.device.id} is unavailable`);
    }
    const snapshot = this.store.getCurrentCapabilitySnapshot(profile.device.id);
    if (!snapshot || snapshot.snapshotId !== request.capabilitySnapshotId
      || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot is outside the current device registration");
    }
    if (!allowExpired && Date.parse(snapshot.freshnessUntil) <= Date.parse(this.now())) {
      throw new DeviceBrokerError("stale_snapshot", "capability snapshot has expired");
    }
    const capability = snapshot.capabilities.find(item => item.id === request.capabilityId);
    if (!capability || capability.schemaVersion !== request.capabilitySchemaVersion) {
      throw new DeviceBrokerError("unsupported_capability", "requested capability is not in the current snapshot");
    }
    return { profile, snapshot, capability, adapter: this.requireAdapter(profile.adapterId) };
  }

  private actionAuthority(workspaceId: string, dispatchStop: DeviceDispatchStopV1, accessGrant?: DeviceAccessGrantV1): DeviceActionAuthorityV1 {
    return { workspaceId, policyRevision: this.policyRevision, dispatchStop, ...(accessGrant ? { accessGrant } : {}) };
  }

  private taskAccessGrant(task: DeviceTaskV1, targetDeviceId: string, capability: CapabilityDescriptorV1): DeviceAccessGrantV1 | undefined {
    if (!task.accessGrantId) return undefined;
    if (!this.accessManager) throw new DeviceBrokerError("permission_denied", "device access grant resolver is unavailable");
    try {
      const grant = this.accessManager.authorize({
        grantId: task.accessGrantId,
        principalId: task.ownerId,
        targetDeviceId,
        capabilityId: capability.id,
        now: this.now(),
      });
      if (grant.scope === "read_only" && capability.sideEffect !== "read_only") {
        throw new DeviceBrokerError("permission_denied", "read-only access grant cannot dispatch a device write");
      }
      return grant;
    } catch (error) {
      if (!(error instanceof DeviceFabricError) || error.code !== "safety_denied") throw error;
      throw new DeviceBrokerError("permission_denied", "device access grant denied");
    }
  }

  private taskAccessIsCurrent(
    task: DeviceTaskV1, targetDeviceId: string, capability: CapabilityDescriptorV1, revision: number | undefined,
  ): boolean {
    try {
      return this.taskAccessGrant(task, targetDeviceId, capability)?.revision === revision;
    } catch (error) {
      if (error instanceof DeviceBrokerError && error.code === "permission_denied") return false;
      throw error;
    }
  }

  private recordActionResult(
    attempt: DeviceTaskAttemptV1,
    snapshotId: string,
    capability: CapabilityDescriptorV1,
    action: DeviceActionResultV1,
    observations: readonly DeviceObservationV1[],
    finalize: boolean,
    requiresVerification: boolean,
  ): { readonly record: DeviceSupportStoreAttemptRecord; readonly verify: boolean } {
    return this.store.withWriteTransaction(() => {
      const now = this.now();
      for (const observation of observations) this.store.appendObservation(attempt.taskId, observation, now);
      if (!this.retainDispatchAuthority(attempt, snapshotId, capability, now)) {
        return { record: this.store.updateAttempt(attempt.attemptId, { status: "unknown", receipt: action }, now), verify: false };
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

  private retainDispatchAuthority(attempt: DeviceTaskAttemptV1, snapshotId: string, capability: CapabilityDescriptorV1, now: string): boolean {
    const task = this.store.getTask(attempt.taskId);
    if ((task?.status !== "executing" && task?.status !== "verifying")
      || task.currentActionId !== attempt.actionId || task.ownerKind !== attempt.ownerKind || task.ownerId !== attempt.ownerId
      || this.store.getLeasedAttempt(task.id)?.attempt.attemptId !== attempt.attemptId) return false;
    const profile = this.store.getDevice(attempt.targetDeviceId);
    const snapshot = this.store.getCurrentCapabilitySnapshot(attempt.targetDeviceId);
    if (!profile || ["offline", "retired", "revoked"].includes(profile.device.lifecycleStatus)
      || snapshot?.snapshotId !== snapshotId || snapshot?.connectionRevision !== attempt.connectionRevision
      || (capability.sideEffect !== "read_only" && this.store.getDispatchStop(attempt.targetDeviceId).active)
      || !this.taskAccessIsCurrent(task, attempt.targetDeviceId, capability, attempt.accessGrantRevision)) {
      this.store.transitionTask(task.id, "unknown", {}, now);
      return false;
    }
    return true;
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

  private async verifyAction(input: DeviceAdapterVerificationInput & { readonly adapter: DeviceAdapter }): Promise<DeviceAdapterVerificationResult> {
    const { adapter, ...verificationInput } = input;
    const { request, action } = verificationInput;
    let reason = "adapter does not expose a verification operation";
    if (adapter.verify) {
      try {
        const reported = await adapter.verify(verificationInput);
        const result = reported && typeof reported === "object" && "verification" in reported
          ? reported
          : { verification: reported };
        const { verification, observations } = result;
        if (isDeviceVerificationResultV1(verification) && verification.actionId === request.actionId
          && (request.expectedVerification === undefined || canonicalJson(request.expectedVerification) === canonicalJson(verification.rule))
          && (observations === undefined || (Array.isArray(observations)
            && observations.every(item => isDeviceObservationV1(item) && verification.observationIds.includes(item.id))
            && new Set(observations.map(item => item.id)).size === observations.length
            && (verification.status !== "verified" || observations.length > 0)))) {
          return result;
        }
        reason = "adapter verification did not match the dispatched action";
      } catch {
        reason = "adapter verification did not return a result";
      }
    }
    return { verification: {
      actionId: request.actionId,
      status: "not_evaluable",
      rule: request.expectedVerification ?? null,
      observationIds: action.observationIds,
      checkedAt: this.now(),
      reason,
    } };
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
