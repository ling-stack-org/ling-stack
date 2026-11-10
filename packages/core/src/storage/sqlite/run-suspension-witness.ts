import { delegationFence, delegationId, delegationInteger, delegationRecord } from "../../harness/delegation-write-validation.js";
import type { RunProgressCheckpointLineage } from "../../run-progress-checkpoint-types.js";
import { RunSuspensionError, type RunSuspensionWitness } from "../../run-suspension-types.js";

const lineageKeys = ["workspaceId", "contextViewId", "contextViewCreatedAt", "providerPresetId", "providerName", "providerModel",
  "providerConfigurationFingerprint", "preparedExecutionFingerprint", "acceptedInstructionsFingerprint", "policySnapshotFingerprint",
  "policySourcesFingerprint", "workspaceProvenanceWatermark"];
const digest = (raw: unknown): string => {
  const value = delegationId(raw);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new RunSuspensionError("suspension.invalid_input");
  return value;
};

export function parseRunSuspensionLineage(raw: unknown): RunProgressCheckpointLineage {
  const row = delegationRecord(raw, lineageKeys);
  for (const key of lineageKeys) if (key !== "providerPresetId" || row[key] !== undefined) delegationId(row[key]);
  return { ...row } as unknown as RunProgressCheckpointLineage;
}

/** Leaf parser shared by live writers and immutable historical readers. */
export function parseRunSuspensionWitness(raw: unknown): RunSuspensionWitness {
  const kind = delegationRecord(raw, ["kind", "checkpoint", "settlement"]).kind;
  const value = delegationRecord(raw, kind === "settlement" ? ["kind", "settlement"] : ["kind", "checkpoint"]);
  if (value.kind === "settlement") {
    const row = delegationRecord(value.settlement, ["id", "artifactId", "digest", "modelViewArtifactId", "modelViewSha256", "boundaryEventSeq", "sourceFence", "lineage"]);
    const boundaryEventSeq = delegationInteger(row.boundaryEventSeq);
    if (!boundaryEventSeq) throw new RunSuspensionError("suspension.invalid_input");
    return { kind: "settlement", settlement: { id: delegationId(row.id), artifactId: delegationId(row.artifactId), digest: digest(row.digest),
      modelViewArtifactId: delegationId(row.modelViewArtifactId), modelViewSha256: digest(row.modelViewSha256), boundaryEventSeq,
      sourceFence: delegationFence(row.sourceFence), lineage: parseRunSuspensionLineage(row.lineage) } };
  }
  if (value.kind !== "ordinary" && value.kind !== "compaction") throw new RunSuspensionError("suspension.unsupported_witness");
  const row = delegationRecord(value.checkpoint, value.kind === "ordinary"
    ? ["checkpointId", "headRevision", "modelViewSha256", "sourceEventSeq", "sourceFence", "lineage"]
    : ["checkpointId", "revision", "sourceEventSeq", "boundaryEventSeq", "summaryArtifactId", "summaryContentSha256",
      "contextSnapshotArtifactId", "contextSnapshotSha256", "installedEventSeq", "installedEventDigest", "sourceFence", "lineage"]);
  const base = { checkpointId: delegationId(row.checkpointId), sourceEventSeq: delegationInteger(row.sourceEventSeq),
    sourceFence: delegationFence(row.sourceFence), lineage: parseRunSuspensionLineage(row.lineage) };
  if (value.kind === "ordinary") {
    const headRevision = delegationInteger(row.headRevision);
    if (!headRevision) throw new RunSuspensionError("suspension.invalid_input");
    return { kind: "ordinary", checkpoint: { ...base, headRevision, modelViewSha256: digest(row.modelViewSha256) } };
  }
  const revision = delegationInteger(row.revision), boundaryEventSeq = delegationInteger(row.boundaryEventSeq), installedEventSeq = delegationInteger(row.installedEventSeq);
  if (!revision || !base.sourceEventSeq || !installedEventSeq || boundaryEventSeq < base.sourceEventSeq || installedEventSeq > boundaryEventSeq)
    throw new RunSuspensionError("suspension.invalid_input");
  return { kind: "compaction", checkpoint: { ...base, revision, boundaryEventSeq,
    summaryArtifactId: delegationId(row.summaryArtifactId), summaryContentSha256: digest(row.summaryContentSha256),
    contextSnapshotArtifactId: delegationId(row.contextSnapshotArtifactId), contextSnapshotSha256: digest(row.contextSnapshotSha256),
    installedEventSeq, installedEventDigest: digest(row.installedEventDigest) } };
}

export const suspensionWitnessBoundary = (witness: RunSuspensionWitness): number =>
  witness.kind === "settlement" ? witness.settlement.boundaryEventSeq : witness.kind === "ordinary" ? witness.checkpoint.sourceEventSeq : witness.checkpoint.boundaryEventSeq;
export const suspensionWitnessModelDigest = (witness: RunSuspensionWitness): string =>
  witness.kind === "settlement" ? witness.settlement.modelViewSha256 : witness.kind === "ordinary" ? witness.checkpoint.modelViewSha256 : witness.checkpoint.summaryContentSha256;
export const suspensionWitnessIdentity = (witness: RunSuspensionWitness) => witness.kind === "settlement" ? witness.settlement : witness.checkpoint;
