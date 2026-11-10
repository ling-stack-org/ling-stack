import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HostMediaArtifactManifestItem, HostMediaExecutionRecord, HostOperationSource, MediaJob,
  RunArtifact, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { MediaExecutionArtifact } from "@ling-stack/providers";

/** Non-secret descriptor supplied only by the private Host transport capture. Not launch authority. */
export interface HostMediaArtifactRemoteDescriptor {
  readonly schemaVersion: 1;
  readonly routeDigest: string;
  readonly responseBodySha256: string;
  readonly candidateIndex: number;
  readonly descriptorKind: "response_item" | "download";
  readonly pathHint?: string;
}
export interface HostMediaArtifactCollectionContext {
  readonly executionId: string;
  readonly executionGenerationId: string;
  readonly source: HostOperationSource;
  readonly childFence: RuntimeAttemptFenceV1;
  readonly getRemoteDescriptor: (candidate: MediaExecutionArtifact, index: number) => HostMediaArtifactRemoteDescriptor | undefined;
}
export interface MediaArtifactCollectionResult {
  readonly artifacts: readonly RunArtifact[];
  readonly manifestItems: readonly HostMediaArtifactManifestItem[];
}

/** A failed collection never erases prior committed artifacts or turns an uncertain write into no-start. */
export class MediaArtifactCollectionError extends Error {
  readonly artifacts: readonly RunArtifact[];
  readonly manifestItems: readonly HostMediaArtifactManifestItem[];
  constructor(cause: unknown, partial: MediaArtifactCollectionResult, readonly failedIndex: number,
    readonly unconfirmedWrite: boolean, readonly unconfirmedPath?: string, readonly unconfirmedArtifactId?: string) {
    super("media_artifact_collection_failed", { cause });
    this.name = "MediaArtifactCollectionError";
    this.artifacts = Object.freeze([...partial.artifacts]);
    this.manifestItems = Object.freeze([...partial.manifestItems]);
  }
}

export type MediaReceiptReadStore = Partial<Pick<RunStore, "getHostMediaExecution">>;

/** Exact persisted identity readback. This does not issue a ticket, launch, resume, or settle a producer. */
export function readMediaCollectionExecution(store: MediaReceiptReadStore, job: MediaJob,
  context: HostMediaArtifactCollectionContext, collectedAt: string): HostMediaExecutionRecord {
  const row = store.getHostMediaExecution?.(context.executionId);
  const at = Date.parse(collectedAt);
  if (!row || row.mediaJobId !== job.id || row.workspaceId !== job.workspaceId || row.operation !== job.operation
    || row.executionGenerationId !== context.executionGenerationId || !isDeepStrictEqual(row.source, context.source)
    || !row.childFence || !isDeepStrictEqual(row.childFence, context.childFence) || !row.childBoundAt
    || row.finalizationArtifactId || row.manifestArtifactId || !Number.isFinite(at) || at < Date.parse(row.childBoundAt)
    || at > Date.now() || typeof context.getRemoteDescriptor !== "function") {
    throw new Error("media_artifact_collection_identity_invalid");
  }
  return row;
}

/** Strict projection keeps transport secrets and model-supplied proof flags out of durable bytes facts. */
export function mediaRemoteDescriptorDigest(context: HostMediaArtifactCollectionContext,
  candidate: MediaExecutionArtifact, index: number): string {
  const input = context.getRemoteDescriptor(candidate, index);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Reflect.ownKeys(input).some(key => typeof key !== "string"
      || !["schemaVersion", "routeDigest", "responseBodySha256", "candidateIndex", "descriptorKind", "pathHint"].includes(key))
    || input.schemaVersion !== 1 || !sha256Digest(input.routeDigest) || !sha256Digest(input.responseBodySha256)
    || input.candidateIndex !== index || !["response_item", "download"].includes(input.descriptorKind)
    || (input.pathHint !== undefined && (typeof input.pathHint !== "string" || input.pathHint.length > 4096))) {
    throw new Error("media_artifact_remote_descriptor_invalid");
  }
  const descriptor: HostMediaArtifactRemoteDescriptor = { schemaVersion: 1, routeDigest: input.routeDigest,
    responseBodySha256: input.responseBodySha256, candidateIndex: index, descriptorKind: input.descriptorKind,
    ...(input.pathHint === undefined ? {} : { pathHint: input.pathHint }) };
  return sha256Bytes(JSON.stringify(descriptor));
}

export function sha256Bytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Both row fields and the SQLite-owned JSON seal must match the exact preassigned artifact ID. */
export function mediaArtifactMatchesWrite(artifact: RunArtifact | undefined, expected: RunArtifact): artifact is RunArtifact {
  return !!artifact && artifact.id === expected.id && artifact.mediaJobId === expected.mediaJobId
    && artifact.runId === undefined && artifact.externalWorkId === undefined && artifact.type === expected.type
    && artifact.path === expected.path && artifact.contentType === expected.contentType && artifact.sizeBytes === expected.sizeBytes
    && artifact.createdAt === expected.createdAt && isDeepStrictEqual(artifact.sealedPayload, expected.sealedPayload)
    && (expected.sealedPayload === undefined ? artifact.contentSha256 === undefined
      : artifact.contentSha256 === sha256Bytes(JSON.stringify(expected.sealedPayload)));
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
