import type { MediaJob, MediaJobStatus, MediaOperation, RunArtifact } from "../../types.js";

export type MediaJobProductState = "ready_to_start" | "generating" | "needs_attention" | "completed" | "unknown";
export type MediaJobRunActionState = "idle" | "starting" | "generating";
export type MediaJobDisplayState = MediaJobProductState | "starting";
export type MediaJobStatusFilter = "all" | "ready_to_start" | "generating" | "needs_attention" | "completed";

export const mediaJobStatusFilters: readonly MediaJobStatusFilter[] = ["all", "ready_to_start", "generating", "needs_attention", "completed"];

export interface MediaJobProductStateInput {
  readonly job: MediaJob;
  readonly artifacts: readonly RunArtifact[];
  readonly runningJobId?: string;
}

export interface MediaJobDisplayStateInput extends MediaJobProductStateInput {
  readonly startingJobId?: string;
}

export interface MediaJobSummary {
  readonly taskCount: number;
  readonly readyCount: number;
  readonly generatingCount: number;
  readonly attentionCount: number;
  readonly completedCount: number;
  readonly unknownCount: number;
}

export interface MediaJobPrimaryActionView {
  readonly visible: boolean;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason: string;
  readonly emphasis: "primary" | "secondary";
}

export interface MediaJobFailureRecoveryView {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionKind: "open_providers" | "retry";
  readonly rawDetails: string;
}

export interface MediaJobResultActionView {
  readonly hasResult: boolean;
  readonly primaryLabel: string;
  readonly copyPromptLabel: string;
  readonly copyResultUrlLabel: string;
}

export function mediaArtifactsForJob(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  return artifacts.filter((artifact) => artifact.type === "image" || artifact.type === "video");
}

export function deriveMediaJobProductState({
  job,
  artifacts,
  runningJobId = "",
}: MediaJobProductStateInput): MediaJobProductState {
  if (runningJobId === job.id || job.status === "running") {
    return "generating";
  }
  const mediaArtifacts = mediaArtifactsForJob(artifacts);
  if (
    job.status === "failed" ||
    job.status === "cancelled" ||
    Boolean(job.errorMessage?.trim()) ||
    mediaJobHasMissingResult(job, artifacts) ||
    (job.status === "succeeded" && mediaArtifacts.length === 0)
  ) {
    return "needs_attention";
  }
  if (job.status === "succeeded" && mediaArtifacts.length > 0) {
    return "completed";
  }
  if (job.status === "queued" || job.status === "waiting_for_approval") {
    return "ready_to_start";
  }
  return "unknown";
}

export function mediaJobRunActionState({
  job,
  runningJobId = "",
  startingJobId = "",
}: {
  readonly job: MediaJob;
  readonly runningJobId?: string;
  readonly startingJobId?: string;
}): MediaJobRunActionState {
  if (job.status === "running" || runningJobId === job.id) {
    return "generating";
  }
  if (startingJobId === job.id) {
    return "starting";
  }
  return "idle";
}

export function deriveMediaJobDisplayState({
  job,
  artifacts,
  runningJobId = "",
  startingJobId = "",
}: MediaJobDisplayStateInput): MediaJobDisplayState {
  if (job.status === "running") {
    return "generating";
  }
  if (startingJobId === job.id) {
    return "starting";
  }
  return deriveMediaJobProductState({ job, artifacts, runningJobId });
}

export function summarizeMediaJobs({
  jobs,
  artifactsByJob,
  runningJobId = "",
}: {
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Record<string, readonly RunArtifact[]>;
  readonly runningJobId?: string;
}): MediaJobSummary {
  const summary: MediaJobSummary = {
    taskCount: jobs.length,
    readyCount: 0,
    generatingCount: 0,
    attentionCount: 0,
    completedCount: 0,
    unknownCount: 0,
  };
  const next = { ...summary };
  for (const job of jobs) {
    const state = deriveMediaJobProductState({
      job,
      artifacts: artifactsByJob[job.id] ?? [],
      runningJobId,
    });
    if (state === "ready_to_start") {
      next.readyCount += 1;
    } else if (state === "generating") {
      next.generatingCount += 1;
    } else if (state === "needs_attention") {
      next.attentionCount += 1;
    } else if (state === "completed") {
      next.completedCount += 1;
    } else {
      next.unknownCount += 1;
    }
  }
  return next;
}

