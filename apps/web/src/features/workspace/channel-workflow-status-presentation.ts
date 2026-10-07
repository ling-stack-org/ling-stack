import type { StatusTone } from "../../shared/ui/index.js";
import type { ChannelWorkflow, ChannelWorkflowStep, RunStatus } from "../../types.js";

export type ChannelWorkflowStatusLabelKey =
  | "Waiting for input"
  | "Draft"
  | "Ready"
  | "Running"
  | "Waiting for approval"
  | "Blocked"
  | "Succeeded"
  | "Failed"
  | "Cancelled";

export type ChannelWorkflowStepStatusLabelKey =
  | "Waiting for input"
  | "Queued"
  | "Claimed"
  | "Running"
  | "Waiting for approval"
  | "Blocked"
  | "Succeeded"
  | "Failed"
  | "Skipped"
  | "Cancelled";

export type ChannelWorkflowRunStatusLabelKey =
  | "Execution yielded"
  | "Queued"
  | "Running"
  | "Waiting for approval"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "Saved";

export interface ChannelWorkflowStatusPresentation<StatusId extends string, LabelKey extends string> {
  readonly id: StatusId;
  readonly labelKey: LabelKey;
  readonly tone: StatusTone;
}

const WORKFLOW_STATUS_PRESENTATION = {
  waiting_for_input: { id: "waiting_for_input", labelKey: "Waiting for input", tone: "neutral" },
  draft: { id: "draft", labelKey: "Draft", tone: "neutral" },
  ready: { id: "ready", labelKey: "Ready", tone: "info" },
  running: { id: "running", labelKey: "Running", tone: "info" },
  waiting_for_approval: { id: "waiting_for_approval", labelKey: "Waiting for approval", tone: "warning" },
  blocked: { id: "blocked", labelKey: "Blocked", tone: "warning" },
  succeeded: { id: "succeeded", labelKey: "Succeeded", tone: "success" },
  failed: { id: "failed", labelKey: "Failed", tone: "danger" },
  cancelled: { id: "cancelled", labelKey: "Cancelled", tone: "neutral" },
} satisfies Record<ChannelWorkflow["status"], ChannelWorkflowStatusPresentation<ChannelWorkflow["status"], ChannelWorkflowStatusLabelKey>>;

const WORKFLOW_STEP_STATUS_PRESENTATION = {
  waiting_for_input: { id: "waiting_for_input", labelKey: "Waiting for input", tone: "neutral" },
  queued: { id: "queued", labelKey: "Queued", tone: "info" },
  claimed: { id: "claimed", labelKey: "Claimed", tone: "info" },
  running: { id: "running", labelKey: "Running", tone: "info" },
  waiting_for_approval: { id: "waiting_for_approval", labelKey: "Waiting for approval", tone: "warning" },
  blocked: { id: "blocked", labelKey: "Blocked", tone: "warning" },
  succeeded: { id: "succeeded", labelKey: "Succeeded", tone: "success" },
  failed: { id: "failed", labelKey: "Failed", tone: "danger" },
  skipped: { id: "skipped", labelKey: "Skipped", tone: "neutral" },
  cancelled: { id: "cancelled", labelKey: "Cancelled", tone: "neutral" },
} satisfies Record<ChannelWorkflowStep["status"], ChannelWorkflowStatusPresentation<ChannelWorkflowStep["status"], ChannelWorkflowStepStatusLabelKey>>;

const RUN_STATUS_PRESENTATION = {
  yielded: { id: "yielded", labelKey: "Execution yielded", tone: "neutral" },
  queued: { id: "queued", labelKey: "Queued", tone: "info" },
  running: { id: "running", labelKey: "Running", tone: "info" },
  waiting_for_approval: { id: "waiting_for_approval", labelKey: "Waiting for approval", tone: "warning" },
  succeeded: { id: "succeeded", labelKey: "Succeeded", tone: "success" },
  failed: { id: "failed", labelKey: "Failed", tone: "danger" },
  cancelled: { id: "cancelled", labelKey: "Cancelled", tone: "neutral" },
} satisfies Record<RunStatus, ChannelWorkflowStatusPresentation<RunStatus, Exclude<ChannelWorkflowRunStatusLabelKey, "Saved">>>;

const SAVED_RUN_PRESENTATION = {
  id: "saved",
  labelKey: "Saved",
  tone: "neutral",
} as const satisfies ChannelWorkflowStatusPresentation<"saved", "Saved">;

const LINKED_WORKFLOW_PRESENTATION = {
  id: "workflow",
  labelKey: "Workflow",
  tone: "neutral",
} as const satisfies ChannelWorkflowStatusPresentation<"workflow", "Workflow">;

export function channelWorkflowStatusPresentation(status: ChannelWorkflow["status"]) {
  return WORKFLOW_STATUS_PRESENTATION[status];
}

export function channelWorkflowStepStatusPresentation(status: ChannelWorkflowStep["status"]) {
  return WORKFLOW_STEP_STATUS_PRESENTATION[status];
}

export function channelWorkflowRunStatusPresentation(status: string | undefined) {
  switch (status) {
    case "queued":
    case "running":
    case "waiting_for_approval":
    case "yielded":
    case "succeeded":
    case "failed":
    case "cancelled":
      return RUN_STATUS_PRESENTATION[status];
    default:
      return SAVED_RUN_PRESENTATION;
  }
}

export function channelLinkedWorkflowStatusPresentation(status: ChannelWorkflow["status"] | undefined) {
  return status ? channelWorkflowStatusPresentation(status) : LINKED_WORKFLOW_PRESENTATION;
}
