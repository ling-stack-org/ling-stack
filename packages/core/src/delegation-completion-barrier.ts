import type { DelegationCompletionEvidenceV1 } from "./delegation-completion-evidence.js";

/** A model return is not a certificate that required descendants have finished. */
export class DelegationCompletionBarrierError extends Error {
  readonly code = "delegation.required_children_unsettled";
  constructor(readonly status: DelegationCompletionEvidenceV1["status"], readonly fingerprint: string) {
    super(`delegation.required_children_unsettled:${status}`);
    this.name = "DelegationCompletionBarrierError";
  }
}

export function assertDelegationCompletionSatisfied(evidence: DelegationCompletionEvidenceV1): void {
  if (evidence.status !== "satisfied") throw new DelegationCompletionBarrierError(evidence.status, evidence.fingerprint);
}
