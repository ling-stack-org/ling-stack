import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { approvalSideEffectFingerprintV1 } from "../../approval-checkpoints.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { RunStore } from "../../run-types.js";
import type { RuntimeHostCapacityApprovalResumePendingInput, RuntimeHostCapacityIntentRecord,
  RuntimeHostCapacityUserInputPendingInput } from "../../runtime-host-capacity-types.js";
import type { UserInputContinuationExecutionPlan } from "../../user-input-host-continuation-types.js";

export type HostCapacityContinuationPorts = Pick<RunStore, "getApprovalCheckpoint" | "getApprovalRequest" | "getRun"
  | "getWorkUnit" | "getWorkUnitAttempt" | "getUserInputContinuationSeed" | "getUserInputContinuationPreparation"
  | "getUserInputContinuationBinding" | "getUserInputDelivery" | "getUserInputWait">;
type Authority = { readonly ownerKey: string; readonly authorityDigest: string };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

export function approvalResumeCapacityAuthority(ports: HostCapacityContinuationPorts, workspaceId: string,
  input: RuntimeHostCapacityApprovalResumePendingInput, source?: HostOperationSource): Authority | undefined {
  if (!text(input.checkpointId) || !revision(input.expectedCheckpointRevision)
    || !text(input.expectedActiveAttemptId) || !text(input.runtimeInstanceId)) return undefined;
  const checkpoint = ports.getApprovalCheckpoint(input.checkpointId), basis = checkpoint?.resumeBasis;
  const approval = checkpoint && ports.getApprovalRequest(checkpoint.approvalId);
  const run = basis && ports.getRun(basis.runId), unit = basis && ports.getWorkUnit(basis.workUnitId);
  const prior = ports.getWorkUnitAttempt(input.expectedActiveAttemptId);
  if (!checkpoint || !basis || !approval || approval.status !== "approved" || !approval.toolCallId
    || approval.runId !== basis.runId || checkpoint.runId !== basis.runId || basis.approvalId !== approval.id
    || basis.toolCallId !== approval.toolCallId || basis.actionType !== approval.actionType
    || basis.sideEffectFingerprint !== approvalSideEffectFingerprintV1({ actionType: approval.actionType,
      toolCallId: approval.toolCallId, sideEffect: approval.payload })
    || !run || !unit || !prior || unit.workspaceId !== workspaceId || run.workUnitId !== unit.id
    || unit.linkedRunId !== run.id || prior.workUnitId !== unit.id
    || (prior.effectiveRunnerId ?? prior.runnerId) !== "pi") return undefined;
  if (source) {
    if (checkpoint.status !== "resume_pending" || checkpoint.revision !== input.expectedCheckpointRevision + 1
      || checkpoint.runnerResumeHandle?.attemptId !== source.attemptId || source.runtimeInstanceId !== input.runtimeInstanceId
      || source.runId !== run.id || source.workUnitId !== unit.id || unit.activeAttemptId !== source.attemptId
      || run.status !== "running" || unit.status !== "running") return undefined;
  } else if (!["approved", "resume_pending"].includes(checkpoint.status)
    || checkpoint.revision !== input.expectedCheckpointRevision || unit.activeAttemptId !== prior.id
    || !["waiting_for_approval", "running"].includes(run.status) || unit.status !== run.status) return undefined;
  return { ownerKey: JSON.stringify([input.checkpointId, input.expectedCheckpointRevision,
    input.expectedActiveAttemptId, input.runtimeInstanceId]),
    authorityDigest: hash([basis.fingerprint, run.id, unit.id, prior.id, prior.runtimeInstanceId, prior.fencingToken,
      run.requestSnapshot, run.taskSnapshot, run.providerSnapshot, unit.request, input.runtimeInstanceId]) };
}

