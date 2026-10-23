import type { RunCompactionCheckpointBlockerCode } from "@ling-stack/contracts";
import {
  captureRunProgressCheckpointLineage,
  RunProgressCheckpointError,
  type EffectiveRunPolicySnapshot,
  type RunProgressCheckpointBlockerCode,
  type RunSession,
  type RunStore,
  type RunSuspensionCompactionWitness,
  type RuntimeAttemptFenceV1,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import { commitRunCompactionProgress } from "./run-compaction-progress.js";
import { samePersistedSdkView } from "./run-ordinary-progress.js";

export type CompactedRunSuspensionProgressResult =
  | { readonly kind: "not_compacted" }
  | { readonly kind: "sealed"; readonly witness: RunSuspensionCompactionWitness }
  | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode | RunCompactionCheckpointBlockerCode };

/** A compacted source keeps its own checkpoint authority, never an ordinary head.
 * No-new-tool boundaries still reread the entire durable view and watermark.
 * This grants neither physical stop nor recovery/dispatch authority.
 */
export function sealRunCompactionSuspensionBoundary(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attempt: WorkUnitAttempt;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly modelView: readonly unknown[] | undefined;
  readonly activeToolCallIds: readonly string[];
  readonly allowRecoveredAttemptHandoff?: boolean;
}): CompactedRunSuspensionProgressResult {
  if (!input.store.getLatestRunCompactionStart(input.run.id)) return { kind: "not_compacted" };
  if (!Array.isArray(input.modelView)) return blocked("checkpoint.snapshot_unavailable");
  if (input.activeToolCallIds.length > 0) return blocked("checkpoint.effect_unknown");
  // The existing producer owns genuine new tool rounds. In particular, do not
  // invent a zero-tool progress checkpoint just to advance a turn marker.
  const progress = commitRunCompactionProgress(input);
  if (progress.kind === "blocked") return progress;
  try {
    const current = input.store.getRun(input.run.id);
    if (!current) return blocked("checkpoint.lineage_mismatch");
    const { lineage } = captureRunProgressCheckpointLineage(input.store, current, input.policySnapshot);
    const verified = input.store.readRunCompactionSuspensionWitness({ runId: current.id,
      sourceFence: input.sourceFence, expectedLineage: lineage });
    if (verified.kind === "not_compacted") return blocked("checkpoint.lineage_mismatch");
    if (verified.kind === "blocked") return verified;
    if (!samePersistedSdkView(verified.modelView, input.modelView)) return blocked("checkpoint.lineage_mismatch");
    return { kind: "sealed", witness: structuredClone(verified.witness) };
  } catch (error) {
    if (error instanceof RunProgressCheckpointError) return blocked(error.code);
    throw error;
  }
}

function blocked(code: RunProgressCheckpointBlockerCode): CompactedRunSuspensionProgressResult {
  return { kind: "blocked", code };
}
