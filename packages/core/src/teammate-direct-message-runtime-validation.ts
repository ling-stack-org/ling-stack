import type { ConversationItemV1 } from "@ling-stack/contracts";
import { approvalSideEffectFingerprintV1, isApprovalResumeBasisV1, type LingApprovalCheckpoint } from "./approval-checkpoints.js";
import type { ApprovalRequest } from "./approval-types.js";
import type { LingThread, LingTurn, RunSession } from "./run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1, type WorkUnit, type WorkUnitAttempt } from "./runtime-supervisor-types.js";
import type { TeammateDirectInputSnapshot } from "./teammate-direct-input-types.js";
import type { TeammateDirectMessageRuntimeScope } from "./teammate-direct-message-runtime-types.js";
import type { TeammateDirectMessage } from "./workspace-types.js";

export function runtimeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function sameTeammateDirectRuntimeFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.fencingToken === right.fencingToken;
}

/** Verify the canonical source, including edited sources whose item ID differs from the native ID. */
export function isTeammateDirectRuntimeSource(input: {
  readonly scope: TeammateDirectMessageRuntimeScope;
  readonly message: TeammateDirectMessage;
  readonly run?: RunSession;
  readonly unit: WorkUnit;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly item: ConversationItemV1;
  readonly source: TeammateDirectMessage;
  readonly snapshot: TeammateDirectInputSnapshot;
  readonly request: Record<string, unknown>;
}): boolean {
  const { scope, message, run, unit, thread, turn, item, source, snapshot, request } = input;
  const ref = runtimeRecord(request.teammateDirectInputRef);
  const task = runtimeRecord(request.task);
  return thread.workspaceId === scope.workspaceId && thread.kind === "teammate_direct"
    && thread.teammateId === scope.teammateId && thread.channelId === undefined && thread.workflowId === undefined && thread.workflowStepId === undefined
    && turn.workspaceId === scope.workspaceId && turn.threadId === thread.id && turn.teammateId === scope.teammateId
    && turn.channelId === undefined && turn.workflowStepId === undefined && turn.status !== "superseded"
    && turn.sourceItemId === item.id && item.workspaceId === scope.workspaceId && item.threadId === thread.id
    && item.turnId === turn.id && item.kind === "user_message" && item.status === "committed"
    && item.visibility === "agent_private" && item.visibilityOwnerId === scope.teammateId && item.channelId === undefined
    && item.domainRefs.some(value => value.type === "message" && value.id === source.id)
    && source.workspaceId === scope.workspaceId && source.threadId === scope.threadId && source.teammateId === scope.teammateId
    && (source.authorType === "local-user" || source.authorType === "system")
    && request.teammateId === scope.teammateId && request.threadId === thread.id && request.turnId === turn.id
    && request.linkedMessageId === message.id && request.sourceMessageId === source.id && task?.id === source.id
    && snapshot.workspaceId === scope.workspaceId && snapshot.threadId === thread.id && snapshot.turnId === turn.id
    && snapshot.sourceItemId === item.id && snapshot.teammateId === scope.teammateId
    && ref?.id === snapshot.id && ref.fingerprint === snapshot.fingerprint
    && unit.workspaceId === scope.workspaceId && unit.kind === "teammate_direct_reply"
    && unit.ownerType === "teammate_direct_message" && unit.ownerId === source.id
    && unit.teammateId === scope.teammateId && unit.channelId === undefined && unit.linkedMessageId === message.id
    && (!run || (run.threadId === thread.id && run.teammateId === scope.teammateId && run.channelId === undefined
      && run.workflowStepId === undefined && run.taskId === source.id && run.workUnitId === unit.id && unit.linkedRunId === run.id));
}

/** A cast JSON handle is not evidence. Host handles close over the exact approval basis and Attempt. */
export function isTeammateDirectRuntimeResumeHandle(checkpoint: LingApprovalCheckpoint, attempt: WorkUnitAttempt, run: RunSession): boolean {
  const handle = runtimeRecord(checkpoint.runnerResumeHandle);
  if (!handle || (handle.kind !== "ling_continuation" && handle.kind !== "runner_native")
    || handle.verified !== true || handle.runId !== run.id || handle.attemptId !== attempt.id
    || handle.runnerId !== attempt.runnerId) return false;
  if (handle.kind === "runner_native") return typeof handle.handleRef === "string" && handle.handleRef.length > 0;
  const payload = runtimeRecord(handle.payload);
  return payload?.schemaVersion === 1 && payload.approvalId === checkpoint.approvalId
    && payload.resumeBasisFingerprint === checkpoint.resumeBasis?.fingerprint;
}

