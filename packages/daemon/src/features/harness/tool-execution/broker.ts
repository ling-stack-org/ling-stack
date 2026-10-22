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
} from "@ling-stack/core";
import type {
  HarnessMode,
  HarnessToolExecutorKind,
  HarnessToolExecutionFailureCode,
  HarnessToolExecutionV1,
} from "@ling-stack/contracts";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import type { NativeRestrictedCommandRuntime } from "../../../runtime/sandbox/restricted-command-runtime.js";
import type { HostCommandOperation, HostFileMutationOperation } from "../../../runtime/host-operation-effects.js";
import { isRecord } from "../../../shared/validation.js";
import {
  appendExecutionActionArtifactEvents,
  createExecutionActionResultArtifact,
} from "../../runs/action-artifacts.js";
import { applyPatchActionDraft } from "../../runs/patch-actions.js";
import { createUnifiedExecDeniedResult, executeUnifiedBashTool } from "../../runs/unified-exec.js";
import {
  createFileMutationRecoveryBasis,
  type FileMutationActionDraft,
  type FileMutationRecoveryBasis,
} from "./executors/file-mutation.js";
import { recordNativeFileMutationCompletion } from "./native-file-mutation-completion.js";
import { readBrokerCommandResult, type BrokerCommandResult } from "./broker-command-result.js";

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

export interface HarnessFileMutationToolContext {
  readonly mode: HarnessMode;
  readonly store: RunStore;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly draft: FileMutationActionDraft;
  readonly allowedWritePaths: readonly string[];
  readonly approvalId?: string;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly previewArtifactIds?: readonly string[];
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly requireExistingParentsForAdds?: boolean;
  readonly hostOperation?: HostFileMutationOperation;
  /** Observe actual native completion for checkpoint handoff; never enables Broker enforcement. */
  readonly recordCompactionBoundaryEvidence?: boolean;
}

export interface HarnessToolContext extends HarnessBashToolContext {
  readonly executorKind: HarnessToolExecutorKind;
  readonly recoveryBasis?: FileMutationRecoveryBasis;
}

interface HarnessBashExecutionInput extends HarnessBashToolContext {
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
  readonly hostOperation?: HostCommandOperation;
}

export async function executeHarnessedBashTool(input: HarnessBashExecutionInput): Promise<PiRunnerToolHandledResult> {
  let dispatched = false;
  let settlementAttempted = false;
  const execute = (executionInput: Parameters<typeof executeUnifiedBashTool>[0]) => {
    dispatched = true;
    return executeUnifiedBashTool(executionInput);
  };
  const settleBeforeDispatch = (): void => {
    if (dispatched || settlementAttempted || !input.hostOperation) return;
    settlementAttempted = true;
    try { input.hostOperation.settleNoStart(); }
    catch (error) {
      try { input.hostOperation.markUnknown("command_execution_unconfirmed"); } catch { /* fail closed */ }
      throw error;
    }
  };
  try {
    input.hostOperation?.assertMayPrepare();
    const result = await executeHarnessedBashToolInternal(input, execute);
    settleBeforeDispatch();
    return result;
  } catch (error) {
    try { settleBeforeDispatch(); } catch { /* preserve the original broker failure */ }
    throw error;
  }
}

async function executeHarnessedBashToolInternal(
  input: HarnessBashExecutionInput,
  execute: typeof executeUnifiedBashTool,
): Promise<PiRunnerToolHandledResult> {
  if (input.mode === "off") return execute(input);
  let execution: HarnessToolExecutionV1 | undefined;
  const context: HarnessToolContext = { ...input, executorKind: "bash" };
  try {
    execution = prepareApprovedExecution(context);
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
    assertPolicySnapshotCurrent(context);
    execution = claimExecution(context, execution);
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
    if (execution?.state === "approved") {
      failExecutionBeforeStart(context, execution, "tool.policy_denied", { reason: formatError(error) });
    }
    if (input.mode === "shadow" && execution === undefined
      && !input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId)) {
      return execute(input);
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
    const handled = await execute({
      ...input,
      onDurableResult: commitDurableResult,
    });
    if (!durableResult) commitDurableResult(handled);
    return handled;
  } catch (error) {
    const current = input.store.getHarnessToolExecution(execution.id);
    if (current && !isTerminal(current.state)) {
      commitUnknownOutcome(context, current, durableResult, error);
    }
    throw error;
  }
}

