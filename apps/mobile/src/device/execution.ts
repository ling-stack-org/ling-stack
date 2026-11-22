import {
  isDeviceActionRequestV1,
  isDeviceActionResultV1,
  isDeviceApprovalBindingV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceProfileV1,
  isDeviceTaskV1,
  isDeviceVerificationResultV1,
  type CapabilityDescriptorV1,
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceApprovalBindingV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceObservationV1,
  type DeviceProfileV1,
  type DeviceRecoveryPlanV1,
  type DeviceTaskAttemptV1,
  type DeviceTaskStatusV1,
  type DeviceTaskV1,
  type DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";

export interface MobileDeviceExecutionResult {
  readonly action: DeviceActionResultV1;
  readonly observations?: readonly DeviceObservationV1[];
}

interface MobileDeviceVerificationEvidence {
  readonly verification: DeviceVerificationResultV1;
  readonly observations: readonly DeviceObservationV1[];
}

export interface MobileDeviceTransport {
  readonly deviceId: string;
  readonly connectionRevision: string;
  readonly permissions: readonly string[];
  execute(input: { readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<MobileDeviceExecutionResult>;
  verify?(input: { readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1; readonly signal?: AbortSignal }): Promise<DeviceVerificationResultV1 | MobileDeviceVerificationEvidence>;
  verifyRecoveryPath?(input: {
    readonly plan: DeviceRecoveryPlanV1; readonly baseline: DeviceObservationV1; readonly signal: AbortSignal;
  }): Promise<boolean>;
}

export interface MobileDeviceJournal {
  getTask(taskId: string): Promise<DeviceTaskV1 | undefined>;
  listTasks(): Promise<readonly DeviceTaskV1[]>;
  saveTask(task: DeviceTaskV1): Promise<void>;
  getAttemptByIdempotency(taskId: string, idempotencyKey: string): Promise<MobileAttemptRecord | undefined>;
  listAttempts(taskId: string): Promise<readonly MobileAttemptRecord[]>;
  listObservations(taskId: string): Promise<readonly DeviceObservationV1[]>;
  saveAttempt(record: MobileAttemptRecord): Promise<void>;
  saveObservation(taskId: string, observation: DeviceObservationV1): Promise<void>;
}

export interface MobileAttemptRecord {
  readonly attempt: DeviceTaskAttemptV1;
  readonly request: DeviceActionRequestV1;
  readonly requestDigest: string;
}

export interface MobileDeviceExecutionOptions {
  readonly ownerId: string;
  readonly journal: MobileDeviceJournal;
  readonly now?: () => string;
  readonly policyRevision?: string;
}

interface MobileDeviceActionInput {
  readonly profile: DeviceProfileV1;
  readonly snapshot: DeviceCapabilitySnapshotV1;
  readonly task: DeviceTaskV1;
  readonly request: DeviceActionRequestV1;
  readonly capabilitySideEffect?: CapabilityDescriptorV1["sideEffect"];
  readonly approval?: DeviceApprovalBindingV1;
  readonly transport: MobileDeviceTransport;
  readonly signal?: AbortSignal;
  readonly finalizeTask?: boolean;
}

type MobileDeviceExecutionErrorCode =
  "invalid_request" | "permission_denied" | "stale_snapshot" | "target_changed" | "target_busy" | "unknown_outcome" | "unsupported_capability";

export class MobileDeviceExecutionError extends Error {
  readonly code: MobileDeviceExecutionErrorCode;

  constructor(code: MobileDeviceExecutionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MobileDeviceExecutionError";
  }
}

export class MobileDeviceExecution {
  readonly #ownerId: string;
  readonly #journal: MobileDeviceJournal;
  readonly #now: () => string;
  readonly #policyRevision: string;
  readonly #active = new Map<string, { readonly targetDeviceId: string; readonly stopOnSuspend: boolean; readonly controller: AbortController }>();
  #foreground = true;

  constructor(options: MobileDeviceExecutionOptions) {
    this.#ownerId = options.ownerId;
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#policyRevision = options.policyRevision ?? "device-policy-v1";
  }

  setForeground(active: boolean): void {
    this.#foreground = active;
    if (!active) {
      for (const operation of this.#active.values()) {
        if (operation.stopOnSuspend) operation.controller.abort();
      }
    }
  }

  async execute(input: MobileDeviceActionInput): Promise<MobileAttemptRecord> {
    const { profile, snapshot, task, transport, request, signal } = input;
    if (!isDeviceActionRequestV1(request) || !isDeviceTaskV1(task)
      || !isDeviceProfileV1(profile) || !isDeviceCapabilitySnapshotV1(snapshot)) {
      throw new MobileDeviceExecutionError("invalid_request", "mobile device execution input is invalid");
    }
    this.assertTaskScope(task, request);
    if (transport.deviceId !== profile.device.id || request.targetDeviceId !== profile.device.id) {
      throw new MobileDeviceExecutionError("target_changed", "connected transport does not match the approved target");
    }
    const capability = snapshot.capabilities.find(item => item.id === request.capabilityId && item.schemaVersion === request.capabilitySchemaVersion);
    if (!capability || !capability.supportedDeviceKinds.includes(profile.device.kind)
      || !capability.supportedTransports.some(kind => profile.transports.includes(kind))) {
      throw new MobileDeviceExecutionError("unsupported_capability", "the device snapshot does not advertise this operation");
    }
    if (input.capabilitySideEffect !== undefined && capability.sideEffect !== input.capabilitySideEffect) {
      throw new MobileDeviceExecutionError("permission_denied", "requested operation class does not match the device snapshot");
    }
    const needsApproval = capability.sideEffect !== "read_only" || capability.approvalClass !== "allow";
    if (this.#active.has(task.id) || [...this.#active.values()].some(active => active.targetDeviceId === request.targetDeviceId)) {
      throw new MobileDeviceExecutionError("target_busy", "phone already has an active operation on this target");
    }
    const controller = new AbortController();
    this.#active.set(task.id, { targetDeviceId: request.targetDeviceId, stopOnSuspend: needsApproval, controller });
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const verifyBy = request.recoveryPlan && Date.parse(request.recoveryPlan.verifyBy);
    const timeoutMs = verifyBy === undefined ? capability.timeoutMs : Math.min(capability.timeoutMs, verifyBy - Date.parse(this.#now()));
    const deadline = setTimeout(abort, Math.max(0, timeoutMs));
    try {
      return await this.executeOwned(input, capability, needsApproval, controller.signal);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      this.#active.delete(task.id);
    }
  }

  private async executeOwned(
    input: MobileDeviceActionInput,
    capability: CapabilityDescriptorV1,
    needsApproval: boolean,
    signal: AbortSignal,
  ): Promise<MobileAttemptRecord> {
    const { profile, snapshot, transport } = input;
    const requestDigest = digestDeviceRequest(input.request);
    const task = await this.#journal.getTask(input.task.id) ?? input.task;
    this.assertTaskScope(task, input.request);
    const replay = await this.#journal.getAttemptByIdempotency(task.id, input.request.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new MobileDeviceExecutionError("invalid_request", "idempotency key is bound to another action");
      return replay;
    }
    const attempts = await this.#journal.listAttempts(task.id);
    if (task.status === "unknown" || task.status === "verifying"
      || attempts.some(record => ["prepared", "dispatched", "unknown"].includes(record.attempt.status))) {
      throw new MobileDeviceExecutionError("unknown_outcome", "the earlier device operation needs reconciliation");
    }
    if (!["created", "target_resolved", "capabilities_loaded", "planning", "awaiting_approval", "executing", "partial"].includes(task.status)) {
      throw new MobileDeviceExecutionError("invalid_request", "task is closed to new device actions");
    }
    const approval = input.request.approval ?? input.approval;
    const request = approval ? { ...input.request, approval } : input.request;
    const plan = request.recoveryPlan;
    const recoveryExpired = () => plan !== undefined && Date.parse(plan.verifyBy) <= Date.parse(this.#now());
    const assertDispatchAllowed = () => {
      if (signal.aborted || recoveryExpired() || (needsApproval && !this.#foreground)) {
        throw new MobileDeviceExecutionError("permission_denied", "device operation authorization has ended");
      }
      if (["offline", "retired", "revoked"].includes(profile.device.lifecycleStatus)
        || snapshot.deviceId !== profile.device.id || snapshot.snapshotId !== request.capabilitySnapshotId
        || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion
        || snapshot.connectionRevision !== transport.connectionRevision
        || Date.parse(snapshot.freshnessUntil) <= Date.parse(this.#now())) {
        throw new MobileDeviceExecutionError("stale_snapshot", "capability snapshot does not match the active connection");
      }
      if (!capability.requiredPermissions.every(permission => transport.permissions.includes(permission))) {
        throw new MobileDeviceExecutionError("permission_denied", "the current transport lacks a required permission");
      }
      if (needsApproval) {
        if (task.policyRevision && task.policyRevision !== this.#policyRevision) {
          throw new MobileDeviceExecutionError("permission_denied", "device task policy has changed");
        }
        assertApproval(request, approval, snapshot.connectionRevision, this.#policyRevision, requestDigest, this.#now());
      }
    };
    assertDispatchAllowed();

    if (capability.requiresRecovery && !plan) {
      throw new MobileDeviceExecutionError("permission_denied", "device action requires an approved recovery path");
    }
    let recoveryPathVerifiedAt: string | undefined;
    if (plan) {
      if (capability.sideEffect === "read_only" || plan.routeRevision === snapshot.connectionRevision) {
        throw new MobileDeviceExecutionError("permission_denied", "device action requires a separate current recovery route");
      }
      const reader = snapshot.capabilities.find(item => item.id === capability.verificationCapabilityId);
      if (!transport.verifyRecoveryPath || !transport.verify || reader?.sideEffect !== "read_only" || reader.approvalClass !== "allow"
        || !reader.requiredPermissions.every(permission => transport.permissions.includes(permission))) {
        throw new MobileDeviceExecutionError("unsupported_capability", "the mobile transport cannot verify an alternate recovery route");
      }
      const baseline = (await this.#journal.listObservations(task.id)).find(observation => observation.id === plan.baselineObservationId);
      if (!baseline || !isCurrentTargetObservation(baseline, request.targetDeviceId, this.#now()) || !attempts.some(record => record.attempt.status === "completed"
        && record.attempt.targetDeviceId === request.targetDeviceId && record.attempt.ownerId === task.ownerId
        && record.request.capabilitySnapshotId === snapshot.snapshotId && record.request.capabilityId === reader.id
        && record.attempt.receipt?.observationIds.includes(baseline.id))) {
        throw new MobileDeviceExecutionError("permission_denied", "device action requires a fresh baseline from its verification capability");
      }
      assertDispatchAllowed();
      let stopWaiting!: () => void;
      const interrupted = new Promise<boolean>(resolve => { stopWaiting = () => resolve(false); });
      signal.addEventListener("abort", stopWaiting, { once: true });
      let verified = false;
      try {
        verified = await Promise.race([transport.verifyRecoveryPath({ plan, baseline, signal }), interrupted]) === true;
      } catch {
        // The transport can report private endpoint information.
      } finally {
        signal.removeEventListener("abort", stopWaiting);
      }
      assertDispatchAllowed();
      if (!verified || !isCurrentTargetObservation(baseline, request.targetDeviceId, this.#now())) {
        throw new MobileDeviceExecutionError("permission_denied", "the alternate recovery route could not be verified");
      }
      recoveryPathVerifiedAt = this.#now();
    }

    const attempt: DeviceTaskAttemptV1 = {
      attemptId: `${task.id}:${request.actionId}`,
      taskId: task.id,
      actionId: request.actionId,
      ownerKind: "mobile",
      ownerId: this.#ownerId,
      targetDeviceId: profile.device.id,
      dispatchIntentAt: this.#now(),
      connectionRevision: snapshot.connectionRevision,
      requestDigest,
      ...(request.approvalId ? { approvalId: request.approvalId } : {}),
      ...(recoveryPathVerifiedAt ? { recoveryPathVerifiedAt } : {}),
      status: "dispatched",
    };
    const record: MobileAttemptRecord = { attempt, request, requestDigest };
    const saveStatus = async (status: DeviceTaskStatusV1, lastVerificationId?: string) => this.#journal.saveTask({
      ...task, status, currentActionId: request.actionId,
      ...(lastVerificationId ? { lastVerificationId } : {}),
      updatedAt: this.#now(),
    });
    await saveStatus("executing");
    await this.#journal.saveAttempt(record);
    try {
      assertDispatchAllowed();
    } catch (error) {
      await this.#journal.saveAttempt({ ...record, attempt: { ...attempt, status: "cancelled" } });
      await saveStatus("cancelled");
      throw error;
    }

    const execution = await this.runTransport(transport, request, signal);
    const action = execution.action;
    const attemptStatus = signal.aborted ? "unknown" : action.status === "completed" ? "completed" : action.status === "rejected" ? "failed" : "unknown";
    let received: MobileAttemptRecord = { ...record, attempt: { ...attempt, status: attemptStatus, receipt: action } };
    await this.#journal.saveAttempt(received);
    for (const observation of execution.observations ?? []) await this.#journal.saveObservation(task.id, observation);

    let outcome: DeviceTaskStatusV1 = attemptStatus === "completed" ? "succeeded" : attemptStatus;
    let lastVerificationId: string | undefined;
    if (signal.aborted) outcome = "unknown";
    if (outcome === "succeeded" && (capability.sideEffect !== "read_only"
      || capability.verificationCapabilityId !== undefined || request.expectedVerification !== undefined)) {
      await saveStatus("verifying");
      const verification = await this.readBack(input, request, action, signal);
      received = { ...received, attempt: { ...received.attempt, verification } };
      await this.#journal.saveAttempt(received);
      lastVerificationId = `${request.actionId}:verification`;
      outcome = signal.aborted || (capability.sideEffect !== "read_only" && verification.status === "not_evaluable")
        ? "unknown" : verification.status === "verified" ? "succeeded" : "failed";
    }
    if ((signal.aborted || recoveryExpired() || (plan && snapshot.connectionRevision !== transport.connectionRevision))
      && received.attempt.status !== "unknown") {
      received = { ...received, attempt: { ...received.attempt, status: "unknown" } };
      await this.#journal.saveAttempt(received);
      outcome = "unknown";
    }
    if (input.finalizeTask !== false || outcome === "unknown") {
      await saveStatus(outcome, lastVerificationId);
    } else {
      await saveStatus("executing", lastVerificationId);
    }
    return received;
  }

  async finishReadOnlyPlaybook(taskId: string, outcome: "succeeded" | "partial" | "failed"): Promise<"succeeded" | "partial" | "failed" | "unknown" | "cancelled"> {
    const task = await this.#journal.getTask(taskId);
    if (!task || task.ownerKind !== "mobile" || task.ownerId !== this.#ownerId || this.#active.has(taskId)) {
      throw new MobileDeviceExecutionError("invalid_request", "phone task is not ready to finalize");
    }
    if (task.status === "unknown" || task.status === "cancelled") return task.status;
    if (task.status === "executing") await this.#journal.saveTask({ ...task, status: outcome, updatedAt: this.#now() });
    return outcome;
  }

  async recoverAfterResume(): Promise<readonly MobileAttemptRecord[]> {
    const recovered: MobileAttemptRecord[] = [];
    for (const task of await this.#journal.listTasks()) {
      if (task.ownerKind !== "mobile" || task.ownerId !== this.#ownerId || this.#active.has(task.id)) continue;
      let interrupted = task.status === "executing" || task.status === "verifying";
      for (const record of await this.#journal.listAttempts(task.id)) {
        if (record.attempt.status !== "prepared" && record.attempt.status !== "dispatched") continue;
        const unknown: MobileAttemptRecord = { ...record, attempt: { ...record.attempt, status: "unknown" } };
        await this.#journal.saveAttempt(unknown);
        recovered.push(unknown);
        interrupted = true;
      }
      if (interrupted) await this.#journal.saveTask({ ...task, status: "unknown", updatedAt: this.#now() });
    }
    return recovered;
  }

  private assertTaskScope(task: DeviceTaskV1, request: DeviceActionRequestV1): void {
    if (task.ownerKind !== "mobile" || task.ownerId !== this.#ownerId || task.id !== request.taskId
      || !task.targetDeviceIds.includes(request.targetDeviceId)) {
      throw new MobileDeviceExecutionError("permission_denied", "device action is outside the phone task's owner or target");
    }
  }

  private async runTransport(transport: MobileDeviceTransport, request: DeviceActionRequestV1, signal: AbortSignal): Promise<MobileDeviceExecutionResult> {
    try {
      const result = await transport.execute({ request, signal });
      if (isDeviceActionResultV1(result?.action) && result.action.actionId === request.actionId
        && (!result.observations || result.observations.every(observation => isDeviceObservationV1(observation)
          && result.action.observationIds.includes(observation.id)))) return result;
    } catch {
      // The dispatch intent is already durable, so transport failures need readback.
    }
    const now = this.#now();
    return { action: {
      actionId: request.actionId, status: "uncertain", errorCode: "unknown_outcome",
      startedAt: now, finishedAt: now, observationIds: [],
    } };
  }

  private async readBack(input: MobileDeviceActionInput, request: DeviceActionRequestV1, action: DeviceActionResultV1, signal: AbortSignal): Promise<DeviceVerificationResultV1> {
    if (input.transport.verify && !signal.aborted) {
      const startedAt = Date.parse(this.#now());
      try {
        const result = await input.transport.verify({ request, action, signal });
        const evidence = result && "verification" in result ? result : undefined;
        const verification = evidence?.verification ?? result;
        if (isDeviceVerificationResultV1(verification) && verification.actionId === request.actionId
          && (request.expectedVerification === undefined
            || encodeBase64Url(canonicalJsonBytes(verification.rule)) === encodeBase64Url(canonicalJsonBytes(request.expectedVerification)))) {
          if (!request.recoveryPlan || verification.status === "not_evaluable") return verification;
          const now = this.#now();
          const checkedAt = Date.parse(verification.checkedAt);
          const observations = evidence?.observations;
          if (!signal.aborted && checkedAt >= startedAt && checkedAt <= Date.parse(now)
            && Array.isArray(observations) && observations.length > 0
            && observations.every(observation => isDeviceObservationV1(observation)
              && verification.observationIds.includes(observation.id)
              && Date.parse(observation.observedAt) >= startedAt && Date.parse(observation.observedAt) <= checkedAt
              && isCurrentTargetObservation(observation, request.targetDeviceId, now))) {
            const ids = new Set(observations.map(observation => observation.id));
            if (ids.size === observations.length && verification.observationIds.every(id => ids.has(id))) {
              for (const observation of observations) await this.#journal.saveObservation(request.taskId, observation);
              return verification;
            }
          }
        }
      } catch {
        // The action receipt remains available when verification cannot finish.
      }
    }
    return {
      actionId: request.actionId, status: "not_evaluable", rule: request.expectedVerification ?? null,
      observationIds: [], checkedAt: this.#now(),
    };
  }
}

function isCurrentTargetObservation(observation: DeviceObservationV1, targetDeviceId: string, now: string): boolean {
  return observation.subjectId === targetDeviceId && observation.redactionClass === "public"
    && (observation.quality === "good" || observation.quality === "degraded") && observation.provenance.includes(targetDeviceId)
    && Date.parse(observation.observedAt) <= Date.parse(now) && Date.parse(observation.freshnessUntil) > Date.parse(now);
}

export function digestDeviceRequest(request: DeviceActionRequestV1): string {
  return encodeBase64Url(sha256(canonicalJsonBytes({
    taskId: request.taskId,
    actionId: request.actionId,
    targetDeviceId: request.targetDeviceId,
    capabilityId: request.capabilityId,
    capabilitySchemaVersion: request.capabilitySchemaVersion,
    capabilitySnapshotId: request.capabilitySnapshotId,
    normalizedInput: request.normalizedInput,
    expectedVerification: request.expectedVerification ?? null,
    ...(request.recoveryPlan ? { recoveryPlan: request.recoveryPlan } : {}),
  })));
}

function assertApproval(request: DeviceActionRequestV1, approval: DeviceApprovalBindingV1 | undefined, connectionRevision: string, policyRevision: string, requestDigest: string, now: string): void {
  if (!isDeviceApprovalBindingV1(approval) || approval.approvalId !== request.approvalId || approval.taskId !== request.taskId || approval.actionId !== request.actionId
    || approval.targetDeviceId !== request.targetDeviceId || approval.capabilitySnapshotId !== request.capabilitySnapshotId
    || approval.connectionRevision !== connectionRevision || approval.policyRevision !== policyRevision
    || approval.normalizedInputDigest !== requestDigest || Date.parse(approval.expiresAt) <= Date.parse(now)
    || (request.recoveryPlan !== undefined && (approval.recoveryScope === undefined
      || encodeBase64Url(canonicalJsonBytes(approval.recoveryScope)) !== encodeBase64Url(canonicalJsonBytes(request.recoveryPlan))))) {
    throw new MobileDeviceExecutionError("permission_denied", "device action lacks an exact current approval");
  }
}
