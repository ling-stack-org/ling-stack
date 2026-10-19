import { isDeepStrictEqual } from "node:util";
import type { RunStore, UserInputContinuationBinding, UserInputContinuationClaim,
  UserInputContinuationExecutionPlan } from "@ling-stack/core";
import { PiRunnerAdapter, readPreparedPiInput, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../context.js";
import { HttpError } from "../../errors.js";
import { readPreparedRunnerInput } from "./prepared-runner-input.js";

type ReceiverStore = Pick<RunStore, "getUserInputContinuationBinding" | "getUserInputContinuationPreparation"
  | "getUserInputContinuationReceipt" | "acknowledgeUserInputContinuation" | "getRun" | "getWorkUnit" | "getWorkUnitAttempt">;

/**
 * Attaches the verified receiver to a newly admitted physical execution, not to a
 * historical Run. Caller still owns current permission/resource and startup CAS.
 * No public route may accept arbitrary binding/fence/ACK input.
 */
export function withUserInputContinuationReceiver(input: {
  readonly store: ReceiverStore;
  readonly threadId: string;
  readonly binding: UserInputContinuationBinding;
  readonly claim: UserInputContinuationClaim;
  readonly adapter: RunnerAdapter;
  readonly options: PiRunnerRunOptions;
  readonly now?: () => string;
  readonly onAccepted?: (acceptedAt: string) => void | Promise<void>;
}): PiRunnerRunOptions {
  const { store, threadId, options } = input;
  const reject = (code: string): never => { throw new HttpError(409, code, "User input continuation cannot enter this receiver."); };
  if (!(input.adapter instanceof PiRunnerAdapter)) return reject("user_input_receiver_unverified");
  if (options.onPreparedInputAccepted !== undefined) return reject("user_input_receiver_conflict");
  const binding = store.getUserInputContinuationBinding(threadId, input.binding.deliveryId);
  if (!binding || !isDeepStrictEqual(binding, input.binding)) return reject("user_input_binding_changed");
  if (store.getUserInputContinuationReceipt(threadId, binding.deliveryId)) return reject("user_input_already_received");
  const prepared = store.getUserInputContinuationPreparation(threadId, binding.deliveryId, "execution");
  const plan = prepared?.payload as UserInputContinuationExecutionPlan | undefined;
  const run = store.getRun(binding.runId), unit = store.getWorkUnit(binding.fence.workUnitId);
  const attempt = store.getWorkUnitAttempt(binding.fence.attemptId);
  if (!prepared || prepared.id !== binding.executionRef.id || prepared.fingerprint !== binding.executionRef.fingerprint || plan?.runnerId !== "pi"
    || !run || run.status !== "queued" || !unit || unit.status !== "claimed" || unit.activeAttemptId !== binding.fence.attemptId
    || unit.linkedRunId !== binding.runId || !attempt || attempt.status !== "created") return reject("user_input_receiver_not_fresh");
  const preparedInput = readPreparedPiInput(plan.preparedInput);
  const execution = readPreparedRunnerInput(plan.runnerExecutionInput, { cwd: run.cwd, task: options.task });
  if (execution.runnerId !== plan.runnerId || !isDeepStrictEqual(execution.preparedInput, preparedInput)) {
    return reject("user_input_receiver_input_changed");
  }
  if (preparedInput.fingerprint !== plan.preparedInputFingerprint || options.cwd !== run.cwd
    || !isDeepStrictEqual(json(options.task), plan.taskSnapshot) || options.provider.provider !== plan.providerName || options.provider.model !== plan.providerModel
    || options.runId !== undefined && options.runId !== binding.runId
    || options.runnerAttemptId !== undefined && options.runnerAttemptId !== binding.fence.attemptId
    || options.preparedInput !== undefined && readPreparedPiInput(options.preparedInput).fingerprint !== preparedInput.fingerprint) {
    return reject("user_input_receiver_input_changed");
  }
  return { ...options, runId: binding.runId, runnerAttemptId: binding.fence.attemptId, preparedInput,
    onPreparedInputAccepted: (receipt, signal) => {
      signal.throwIfAborted();
      const acceptedAt = input.now?.() ?? new Date().toISOString();
      const accepted = store.acknowledgeUserInputContinuation({ threadId, deliveryId: binding.deliveryId,
        bindingRef: { id: binding.id, fingerprint: binding.fingerprint }, sourceFence: binding.fence,
        claim: { ownerId: input.claim.ownerId, claimToken: input.claim.claimToken }, receipt },
      acceptedAt);
      // Read-only ACK replay is valid audit/recovery, never permission to send the model twice.
      if (accepted.replayed) return reject("user_input_already_received");
      signal.throwIfAborted();
      return input.onAccepted?.(acceptedAt);
    } };
}
function json(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
