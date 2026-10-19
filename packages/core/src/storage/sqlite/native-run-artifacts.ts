import { isDeepStrictEqual } from "node:util";
import { nativeArtifactIdentity, NATIVE_ARTIFACT_MAX_BYTES } from "../../native-artifacts.js";
import { NativeExecutionJournalError, type AppendNativeRunEventsInput, type NativeRunOutput,
  type NativeRunArtifact, type NativeSubmission } from "../../native-execution-types.js";
import type { RunStore } from "../../run-types.js";

export type NativeArtifactPorts = Pick<RunStore, "createArtifact" | "getArtifact"> & { readonly artifactsDir: string };
export type PublishedNativeOutput = NativeRunOutput | { type: "artifact_created"; data: Record<string, unknown> };

export function validateNativeArtifacts(input: AppendNativeRunEventsInput): readonly NativeRunArtifact[] {
  const artifacts = input.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 32) invalid();
  const positions = new Set<string>();
  let bytes = 0;
  for (const artifact of artifacts) {
    if (!artifact || Object.keys(artifact).some(key => !["eventIndex", "contentIndex", "toolCallId", "sourceKind", "kind", "sha256", "sizeBytes"].includes(key))
      || !Number.isSafeInteger(artifact.eventIndex) || artifact.eventIndex < 0 || artifact.eventIndex >= input.events.length
      || !Number.isSafeInteger(artifact.contentIndex) || artifact.contentIndex < 0 || artifact.contentIndex >= 256
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || artifact.sizeBytes > NATIVE_ARTIFACT_MAX_BYTES) invalid();
    nativeArtifactIdentity("", input.submissionId, artifact);
    const position = `${artifact.eventIndex}:${artifact.contentIndex}`;
    if (positions.has(position)) invalid();
    positions.add(position);
    bytes += artifact.sizeBytes;
  }
  if (bytes > 64 * 1024 * 1024) invalid();
  return structuredClone(artifacts).sort((a, b) => a.eventIndex - b.eventIndex || a.contentIndex - b.contentIndex);
}

/** Called only inside the fenced native journal transaction. */
export function publishNativeArtifacts(ports: NativeArtifactPorts, current: NativeSubmission,
  events: readonly NativeRunOutput[], artifacts: readonly NativeRunArtifact[], now: string): PublishedNativeOutput[] {
  const result: PublishedNativeOutput[] = [];
  for (const [index, event] of events.entries()) {
    result.push(event);
    for (const descriptor of artifacts.filter(artifact => artifact.eventIndex === index)) {
      const id = nativeArtifactIdentity(ports.artifactsDir, current.id, descriptor);
      const data = event.data;
      const assistant = event.type === "progress" && data.nativeKind === "assistant_content";
      const output = event.type === "tool_end" ? record(data.result) ? data.result : undefined
        : event.type === "progress" && (data.nativeKind === "function_output" || assistant) ? data : undefined;
      if (assistant ? descriptor.sourceKind !== "assistant" || data.role !== "assistant" || data.toolCallId !== undefined
        || data.toolName !== undefined : descriptor.sourceKind !== undefined || typeof data.toolName !== "string") invalid();
      if (!output || (data.toolCallId ?? data.itemId) !== descriptor.toolCallId
        || !Array.isArray(output.content) || !isDeepStrictEqual(output.content[descriptor.contentIndex], id.content)) invalid();
      const metadata = { id: id.id, runId: current.runId, type: descriptor.kind === "image" ? "image" as const : "file" as const,
        path: id.path, contentType: id.contentType, sizeBytes: descriptor.sizeBytes,
        sealedPayload: { nativeArtifact: { version: 1, submissionId: current.id, toolCallId: descriptor.toolCallId,
          ...(assistant ? { sourceKind: "assistant" } : {}), byteSha256: descriptor.sha256 } } };
      const prior = ports.getArtifact(id.id);
      if (prior && Object.entries(metadata).some(([key, value]) => !isDeepStrictEqual(prior[key as keyof typeof prior], value))) {
        throw new NativeExecutionJournalError("native_output_conflict");
      }
      const artifact = prior ?? ports.createArtifact({ ...metadata, createdAt: now });
      result.push({ type: "artifact_created", data: { ...(assistant
        ? { itemId: descriptor.toolCallId, role: "assistant" }
        : { toolCallId: descriptor.toolCallId, toolName: data.toolName }), artifactId: artifact.id, artifact } });
    }
  }
  return result;
}

function invalid(): never { throw new NativeExecutionJournalError("native_journal_invalid"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
