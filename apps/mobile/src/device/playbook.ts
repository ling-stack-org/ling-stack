import type {
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
}

export interface MobileReadOnlyPlaybookResult {
  readonly playbookId: string;
  readonly attempts: readonly MobileAttemptRecord[];
  readonly status: "succeeded" | "partial" | "failed" | "unknown" | "cancelled";
}

export async function runMobileReadOnlyPlaybook(input: MobileReadOnlyPlaybookInput): Promise<MobileReadOnlyPlaybookResult> {
  if (!input.playbookId.trim() || input.steps.length === 0) throw new Error("A mobile read-only playbook needs an id and at least one step");
  const attempts: MobileAttemptRecord[] = [];
  for (const step of input.steps) {
    if (!step.stepId.trim() || !step.capabilityId.trim() || !step.capabilitySchemaVersion.trim()) throw new Error("Mobile playbook step metadata is invalid");
    const request: DeviceActionRequestV1 = {
      actionId: `${input.playbookId}:${step.stepId}`,
      taskId: input.task.id,
      targetDeviceId: input.profile.device.id,
      capabilityId: step.capabilityId,
      capabilitySchemaVersion: step.capabilitySchemaVersion,
      capabilitySnapshotId: input.snapshot.snapshotId,
      normalizedInput: step.normalizedInput,
      idempotencyKey: `${input.task.id}:${input.playbookId}:${step.stepId}`,
    };
    const attempt = await input.execution.execute({
      profile: input.profile,
      snapshot: input.snapshot,
      task: input.task,
      request,
      capabilitySideEffect: "read_only",
      transport: input.transport,
      finalizeTask: false,
    });
    attempts.push(attempt);
    if (attempt.attempt.status === "unknown") return { playbookId: input.playbookId, attempts, status: "unknown" };
    if (attempt.attempt.receipt?.status !== "completed"
      || (attempt.attempt.verification && attempt.attempt.verification.status !== "verified")) {
      const status = await input.execution.finishReadOnlyPlaybook(input.task.id, attempts.length === 1 ? "failed" : "partial");
      return { playbookId: input.playbookId, attempts, status };
    }
  }
  const status = await input.execution.finishReadOnlyPlaybook(input.task.id, "succeeded");
  return { playbookId: input.playbookId, attempts, status };
}
