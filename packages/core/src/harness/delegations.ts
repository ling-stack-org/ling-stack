import type { DelegationBudgetV1, DelegationStepState, DelegationStepV1 } from "@ling-stack/contracts";
import { assertNonNegativeSafeInteger, transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<DelegationStepState, ReadonlySet<DelegationStepState>>> = {
  planned: new Set(["spawning", "cancelled", "failed"]),
  spawning: new Set(["running", "failed", "cancelled", "lost"]),
  running: new Set(["waiting", "interrupting", "succeeded", "failed", "cancelled", "lost"]),
  waiting: new Set(["running", "interrupting", "succeeded", "failed", "cancelled", "lost"]),
  interrupting: new Set(["interrupted", "failed", "lost"]),
  interrupted: new Set(["resuming", "cancelled", "failed", "lost"]),
  resuming: new Set(["running", "failed", "cancelled", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

export function transitionDelegationStep(input: {
  readonly current: DelegationStepV1;
  readonly expectedRevision: number;
  readonly nextState: DelegationStepState;
  readonly now: string;
}): HarnessTransitionResult<DelegationStepV1> {
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
      ...(["succeeded", "failed", "cancelled", "lost"].includes(state) ? { completedAt: input.now } : {}),
    }),
  });
}

export function assertDelegationBudgetSubset(parent: DelegationBudgetV1, child: DelegationBudgetV1): void {
  for (const [field, childValue, parentValue] of [
    ["tokenBudget", child.tokenBudget, parent.tokenBudget],
    ["costBudgetMicros", child.costBudgetMicros, parent.costBudgetMicros],
    ["wallTimeBudgetMs", child.wallTimeBudgetMs, parent.wallTimeBudgetMs],
  ] as const) {
    assertNonNegativeSafeInteger(childValue, field);
    assertNonNegativeSafeInteger(parentValue, field);
    if (childValue !== undefined && parentValue !== undefined && childValue > parentValue) {
      throw new Error(`Delegation ${field} exceeds the parent budget.`);
    }
  }
}

/** Missing child limits inherit the parent; missing parent limits are uncapped. */
export function isUniqueStringSubset(parent: readonly string[], child: readonly string[]): boolean {
  const allowed = new Set(parent);
  return new Set(child).size === child.length && child.every((value) => allowed.has(value));
}

export function delegationIdempotencyKey(parentAttemptId: string, spawnCallId: string): string {
  return `delegation:${parentAttemptId}:${spawnCallId}`;
}