export async function executeHarnessedFileMutationTool(
  input: HarnessFileMutationToolContext,
): Promise<PiRunnerToolHandledResult> {
  input.hostOperation?.assertMayPrepare();
  if (input.mode === "off") {
    return input.hostOperation
      ? createFileMutationDeniedResult(input, "host_file_broker_evidence_required: Tracked file mutation requires an exact durable Broker receipt.")
      : executeFileMutationDirectly(input);
  }
  if (!input.sourceFence) {
    return createFileMutationDeniedResult(input, "stale_run_execution: File mutation requires the captured source Attempt.");
  }
  const context: HarnessToolContext = {
    mode: input.mode,
    store: input.store,
    sourceFence: input.sourceFence,
    run: input.run,
    request: input.request,
    approvalId: input.approvalId,
    effectivePolicySnapshot: input.effectivePolicySnapshot,
    executorKind: input.draft.executorKind,
    recoveryBasis: createFileMutationRecoveryBasis(input.draft),
  };
  let execution: HarnessToolExecutionV1 | undefined;
  try {
    execution = prepareApprovedExecution(context);
    input.hostOperation?.bindHarnessExecution(execution.id);
    const blocked = executionStartRejection(input, execution);
    if (blocked) return blocked;
    assertPolicySnapshotCurrent(context);
    input.hostOperation?.assertMayPrepare();
    execution = claimExecution(context, execution);
    execution = startExecution(context, execution);
  } catch (error) {
    if (execution?.state === "approved") {
      failExecutionBeforeStart(context, execution, "tool.policy_denied", { reason: formatError(error) });
    }
    if (!input.hostOperation && input.mode === "shadow" && execution === undefined
      && !input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId)) {
      return executeFileMutationDirectly(input);
    }
    return createFileMutationDeniedResult(input, `tool_broker_prepare_failed: ${formatError(error)}`);
  }

  try {
    const applied = await applyPatchActionDraft({
      draft: input.draft,
      cwd: input.request.cwd,
      allowedWritePaths: input.allowedWritePaths,
      previewArtifactIds: input.previewArtifactIds,
      provenance: {
        store: input.store,
        run: input.run,
        executionId: execution.id,
        toolCallId: input.request.toolCallId,
        approvalId: input.approvalId,
      },
      signal: input.signal,
      requireExistingParentsForAdds: input.requireExistingParentsForAdds,
      effectGuard: input.hostOperation?.effectGuard,
    });
    const resultArtifact = createFileMutationResultEvidence(input, execution, applied.resultArtifactContent);
    if (!resultArtifact) throw new Error("tool_evidence_result_artifact_missing");
    const evidenceArtifactIds = [...new Set([...applied.evidenceArtifactIds, resultArtifact.id])];
    const resultSummary = fileMutationResultSummary(applied.handledResult, applied.outcome, evidenceArtifactIds.length);
    const outcome = fileMutationExecutionOutcome(applied.handledResult, applied.outcome);
    finishExecution(context, execution, {
      nextState: outcome.state,
      failureCode: outcome.failureCode,
      resultDigest: digestHarnessToolValue(resultSummary),
      resultSummary,
      evidenceArtifactIds,
    });
    recordNativeFileMutationCompletion(input, applied);
    return applied.handledResult;
  } catch (error) {
    const current = input.store.getHarnessToolExecution(execution.id);
    if (current && !isTerminal(current.state)) {
      commitUnknownOutcome(context, current, undefined, error);
    }
    throw error;
  }
}

export function createFileMutationDeniedResult(
  input: Pick<HarnessFileMutationToolContext, "request" | "approvalId">,
  reason: string,
): PiRunnerToolHandledResult {
  const separator = reason.indexOf(":");
  const code = separator > 0 ? reason.slice(0, separator) : undefined;
  return {
    isError: true,
    content: [{ type: "text", text: reason }],
    details: {
      status: "denied",
      toolCallId: input.request.toolCallId,
      approvalId: input.approvalId,
      reason,
      ...(code ? { code } : {}),
    },
  };
}

