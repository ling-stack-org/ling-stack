export * from "./media-job-types.js";
export * from "./media-job-form-view-models.js";
export * from "./media-job-repair-view-models.js";
export * from "./media-job-result-view-models.js";
export * from "./media-job-state-view-models.js";

import type { MediaJob, RunArtifact } from "../../types.js";
import { mediaArtifactsForJob } from "./media-job-result-view-models.js";

export function mediaJobFailureRecoveryView({
  job,
  artifacts,
  t,
}: {
  readonly job: MediaJob;
  readonly artifacts: readonly RunArtifact[];
  readonly t: (key: string) => string;
}): { readonly title: string; readonly description: string; readonly rawDetails: string } {
  const rawDetails = job.errorMessage?.trim() || t("No raw generation error was returned.");
  if (job.status === "succeeded" && mediaArtifactsForJob(artifacts).length === 0) {
    return {
      title: t("No usable result was returned"),
      description: t("The task finished, but Ling did not receive an image or video it can show."),
      rawDetails,
    };
  }
  return {
    title: t("Generation failed"),
    description: t("Review the details, then retry generation."),
    rawDetails,
  };
}
