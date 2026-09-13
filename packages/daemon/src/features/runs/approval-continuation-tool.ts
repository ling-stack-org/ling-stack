import {
  approvalSideEffectFingerprintV1,
  toRuntimeAttemptFence,
  type RunEventDataByType,
  type RunEventEmitter,
  type RunSession,
  type RunStore,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type {
  PiRunnerApprovedToolContinuation,
  PiRunnerApprovalRequest,
  PiRunnerToolHandledResult,
} from "@ling-stack/runner-pi";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { isRecord } from "../../shared/validation.js";
import { workflowStepExecutionOperationBindings } from "../channels/workflow-operation-evidence.js";
import { workflowExactCommandBindingRejection } from "./approvals.js";
import { executeUnifiedBashTool } from "./unified-exec.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";

/**
 * Execute an approved Host command at most once, or reuse its durable result
 * after restart, then return transcript evidence for the Agent continuation.
 */
export async function prepareApprovedToolContinuation(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly approvalId: string;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
}): Promise<PiRunnerApprovedToolContinuation> {
  const approval = input.store.getApprovalRequest(input.approvalId);
  const checkpoint = input.store.getApprovalCheckpointForApproval(input.approvalId);
  const basis = checkpoint?.resumeBasis;
  if (!approval
    || approval.status !== "approved"
    || !checkpoint
    || checkpoint.status !== "resume_pending"
    || !basis
    || approval.runId !== input.run.id
    || basis.runId !== input.run.id
    || basis.workUnitId !== input.workUnit.id
    || input.run.workUnitId !== input.workUnit.id
    || input.workUnit.activeAttemptId !== input.attempt.id
    || checkpoint.runnerResumeHandle?.attemptId !== input.attempt.id
    || !approval.toolCallId
    || approval.toolCallId !== basis.toolCallId
    || approval.actionType !== basis.actionType) {
    throw new Error("approval_resume_lineage_invalid");
  }
  const sideEffectFingerprint = approvalSideEffectFingerprintV1({
    actionType: approval.actionType,
    toolCallId: approval.toolCallId,
    sideEffect: approval.payload,
  });
  if (basis.sideEffectFingerprint !== sideEffectFingerprint) {
    throw new Error("approval_resume_mismatch");
  }
  if (approval.payload.type !== "bash") {
    throw new Error(`approval_resume_unsupported:${approval.payload.type}`);
  }
  const request: PiRunnerApprovalRequest = {
    toolCallId: approval.toolCallId,
    toolName: "bash",
    input: {
      command: approval.payload.command,
      cwd: approval.payload.cwd,
      timeoutMs: approval.payload.exec?.timeoutMs,
      idleTimeoutMs: approval.payload.exec?.idleTimeoutMs,
      pty: approval.payload.exec?.pty,
    },
    task: readTaskSnapshot(input.run),
    cwd: approval.payload.cwd,
    defaultApproval: "allow",
  };
  const phase = readApprovedToolPhase(input.store, input.run.id, approval.id, approval.toolCallId);
  if (phase.uncertain) throw new Error("approval_resume_effect_unknown");

  let result = phase.result;
  if (!result) {
    const workflowStep = input.run.workflowStepId
      ? input.store.getChannelWorkflowStep(input.run.workflowStepId)
      : undefined;
    const restrictedCommandRuntime = input.runtimeSupervisor.getRestrictedCommandRuntime();
    const bindingRejection = workflowExactCommandBindingRejection({
      bindings: workflowStep ? workflowStepExecutionOperationBindings(workflowStep) : undefined,
      request,
    });
    if (bindingRejection) throw new Error(`approval_resume_tool_mismatch:${bindingRejection}`);
    const effectRejection = workflowOperationEffectRejection({
      store: input.store,
      run: input.run,
      request,
      restrictedCommandRuntime,
    });
    if (effectRejection) throw new Error(`${effectRejection.code}:${effectRejection.reason}`);
    input.signal.throwIfAborted();
    input.appendAndMaybeStream("tool_start", {
      type: "tool_start",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      args: request.input,
      resumedFromApprovalId: approval.id,
      attemptId: input.attempt.id,
    } as RunEventDataByType["tool_start"]);
    result = await executeUnifiedBashTool({
      restrictedCommandRuntime,
      store: input.store,
      sourceFence: toRuntimeAttemptFence(input.attempt),
      run: input.run,
      request,
      approvalId: approval.id,
      appendAndMaybeStream: input.appendAndMaybeStream,
      signal: input.signal,
      extraSecrets: input.extraSecrets,
      shellSnapshotEnabled: input.shellSnapshotEnabled,
    });
    input.appendAndMaybeStream("tool_end", {
      type: "tool_end",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      result,
      isError: result.isError === true,
      resumedFromApprovalId: approval.id,
      attemptId: input.attempt.id,
    } as RunEventDataByType["tool_end"]);
  }

  return {
    schemaVersion: 1,
    kind: "approved_tool_result",
    approvalId: approval.id,
    sideEffectFingerprint,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    args: request.input,
    result,
    assistantText: phase.assistantText,
  };
}

function readApprovedToolPhase(
  store: RunStore,
  runId: string,
  approvalId: string,
  toolCallId: string,
): { readonly result?: PiRunnerToolHandledResult; readonly assistantText?: string; readonly uncertain: boolean } {
  let afterSeq = 0;
  let pending = false;
  let result: PiRunnerToolHandledResult | undefined;
  let assistantText: string | undefined;
  let approvalSeq = Number.POSITIVE_INFINITY;
  while (true) {
    const page = store.listEvents(runId, { afterSeq, limit: 1_000 });
    for (const event of page) {
      if (event.type === "approval_requested" && isRecord(event.data) && event.data.approvalId === approvalId) {
        approvalSeq = Math.min(approvalSeq, event.seq);
      }
      if (event.seq < approvalSeq && event.type === "message_end" && isRecord(event.data)
        && event.data.role === "assistant" && typeof event.data.text === "string" && event.data.text.trim()) {
        assistantText = event.data.text;
      }
      if ((event.type !== "tool_start" && event.type !== "tool_end") || !isRecord(event.data)
        || event.data.resumedFromApprovalId !== approvalId || event.data.toolCallId !== toolCallId) continue;
      if (event.type === "tool_start") {
        if (pending || result) return { assistantText, uncertain: true };
        pending = true;
        continue;
      }
      if (!pending || result || !isRecord(event.data.result) || !Array.isArray(event.data.result.content)) {
        return { assistantText, uncertain: true };
      }
      result = event.data.result as unknown as PiRunnerToolHandledResult;
      pending = false;
    }
    if (page.length < 1_000) break;
    afterSeq = page.at(-1)?.seq ?? afterSeq;
  }
  return { result, assistantText, uncertain: pending };
}

function readTaskSnapshot(run: RunSession): PiRunnerApprovalRequest["task"] {
  if (!isRecord(run.taskSnapshot)
    || typeof run.taskSnapshot.id !== "string"
    || typeof run.taskSnapshot.title !== "string"
    || typeof run.taskSnapshot.prompt !== "string") {
    throw new Error("approval_resume_task_snapshot_invalid");
  }
  return {
    id: run.taskSnapshot.id,
    title: run.taskSnapshot.title,
    prompt: run.taskSnapshot.prompt,
    channelId: typeof run.taskSnapshot.channelId === "string" ? run.taskSnapshot.channelId : undefined,
  };
}
