import { setTimeout as delay } from "node:timers/promises";
import {
  DelegationCompletionBarrierError,
  type DelegationCompletionEvidenceV1,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { DelegationRuntimeRegistry } from "./runtime-registry.js";

/**
 * The SDK returning only ends model production. The original Host execution
 * remains alive until every descendant is physically finished and required
 * descendants have successful sealed results.
 * No model/tool is replayed by this observer. A restart uses durable recovery,
 * not this process-local Promise as evidence that the parent finished.
 */
export async function waitForRequiredDelegationCompletion(input: {
  readonly store: Pick<RunStore, "getDelegationCompletionEvidence" | "isCurrentRunExecutionOwner">;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly signal: AbortSignal;
  /** Failure/cancel still require physical completion, not required success. */
  readonly settlementOnly?: boolean;
  /** Diagnostics only; never used as a completion certificate. */
  readonly onChanged?: (evidence: DelegationCompletionEvidenceV1) => void;
}): Promise<void> {
  let previous: string | undefined;
  for (;;) {
    input.signal.throwIfAborted();
    if (!input.store.isCurrentRunExecutionOwner(input.runId, input.sourceFence, input.settlementOnly)) {
      throw Object.assign(new Error("delegation.source_attempt_stale"), { code: "delegation.source_attempt_stale" });
    }
    const evidence = input.store.getDelegationCompletionEvidence({ rootRunIds: [input.runId] });
    if (evidence.fingerprint !== previous) {
      previous = evidence.fingerprint;
      input.onChanged?.(evidence);
    }
    const allStopped = evidence.steps.every(({ step }) => ["succeeded", "failed", "cancelled"].includes(step.state));
    if (evidence.status === "satisfied" || input.settlementOnly && !evidence.issues.length && allStopped) return;
    if (input.settlementOnly && !evidence.issues.length
      && !evidence.steps.some(({ step }) => step.state === "lost")) {
      await delay(100, undefined, { signal: input.signal });
      continue;
    }
    if (evidence.status !== "pending") {
      throw new DelegationCompletionBarrierError(evidence.status, evidence.fingerprint);
    }
    // Event delivery can be lost. Polling always re-reads the canonical SQLite
    // facts, and abort tears down the timer without an orphaned background wait.
    // The caller's hard/absolute deadline watchdogs remain active throughout.
    await delay(100, undefined, { signal: input.signal });
  }
}

/** Original stop lifetime first; then re-read Host drain/effect/usage/result facts. */
export async function settleDelegationsForParentOutcome(input: {
  readonly store: RunStore;
  readonly registry?: Pick<DelegationRuntimeRegistry, "closeParent">;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly signal: AbortSignal;
  readonly onChanged?: (evidence: DelegationCompletionEvidenceV1) => void;
}): Promise<void> {
  const evidence = input.store.getDelegationCompletionEvidence({ rootRunIds: [input.runId] });
  // Ordinary/off installations have no dynamic Store enrollment. No canonical
  // descendants means there is nothing for that registry to stop; preserve
  // the exact-owner completion check below without creating new authority.
  if (evidence.issues.length || evidence.steps.length) await input.registry?.closeParent(input);
  await waitForRequiredDelegationCompletion({ ...input, settlementOnly: input.outcome !== "succeeded" });
}
