import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import {
  createArtifactId,
  redactSecrets,
  type ArtifactType,
  type HostMediaArtifactManifestItem,
  type MediaJob,
  type RunArtifact,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
} from "@ling-stack/core";
import type { MediaExecutionArtifact } from "@ling-stack/providers";
import { normalizeArtifactPath } from "../../shared/path.js";
import { formatTimestampSlug } from "../../shared/time.js";
import { MediaArtifactCollectionError, mediaArtifactMatchesWrite, mediaRemoteDescriptorDigest,
  readMediaCollectionExecution, sha256Bytes, type HostMediaArtifactCollectionContext,
  type MediaArtifactCollectionResult, type MediaReceiptReadStore } from "./artifact-collection-receipt.js";

type MediaArtifactStore = RunStorePathsFacet & RunExecutionStoreFacet & MediaReceiptReadStore;
export { MediaArtifactCollectionError } from "./artifact-collection-receipt.js";
export type { HostMediaArtifactCollectionContext, HostMediaArtifactRemoteDescriptor,
  MediaArtifactCollectionResult } from "./artifact-collection-receipt.js";

export function mediaExecutionHasRequiredArtifact(
  artifacts: readonly MediaExecutionArtifact[],
  operation: MediaJob["operation"],
): boolean {
  if (operation === "image_generate" || operation === "image_edit") {
    return artifacts.some((artifact) => artifact.type === "image" && artifact.contentBytes !== undefined);
  }
  return artifacts.some((artifact) => artifact.type === "video" && artifact.contentBytes !== undefined);
}

export function createMediaJobArtifacts(
  store: MediaArtifactStore,
  job: MediaJob,
  candidates: readonly MediaExecutionArtifact[],
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
  context?: HostMediaArtifactCollectionContext,
): RunArtifact[] {
  return [...collectMediaJobArtifacts(store, job, candidates, createdAt, extraSecrets, context).artifacts];
}

/** Receipt-aware collection keeps each physical write and exact SQLite readback independently observable. */
export function collectMediaJobArtifacts(
  store: MediaArtifactStore,
  job: MediaJob,
  candidates: readonly MediaExecutionArtifact[],
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
  context?: HostMediaArtifactCollectionContext,
): MediaArtifactCollectionResult {
  const artifacts: RunArtifact[] = [], manifestItems: HostMediaArtifactManifestItem[] = [];
  const partial = { artifacts, manifestItems };
  let directory = `media_jobs/${job.id}`;
  try {
    if (context) {
      readMediaCollectionExecution(store, job, context, createdAt);
      if (store.listMediaJobArtifacts(job.id).length) throw new Error("media_artifact_collection_existing_job_artifacts");
      directory += `/generation-${sha256Bytes(context.executionGenerationId)}/execution-${sha256Bytes(context.executionId)}`;
    }
    // Job IDs are path segments, never a caller-selected absolute path or traversal.
    if (!/^[a-zA-Z0-9_.:-]+$/u.test(job.id) || job.id === "." || job.id === "..") throw new Error("media_artifact_job_path_invalid");
  } catch (error) {
    throw new MediaArtifactCollectionError(error, partial, 0, false);
  }
  for (const [index, input] of candidates.entries()) {
    let writeStarted = false, confirmed = false, relativePath: string | undefined;
    let expected: RunArtifact | undefined, item: HostMediaArtifactManifestItem | undefined;
    try {
      // Snapshot once inside the partial boundary. Neither an adapter getter nor
      // the descriptor callback can replace the bytes between matching and write.
      const candidate = snapshotCandidate(input, extraSecrets);
      if (candidate.content === undefined && candidate.contentBytes === undefined) continue;
      const content = candidate.contentBytes !== undefined ? Buffer.from(candidate.contentBytes)
        : Buffer.from(candidate.content ?? "", "utf8");
      // Read identity for every candidate, not only before a possibly effectful descriptor getter.
      if (context) readMediaCollectionExecution(store, job, context, createdAt);
      const descriptorDigest = context ? mediaRemoteDescriptorDigest(context, candidate, index) : undefined;
      if (context) readMediaCollectionExecution(store, job, context, createdAt);
      relativePath = normalizeArtifactPath(`${directory}/${formatMediaArtifactFilename(index, candidate, createdAt)}`);
      const artifactDir = resolvePath(store.paths.artifactsDir, directory);
      ensureMediaArtifactDirectory(store.paths.artifactsDir, directory);
      const absolutePath = resolvePath(artifactDir, basename(relativePath));
      const artifactId = createArtifactId();
      writeStarted = true;
      // Exclusive receipt paths cannot overwrite a previous generation or silently reuse an old file.
      writeFileSync(absolutePath, content, { flag: context ? "wx" : "w", flush: true });
      const persistedBytes = readFileSync(absolutePath);
      if (!persistedBytes.equals(content)) throw new Error("media_artifact_persisted_bytes_mismatch");
      const contentType = candidate.contentType ?? contentTypeForArtifactType(candidate.type);
      const bytesFact = context ? { schemaVersion: 1, kind: "media_bytes_v1", executionId: context.executionId,
        mediaJobId: job.id, path: relativePath, type: candidate.type, contentType, sizeBytes: persistedBytes.length,
        bytesSha256: sha256Bytes(persistedBytes), remoteDescriptorDigest: descriptorDigest!, collectedAt: createdAt } : undefined;
      expected = { id: artifactId, mediaJobId: job.id, type: candidate.type, path: relativePath,
        title: candidate.title, contentType, sizeBytes: persistedBytes.length, createdAt,
        ...(bytesFact ? { sealedPayload: bytesFact } : {}) };
      if (bytesFact) item = { artifactId, type: candidate.type, path: relativePath, contentType, sizeBytes: persistedBytes.length,
        bytesSha256: bytesFact.bytesSha256, remoteDescriptorDigest: bytesFact.remoteDescriptorDigest, collectedAt: createdAt };
      store.createArtifact(expected);
      const persisted = store.getArtifact(artifactId);
      if (!mediaArtifactMatchesWrite(persisted, expected)) throw new Error("media_artifact_metadata_readback_invalid");
      artifacts.push(persisted); if (item) manifestItems.push(Object.freeze(item));
      confirmed = true;
    } catch (error) {
      // A post-COMMIT error may follow an actual insert. Only this preassigned ID may be recovered.
      if (expected && !confirmed) {
        try {
          const persisted = store.getArtifact(expected.id);
          if (mediaArtifactMatchesWrite(persisted, expected)) {
            artifacts.push(persisted); if (item) manifestItems.push(Object.freeze(item));
            confirmed = true;
          }
        } catch { /* An unavailable readback leaves the physical write conservatively unconfirmed. */ }
      }
      throw new MediaArtifactCollectionError(error, partial, index, writeStarted && !confirmed,
        writeStarted && !confirmed ? relativePath : undefined, writeStarted && !confirmed ? expected?.id : undefined);
    }
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), manifestItems: Object.freeze(manifestItems) });
}

