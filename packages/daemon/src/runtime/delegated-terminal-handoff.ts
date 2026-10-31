import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";

declare const handoffBrand: unique symbol;
export interface DelegatedTerminalHandoff { readonly [handoffBrand]: true }
type Phase = "capture" | "settled";
const handoffs = new WeakMap<DelegatedTerminalHandoff, {
  readonly source: AttemptExecutionSource;
  readonly verify: (phase: Phase) => void;
}>();

/** Constructor-private composition port. The observer owns the original
 * Store/claim/intent; no JSON receipt or completion Promise authorizes this. */
export function createDelegatedTerminalHandoff(source: AttemptExecutionSource,
  verify: (phase: Phase) => void): DelegatedTerminalHandoff {
  const reference = Object.freeze(Object.create(null) as DelegatedTerminalHandoff);
  handoffs.set(reference, { source: Object.freeze({ ...source }), verify });
  return reference;
}

/** Capture is intent-only; settled must be checked after all real finalizers. */
export function verifyDelegatedTerminalHandoff(reference: unknown, source: AttemptExecutionSource, phase: Phase): void {
  const original = reference && typeof reference === "object" ? handoffs.get(reference as DelegatedTerminalHandoff) : undefined;
  if (!original || Object.keys(original.source).some(key => original.source[key as keyof AttemptExecutionSource]
    !== source[key as keyof AttemptExecutionSource])) throw new Error("runtime_terminal_handoff_source_unverified");
  original.verify(phase);
}
