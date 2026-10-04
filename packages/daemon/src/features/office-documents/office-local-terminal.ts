import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalTerminalManifest } from "@ling-stack/core";
import type { OfficeLocalWriteState } from "./office-local-authority.js";

type TerminalFacts = Pick<HostOfficeLocalTerminalManifest,
  "outcome" | "publicationEntered" | "members" | "resources" | "workspace" | "completedAt">;

/**
 * Capture the original Host owner roster, not a parsed writer summary. SQLite
 * independently checks the full effect set again under its original pair lock.
 * Creating this immutable artifact does not grant safe or execution authority.
 */
export function createOfficeLocalTerminalArtifact(state: OfficeLocalWriteState, facts: TerminalFacts): {
  readonly artifactId: string; readonly digest: string;
} {
  const execution = state.store.getHostOfficeLocalExecution(state.execution.executionId);
  if (!execution || execution.identityDigest !== state.identityDigest) throw new Error("office_local_terminal_execution_invalid");
  const effects = state.store.listHostOfficeLocalEffects(execution.executionId).map(effect => {
    const observation = effect.observationArtifactId ? state.store.getArtifact(effect.observationArtifactId) : undefined;
    if (effect.observationArtifactId && (!observation?.contentSha256 || observation.runId !== execution.source.runId)) {
      throw new Error("office_local_terminal_effect_invalid");
    }
    return { ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest,
      enteredAt: effect.enteredAt ?? null,
      observation: observation ? { artifactId: observation.id, digest: observation.contentSha256! } : null };
  });
  const manifest: HostOfficeLocalTerminalManifest = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL,
    kind: "office_local_terminal_v1", executionId: execution.executionId, executionIdentityDigest: state.identityDigest,
    source: state.execution.source, preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest,
    ...facts, effects };
  const artifact = state.store.createArtifact({ runId: execution.source.runId, type: "json",
    path: `office/${execution.executionId}/terminal.json`, createdAt: facts.completedAt, sealedPayload: manifest });
  if (!artifact.contentSha256) throw new Error("office_local_terminal_artifact_invalid");
  return { artifactId: artifact.id, digest: artifact.contentSha256 };
}
