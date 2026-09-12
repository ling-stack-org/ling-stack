import type { RunnerContinuationOrigin, RunnerContinuationState, RunnerContinuationV1 } from "@ling-stack/contracts";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<RunnerContinuationState, ReadonlySet<RunnerContinuationState>>> = {
  requested: new Set(["prepared", "cancelled", "failed", "superseded"]),
  prepared: new Set(["claimed", "cancelled", "failed", "superseded"]),
  claimed: new Set(["running", "recovery_pending", "cancelled", "failed", "superseded"]),
  running: new Set(["succeeded", "failed", "cancelled", "recovery_pending"]),
  recovery_pending: new Set(["prepared", "cancelled", "failed", "superseded"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

export function transitionRunnerContinuation(input: {
  readonly current: RunnerContinuationV1;
  readonly expectedRevision: number;
  readonly nextState: RunnerContinuationState;
  readonly now: string;
}): HarnessTransitionResult<RunnerContinuationV1> {
  return transitionHarnessEntity({
    current: input.current,
    expectedRevision: input.expectedRevision,
    nextState: input.nextState,
    allowedNextStates: transitions[input.current.state],
    update: (revision, state) => ({
      ...input.current,
      state,
      revision,
      updatedAt: input.now,
      ...(["succeeded", "failed", "cancelled", "superseded"].includes(state) ? { completedAt: input.now } : {}),
    }),
  });
}

export function runnerContinuationIdempotencyKey(input: {
  readonly runId: string;
  readonly sourceAttemptId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly generation: number;
}): string {
  return `runner-continuation:${input.runId}:${input.sourceAttemptId}:${input.origin}:${input.generation}`;
}