export function userInputCapacityAuthority(ports: HostCapacityContinuationPorts, workspaceId: string,
  input: RuntimeHostCapacityUserInputPendingInput, source?: HostOperationSource): Authority | undefined {
  if (!text(input.threadId) || !text(input.deliveryId) || !revision(input.expectedRevision)
    || !text(input.runtimeInstanceId) || !text(input.executionRef?.id) || !text(input.executionRef?.fingerprint)) return undefined;
  const seed = ports.getUserInputContinuationSeed(input.threadId, input.deliveryId);
  const prepared = ports.getUserInputContinuationPreparation(input.threadId, input.deliveryId, "execution");
  const delivery = ports.getUserInputDelivery(input.threadId, input.deliveryId);
  const wait = seed && ports.getUserInputWait(input.threadId, seed.request.requestId);
  const plan = prepared?.payload as UserInputContinuationExecutionPlan | undefined;
  if (!seed || !prepared || !delivery || !wait || seed.source.workspaceId !== workspaceId || plan?.runnerId !== "pi"
    || !isDeepStrictEqual(input.executionRef, { id: prepared.id, fingerprint: prepared.fingerprint })
    || prepared.createdAt > input.now || delivery.status !== "claimed" || !delivery.claim
    || delivery.claim.expiresAt <= input.now) return undefined;
  if (source) {
    const binding = ports.getUserInputContinuationBinding(input.threadId, input.deliveryId);
    if (!binding || binding.runId !== seed.successorRunId || source.runId !== binding.runId
      || !isDeepStrictEqual(binding.fence, { workUnitId: source.workUnitId, attemptId: source.attemptId,
        runtimeInstanceId: source.runtimeInstanceId, fencingToken: source.fencingToken })
      || source.runtimeInstanceId !== input.runtimeInstanceId || binding.deliveryRevision !== input.expectedRevision + 1
      || delivery.revision !== binding.deliveryRevision || wait.status !== "resuming"
      || wait.revision !== binding.waitRevision || !isDeepStrictEqual(binding.executionRef, input.executionRef)) return undefined;
  } else if (delivery.revision !== input.expectedRevision || delivery.claim.ownerId !== input.ownerId
    || delivery.claim.token !== input.claimToken || wait.status !== "waiting"
    || ports.getUserInputContinuationBinding(input.threadId, input.deliveryId)) return undefined;
  return { ownerKey: JSON.stringify([input.threadId, input.deliveryId, input.expectedRevision,
    input.executionRef.id, input.executionRef.fingerprint, input.runtimeInstanceId]),
    authorityDigest: hash([seed.fingerprint, prepared.id, prepared.fingerprint, plan.runnerId, input.runtimeInstanceId]) };
}

/** Owner keys carry only immutable lineage identifiers; current authority is read from the owning stores. */
export function continuationCapacityAuthority(ports: HostCapacityContinuationPorts, workspaceId: string,
  record: RuntimeHostCapacityIntentRecord, now: string, source: HostOperationSource): Authority | undefined {
  let key: unknown;
  try { key = JSON.parse(record.intent.ownerKey); } catch { return undefined; }
  if (!Array.isArray(key)) return undefined;
  if (record.intent.ownerKind === "approval_resume_pending" && key.length === 4) {
    const [checkpointId, expectedCheckpointRevision, expectedActiveAttemptId, runtimeInstanceId] = key as unknown[];
    if (!text(checkpointId) || !revision(expectedCheckpointRevision) || !text(expectedActiveAttemptId) || !text(runtimeInstanceId)) return undefined;
    return approvalResumeCapacityAuthority(ports, workspaceId,
      { checkpointId, expectedCheckpointRevision, expectedActiveAttemptId, runtimeInstanceId, now }, source);
  }
  if (record.intent.ownerKind === "user_input_continuation" && key.length === 6) {
    const [threadId, deliveryId, expectedRevision, id, fingerprint, runtimeInstanceId] = key as unknown[];
    if (!text(threadId) || !text(deliveryId) || !revision(expectedRevision) || !text(id) || !text(fingerprint) || !text(runtimeInstanceId)) return undefined;
    return userInputCapacityAuthority(ports, workspaceId,
      { threadId, deliveryId, expectedRevision, executionRef: { id, fingerprint }, runtimeInstanceId,
        ownerId: "bound", claimToken: "bound", now }, source);
  }
  return undefined;
}
