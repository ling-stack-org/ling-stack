import { randomUUID } from "node:crypto";
import {
  approvalSideEffectFingerprintV1,
  digestHarnessToolValue,
  type EffectiveRunPolicySnapshot,
  type RunArtifact,
  type RunEventEmitter,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
  type UnifiedExecResult,
} from "@ling-stack/core";
import type {
  HarnessMode,
  HarnessToolExecutionFailureCode,
  HarnessToolExecutionV1,
} from "@ling-stack/contracts";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import type { NativeRestrictedCommandRuntime } from "../../../runtime/sandbox/restricted-command-runtime.js";
import { isRecord } from "../../../shared/validation.js";
import { createUnifiedExecDeniedResult, executeUnifiedBashTool } from "../../runs/unified-exec.js";

const TOOL_EXECUTION_LEASE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface HarnessBashToolContext {
  readonly mode: HarnessMode;
  readonly store: RunStore;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly approvalId?: string;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
}

export async function executeHarnessedBashTool(input: HarnessBashToolContext & {
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
}): Promise<PiRunnerToolHandledResult> {
  if (input.mode === "off") return executeUnifiedBashTool(input);
  let execution: HarnessToolExecutionV1 | undefined;
  try {
    execution = prepareApprovedExecution(input);
    if (isTerminal(execution.state)) {
      return createUnifiedExecDeniedResult({
        toolCallId: input.request.toolCallId,
        approvalId: input.approvalId,
        reason: `tool_execution_already_terminal: ${execution.state}`,
      });
    }
    if (execution.state === "approval_pending") {
      return createUnifiedExecDeniedResult({
        toolCallId: input.request.toolCallId,
        approvalId: input.approvalId,
        reason: "tool_approval_pending: Tool execution cannot start before its durable approval is resolved.",
      });
    }
    execution = claimExecution(input, execution);
    const started = input.store.startHarnessToolExecution({
      executionId: execution.id,
      expectedRevision: execution.revision,
      claimOwner: execution.claimOwner!,
      claimToken: execution.claimToken!,
      sourceFence: input.sourceFence,
      now: new Date().toISOString(),
    });
    if (!started.ok) throw brokerMutationError("start", started.code);
    execution = started.value;
  } catch (error) {
    if (input.mode === "shadow" && execution === undefined
      && !input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId)) {
      return executeUnifiedBashTool(input);
    }
    return createUnifiedExecDeniedResult({
      toolCallId: input.request.toolCallId,
      approvalId: input.approvalId,
      reason: `tool_broker_prepare_failed: ${formatError(error)}`,
    });
  }
  if (!execution) {
    return createUnifiedExecDeniedResult({
      toolCallId: input.request.toolCallId,
      approvalId: input.approvalId,
      reason: "tool_broker_prepare_failed: Tool execution identity was not created.",
    });
  }

  let durableResult: PiRunnerToolHandledResult | undefined;
  const commitDurableResult = (handled: PiRunnerToolHandledResult): void => {
    durableResult = handled;
    finishFromHandledResult(input, execution, handled);
  };
  try {
    const handled = await executeUnifiedBashTool({
      ...input,
      onDurableResult: commitDurableResult,
    });
    if (!durableResult) commitDurableResult(handled);
    return handled;
  } catch (error) {
    const current = input.store.getHarnessToolExecution(execution.id);
    if (current && !isTerminal(current.state)) {
      commitUnknownOutcome(input, current, durableResult, error);
    }
    throw error;
  }
}

export function prepareHarnessBashApproval(input: HarnessBashToolContext & {
  readonly approvalState: "approval_pending" | "denied";
  readonly failureCode?: Extract<HarnessToolExecutionFailureCode, "tool.policy_denied" | "tool.approval_denied">;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}): HarnessToolExecutionV1 | undefined {
  if (input.mode === "off") return undefined;
  try {
    const basis = prepareBasis(input);
    return input.store.prepareHarnessToolExecution({
      ...basis,
      approvalState: input.approvalState,
      failureCode: input.failureCode,
      resultSummary: input.resultSummary,
    }).execution;
  } catch (error) {
    if (input.mode === "enforce") throw error;
    return undefined;
  }
}

