import type { HarnessToolExecutionState, HarnessToolExecutionV1 } from "@ling-stack/contracts";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<HarnessToolExecutionState, ReadonlySet<HarnessToolExecutionState>>> = {
  proposed: new Set(["prepared", "cancelled", "failed", "superseded"]),
  prepared: new Set(["approval_pending", "approved", "cancelled", "failed", "superseded"]),
  approval_pending: new Set(["approved", "denied", "cancelled", "superseded"]),
  approved: new Set(["claimed", "cancelled", "failed", "superseded"]),
  claimed: new Set(["executing", "cancelled", "failed", "superseded", "unknown_outcome"]),
  executing: new Set(["committing_evidence", "cancelled", "failed", "unknown_outcome"]),
  committing_evidence: new Set(["succeeded", "failed", "unknown_outcome"]),
  succeeded: new Set(),
  denied: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
  unknown_outcome: new Set(),
};

export function transitionHarnessToolExecution(input: {
  readonly current: HarnessToolExecutionV1;
  readonly expectedRevision: number;
  readonly nextState: HarnessToolExecutionState;
  readonly now: string;
}): HarnessTransitionResult<HarnessToolExecutionV1> {
  return transitionHarnessEntity({
    current: input.current,
    expectedRevision: input.expectedRevision,
    nextState: input.nextState,
    allowedNextStates: transitions[input.current.state],
    update: (revision, state) => ({ ...input.current, state, revision, updatedAt: input.now }),
  });
}

export function harnessToolExecutionIdempotencyKey(attemptId: string, toolCallId: string): string {
  return `harness-tool:${attemptId}:${toolCallId}`;
}
