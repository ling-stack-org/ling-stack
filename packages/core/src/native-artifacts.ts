import { createHash } from "node:crypto";
import { join } from "node:path";
import { NativeExecutionJournalError, type NativeRunArtifact } from "./native-execution-types.js";

export const NATIVE_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

/** Shared identity for owned file publication and the SQLite journal. No caller-selected path. */
export function nativeArtifactIdentity(artifactsDir: string, submissionId: string,
  artifact: Pick<NativeRunArtifact, "toolCallId" | "kind" | "sha256" | "sourceKind">) {
  if (typeof submissionId !== "string" || !submissionId || typeof artifact.toolCallId !== "string" || !artifact.toolCallId
    || artifact.toolCallId.length > 128 || /[\x00-\x1f\x7f]/.test(artifact.toolCallId)
    || (artifact.sourceKind !== undefined && artifact.sourceKind !== "assistant")
    || !["image", "text"].includes(artifact.kind) || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new NativeExecutionJournalError("native_journal_invalid");
  }
  // Preserve legacy identities while separating assistant items from native tool-call ids.
  const digest = createHash("sha256").update(JSON.stringify([submissionId, artifact.toolCallId, artifact.kind, artifact.sha256,
    ...(artifact.sourceKind ? [artifact.sourceKind] : [])])).digest("hex");
  const id = `artifact_native_${digest}`;
  const extension = artifact.kind === "image" ? "png" : "txt";
  const contentType = artifact.kind === "image" ? "image/png" : "text/plain; charset=utf-8";
  return { id, path: join(artifactsDir, "native", `${id}.${extension}`), contentType,
    content: { type: "resource_link", uri: `ling-artifact:${id}`, name: `${id}.${extension}`, mimeType: contentType } };
}