export function mediaJobMatchesProductFilter({
  job,
  artifacts,
  runningJobId = "",
  startingJobId = "",
  filter,
}: MediaJobDisplayStateInput & { readonly filter: MediaJobStatusFilter }): boolean {
  if (filter === "all") {
    return true;
  }
  const displayState = deriveMediaJobDisplayState({ job, artifacts, runningJobId, startingJobId });
  if (displayState === "starting") {
    return filter === "generating";
  }
  return displayState === filter;
}

export function isMediaJobActiveStatus(status: MediaJobStatus): boolean {
  return status === "running";
}

export function mediaJobHasMissingResult(job: MediaJob, artifacts: readonly RunArtifact[]): boolean {
  return job.artifactIds.length > 0 && mediaArtifactsForJob(artifacts).length === 0;
}

export function mediaJobNeedsRecovery(job: MediaJob, artifacts: readonly RunArtifact[]): boolean {
  return deriveMediaJobProductState({ job, artifacts }) === "needs_attention";
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

export function mediaJobRunDisabledReason({
  job,
  artifacts,
  isLoading,
  isRunning,
  isStarting = false,
}: {
  readonly job: MediaJob;
  readonly artifacts: readonly RunArtifact[];
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly isStarting?: boolean;
}): string {
  if (isStarting) {
    return "Generation request is starting.";
  }
  if (isLoading) {
    return "Generation tasks are refreshing.";
  }
  if (isRunning || job.status === "running") {
    return "Generation is already running.";
  }
  if (mediaJobCanRun(job, artifacts)) {
    return "";
  }
  if (job.status === "succeeded" && mediaArtifactsForJob(artifacts).length > 0) {
    return "This task already has generated results.";
  }
  return "This task cannot be started from its current state.";
}

export function mediaJobPrimaryActionView({
  job,
  artifacts,
  isLoading,
  isRunning,
  isStarting = false,
}: {
  readonly job: MediaJob;
  readonly artifacts: readonly RunArtifact[];
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly isStarting?: boolean;
}): MediaJobPrimaryActionView {
  const state = deriveMediaJobDisplayState({
    job,
    artifacts,
    runningJobId: isRunning ? job.id : "",
    startingJobId: isStarting ? job.id : "",
  });
  const disabledReason = mediaJobRunDisabledReason({ job, artifacts, isLoading, isRunning, isStarting });
  if (state === "completed") {
    return {
      visible: false,
      label: "Completed",
      disabled: true,
      disabledReason,
      emphasis: "secondary",
    };
  }
  if (state === "starting") {
    return {
      visible: true,
      label: "Starting",
      disabled: true,
      disabledReason,
      emphasis: "secondary",
    };
  }
  if (state === "generating") {
    return {
      visible: true,
      label: "Generating",
      disabled: true,
      disabledReason,
      emphasis: "secondary",
    };
  }
  if (state === "ready_to_start") {
    return {
      visible: true,
      label: "Start generation",
      disabled: Boolean(isLoading || !mediaJobCanRun(job, artifacts)),
      disabledReason,
      emphasis: "secondary",
    };
  }
  if (state === "needs_attention") {
    return {
      visible: true,
      label: "Retry generation",
      disabled: Boolean(isLoading || !mediaJobCanRun(job, artifacts)),
      disabledReason,
      emphasis: "primary",
    };
  }
  return {
    visible: false,
    label: "Unavailable",
    disabled: true,
    disabledReason,
    emphasis: "secondary",
  };
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
    return "Ready";
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

export function mediaJobProductStateLabel(state: MediaJobProductState): string {
  if (state === "ready_to_start") {
    return "Ready to start";
  }
  if (state === "generating") {
    return "Generating";
  }
  if (state === "needs_attention") {
    return "Needs attention";
  }
  if (state === "completed") {
    return "Completed";
  }
  return "Unknown";
}

export function mediaJobDisplayStateLabel(state: MediaJobDisplayState): string {
  if (state === "starting") {
    return "Starting generation";
  }
  return mediaJobProductStateLabel(state);
}

export function mediaJobStatusBadgeClass(state: MediaJobDisplayState): string {
  if (state === "ready_to_start") {
    return "ready";
  }
  if (state === "starting") {
    return "running";
  }
  if (state === "generating") {
    return "running";
  }
  if (state === "needs_attention") {
    return "failed";
  }
  if (state === "completed") {
    return "succeeded";
  }
  return "unknown";
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

export function mediaJobFailureRecoveryView({
  job,
  artifacts,
  t,
}: {
  readonly job: MediaJob;
  readonly artifacts: readonly RunArtifact[];
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): MediaJobFailureRecoveryView {
  const normalized = job.errorMessage?.trim() ?? "";
  const lower = normalized.toLowerCase();
  const rawDetails = normalized || t("No raw generation error was returned.");
  if (mediaJobHasMissingResult(job, artifacts) || (job.status === "succeeded" && mediaArtifactsForJob(artifacts).length === 0)) {
    return {
      title: t("No usable result was returned"),
      description: t("The task finished, but Ling did not receive an image or video it can show."),
      actionLabel: t("Retry generation"),
      actionKind: "retry",
      rawDetails,
    };
  }
  if (lower.includes("api key") || lower.includes("secret") || lower.includes("unauthorized") || lower.includes("401")) {
    return {
      title: t("This model needs an API key"),
      description: t("Add or fix the API key for this model route before generating again."),
      actionLabel: t("Open Model Workbench"),
      actionKind: "open_providers",
      rawDetails,
    };
  }
  if (lower.includes("base url") || lower.includes("base_url")) {
    return {
      title: t("This model route needs a Base URL"),
      description: t("Check the route URL in Model Workbench, then retry generation."),
      actionLabel: t("Open Model Workbench"),
      actionKind: "open_providers",
      rawDetails,
    };
  }
  if (lower.includes("disabled")) {
    return {
      title: t("This model route is disabled"),
      description: t("Enable the route in Model Workbench before generating again."),
      actionLabel: t("Open Model Workbench"),
      actionKind: "open_providers",
      rawDetails,
    };
  }
  if (lower.includes("live_media_transport_required") || lower.includes("unsupported") || lower.includes("暂未接入") || lower.includes("可真实生成")) {
    return {
      title: t("Real generation is not connected for this model"),
      description: t("Choose another runnable generation model or configure one in Model Workbench."),
      actionLabel: t("Open Model Workbench"),
      actionKind: "open_providers",
      rawDetails,
    };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate limited") || lower.includes("quota")) {
    return {
      title: t("The provider limited this request"),
      description: t("Try again later, or choose another generation route."),
      actionLabel: t("Retry generation"),
      actionKind: "retry",
      rawDetails,
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("network") || lower.includes("econn") || lower.includes("fetch failed")) {
    return {
      title: t("The provider did not respond in time"),
      description: t("Check the route connection, then retry generation."),
      actionLabel: t("Retry generation"),
      actionKind: "retry",
      rawDetails,
    };
  }
  if (lower.includes("invalid_request") || lower.includes("bad_request") || lower.includes("rejected") || lower.includes("400")) {
    return {
      title: t("The relay rejected this generation request"),
      description: t("Check the model name, route, prompt, and account permissions."),
      actionLabel: t("Open Model Workbench"),
      actionKind: "open_providers",
      rawDetails,
    };
  }
  return {
    title: t("Generation failed"),
    description: t("Review the details, retry generation, or choose another model route."),
    actionLabel: t("Retry generation"),
    actionKind: "retry",
    rawDetails,
  };
}

export function mediaJobResultActionView(artifacts: readonly RunArtifact[]): MediaJobResultActionView {
  return {
    hasResult: artifacts.length > 0,
    primaryLabel: "View result",
    copyPromptLabel: "Copy prompt",
    copyResultUrlLabel: "Copy result URL",
  };
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
