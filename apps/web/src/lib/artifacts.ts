import type { RunArtifact } from "../types.js";

export function formatArtifactSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "-";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageArtifact(artifact: RunArtifact): boolean {
  return artifact.type === "image" || artifact.contentType?.toLowerCase().startsWith("image/") === true;
}

export function artifactDownloadName(artifact: RunArtifact): string {
  return artifact.path.split(/[\\/]/).filter(Boolean).pop() || artifact.title || artifact.id;
}