function snapshotCandidate(input: MediaExecutionArtifact, secrets: readonly (string | undefined)[]): MediaExecutionArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("media_artifact_candidate_invalid");
  const { type, title, content, contentBytes, pathHint, contentType } = input;
  if (!["file", "json", "markdown", "image", "video"].includes(type) || typeof title !== "string"
    || (content !== undefined && typeof content !== "string")
    || (contentBytes !== undefined && !(contentBytes instanceof Uint8Array))
    || (pathHint !== undefined && typeof pathHint !== "string")
    || (contentType !== undefined && typeof contentType !== "string")) throw new Error("media_artifact_candidate_invalid");
  return Object.freeze({ type, title, ...(content === undefined ? {} : { content: redactMediaArtifactContent(content, secrets) }),
    ...(contentBytes === undefined ? {} : { contentBytes: Buffer.from(contentBytes) }),
    ...(pathHint === undefined ? {} : { pathHint }), ...(contentType === undefined ? {} : { contentType }) });
}

function ensureMediaArtifactDirectory(root: string, directory: string): void {
  mkdirSync(root, { recursive: true });
  const absoluteRoot = realpathSync(root);
  let path = absoluteRoot;
  for (const segment of directory.split("/")) {
    path = resolvePath(path, segment);
    try { mkdirSync(path); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("media_artifact_directory_invalid");
  }
}

function formatMediaArtifactFilename(index: number, candidate: MediaExecutionArtifact, createdAt: string): string {
  const hintedName = candidate.pathHint ? basename(candidate.pathHint) : "";
  const titleSlug = (hintedName || candidate.title)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `artifact-${formatTimestampSlug(createdAt)}`;
  const extension = extname(titleSlug) ? "" : `.${artifactExtensionForType(candidate.type)}`;
  return `${String(index + 1).padStart(3, "0")}-${titleSlug}${extension}`;
}

function artifactExtensionForType(type: ArtifactType): string {
  if (type === "markdown") return "md";
  if (type === "diff") return "diff";
  if (type === "json") return "json";
  if (type === "log") return "log";
  if (type === "image") return "png";
  if (type === "video") return "mp4";
  return "txt";
}

function contentTypeForArtifactType(type: ArtifactType): string {
  if (type === "json") return "application/json; charset=utf-8";
  if (type === "markdown") return "text/markdown; charset=utf-8";
  if (type === "diff") return "text/x-diff; charset=utf-8";
  if (type === "log" || type === "file") return "text/plain; charset=utf-8";
  if (type === "image") return "image/png";
  if (type === "video") return "video/mp4";
  return "application/octet-stream";
}

function redactMediaArtifactContent(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}
