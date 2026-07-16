import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import {
  redactSecrets,
  type ArtifactType,
  type MediaJob,
  type RunArtifact,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
} from "@ling-stack/core";
import type { MediaExecutionArtifact } from "@ling-stack/providers";
import { normalizeArtifactPath } from "../../shared/path.js";
import { formatTimestampSlug } from "../../shared/time.js";

type MediaArtifactStore = RunStorePathsFacet & RunExecutionStoreFacet;

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
): RunArtifact[] {
  return candidates
    .map((candidate, index) => createMediaJobArtifact(store, job, candidate, index, createdAt, extraSecrets))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact));
}

function createMediaJobArtifact(
  store: MediaArtifactStore,
  job: MediaJob,
  candidate: MediaExecutionArtifact,
  index: number,
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact | undefined {
  if (candidate.content === undefined && candidate.contentBytes === undefined) return undefined;
  const artifactDir = resolvePath(store.paths.artifactsDir, "media_jobs", job.id);
  mkdirSync(artifactDir, { recursive: true });
  const relativePath = normalizeArtifactPath(`media_jobs/${job.id}/${formatMediaArtifactFilename(index, candidate, createdAt)}`);
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  if (candidate.contentBytes !== undefined) {
    writeFileSync(absolutePath, Buffer.from(candidate.contentBytes));
  } else {
    writeFileSync(absolutePath, redactMediaArtifactContent(candidate.content ?? "", extraSecrets), "utf8");
  }
  const stats = statSync(absolutePath);
  return store.createArtifact({
    mediaJobId: job.id,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType ?? contentTypeForArtifactType(candidate.type),
    sizeBytes: Number(stats.size),
    createdAt,
  });
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