export function prepareHarnessBashApproval(input: HarnessBashToolContext & {
  readonly approvalState: "approval_pending" | "denied";
  readonly failureCode?: Extract<HarnessToolExecutionFailureCode, "tool.policy_denied" | "tool.approval_denied">;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}): HarnessToolExecutionV1 | undefined {
  return prepareHarnessToolApproval({ ...input, executorKind: "bash" });
}

export function prepareHarnessToolApproval(input: HarnessToolContext & {
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
  return resolveHarnessToolApproval({ ...input, executorKind: "bash" });
}

export function resolveHarnessToolApproval(input: HarnessToolContext & {
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
  return failHarnessToolBeforeExecution({ ...input, executorKind: "bash" });
}

export function failHarnessToolBeforeExecution(input: HarnessToolContext & {
  readonly failureCode: HarnessToolExecutionFailureCode;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
}): HarnessToolExecutionV1 | undefined {
  if (input.mode === "off") return undefined;
  const current = input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId);
  if (!current) {
    if (input.mode === "enforce") throw new Error("tool_execution_identity_missing");
    return undefined;
  }
  try {
    return failExecutionBeforeStart(input, current, input.failureCode, input.resultSummary);
  } catch (error) {
    if (input.mode === "enforce") throw error;
    return undefined;
  }
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

function prepareApprovedExecution(input: HarnessToolContext): HarnessToolExecutionV1 {
  const existing = input.store.findHarnessToolExecution(input.sourceFence.attemptId, input.request.toolCallId);
  if (existing) return existing;
  return input.store.prepareHarnessToolExecution({
    ...prepareBasis(input),
    approvalState: "allowed",
  }).execution;
}

function prepareBasis(input: HarnessToolContext) {
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
    executorKind: input.executorKind,
    recoveryBasis: input.recoveryBasis,
  });
  return {
    runId: input.run.id,
    workUnitId: input.sourceFence.workUnitId,
    sourceFence: input.sourceFence,
    supersedesExecutionId: priorApprovalExecution?.id,
    toolCallId: input.request.toolCallId,
    toolName: input.request.toolName,
    executorKind: input.executorKind,
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
  readonly executorKind: HarnessToolExecutorKind;
  readonly recoveryBasis?: FileMutationRecoveryBasis;
}): RunArtifact {
  const sealedPayload = {
    schemaVersion: 1,
    runId: input.run.id,
    attemptId: input.attemptId,
    toolCallId: input.toolCallId,
    executorKind: input.executorKind,
    brokerMode: input.mode,
    requestDigest: input.requestDigest,
    sideEffectFingerprint: input.sideEffectFingerprint,
    effectivePolicySnapshot: input.policySnapshot,
    ...(input.recoveryBasis ? { fileMutationRecovery: input.recoveryBasis } : {}),
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

function claimExecution(input: HarnessToolContext, current: HarnessToolExecutionV1): HarnessToolExecutionV1 {
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

function startExecution(input: HarnessToolContext, execution: HarnessToolExecutionV1): HarnessToolExecutionV1 {
  const started = input.store.startHarnessToolExecution({
    executionId: execution.id,
    expectedRevision: execution.revision,
    claimOwner: execution.claimOwner!,
    claimToken: execution.claimToken!,
    sourceFence: input.sourceFence,
    now: new Date().toISOString(),
  });
  if (!started.ok) throw brokerMutationError("start", started.code);
  return started.value;
}

function executionStartRejection(
  input: Pick<HarnessFileMutationToolContext, "request" | "approvalId">,
  execution: HarnessToolExecutionV1,
): PiRunnerToolHandledResult | undefined {
  if (isTerminal(execution.state)) {
    return createFileMutationDeniedResult(input, `tool_execution_already_terminal: ${execution.state}`);
  }
  if (execution.state === "approval_pending") {
    return createFileMutationDeniedResult(
      input,
      "tool_approval_pending: Tool execution cannot start before its durable approval is resolved.",
    );
  }
  return undefined;
}

function assertPolicySnapshotCurrent(input: HarnessToolContext): void {
  const snapshot = input.effectivePolicySnapshot ?? effectivePolicySnapshotForHarnessRun(input.run);
  if (!snapshot) throw new Error("tool_policy_snapshot_missing");
  if (input.store.getApprovalPolicy().updatedAt !== snapshot.workspacePolicyUpdatedAt) {
    throw new Error("tool_policy_changed: Workspace policy changed after this Run captured its execution authority.");
  }
}

function failExecutionBeforeStart(
  input: HarnessToolContext,
  current: HarnessToolExecutionV1,
  failureCode: HarnessToolExecutionFailureCode,
  resultSummary?: Readonly<Record<string, unknown>>,
): HarnessToolExecutionV1 {
  const failed = input.store.failApprovedHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    sourceFence: input.sourceFence,
    nextState: failureCode === "tool.stale_attempt" ? "superseded" : "failed",
    failureCode,
    resultSummary,
    now: new Date().toISOString(),
  });
  if (!failed.ok) throw brokerMutationError("fail_before_execution", failed.code);
  return failed.value;
}

async function executeFileMutationDirectly(input: HarnessFileMutationToolContext): Promise<PiRunnerToolHandledResult> {
  input.hostOperation?.assertMayPrepare();
  const applied = await applyPatchActionDraft({
    draft: input.draft,
    cwd: input.request.cwd,
    allowedWritePaths: input.allowedWritePaths,
    previewArtifactIds: input.previewArtifactIds,
    provenance: {
      store: input.store,
      run: input.run,
      toolCallId: input.request.toolCallId,
      approvalId: input.approvalId,
    },
    signal: input.signal,
    requireExistingParentsForAdds: input.requireExistingParentsForAdds,
    effectGuard: input.hostOperation?.effectGuard,
  });
  if (input.approvalId) createFileMutationResultEvidence(input, undefined, applied.resultArtifactContent);
  recordNativeFileMutationCompletion(input, applied);
  return applied.handledResult;
}

function createFileMutationResultEvidence(
  input: HarnessFileMutationToolContext,
  execution: HarnessToolExecutionV1 | undefined,
  content: string,
): RunArtifact | undefined {
  const approval = input.approvalId ? input.store.getApprovalRequest(input.approvalId) : undefined;
  if (approval) {
    const artifact = createExecutionActionResultArtifact({
      store: input.store,
      run: input.run,
      approval,
      filename: "patch-result.json",
      type: "json",
      title: `Patch result: ${input.draft.plan.touchedPaths.join(", ")}`,
      contentType: "application/json",
      content,
      now: new Date().toISOString(),
      sealedPayload: JSON.parse(content) as unknown,
    });
    appendExecutionActionArtifactEvents({
      artifacts: [artifact],
      approval,
      role: "result",
      appendAndMaybeStream: input.appendAndMaybeStream,
    });
    return artifact;
  }
  if (!execution) return undefined;
  const sealedPayload = JSON.parse(content) as unknown;
  const artifactId = `artifact_harness_tool_result_${safeSegment(execution.id)}`;
  const existing = input.store.getArtifact(artifactId);
  if (existing) return existing;
  return input.store.createArtifact({
    id: artifactId,
    runId: input.run.id,
    type: "json",
    path: `harness/tool-executions/${safeSegment(execution.attemptId)}/${safeSegment(execution.toolCallId)}/result.json`,
    title: `Harness file mutation result: ${input.request.toolName}`,
    contentType: "application/json",
    sealedPayload,
    createdAt: new Date().toISOString(),
  });
}

function fileMutationResultSummary(
  handled: PiRunnerToolHandledResult,
  outcome: "applied" | "not_applied" | "rolled_back" | "diverged",
  artifactCount: number,
): Readonly<Record<string, unknown>> {
  const details = isRecord(handled.details) ? handled.details : {};
  return {
    status: typeof details.status === "string" ? details.status : handled.isError ? "failed" : "applied",
    outcome,
    touchedPaths: Array.isArray(details.touchedPaths)
      ? details.touchedPaths.filter((path): path is string => typeof path === "string").slice(0, 256)
      : [],
    artifactCount,
    cancelled: details.cancelled === true,
  };
}

function fileMutationExecutionOutcome(
  handled: PiRunnerToolHandledResult,
  outcome: "applied" | "not_applied" | "rolled_back" | "diverged",
): {
  readonly state: "succeeded" | "failed" | "cancelled" | "unknown_outcome";
  readonly failureCode?: HarnessToolExecutionFailureCode;
} {
  if (outcome === "applied" && handled.isError !== true) return { state: "succeeded" };
  if (outcome === "diverged") return { state: "unknown_outcome", failureCode: "tool.unknown_side_effect_outcome" };
  if (isRecord(handled.details) && handled.details.cancelled === true) {
    return { state: "cancelled", failureCode: "tool.execution_cancelled" };
  }
  return { state: "failed", failureCode: "tool.executor_failed" };
}

function finishExecution(
  input: HarnessToolContext,
  execution: HarnessToolExecutionV1,
  result: {
    readonly nextState: "succeeded" | "failed" | "cancelled" | "unknown_outcome";
    readonly resultDigest: string;
    readonly resultSummary: Readonly<Record<string, unknown>>;
    readonly evidenceArtifactIds: readonly string[];
    readonly failureCode?: HarnessToolExecutionFailureCode;
  },
): void {
  const current = input.store.getHarnessToolExecution(execution.id);
  if (!current || isTerminal(current.state)) return;
  const finished = input.store.finishHarnessToolExecution({
    executionId: current.id,
    expectedRevision: current.revision,
    claimOwner: current.claimOwner!,
    claimToken: current.claimToken!,
    sourceFence: input.sourceFence,
    nextState: result.nextState,
    resultDigest: result.resultDigest,
    resultSummary: result.resultSummary,
    evidenceArtifactIds: result.evidenceArtifactIds,
    failureCode: result.failureCode,
    now: new Date().toISOString(),
  });
  if (!finished.ok) throw brokerMutationError("finish", finished.code);
}

function finishFromHandledResult(
  input: HarnessBashToolContext,
  execution: HarnessToolExecutionV1,
  handled: PiRunnerToolHandledResult,
): void {
  const result = readUnifiedResult(handled, input);
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
    evidenceArtifactIds: result.denied ? [] : result.artifacts.map((artifact) => artifact.artifactId),
    failureCode: outcome.failureCode,
    now: new Date().toISOString(),
  });
  if (!finished.ok) throw brokerMutationError("finish", finished.code);
}

