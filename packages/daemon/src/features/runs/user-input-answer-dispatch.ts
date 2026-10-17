import { isDeepStrictEqual } from "node:util";
import { toRuntimeAttemptFence, type EffectiveRunPolicySnapshot, type RunStore, type RunSession,
  type UserInputContinuationBinding, type UserInputContinuationClaim, workflowStepStartOwnerMatches } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { prepareUserInputContinuationRequest } from "./user-input-prepared-request.js";
import { readUserInputSourceExecution } from "./user-input-source-execution.js";
import { readUserInputSourcePolicyIntent } from "./user-input-source-policy.js";
import type { UserInputPreparedExecution } from "./user-input-execution-preparation.js";
import { isRecord } from "../../shared/validation.js";
import { finalizeOrchestratedWorkflowStepRun } from "../channels/orchestrator.js";
import { completeWorkflowIfStepsFinished } from "../channels/workflow-completion.js";

export function prepareUserInputAnswerDispatch(store: RunStore, claim: UserInputContinuationClaim, now: string) {
  if (store.getUserInputContinuationBinding(claim.threadId, claim.deliveryId)) {
    throw new HttpError(409, "user_input_dispatch_already_admitted", "An admitted answer requires reconciliation, not another dispatch.");
  }
  const preparedRequest = prepareUserInputContinuationRequest(store, claim, now);
  const request = preparedRequest.request;
  const seed = store.getUserInputContinuationSeed(claim.threadId, claim.deliveryId);
  const source = seed && store.getRun(seed.source.runId);
  const thread = seed && store.getLingThread(seed.source.threadId);
  const turn = seed && store.getLingTurn(seed.source.turnId);
  const workUnit = seed && store.getWorkUnit(seed.source.fence.workUnitId);
  if (!seed || !source || !thread || !turn || !workUnit || !isRecord(source.requestSnapshot)) {
    throw new HttpError(409, "user_input_dispatch_source_missing", "Answer dispatch has no original source ownership.");
  }
  return { claim: structuredClone(claim), request, requestPreparationCreatedAt: preparedRequest.createdAt,
    seed, source, thread, turn, workUnit, sourceExecution: readUserInputSourceExecution(store, source, seed),
    policyIntent: readUserInputSourcePolicyIntent(source.requestSnapshot) };
}

export type UserInputAnswerDispatch = ReturnType<typeof prepareUserInputAnswerDispatch>;

export function admitUserInputAnswerDispatch(input: {
  readonly store: RunStore;
  readonly dispatch: UserInputAnswerDispatch;
  readonly prepared: UserInputPreparedExecution;
  readonly runtimeInstanceId: string;
  readonly policy: EffectiveRunPolicySnapshot;
  readonly workflowStartOwner?: import("@ling-stack/core").WorkflowStepStartOwnerV1;
  readonly now: string;
}) {
  const { store, dispatch } = input;
  const binding = store.admitUserInputContinuation({ ...dispatch.claim, executionRef: input.prepared.ref,
    runtimeInstanceId: input.runtimeInstanceId, effectivePolicySnapshot: input.policy,
    workflowStartOwner: input.workflowStartOwner }, input.now);
  const run = store.getRun(binding.runId), workUnit = store.getWorkUnit(binding.fence.workUnitId);
  const attempt = store.getWorkUnitAttempt(binding.fence.attemptId);
  if (!run || !workUnit || !attempt || !binding.effectivePolicySnapshot
    || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), binding.fence)) {
    throw new HttpError(409, "user_input_dispatch_binding_changed", "Admitted answer execution is no longer owned by this Host.");
  }
  return { binding, run, workUnit, attempt };
}

export function isFreshUserInputAnswerClaim(store: RunStore, binding: UserInputContinuationBinding, now: string): boolean {
  return store.readSnapshot(() => {
    const run = store.getRun(binding.runId), unit = store.getWorkUnit(binding.fence.workUnitId);
    const current = run?.threadId ? store.getUserInputContinuationBinding(run.threadId, binding.deliveryId) : undefined;
    const attempt = store.getWorkUnitAttempt(binding.fence.attemptId);
    const delivery = run?.threadId ? store.getUserInputDelivery(run.threadId, binding.deliveryId) : undefined;
    return isDeepStrictEqual(current, binding) && run?.status === "queued" && !run.endedAt
      && unit?.status === "claimed" && !unit.endedAt && unit.activeAttemptId === binding.fence.attemptId
      && unit.linkedRunId === binding.runId && attempt?.status === "created" && !attempt.abortRequestedAt
      && isDeepStrictEqual(toRuntimeAttemptFence(attempt), binding.fence)
      && delivery?.status === "claimed" && delivery.revision === binding.deliveryRevision
      && !!delivery.claim && delivery.claim.expiresAt > now;
  });
}

export function failUserInputAnswerStartup(store: RunStore, binding: UserInputContinuationBinding,
  code: string, message: string, now: string): void {
  const run = store.getRun(binding.runId);
  if (!run?.threadId) return;
  if (store.failUserInputContinuationStartup({ threadId: run.threadId, deliveryId: binding.deliveryId,
    bindingRef: { id: binding.id, fingerprint: binding.fingerprint }, sourceFence: binding.fence,
    errorCode: code, errorMessage: message }, now)) {
    store.appendEvent(run.id, "run_error", { code, message, origin: "user_input_continuation_startup" });
    if (run.workflowStepId && binding.workflowStartOwner) {
      const step = store.getChannelWorkflowStep(run.workflowStepId);
      if (step?.status === "skipped" && step.runId === run.id
        && workflowStepStartOwnerMatches(step.metadata?.startOwner, binding.workflowStartOwner)) {
        completeWorkflowIfStepsFinished(store, step.workflowId, now);
      }
    }
  }
}

export function finalizeUserInputAnswerWorkflow(store: RunStore, binding: UserInputContinuationBinding,
  run: RunSession, now: string): void {
  if (!run.workflowStepId || run.id !== binding.runId || !binding.workflowStartOwner) return;
  const step = store.getChannelWorkflowStep(run.workflowStepId);
  if (!step || step.runId !== run.id
    || !workflowStepStartOwnerMatches(step.metadata?.startOwner, binding.workflowStartOwner)) return;
  finalizeOrchestratedWorkflowStepRun(store, step.id, run.taskId, run, now);
}