export function resolveHarnessBashApproval(input: HarnessBashToolContext & {
  readonly nextState: "approved" | "denied" | "cancelled";
  readonly failureCode?: Extract<HarnessToolExecutionFailureCode, "tool.approval_denied" | "tool.execution_cancelled">;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}): HarnessToolExecutionV1 | undefined {
  if (input.mode === "off") return undefined;
  if (!input.approvalId) {
    if (input.mode === "enforce") throw new Error("tool_approval_identity_missing");
    return undefined;
  }
  const current = input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId);
  if (!current) {
    if (input.mode === "enforce") throw new Error("tool_execution_identity_missing");
    return undefined;
  }
  const resolved = input.store.resolveHarnessToolApproval({
    executionId: current.id,
    expectedRevision: current.revision,
    approvalId: input.approvalId,
    nextState: input.nextState,
    failureCode: input.failureCode,
    resultSummary: input.resultSummary,
    now: new Date().toISOString(),
  });
  if (!resolved.ok) {
    if (input.mode === "enforce") throw brokerMutationError("resolve_approval", resolved.code);
    return undefined;
  }
  return resolved.value;
}

export function failHarnessBashBeforeExecution(input: HarnessBashToolContext & {
  readonly failureCode: HarnessToolExecutionFailureCode;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}): HarnessToolExecutionV1 | undefined {
  if (input.mode === "off") return undefined;
  const current = input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId);
  if (!current) {
    if (input.mode === "enforce") throw new Error("tool_execution_identity_missing");
    return undefined;
  }
  const failed = input.store.failApprovedHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    sourceFence: input.sourceFence,
    nextState: input.failureCode === "tool.stale_attempt" ? "superseded" : "failed",
    failureCode: input.failureCode,
    resultSummary: input.resultSummary,
    now: new Date().toISOString(),
  });
  if (!failed.ok) {
    if (input.mode === "enforce") throw brokerMutationError("fail_before_execution", failed.code);
    return undefined;
  }
  return failed.value;
}

export function harnessToolBrokerModeForRun(run: RunSession): HarnessMode {
  if (!isRecord(run.requestSnapshot) || !isRecord(run.requestSnapshot.harnessFeatureSnapshot)) return "off";
  const mode = run.requestSnapshot.harnessFeatureSnapshot.toolBroker;
  return mode === "shadow" || mode === "enforce" ? mode : "off";
}

export function effectivePolicySnapshotForHarnessRun(run: RunSession): EffectiveRunPolicySnapshot | undefined {
  if (!isRecord(run.requestSnapshot) || !isRecord(run.requestSnapshot.effectivePolicySnapshot)) return undefined;
  return run.requestSnapshot.effectivePolicySnapshot as unknown as EffectiveRunPolicySnapshot;
}

function prepareApprovedExecution(input: HarnessBashToolContext): HarnessToolExecutionV1 {
  const existing = input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId);
  if (existing) return existing;
  return input.store.prepareHarnessToolExecution({
    ...prepareBasis(input),
    approvalState: "allowed",
  }).execution;
}

