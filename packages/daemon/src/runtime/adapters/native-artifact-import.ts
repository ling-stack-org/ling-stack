import { createHash } from "node:crypto";
import { sanitizeNativeImage } from "./native-image-sanitizer.js";
import { nativeArtifactIdentity, NATIVE_ARTIFACT_MAX_BYTES, type NativeRunOutput, type NativeRunArtifact } from "@ling-stack/core";
import { inspectSupportedImage } from "../../features/media/image-inspection.js";
import { NativeArtifactError, publishNativeArtifactFile } from "./native-artifact-files.js";
import { NativeSecretRegistry, redactNativeOutput } from "./native-stream-redaction.js";

interface Options {
  readonly directory: string;
  readonly submissionId: string;
  readonly signal: AbortSignal;
  readonly extraSecrets?: readonly string[];
  readonly secretRegistry?: NativeSecretRegistry;
  readonly maxPixels?: number;
}

/** Consumes returned bytes only. Resource URIs and native savedPath values never authorize I/O. */
export async function materializeNativeArtifacts(input: readonly NativeRunOutput[], options: Options) {
  options.signal.throwIfAborted();
  if (options.secretRegistry !== undefined && !(options.secretRegistry instanceof NativeSecretRegistry)) invalid();
  options.secretRegistry?.register((options.extraSecrets ?? []).filter(secret => secret !== ""));
  const secrets = options.secretRegistry ?? options.extraSecrets;
  // Replacement links belong to each event, even when callers reuse a content array.
  const events = input.map(event => structuredClone(event));
  const artifacts: NativeRunArtifact[] = [];
  let totalBytes = 0;
  for (const [eventIndex, event] of events.entries()) {
    const data = event.data;
    const assistant = event.type === "progress" && data.nativeKind === "assistant_content";
    const output = event.type === "tool_end" && record(data.result) ? data.result
      : event.type === "progress" && (data.nativeKind === "function_output" || assistant) ? data : undefined;
    if (!output || !Array.isArray(output.content)) continue;
    if (assistant && (data.role !== "assistant" || typeof data.itemId !== "string"
      || data.toolCallId !== undefined || data.toolName !== undefined)) invalid();
    for (const [contentIndex, block] of output.content.entries()) {
      options.signal.throwIfAborted();
      if (!record(block)) continue;
      let bytes: Buffer;
      let kind: NativeRunArtifact["kind"];
      if (block.type === "image") {
        bytes = await imageBytes(block, options);
        kind = "image";
      } else if (block.type === "resource" && record(block.resource) && typeof block.resource.text === "string") {
        if (Buffer.byteLength(block.resource.text, "utf8") > NATIVE_ARTIFACT_MAX_BYTES) capacity();
        bytes = Buffer.from(redactNativeOutput(block.resource.text, secrets), "utf8");
        kind = "text";
      } else continue;
      const toolCallId = data.toolCallId ?? data.itemId;
      if (typeof toolCallId !== "string") invalid();
      totalBytes += bytes.length;
      if (bytes.length > NATIVE_ARTIFACT_MAX_BYTES || totalBytes > 64 * 1024 * 1024 || artifacts.length >= 32) capacity();
      const artifact = { eventIndex, contentIndex, toolCallId, kind, sizeBytes: bytes.length,
        ...(assistant ? { sourceKind: "assistant" as const } : {}),
        sha256: createHash("sha256").update(bytes).digest("hex") };
      const identity = nativeArtifactIdentity(options.directory, options.submissionId, artifact);
      publishNativeArtifactFile(options.directory, identity.path, bytes, artifact.sha256, options.signal);
      output.content[contentIndex] = identity.content;
      artifacts.push(artifact);
    }
  }
  options.signal.throwIfAborted();
  return { events, artifacts };
}

async function imageBytes(block: Record<string, unknown>, options: Options): Promise<Buffer> {
  if (typeof block.data !== "string" || typeof block.mimeType !== "string") invalid();
  if (block.data.length > 4 * Math.ceil(NATIVE_ARTIFACT_MAX_BYTES / 3)) capacity();
  const bytes = Buffer.from(block.data, "base64");
  if (!bytes.length || bytes.length > NATIVE_ARTIFACT_MAX_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)
    || bytes.toString("base64").replace(/=+$/, "") !== block.data.replace(/=+$/, "")) invalid();
  const inspection = inspectSupportedImage(bytes);
  if (!inspection || (block.mimeType !== "image/*" && block.mimeType !== inspection.contentType)) invalid();
  const maxPixels = options.maxPixels ?? 32_000_000;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 32_000_000
    || inspection.width * inspection.height > maxPixels) capacity();
  return sanitizeNativeImage(bytes, maxPixels, options.signal);
}

function invalid(): never { throw new NativeArtifactError("invalid_artifact"); }
function capacity(): never { throw new NativeArtifactError("capacity_exceeded"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
