import type { DelegationBudgetV1, DelegationStepState, DelegationStepV1 } from "@ling-stack/contracts";
import { assertNonNegativeSafeInteger, transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

export const DELEGATION_LEGACY_READ_LIMIT = 1000;
export const DELEGATION_QUERY_DEFAULT_LIMIT = 200;
export const DELEGATION_QUERY_MAX_LIMIT = 1000;

/** Exclusive BINARY ordering position for live discovery, never execution authority. */
export interface DelegationQueryCursorV1 {
  readonly schemaVersion: 1;
  readonly kind: "children" | "messages";
  readonly scopeId: string;
  readonly createdAt: string;
  readonly id: string;
}

export interface DelegationQueryPageInput {
  readonly limit?: number;
  readonly after?: DelegationQueryCursorV1;
}

/** Row-bounded live discovery; neither a byte bound nor a stable subtree snapshot. */
export interface DelegationQueryPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: DelegationQueryCursorV1;
}

export type DelegationReadErrorCode = "read_limit_exceeded" | "invalid_read_input" | "invalid_persisted_row";

/** Read failures are not persisted DelegationFailureCode values or step transitions. */
export class DelegationReadError extends Error {
  readonly kind = "read_error";

  constructor(readonly code: DelegationReadErrorCode, message: string) {
    super(message);
    this.name = "DelegationReadError";
  }
}

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
