import { createHash } from "node:crypto";
import type { PatchActionApplyOutput } from "../../runs/patch-actions.js";
import type { HarnessFileMutationToolContext } from "./broker.js";

export const NATIVE_FILE_MUTATION_COMPLETION_TYPE = "application/vnd.ling.native-file-mutation-completion+json";

/** Called only with the actual Host patch executor's completed output, not SDK text. */
export function recordNativeFileMutationCompletion(
  input: HarnessFileMutationToolContext, applied: PatchActionApplyOutput,
): void {
  if (!input.recordCompactionBoundaryEvidence || !input.sourceFence || applied.outcome !== "applied"
    || applied.handledResult.isError === true) return;
  try {
    const source = { runId: input.run.id, ...input.sourceFence };
    if (!input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence, true)) return;
    const payload = {
      schemaVersion: 1,
      boundary: "native-file-mutation-completion",
      source,
      toolCallId: input.request.toolCallId,
      toolName: input.request.toolName,
      outcome: applied.outcome,
      rawPatchSha256: input.draft.plan.rawPatchSha256,
      touchedPaths: [...input.draft.plan.touchedPaths],
      provenanceArtifactIds: applied.evidenceArtifactIds.filter(id => !input.previewArtifactIds?.includes(id)),
    };
    const identity = createHash("sha256").update(JSON.stringify([source, input.request.toolCallId])).digest("hex");
    const id = `artifact_native_file_completion_${identity}`;
    const existing = input.store.getArtifact(id);
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (existing) {
      if (existing.runId !== input.run.id || existing.contentType !== NATIVE_FILE_MUTATION_COMPLETION_TYPE
        || existing.contentSha256 !== digest) throw new Error("native_file_completion_identity_conflict");
      return;
    }
    input.store.createArtifact({ id, runId: input.run.id, type: "json",
      path: `${input.run.id}/compaction/native-file-completions/${identity}.json`,
      title: "Host native file completion", contentType: NATIVE_FILE_MUTATION_COMPLETION_TYPE,
      sealedPayload: payload, createdAt: new Date().toISOString() });
  } catch {
    // Observation cannot change the already-applied effect or manufacture recovery proof.
    console.warn("native_file_completion_unavailable: checkpoint resource handoff remains unverified");
  }
}
