import { isDeepStrictEqual as same } from "node:util";
import { delegationTimestamp, toRuntimeAttemptFence, type RootRunSuspensionActivationRecord,
  type RootRunSuspensionStartObservationV1, type RunStore } from "@ling-stack/core";
import { PiRunnerAdapter, readPreparedPiInput, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../../context.js";
import { HttpError } from "../../../errors.js";
import { readStoredRunnerExecution } from "../../runs/existing-run-request.js";
import { inlineProviderDescriptor } from "../../conversations/normal-conversation-prepared-provider.js";
import type { PreparedRunnerContinuationExecution } from "./coordinator.js";

const reject = (code = "suspension_start.receiver_unverified"): never => {
  throw new HttpError(409, code, "Stopped-root recovery requires its original prepared-input receiver.");
};

/** Constructor-owned receiver. A serialized receipt alone never grants a start. */
export function createRootSuspensionDispatchAuthority() {
  const observations = new WeakMap<object, RootRunSuspensionStartObservationV1>();
  return Object.freeze({
    readStartObservation(reference: unknown): RootRunSuspensionStartObservationV1 {
      const value = reference && typeof reference === "object" ? observations.get(reference) : undefined;
      if (!value) return reject();
      return structuredClone(value);
    },
    withReceiver(input: {
      readonly store: RunStore;
      readonly record: RootRunSuspensionActivationRecord;
      readonly execution: PreparedRunnerContinuationExecution;
      readonly adapter: RunnerAdapter;
      readonly options: PiRunnerRunOptions;
      readonly now: () => string;
      readonly onAccepted: (reference: object, at: string) => void | Promise<void>;
    }): PiRunnerRunOptions {
      if (!(input.adapter instanceof PiRunnerAdapter) || input.options.onPreparedInputAccepted !== undefined) return reject();
      const activation = structuredClone(input.record.activation), execution = input.execution;
      const run = input.store.getRun(activation.runId), frozen = run && readStoredRunnerExecution(run);
      if (!run || !frozen || frozen.runnerId !== "pi") return reject();
      const prepared = readPreparedPiInput(frozen.preparedInput);
      const assertTarget = (): void => {
        const current = input.store.getRun(activation.runId), unit = input.store.getWorkUnit(activation.targetFence.workUnitId);
        const attempt = input.store.getWorkUnitAttempt(activation.targetFence.attemptId);
        const continuation = input.store.getRunnerContinuation(activation.continuationId);
        if (!current || current.parentRunId || current.status !== "running" || current.endedAt
          || current.workUnitId !== activation.targetFence.workUnitId || !same(current.requestSnapshot, run.requestSnapshot)
          || !unit || unit.status !== "claimed" || unit.endedAt || unit.linkedRunId !== current.id
          || unit.activeAttemptId !== activation.targetFence.attemptId || !attempt || attempt.status !== "created"
          || attempt.endedAt || attempt.abortRequestedAt || !same(toRuntimeAttemptFence(attempt), activation.targetFence)
          || !continuation || continuation.state !== "claimed" || continuation.revision !== execution.continuation.revision
          || continuation.claimOwner !== execution.claimOwner || continuation.claimToken !== execution.claimToken
          || continuation.targetAttemptId !== attempt.id || continuation.runId !== current.id
          || execution.continuation.id !== activation.continuationId || !same(toRuntimeAttemptFence(execution.attempt), activation.targetFence)
          || !same(readStoredRunnerExecution(current), frozen)) return reject();
      };
      assertTarget();
      const options = input.options;
      if (options.cwd !== run.cwd || options.task.id !== run.taskId || !same(JSON.parse(JSON.stringify(options.task)), frozen.input.task)
        || !same(JSON.parse(JSON.stringify(inlineProviderDescriptor(options.provider))), frozen.input.provider)
        || options.runId !== undefined && options.runId !== run.id
        || options.runnerAttemptId !== undefined && options.runnerAttemptId !== activation.targetFence.attemptId
        || options.preparedInput !== undefined && readPreparedPiInput(options.preparedInput).fingerprint !== prepared.fingerprint) return reject();
      let accepted = false;
      return { ...options, runId: run.id, runnerAttemptId: activation.targetFence.attemptId, preparedInput: prepared,
        async onPreparedInputAccepted(receipt, signal) {
          signal.throwIfAborted();
          if (accepted) return reject("suspension_start.already_received");
          assertTarget();
          if (receipt.schemaVersion !== 1 || receipt.boundary !== "pi-session-ready" || receipt.runId !== run.id
            || receipt.attemptId !== activation.targetFence.attemptId || receipt.taskId !== run.taskId
            || receipt.preparedInputFingerprint !== prepared.fingerprint) return reject();
          const at = delegationTimestamp(input.now()), reference = Object.freeze(Object.create(null) as object);
          observations.set(reference, Object.freeze({ schemaVersion: 1, kind: "run.suspension_start_observation.v1",
            activationId: activation.id, runId: run.id, targetFence: Object.freeze({ ...activation.targetFence }),
            continuationId: activation.continuationId, taskId: run.taskId, preparedInputFingerprint: prepared.fingerprint,
            runnerId: "pi", observationId: `pi-session:${activation.targetFence.attemptId}:${prepared.fingerprint}`, observedAt: at }));
          accepted = true;
          try { await input.onAccepted(reference, at); signal.throwIfAborted(); }
          finally { observations.delete(reference); }
        } };
    },
  });
}
