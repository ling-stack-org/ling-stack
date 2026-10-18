import { createHash } from "node:crypto";
import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { HostAttemptEffectInventory } from "./host-attempt-completion-types.js";

export interface SealHostCompactionResourceBoundaryInput {
  readonly source: HostOperationSource;
  readonly checkpointId: string;
  /** Original live SDK boundary inventory, not an execution-completion observation. */
  readonly inventory: HostAttemptEffectInventory;
  readonly now: string;
}

export function hostCompactionResourceBoundaryArtifactId(source: HostOperationSource, checkpointId: string): string {
  const identity = [source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken, checkpointId];
  return `artifact_compaction_resource_boundary_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
