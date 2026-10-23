import type { RunProgressCheckpointBlockerCode, RunProgressCheckpointLineage, RunProgressCheckpointWitness } from "./run-progress-checkpoint-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

export type RunSuspensionCause = "daemon_restart" | "desktop_quit" | "process_signal";

/** Host intent only. Neither a stop receipt nor permission to resume a Runner. */
export interface RunSuspensionRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_request.v1";
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly cause: RunSuspensionCause;
  readonly contextDigest: string;
  readonly selectionDigest: string;
  readonly lineage: RunProgressCheckpointLineage;
  /** Audit watermark: the same source may finish in-flight work before sealing. */
  readonly requestedEventSeq: number;
  readonly requestedAt: string;
}

/** Exact existing checkpoint authority. A supplied boolean is never a witness. */
export interface RunSuspensionOrdinaryWitness {
  readonly kind: "ordinary";
  readonly checkpoint: RunProgressCheckpointWitness;
}

/** Existing committed compaction authority, not a synthetic ordinary head. */
export interface RunSuspensionCompactionWitness {
  readonly kind: "compaction";
  readonly checkpoint: {
    readonly checkpointId: string;
    readonly revision: number;
    readonly sourceEventSeq: number;
    readonly boundaryEventSeq: number;
    readonly summaryArtifactId: string;
    readonly summaryContentSha256: string;
    readonly contextSnapshotArtifactId: string;
    readonly contextSnapshotSha256: string;
    readonly installedEventSeq: number;
    readonly installedEventDigest: string;
    readonly sourceFence: RuntimeAttemptFenceV1;
    readonly lineage: RunProgressCheckpointLineage;
  };
}
/** Successful final SDK settlement is a separate immutable ledger, not a checkpoint. */
export interface RunSuspensionSettlementWitness {
  readonly kind: "settlement";
  readonly settlement: {
    readonly id: string;
    readonly artifactId: string;
    readonly digest: string;
    readonly modelViewArtifactId: string;
    readonly modelViewSha256: string;
    readonly boundaryEventSeq: number;
    readonly sourceFence: RuntimeAttemptFenceV1;
    readonly lineage: RunProgressCheckpointLineage;
  };
}
export type RunSuspensionWitness = RunSuspensionOrdinaryWitness | RunSuspensionCompactionWitness | RunSuspensionSettlementWitness;
export interface ReadRunCompactionSuspensionWitnessInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedLineage: RunProgressCheckpointLineage;
}
export type ReadRunCompactionSuspensionWitnessResult = {
  readonly kind: "verified";
  readonly witness: RunSuspensionCompactionWitness;
  readonly modelViewArtifactId: string;
  readonly modelView: readonly unknown[];
} | { readonly kind: "not_compacted" } | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };

/** Safe model-view boundary, still not evidence that Host effects or children stopped. */
export interface RunSuspensionSealV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_seal.v1";
  readonly suspensionId: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly requestDigest: string;
  readonly witness: RunSuspensionWitness;
  readonly modelViewArtifactId: string;
  readonly sealedAt: string;
}

export interface RunSuspensionRecord {
  readonly id: string;
  readonly state: "requested" | "sealed";
  readonly requestArtifactId: string;
  readonly requestDigest: string;
  readonly request: RunSuspensionRequestV1;
  readonly sealArtifactId?: string;
  readonly sealDigest?: string;
  readonly seal?: RunSuspensionSealV1;
}

export interface RequestRunSuspensionInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly cause: RunSuspensionCause;
  readonly expectedLineage: RunProgressCheckpointLineage;
  readonly now: string;
}

export interface SealRunSuspensionInput {
  readonly suspensionId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly witness: RunSuspensionWitness;
  readonly now: string;
}

export type RunSuspensionErrorCode =
  | "suspension.invalid_input" | "suspension.source_stale" | "suspension.request_conflict"
  | "suspension.missing" | "suspension.terminal_intent" | "suspension.context_changed"
  | "suspension.selection_changed" | "suspension.lineage_changed" | "suspension.snapshot_unverified"
  | "suspension.witness_mismatch" | "suspension.watermark_changed" | "suspension.unsupported_witness"
  | "suspension.artifact_invalid" | "suspension.pin_missing" | "suspension.commit_failed"
  | "suspension.admission_closed" | "suspension.schema_missing";

export class RunSuspensionError extends Error {
  constructor(readonly code: RunSuspensionErrorCode) { super(code); this.name = "RunSuspensionError"; }
}
