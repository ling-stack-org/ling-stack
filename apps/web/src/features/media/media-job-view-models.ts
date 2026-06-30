import type { MediaJob, MediaJobStatus, MediaOperation, RunArtifact } from "../../types.js";

export type MediaJobStatusFilter = "all" | "succeeded" | "failed" | "queued";

export const mediaJobStatusFilters: readonly MediaJobStatusFilter[] = ["all", "succeeded", "failed", "queued"];

export function mediaArtifactsForJob(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  return artifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");
}

export function mediaJobMatchesFilter(job: MediaJob, filter: MediaJobStatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "queued") {
    return isMediaJobActiveStatus(job.status);
  }
  return job.status === filter;
}

export function isMediaJobActiveStatus(status: MediaJobStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}

export function mediaJobHasMissingResult(job: MediaJob, artifacts: readonly RunArtifact[]): boolean {
  return job.artifactIds.length > 0 && mediaArtifactsForJob(artifacts).length === 0;
}

export function mediaJobNeedsRecovery(job: MediaJob, artifacts: readonly RunArtifact[]): boolean {
  return Boolean(job.errorMessage || mediaJobHasMissingResult(job, artifacts));
}

export function mediaJobCanRun(job: MediaJob, artifacts: readonly RunArtifact[]): boolean {
  return (
    job.status === "queued" ||
    job.status === "waiting_for_approval" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    mediaJobHasMissingResult(job, artifacts)
  );
}

export function mediaOperationLabel(operation: MediaOperation): string {
  if (operation === "image_generate") {
    return "Image generation";
  }
  if (operation === "image_edit") {
    return "Image editing";
  }
  return "Video generation";
}

export function mediaJobStatusLabel(status: MediaJobStatus): string {
  if (status === "queued") {
    return "Queued";
  }
  if (status === "running") {
    return "Running";
  }
  if (status === "waiting_for_approval") {
    return "Ready to run";
  }
  if (status === "succeeded") {
    return "Succeeded";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Cancelled";
}

export function mediaJobInputValue(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "--";
}

export function formatMediaJobError(
  errorMessage: string,
  t: (key: string, values?: Readonly<Record<string, string | number>>) => string,
): string {
  const normalized = errorMessage.trim();
  if (!normalized) {
    return t("Generation task failed.");
  }
  if (normalized === "This operation was aborted" || normalized === "This operation was aborted." || normalized === "The operation was aborted.") {
    return t("Generation task was cancelled.");
  }
  if (normalized === "No generated media artifact was returned." || normalized.includes("No returned image") || normalized.includes("No returned video")) {
    return t("No generated media artifact was returned.");
  }
  if (normalized.includes("invalid_request")) {
    return t("The provider rejected this generation request. Check the model, prompt, and account permissions.");
  }
  return t(normalized);
}