function prepareBasis(input: HarnessBashToolContext) {
  const policySnapshot = input.effectivePolicySnapshot ?? effectivePolicySnapshotForHarnessRun(input.run);
  if (!policySnapshot) throw new Error("tool_policy_snapshot_missing");
  const requestDigest = digestHarnessToolValue({
    schemaVersion: 1,
    toolName: input.request.toolName,
    toolCallId: input.request.toolCallId,
    cwd: input.request.cwd,
    input: input.request.input,
  });
  const approval = input.approvalId ? input.store.getApprovalRequest(input.approvalId) : undefined;
  const sideEffectFingerprint = approval
    ? approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: input.request.toolCallId,
        sideEffect: approval.payload,
      })
    : digestHarnessToolValue({
        schemaVersion: 1,
        toolName: input.request.toolName,
        toolCallId: input.request.toolCallId,
        cwd: input.request.cwd,
        input: input.request.input,
      });
  const priorApprovalExecution = input.approvalId
    ? input.store.listHarnessToolExecutions(input.run.id)
        .filter((candidate) => candidate.approvalId === input.approvalId
          && candidate.toolCallId === input.request.toolCallId
          && candidate.attemptId !== input.sourceFence.attemptId
          && candidate.state !== "superseded")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0]
    : undefined;
  if (priorApprovalExecution && !["approval_pending", "approved"].includes(priorApprovalExecution.state)) {
    throw new Error(`tool_prior_execution_blocks_retry:${priorApprovalExecution.state}`);
  }
  const policySnapshotArtifact = ensurePolicySnapshotArtifact({
    store: input.store,
    run: input.run,
    attemptId: input.sourceFence.attemptId,
    toolCallId: input.request.toolCallId,
    requestDigest,
    sideEffectFingerprint,
    mode: input.mode,
    policySnapshot,
  });
  return {
    runId: input.run.id,
    workUnitId: input.sourceFence.workUnitId,
    sourceFence: input.sourceFence,
    supersedesExecutionId: priorApprovalExecution?.id,
    toolCallId: input.request.toolCallId,
    toolName: input.request.toolName,
    executorKind: "bash" as const,
    requestDigest,
    sideEffectFingerprint,
    policySnapshotArtifactId: policySnapshotArtifact.id,
    approvalId: input.approvalId,
    sandboxProfileId: `platform-native:${policySnapshot.workspaceAccessMode ?? policySnapshot.mode}`,
    now: new Date().toISOString(),
  };
}

function ensurePolicySnapshotArtifact(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly requestDigest: string;
  readonly sideEffectFingerprint: string;
  readonly mode: HarnessMode;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
}): RunArtifact {
  const sealedPayload = {
    schemaVersion: 1,
    runId: input.run.id,
    attemptId: input.attemptId,
    toolCallId: input.toolCallId,
    executorKind: "bash",
    brokerMode: input.mode,
    requestDigest: input.requestDigest,
    sideEffectFingerprint: input.sideEffectFingerprint,
    effectivePolicySnapshot: input.policySnapshot,
  };
  const identity = digestHarnessToolValue(sealedPayload);
  const artifactId = `artifact_harness_tool_policy_${identity.slice(0, 32)}`;
  const existing = input.store.getArtifact(artifactId);
  if (existing) {
    if (existing.runId !== input.run.id || digestHarnessToolValue(existing.sealedPayload) !== identity) {
      throw new Error("tool_policy_snapshot_identity_conflict");
    }
    return existing;
  }
  try {
    return input.store.createArtifact({
      id: artifactId,
      runId: input.run.id,
      type: "json",
      path: `harness/tool-executions/${safeSegment(input.attemptId)}/${safeSegment(input.toolCallId)}/policy.json`,
      title: "Harness tool policy snapshot",
      contentType: "application/json",
      sealedPayload,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const raced = input.store.getArtifact(artifactId);
    if (raced?.runId === input.run.id && digestHarnessToolValue(raced.sealedPayload) === identity) return raced;
    throw error;
  }
}

function claimExecution(input: HarnessBashToolContext, current: HarnessToolExecutionV1): HarnessToolExecutionV1 {
  if (current.state !== "approved" && current.state !== "claimed") {
    throw new Error(`tool_execution_not_claimable:${current.state}`);
  }
  const now = new Date();
  const timeout = readTimeoutMs(input.request.input) ?? DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  const claimed = input.store.claimHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    claimOwner: `daemon:${process.pid}`,
    claimToken: `tool-claim:${randomUUID()}`,
    claimExpiresAt: new Date(now.getTime() + timeout + TOOL_EXECUTION_LEASE_GRACE_MS).toISOString(),
    sourceFence: input.sourceFence,
    now: now.toISOString(),
  });
  if (!claimed.ok) throw brokerMutationError("claim", claimed.code);
  return claimed.value;
}

