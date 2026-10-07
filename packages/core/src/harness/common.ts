export interface HarnessRevisioned {
  readonly revision: number;
}

export type HarnessTransitionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "stale_revision" | "invalid_transition" };

export function transitionHarnessEntity<T extends HarnessRevisioned, TState extends string>(input: {
  readonly current: T;
  readonly expectedRevision: number;
  readonly nextState: TState;
  readonly allowedNextStates: ReadonlySet<TState>;
  readonly update: (revision: number, nextState: TState) => T;
}): HarnessTransitionResult<T> {
  if (input.current.revision !== input.expectedRevision) {
    return { ok: false, code: "stale_revision" };
  }
  if (!input.allowedNextStates.has(input.nextState)) {
    return { ok: false, code: "invalid_transition" };
  }
  return { ok: true, value: input.update(input.current.revision + 1, input.nextState) };
}

export function isHarnessLeaseClaimable(input: {
  readonly now: string;
  readonly claimOwner?: string;
  readonly claimExpiresAt?: string;
  readonly nextAttemptAt?: string;
}): boolean {
  if (input.nextAttemptAt && input.nextAttemptAt > input.now) return false;
  return !input.claimOwner || !input.claimExpiresAt || input.claimExpiresAt <= input.now;
}

export function assertNonNegativeSafeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}
