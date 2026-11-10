import type { HostOperationSource, RunStore } from "@ling-stack/core";
import { readPiProviderBoundaryInventory, type PiToolBoundaryObservation } from "@ling-stack/runner-pi";

/** Failure withholds handoff proof; it never changes execution policy or stop evidence. */
export function observeHostCompactionResourceBoundary(input: {
  readonly store: RunStore;
  readonly source: HostOperationSource;
  readonly observation: PiToolBoundaryObservation | undefined;
  readonly hostToolCallIds: readonly string[];
  readonly hostBoundaryUnverified: boolean;
}): void {
  if (input.hostBoundaryUnverified) return;
  const inventory = readPiProviderBoundaryInventory(input.observation, input.source.runId, input.source.attemptId);
  const checkpoint = input.store.getLatestRunCompactionCheckpoint(input.source.runId);
  if (!inventory || !checkpoint || checkpoint.attemptId !== input.source.attemptId) return;
  try {
    input.store.sealHostCompactionResourceBoundary({ source: input.source, checkpointId: checkpoint.id,
      inventory: { schemaVersion: 1, toolCallIds: [...new Set([...inventory.toolCallIds, ...input.hostToolCallIds])],
        settledBuiltinReads: inventory.settledBuiltinReads }, now: new Date().toISOString() });
  } catch {
    console.warn("host_compaction_boundary_unavailable: checkpoint resource handoff remains unverified");
  }
}