function commitUnknownOutcome(
  input: HarnessToolContext,
  current: HarnessToolExecutionV1,
  durableResult: PiRunnerToolHandledResult | undefined,
  error: unknown,
): void {
  if (current.state !== "executing" || !current.claimOwner || !current.claimToken) return;
  let result: BrokerCommandResult | undefined;
  if (durableResult) {
    try { result = readUnifiedResult(durableResult, input); }
    catch (invalid) {
      if (!(invalid instanceof Error) || invalid.message !== "tool_executor_result_invalid") throw invalid;
      // Do not parse the same malformed result again while recording failure.
      // Without a validated result, retain unknown outcome and its original error.
    }
  }
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
    evidenceArtifactIds: result && !result.denied ? result.artifacts.map((artifact) => artifact.artifactId) : [],
    failureCode: "tool.unknown_side_effect_outcome",
    now: new Date().toISOString(),
  });
  if (!finished.ok && input.mode === "enforce") throw brokerMutationError("commit_unknown_outcome", finished.code);
}

function outcomeForUnifiedResult(result: BrokerCommandResult): {
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly failureCode?: HarnessToolExecutionFailureCode;
} {
  if (result.denied) return { state: "failed", failureCode: "tool.policy_denied" };
  if (result.status === "succeeded") return { state: "succeeded" };
  if (result.cancelled || result.status === "cancelled") {
    return { state: "cancelled", failureCode: "tool.execution_cancelled" };
  }
  if (result.timedOut || result.status === "timed_out") {
    return { state: "failed", failureCode: "tool.execution_timeout" };
  }
  return { state: "failed", failureCode: "tool.executor_failed" };
}

function boundedUnifiedResultSummary(result: BrokerCommandResult, blockers: readonly string[]): Readonly<Record<string, unknown>> {
  if (result.denied) return { status: blockers.length ? "unknown_outcome" : "failed", denied: true, reason: result.reason.slice(0, 2_000),
    ...(blockers.length ? { writeBlockerExecutionIds: blockers } : {}) };
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

function readUnifiedResult(handled: PiRunnerToolHandledResult, input: HarnessBashToolContext): BrokerCommandResult {
  return readBrokerCommandResult(handled, { runId: input.run.id, taskId: input.run.taskId,
    toolCallId: input.request.toolCallId, approvalId: input.approvalId });
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