export function isTeammateDirectRuntimeApprovalBasis(
  checkpoint: LingApprovalCheckpoint, approval: ApprovalRequest | undefined, run: RunSession, unit: WorkUnit,
  prior: WorkUnitAttempt | undefined,
): approval is ApprovalRequest {
  const basis = checkpoint.resumeBasis;
  return Boolean(approval && isApprovalResumeBasisV1(basis) && prior && prior.id === basis.priorAttemptId
    && prior.workUnitId === unit.id && basis.workUnitId === unit.id && basis.runId === run.id
    && basis.approvalId === approval.id && basis.toolCallId === approval.toolCallId && basis.actionType === approval.actionType
    && basis.workflowStepId === undefined && checkpoint.workflowStepId === undefined && approval.workflowStepId === undefined
    && checkpoint.channelId === undefined && approval.channelId === undefined
    && checkpoint.approvalId === approval.id && checkpoint.runId === run.id && approval.runId === run.id
    && checkpoint.toolCallId === basis.toolCallId && checkpoint.actionType === basis.actionType
    && Number.isSafeInteger(checkpoint.revision) && checkpoint.revision >= 1
    && basis.sideEffectFingerprint === approvalSideEffectFingerprintV1({ actionType: approval.actionType,
      toolCallId: basis.toolCallId, sideEffect: approval.payload })
    && basis.sideEffectFingerprint === approvalSideEffectFingerprintV1({ actionType: checkpoint.actionType,
      toolCallId: basis.toolCallId, sideEffect: checkpoint.sideEffect }));
}

export function isTeammateDirectRuntimeActive(run: RunSession, unit: WorkUnit, attempt: WorkUnitAttempt | undefined): boolean {
  return Boolean(attempt && unit.activeAttemptId === attempt.id && attempt.workUnitId === unit.id
    && !run.endedAt && !attempt.endedAt && !attempt.abortRequestedAt
    && ["queued", "running", "waiting_for_approval"].includes(run.status)
    && ["queued", "claimed", "running", "waiting_for_approval"].includes(unit.status)
    && ["created", "started", "waiting_for_approval"].includes(attempt.status));
}

export function runtimeAttemptIdentity(attempt: WorkUnitAttempt | undefined): unknown {
  return attempt ? { ...toRuntimeAttemptFence(attempt), runnerId: attempt.runnerId, effectiveRunnerId: attempt.effectiveRunnerId,
    status: attempt.status, endedAt: attempt.endedAt, abortRequestedAt: attempt.abortRequestedAt,
    errorCode: attempt.errorCode, errorMessage: attempt.errorMessage } : null;
}

const receiptHead = String.raw`(?:(?:好的|好)[，,\s]*)?(?:已)?收到(?:了)?`;
const receiptEcho = String.raw`(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?`;
const receiptEnd = String.raw`[。！？!?]`;
const receiptLine = new RegExp(String.raw`^${receiptHead}${receiptEcho}${receiptEnd}?[\t ]*(?:\r?\n)+`, "u");
const receiptSentence = new RegExp(String.raw`^${receiptHead}${receiptEcho}${receiptEnd}[\t ]*(?=\S)`, "u");
const receiptOnly = new RegExp(String.raw`^${receiptHead}${receiptEcho}${receiptEnd}?\s*$`, "u");
const receiptPartial = /^(?:好|好的|好的[，,\s]*|已|已收|收|收到(?:了)?(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?)$/u;

/** Shared receipt filtering; this is display text, never lifecycle or authorization evidence. */
export function projectTeammateDirectRuntimeReplyText(value: string): string {
  const source = value.trimStart();
  const leading = receiptLine.exec(source) ?? receiptSentence.exec(source);
  if (leading) return source.slice(leading[0].length).trimStart();
  if (receiptOnly.test(source) || receiptPartial.test(source)) return "";
  return value;
}
