import type { MediaJob, RunArtifact } from "../../types.js";
import type { MediaJobArtifactState } from "../../domains/media/media-domain-types.js";
import type { MediaJobResultView } from "./media-job-types.js";

export function mediaArtifactsForJob(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  return artifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");
}

export function deriveMediaJobResultView(
  job: MediaJob,
  artifactState?: MediaJobArtifactState,
): MediaJobResultView {
  const artifacts = artifactState?.artifacts ?? [];
  const mediaArtifacts = mediaArtifactsForJob(artifacts);
  const auxiliaryArtifacts = artifacts.filter((artifact) => artifact.type !== "image" && artifact.type !== "video");
  if (job.artifactIds.length > 0 && artifactState?.phase === "loading") {
    return { state: "loading", mediaArtifacts, auxiliaryArtifacts };
  }
  if (mediaArtifacts.length > 0) {
    return { state: "ready", primary: mediaArtifacts[0], mediaArtifacts, auxiliaryArtifacts };
  }
  if (artifactState?.phase === "error") {
    return {
      state: "unavailable",
      mediaArtifacts,
      auxiliaryArtifacts,
      errorMessage: artifactState.errorMessage,
    };
  }
  if (job.status === "succeeded") {
    return { state: "missing", mediaArtifacts, auxiliaryArtifacts };
  }
  return { state: "none", mediaArtifacts, auxiliaryArtifacts };
}

export function appendPreviewRetry(canonicalContentUrl: string, retryNonce: number): string {
  if (retryNonce <= 0) return canonicalContentUrl;
  const url = new URL(canonicalContentUrl, window.location.origin);
  url.searchParams.set("previewRetry", String(retryNonce));
  return url.toString();
}

export function sanitizeMediaJobDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMediaJobDetails);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveText(value) : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(secret|token|api.?key|authorization|header|cookie|password|path)/iu.test(key))
    .map(([key, entry]) => [key, sanitizeMediaJobDetails(entry)]));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(?:bearer|token|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/giu, "[redacted]")
    .replace(/(?:\/?(?:Users|Volumes|home)\/[^\s,;]+)/gu, "[local path redacted]");
}
