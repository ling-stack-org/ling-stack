import type { ExecutionAction, RunArtifact, RunEventEnvelope } from "@ling-stack/core";

/** These Host-only receipts are neither deliverables nor downloadable Run evidence. */
export function isPrivateHostRecoveryArtifact(artifact: Pick<RunArtifact, "contentType">): boolean {
  return artifact.contentType === "application/vnd.ling.native-file-mutation-completion+json"
    || artifact.contentType === "application/vnd.ling.host-compaction-resource-boundary+json";
}

/** Artifact metadata may cross HTTP; sealed Host recovery payloads may not. */
export function toPublicArtifactMetadata({ sealedPayload: _sealedPayload, contentSha256: _contentSha256, ...artifact }: RunArtifact): Omit<RunArtifact, "sealedPayload" | "contentSha256"> {
  return artifact;
}

/** Project legacy and new Run events at every public egress, without rewriting Host history. */
export function projectPublicRunEventEnvelope(envelope: RunEventEnvelope): RunEventEnvelope {
  if (envelope.type !== "artifact_created" || !isRecord(envelope.data.artifact)) return envelope;
  const { sealedPayload: _sealedPayload, contentSha256: _contentSha256, ...artifact } = envelope.data.artifact;
  return { ...envelope, data: { ...envelope.data, artifact } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Internal run storage is durable evidence, not a workspace deliverable. */
export function isWorkspaceDeliverableArtifact(artifact: Pick<RunArtifact, "path" | "runId">): boolean {
  const path = artifact.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return !(
    path === ".ling-stack" || path.startsWith(".ling-stack/") ||
    (artifact.runId && path.startsWith(`${artifact.runId}/`)) ||
    path.startsWith("harness/") || path.startsWith("workflows/") ||
    path.startsWith("automation-context/") || path.startsWith("external-work/")
  );
}

type ArtifactOwner = Pick<ExecutionAction, "actionType" | "runId" | "resultArtifactIds">;

function isOwnedEditDiffArtifact(artifact: RunArtifact, actions: readonly ArtifactOwner[]): boolean {
  if (!artifact.runId || artifact.type !== "diff" || !/^text\/x-diff(?:;|$)/iu.test(artifact.contentType ?? "")) return false;
  const path = artifact.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!path.startsWith(`${artifact.runId}/`) || !/\.(?:diff|patch)$/iu.test(path) || path.split("/").includes("..")) return false;
  return actions.filter((action) =>
    (action.actionType === "edit" || action.actionType === "write") &&
    action.runId === artifact.runId && action.resultArtifactIds.includes(artifact.id)).length === 1;
}

/** Conversation DTOs expose deliverables and uniquely edit-owned diffs, never sealed Host payloads. */
export function projectConversationArtifacts(artifacts: readonly RunArtifact[], actions: readonly ArtifactOwner[] = []): RunArtifact[] {
  return artifacts
    .filter((artifact) => !isPrivateHostRecoveryArtifact(artifact))
    .filter((artifact) => isWorkspaceDeliverableArtifact(artifact) || isOwnedEditDiffArtifact(artifact, actions))
    .map(toPublicArtifactMetadata);
}
