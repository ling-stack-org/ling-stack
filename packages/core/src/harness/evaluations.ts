import type { RunEvaluationState, RunEvaluationV1 } from "@ling-stack/contracts";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<RunEvaluationState, ReadonlySet<RunEvaluationState>>> = {
  queued: new Set(["claimed", "cancelled", "failed"]),
  claimed: new Set(["grading", "queued", "cancelled", "failed"]),
  grading: new Set(["completed", "queued", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function transitionRunEvaluation(input: {
  readonly current: RunEvaluationV1;
  readonly expectedRevision: number;
  readonly nextState: RunEvaluationState;
  readonly now: string;
}): HarnessTransitionResult<RunEvaluationV1> {
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
      ...(["completed", "failed", "cancelled"].includes(state) ? { completedAt: input.now } : {}),
    }),
  });
}

export function runEvaluationIdempotencyKey(input: {
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly candidateArtifactId: string;
}): string {
  return ["run-evaluation", input.runId, input.suiteId, input.suiteVersion, input.caseId, input.caseVersion, input.candidateArtifactId].join(":");
}
