import type {
  CapabilitySideEffectV1,
  DeviceRecoveryPlanV1,
  DeviceApprovalBindingV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceProfileV1,
  DeviceTaskV1,
} from "@ling-stack/contracts";
import type { MobileAttemptRecord, MobileDeviceExecution, MobileDeviceTransport } from "./execution.js";

export interface MobileReadOnlyPlaybookStep {
  readonly stepId: string;
  readonly capabilityId: string;
  readonly capabilitySchemaVersion: string;
  readonly normalizedInput: DeviceActionRequestV1["normalizedInput"];
}

export interface MobileReadOnlyPlaybookInput {
  readonly playbookId: string;
  readonly profile: DeviceProfileV1;
  readonly snapshot: DeviceCapabilitySnapshotV1;
  readonly task: DeviceTaskV1;
  readonly steps: readonly MobileReadOnlyPlaybookStep[];
  readonly transport: MobileDeviceTransport;
  readonly execution: MobileDeviceExecution;
  readonly signal?: AbortSignal;
}

export interface MobileReadOnlyPlaybookResult {
  readonly playbookId: string;
  readonly attempts: readonly MobileAttemptRecord[];
  readonly status: "succeeded" | "partial" | "failed" | "unknown" | "cancelled";
}

/** A bounded device setup flow. Every side-effecting step must carry its own exact approval. */
export interface MobileSetupPlaybookStep extends MobileReadOnlyPlaybookStep {
  readonly sideEffect: Exclude<CapabilitySideEffectV1, "read_only">;
  readonly approval: DeviceApprovalBindingV1;
  readonly expectedVerification?: DeviceActionRequestV1["expectedVerification"];
  readonly recoveryPlan?: DeviceRecoveryPlanV1;
}

export interface MobileSetupPlaybookInput extends Omit<MobileReadOnlyPlaybookInput, "steps"> {
  readonly steps: readonly MobileSetupPlaybookStep[];
}

export function runMobileReadOnlyPlaybook(input: MobileReadOnlyPlaybookInput): Promise<MobileReadOnlyPlaybookResult> {
  return runMobilePlaybook(input, "read_only");
}

export function runMobileSetupPlaybook(input: MobileSetupPlaybookInput): Promise<MobileReadOnlyPlaybookResult> {
  return runMobilePlaybook(input, "setup");
}

async function runMobilePlaybook(
  input: MobileReadOnlyPlaybookInput | MobileSetupPlaybookInput,
  mode: "read_only" | "setup",
): Promise<MobileReadOnlyPlaybookResult> {
  if (!input.playbookId.trim() || input.steps.length === 0) {
    throw new Error(`A mobile ${mode === "setup" ? "setup" : "read-only"} playbook needs an id and at least one step`);
  }
  if (mode === "setup" && input.steps.some(step => !isSetupStep(step).approval.approvalId)) {
    throw new Error("A mobile setup playbook requires explicit approval for every step");
  }
  const attempts: MobileAttemptRecord[] = [];
  for (const step of input.steps) {
    if (!step.stepId.trim() || !step.capabilityId.trim() || !step.capabilitySchemaVersion.trim()) {
      throw new Error("Mobile playbook step metadata is invalid");
    }
    const setup = mode === "setup" ? isSetupStep(step) : undefined;
    const request: DeviceActionRequestV1 = {
      actionId: `${input.playbookId}:${step.stepId}`,
      taskId: input.task.id,
      targetDeviceId: input.profile.device.id,
      capabilityId: step.capabilityId,
      capabilitySchemaVersion: step.capabilitySchemaVersion,
      capabilitySnapshotId: input.snapshot.snapshotId,
      normalizedInput: step.normalizedInput,
      idempotencyKey: `${input.task.id}:${input.playbookId}:${step.stepId}`,
      ...(setup ? {
        approvalId: setup.approval.approvalId,
        approval: setup.approval,
        ...(setup.expectedVerification === undefined ? {} : { expectedVerification: setup.expectedVerification }),
        ...(setup.recoveryPlan === undefined ? {} : { recoveryPlan: setup.recoveryPlan }),
      } : {}),
    };
    const attempt = await input.execution.execute({
      profile: input.profile,
      snapshot: input.snapshot,
      task: input.task,
      request,
      capabilitySideEffect: setup?.sideEffect ?? "read_only",
      ...(setup ? { approval: setup.approval, requireFreshVerificationEvidence: true } : {}),
      transport: input.transport,
      signal: input.signal,
      finalizeTask: false,
    });
    attempts.push(attempt);
    if (attempt.attempt.status === "unknown") return { playbookId: input.playbookId, attempts, status: "unknown" };
    if (attempt.attempt.receipt?.status !== "completed"
      || (attempt.attempt.verification && attempt.attempt.verification.status !== "verified")) {
      const status = await input.execution.finishPlaybook(input.task.id, attempts.length === 1 ? "failed" : "partial");
      return { playbookId: input.playbookId, attempts, status };
    }
  }
  const status = await input.execution.finishPlaybook(input.task.id, "succeeded");
  return { playbookId: input.playbookId, attempts, status };
}

function isSetupStep(step: MobileReadOnlyPlaybookStep | MobileSetupPlaybookStep): MobileSetupPlaybookStep {
  if (!("approval" in step) || !("sideEffect" in step)) {
    throw new Error("Mobile setup step metadata is invalid");
  }
  return step;
}
