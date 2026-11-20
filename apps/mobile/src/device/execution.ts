import type {
  DeviceActionRequestV1,
  DeviceActionResultV1,
  DeviceApprovalBindingV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceTaskAttemptV1,
  DeviceTaskV1,
  DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import {
  canonicalJsonBytes,
  encodeBase64Url,
  sha256,
} from "@ling-stack/remote-protocol";
import {
  isDeviceActionRequestV1,
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceTaskV1,
  isDeviceVerificationResultV1,
} from "@ling-stack/contracts";

export interface MobileDeviceExecutionResult {
  readonly action: DeviceActionResultV1;
  readonly observations?: readonly DeviceObservationV1[];
}

export interface MobileDeviceTransport {
  readonly deviceId: string;
  execute(input: { readonly request: DeviceActionRequestV1; readonly signal?: AbortSignal }): Promise<MobileDeviceExecutionResult>;
  verify?(input: { readonly request: DeviceActionRequestV1; readonly action: DeviceActionResultV1; readonly signal?: AbortSignal }): Promise<DeviceVerificationResultV1>;
}

export interface MobileDeviceJournal {
  getTask(taskId: string): Promise<DeviceTaskV1 | undefined>;
  listTasks(): Promise<readonly DeviceTaskV1[]>;
  saveTask(task: DeviceTaskV1): Promise<void>;
  getAttemptByIdempotency(taskId: string, idempotencyKey: string): Promise<MobileAttemptRecord | undefined>;
  listAttempts(taskId: string): Promise<readonly MobileAttemptRecord[]>;
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

export class MobileDeviceExecutionError extends Error {
  readonly code: "invalid_request" | "permission_denied" | "stale_snapshot" | "target_changed" | "unknown_outcome";

  constructor(code: "invalid_request" | "permission_denied" | "stale_snapshot" | "target_changed" | "unknown_outcome", message: string) {
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
  #foreground = true;

  constructor(options: MobileDeviceExecutionOptions) {
    this.#ownerId = options.ownerId;
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#policyRevision = options.policyRevision ?? "device-policy-v1";
  }

  setForeground(active: boolean): void {
    this.#foreground = active;
  }

  async execute(input: {
    readonly profile: DeviceProfileV1;
    readonly snapshot: DeviceCapabilitySnapshotV1;
    readonly task: DeviceTaskV1;
    readonly request: DeviceActionRequestV1;
    readonly capabilitySideEffect: "read_only" | "reversible" | "mutating" | "irreversible" | "critical";
    readonly approval?: DeviceApprovalBindingV1;
    readonly transport: MobileDeviceTransport;
    readonly signal?: AbortSignal;
  }): Promise<MobileAttemptRecord> {
    if (!isDeviceActionRequestV1(input.request) || !isDeviceTaskV1(input.task) || !isDeviceCapabilitySnapshotV1(input.snapshot)) {
      throw new MobileDeviceExecutionError("invalid_request", "mobile device execution input is invalid");
    }
    if (input.task.ownerKind !== "mobile" || input.task.ownerId !== this.#ownerId) {
      throw new MobileDeviceExecutionError("permission_denied", "mobile is not the task owner");
    }
    if (input.transport.deviceId !== input.profile.device.id || input.request.targetDeviceId !== input.profile.device.id) {
      throw new MobileDeviceExecutionError("target_changed", "connected transport does not match the approved target");
    }
    if (input.snapshot.deviceId !== input.profile.device.id || input.snapshot.snapshotId !== input.request.capabilitySnapshotId
      || Date.parse(input.snapshot.freshnessUntil) <= Date.parse(this.#now())) {
      throw new MobileDeviceExecutionError("stale_snapshot", "capability snapshot is stale or bound to another target");
    }
    const requestDigest = digestDeviceRequest(input.request);
    const replay = await this.#journal.getAttemptByIdempotency(input.request.taskId, input.request.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new MobileDeviceExecutionError("invalid_request", "idempotency key is bound to another action");
      return replay;
    }
    if (input.capabilitySideEffect !== "read_only") {
      if (!this.#foreground) throw new MobileDeviceExecutionError("permission_denied", "foreground authorization has ended");
      assertApproval(input.request, input.approval, input.snapshot.connectionRevision, this.#policyRevision, requestDigest, this.#now());
    }

    const attempt: DeviceTaskAttemptV1 = {
      attemptId: `${input.task.id}:${input.request.actionId}`,
      taskId: input.task.id,
      actionId: input.request.actionId,
      ownerKind: "mobile",
      ownerId: this.#ownerId,
      targetDeviceId: input.profile.device.id,
      dispatchIntentAt: this.#now(),
      status: "prepared",
    };
    const record: MobileAttemptRecord = { attempt, request: input.request, requestDigest };
    await this.#journal.saveAttempt(record);
    await this.#journal.saveTask({ ...input.task, status: "executing", currentActionId: input.request.actionId, updatedAt: this.#now() });

    let execution: MobileDeviceExecutionResult;
    try {
      await this.#journal.saveAttempt({ ...record, attempt: { ...attempt, status: "dispatched" } });
      execution = await input.transport.execute({ request: input.request, signal: input.signal });
    } catch (error) {
      const action: DeviceActionResultV1 = {
        actionId: input.request.actionId,
        status: "uncertain",
        errorCode: "unknown_outcome",
        redactedDetails: error instanceof Error ? error.message.slice(0, 512) : "transport execution failed",
        startedAt: this.#now(),
        finishedAt: this.#now(),
        observationIds: [],
      };
      const unknown: MobileAttemptRecord = { ...record, attempt: { ...attempt, status: "unknown", receipt: action } };
      await this.#journal.saveAttempt(unknown);
      await this.#journal.saveTask({ ...input.task, status: "unknown", currentActionId: input.request.actionId, updatedAt: this.#now() });
      return unknown;
    }
    if (!isDeviceActionResultV1(execution.action)) throw new MobileDeviceExecutionError("unknown_outcome", "device transport returned an invalid action result");
    for (const observation of execution.observations ?? []) {
      if (!isDeviceObservationV1(observation)) throw new MobileDeviceExecutionError("unknown_outcome", "device transport returned an invalid observation");
      await this.#journal.saveObservation(input.task.id, observation);
    }
    const nextStatus: DeviceTaskAttemptV1["status"] = execution.action.status === "completed" ? "completed" : execution.action.status === "uncertain" ? "unknown" : "failed";
    let nextAttempt: MobileAttemptRecord = {
      ...record,
      attempt: { ...attempt, status: nextStatus, receipt: execution.action },
    };
    if (execution.action.status === "completed" && input.transport.verify && input.request.expectedVerification !== undefined) {
      const verification = await input.transport.verify({ request: input.request, action: execution.action, signal: input.signal });
      if (!isDeviceVerificationResultV1(verification)) throw new MobileDeviceExecutionError("unknown_outcome", "device transport returned an invalid verification");
      nextAttempt = { ...nextAttempt, attempt: { ...nextAttempt.attempt, verification } };
      await this.#journal.saveTask({ ...input.task, status: verification.status === "verified" ? "succeeded" : "failed", currentActionId: input.request.actionId, lastVerificationId: `${input.request.actionId}:verification`, updatedAt: this.#now() });
    } else {
      await this.#journal.saveTask({ ...input.task, status: execution.action.status === "completed" ? "succeeded" : execution.action.status === "uncertain" ? "unknown" : "failed", currentActionId: input.request.actionId, updatedAt: this.#now() });
    }
    await this.#journal.saveAttempt(nextAttempt);
    return nextAttempt;
  }

  async recoverAfterResume(): Promise<readonly MobileAttemptRecord[]> {
    const recovered: MobileAttemptRecord[] = [];
    for (const task of await this.listOwnedTasks()) {
      for (const record of await this.#journal.listAttempts(task.id)) {
        if (record.attempt.status !== "prepared" && record.attempt.status !== "dispatched") continue;
        const unknown: MobileAttemptRecord = { ...record, attempt: { ...record.attempt, status: "unknown" } };
        await this.#journal.saveAttempt(unknown);
        await this.#journal.saveTask({ ...task, status: "unknown", updatedAt: this.#now() });
        recovered.push(unknown);
      }
    }
    return recovered;
  }

  private async listOwnedTasks(): Promise<readonly DeviceTaskV1[]> {
    const tasks = await this.#journal.listTasks();
    return tasks.filter(task => task.ownerKind === "mobile" && task.ownerId === this.#ownerId);
  }
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
  })));
}

function assertApproval(request: DeviceActionRequestV1, approval: DeviceApprovalBindingV1 | undefined, connectionRevision: string, policyRevision: string, requestDigest: string, now: string): void {
  if (!approval || approval.approvalId !== request.approvalId || approval.taskId !== request.taskId || approval.actionId !== request.actionId
    || approval.targetDeviceId !== request.targetDeviceId || approval.capabilitySnapshotId !== request.capabilitySnapshotId
    || approval.connectionRevision !== connectionRevision || approval.policyRevision !== policyRevision
    || approval.normalizedInputDigest !== requestDigest || Date.parse(approval.expiresAt) <= Date.parse(now)) {
    throw new MobileDeviceExecutionError("permission_denied", "device write lacks an exact current approval");
  }
}