function finishFromHandledResult(
  input: HarnessBashToolContext,
  execution: HarnessToolExecutionV1,
  handled: PiRunnerToolHandledResult,
): void {
  const result = readUnifiedResult(handled);
  const current = input.store.getHarnessToolExecution(execution.id);
  if (!current || isTerminal(current.state)) return;
  const blockers = input.store.listHostCommandWriteBlockers(input.run.cwd)
    .filter((blocker) => blocker.toolCallId === input.request.toolCallId && blocker.attemptId === input.sourceFence.attemptId);
  const outcome = blockers.length > 0
    ? { state: "unknown_outcome" as const, failureCode: "tool.unknown_side_effect_outcome" as const }
    : outcomeForUnifiedResult(result);
  const finished = input.store.finishHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    claimOwner: current.claimOwner!,
    claimToken: current.claimToken!,
    sourceFence: input.sourceFence,
    nextState: outcome.state,
    resultDigest: digestHarnessToolValue(result),
    resultSummary: boundedUnifiedResultSummary(result, blockers.map((item) => item.executionId)),
    evidenceArtifactIds: result.artifacts.map((artifact) => artifact.artifactId),
    failureCode: outcome.failureCode,
    now: new Date().toISOString(),
  });
  if (!finished.ok) throw brokerMutationError("finish", finished.code);
}

function commitUnknownOutcome(
  input: HarnessBashToolContext,
  current: HarnessToolExecutionV1,
  durableResult: PiRunnerToolHandledResult | undefined,
  error: unknown,
): void {
  if (current.state !== "executing" || !current.claimOwner || !current.claimToken) return;
  const result = durableResult ? readUnifiedResult(durableResult) : undefined;
  const finished = input.store.finishHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    claimOwner: current.claimOwner,
    claimToken: current.claimToken,
    sourceFence: input.sourceFence,
    nextState: "unknown_outcome",
    resultDigest: digestHarnessToolValue(result ?? { error: formatError(error) }),
    resultSummary: result
      ? boundedUnifiedResultSummary(result, ["evidence_commit_failed"])
      : { status: "unknown_outcome", reason: "executor_or_evidence_commit_failed" },
    evidenceArtifactIds: result?.artifacts.map((artifact) => artifact.artifactId) ?? [],
    failureCode: "tool.unknown_side_effect_outcome",
    now: new Date().toISOString(),
  });
  if (!finished.ok && input.mode === "enforce") throw brokerMutationError("commit_unknown_outcome", finished.code);
}

function outcomeForUnifiedResult(result: UnifiedExecResult): {
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly failureCode?: HarnessToolExecutionFailureCode;
} {
  if (result.status === "succeeded") return { state: "succeeded" };
  if (result.cancelled || result.status === "cancelled") {
    return { state: "cancelled", failureCode: "tool.execution_cancelled" };
  }
  if (result.timedOut || result.status === "timed_out") {
    return { state: "failed", failureCode: "tool.execution_timeout" };
  }
  return { state: "failed", failureCode: "tool.executor_failed" };
}

function boundedUnifiedResultSummary(result: UnifiedExecResult, blockers: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    status: blockers.length > 0 ? "unknown_outcome" : result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    stdoutBytes: result.stdout.byteCount,
    stderrBytes: result.stderr.byteCount,
    artifactCount: result.artifacts.length,
    ...(blockers.length > 0 ? { writeBlockerExecutionIds: blockers } : {}),
  };
}

function readUnifiedResult(handled: PiRunnerToolHandledResult): UnifiedExecResult {
  const details = handled.details;
  if (!isRecord(details) || !isRecord(details.unifiedExec)) throw new Error("tool_executor_result_invalid");
  return details.unifiedExec as unknown as UnifiedExecResult;
}

function readTimeoutMs(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.timeoutMs !== "number" || !Number.isSafeInteger(value.timeoutMs)) return undefined;
  return value.timeoutMs > 0 ? value.timeoutMs : undefined;
}

function isTerminal(state: HarnessToolExecutionV1["state"]): boolean {
  return ["succeeded", "denied", "failed", "cancelled", "superseded", "unknown_outcome"].includes(state);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 160) || "unknown";
}

function brokerMutationError(operation: string, code: string): Error {
  return new Error(`tool_broker_${operation}_failed:${code}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
