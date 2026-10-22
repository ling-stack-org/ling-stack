import { setTimeout as delay } from "node:timers/promises";
import {
  DelegationCompletionBarrierError,
  type DelegationCompletionEvidenceV1,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";

/**
 * The SDK returning only ends model production. The original Host execution
 * remains alive until its required descendants have real sealed results.
 * No model/tool is replayed by this observer. A restart uses durable recovery,
 * not this process-local Promise as evidence that the parent finished.
 */
export async function waitForRequiredDelegationCompletion(input: {
  readonly store: Pick<RunStore, "getDelegationCompletionEvidence" | "isCurrentRunExecutionOwner">;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly signal: AbortSignal;
  /** Diagnostics only; never used as a completion certificate. */
  readonly onChanged?: (evidence: DelegationCompletionEvidenceV1) => void;
}): Promise<void> {
  let previous: string | undefined;
  for (;;) {
    input.signal.throwIfAborted();
    if (!input.store.isCurrentRunExecutionOwner(input.runId, input.sourceFence)) {
      throw Object.assign(new Error("delegation.source_attempt_stale"), { code: "delegation.source_attempt_stale" });
    }
    const evidence = input.store.getDelegationCompletionEvidence({ rootRunIds: [input.runId] });
    if (evidence.fingerprint !== previous) {
      previous = evidence.fingerprint;
      input.onChanged?.(evidence);
    }
    if (evidence.status === "satisfied") return;
    if (evidence.status !== "pending") {
      throw new DelegationCompletionBarrierError(evidence.status, evidence.fingerprint);
    }
    // Event delivery can be lost. Polling always re-reads the canonical SQLite
    // facts, and abort tears down the timer without an orphaned background wait.
    // The caller's hard/absolute deadline watchdogs remain active throughout.
    await delay(100, undefined, { signal: input.signal });
  }
}
