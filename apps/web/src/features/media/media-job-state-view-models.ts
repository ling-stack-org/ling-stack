import type { ApprovalRequest, MediaJob } from "../../types.js";
import type {
  MediaJobActionView,
  MediaJobApprovalView,
  MediaJobProductState,
  MediaJobProjectionInput,
  MediaJobRowView,
  MediaJobStatusFilter,
} from "./media-job-types.js";

export const mediaJobStatusFilters: readonly MediaJobStatusFilter[] = [
  "all",
  "ready_to_start",
  "generating",
  "needs_attention",
  "completed",
];

export function deriveMediaJobApprovalView(
  job: MediaJob,
  approvals: readonly ApprovalRequest[],
): MediaJobApprovalView {
  if (job.input.approvalGate !== "media_cost") return { kind: "none" };
  const approval = approvals.find((item) => item.mediaJobId === job.id && item.actionType === "media_cost" && item.status === "pending");
  return approval ? { kind: "pending", id: approval.id } : { kind: "missing" };
}

export function deriveMediaJobProductState(input: MediaJobProjectionInput): MediaJobProductState {
  const { job, result, source, approval, isRunning } = input;
  if (isRunning) return "starting";
  if (job.status === "running") return "generating";
  if (job.status === "waiting_for_approval" && approval.kind !== "none") return "waiting_for_review";
  if (result.state === "ready" && job.status === "succeeded") return "completed";
  if (result.state === "loading" && job.status === "succeeded") return "unknown";
  if (sourceNeedsRepair(source)) return "needs_attention";
  if (job.status === "failed" || job.status === "cancelled" || job.errorMessage || result.state === "missing" || result.state === "unavailable") {
    return "needs_attention";
  }
  if (job.status === "queued" || (job.status === "waiting_for_approval" && approval.kind === "none")) return "ready_to_start";
  return "unknown";
}

export function deriveMediaJobPrimaryAction(input: MediaJobProjectionInput): MediaJobActionView | undefined {
  const state = deriveMediaJobProductState(input);
  if (state === "starting") return action("start", "Starting generation", true, "Generation request is starting.", "secondary");
  if (state === "generating") return action("start", "Generating", true, "Generation is already running.", "secondary");
  if (state === "waiting_for_review") {
    return input.approval.kind === "pending"
      ? action("open_approval", "Open review queue", false, undefined, "primary")
      : action("refresh", "Refresh", false, undefined, "secondary");
  }
  if (state === "ready_to_start") return action("start", "Start generation", false, undefined, "secondary");
  if (state === "needs_attention") {
    if (input.source.kind === "provider_missing" || (input.source.kind === "provider" && !input.source.runtime.canRun)) {
      return action("repair_provider", input.source.kind === "provider_missing" ? "Configure generation model" : "Edit this model", false, undefined, "primary");
    }
    if (input.source.kind === "workflow_missing" || (input.source.kind === "workflow" && input.source.status !== "ready")) {
      return action("repair_workflow", "Open workflow", false, undefined, "primary");
    }
    if (input.source.kind === "workflow" && (input.source.connection.kind === "missing" || input.source.connection.status !== "ready")) {
      return action("repair_connection", "Open connection settings", false, undefined, "primary");
    }
    return action("retry", "Retry generation", false, undefined, "primary");
  }
  if (state === "completed") return action("view_result", "View result", false, undefined, "primary");
  return action("refresh", "Refresh", false, undefined, "secondary");
}

export function deriveMediaJobRowView(input: MediaJobProjectionInput): MediaJobRowView {
  const state = deriveMediaJobProductState(input);
  const title = input.context?.sceneName || input.context?.projectName || compactPrompt(input.job.prompt) || mediaOperationLabel(input.job.operation);
  const description = input.context?.projectName && input.context.sceneName
    ? `${input.context.projectName} / ${input.context.sceneName}`
    : compactPrompt(input.job.prompt) || mediaOperationLabel(input.job.operation);
  const primary = input.result.primary;
  return {
    jobId: input.job.id,
    identity: { title, description, titleTooltip: title },
    meta: [mediaOperationLabel(input.job.operation), sourceName(input.source), `${input.result.mediaArtifacts.length} results`, input.job.updatedAt],
    status: { id: state, labelKey: productStateLabel(state), tone: productStateTone(state) },
    primaryAction: deriveMediaJobPrimaryAction(input),
    preview: primary ? { kind: primary.type as "image" | "video", artifact: primary }
      : input.result.state === "loading" ? { kind: "loading" } : { kind: "empty" },
    stale: input.stale,
  };
}

export function summarizeMediaJobs(inputs: readonly MediaJobProjectionInput[]): {
  readonly taskCount: number;
  readonly generatingCount: number;
  readonly attentionCount: number;
} {
  let generatingCount = 0;
  let attentionCount = 0;
  for (const input of inputs) {
    const state = deriveMediaJobProductState(input);
    if (state === "starting" || state === "generating") generatingCount += 1;
    if (state === "needs_attention" || state === "waiting_for_review") attentionCount += 1;
  }
  return { taskCount: inputs.length, generatingCount, attentionCount };
}

export function mediaJobMatchesProductFilter(input: MediaJobProjectionInput, filter: MediaJobStatusFilter): boolean {
  if (filter === "all") return true;
  const state = deriveMediaJobProductState(input);
  if (filter === "generating") return state === "starting" || state === "generating";
  if (filter === "needs_attention") return state === "needs_attention" || state === "waiting_for_review" || state === "unknown";
  return state === filter;
}

export function mediaOperationLabel(operation: MediaJob["operation"]): string {
  if (operation === "image_generate") return "Image generation";
  if (operation === "image_edit") return "Image editing";
  return "Video generation";
}

function sourceNeedsRepair(source: MediaJobProjectionInput["source"]): boolean {
  if (source.kind === "provider_missing" || source.kind === "workflow_missing") return true;
  if (source.kind === "provider") return !source.runtime.canRun;
  return source.status !== "ready" || source.connection.kind === "missing" || source.connection.status !== "ready";
}

function sourceName(source: MediaJobProjectionInput["source"]): string {
  if (source.kind === "provider") return source.name;
  if (source.kind === "workflow") return source.name;
  return "Source unavailable";
}

function productStateLabel(state: MediaJobProductState): string {
  if (state === "ready_to_start") return "Ready to start";
  if (state === "starting") return "Starting generation";
  if (state === "generating") return "Generating";
  if (state === "waiting_for_review") return "Waiting for review";
  if (state === "needs_attention") return "Needs attention";
  if (state === "completed") return "Completed";
  return "Status unavailable";
}

function productStateTone(state: MediaJobProductState): "neutral" | "success" | "warning" | "danger" | "info" {
  if (state === "completed") return "success";
  if (state === "needs_attention") return "danger";
  if (state === "waiting_for_review" || state === "ready_to_start") return "warning";
  if (state === "starting" || state === "generating") return "info";
  return "neutral";
}

function action(
  id: MediaJobActionView["id"],
  labelKey: string,
  disabled: boolean,
  disabledReasonKey: string | undefined,
  emphasis: MediaJobActionView["emphasis"],
): MediaJobActionView {
  return { id, labelKey, disabled, disabledReasonKey, emphasis };
}

function compactPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/gu, " ");
}
