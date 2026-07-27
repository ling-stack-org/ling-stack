import type { StatusTone } from "../../shared/ui/index.js";
import type { TaskStatus } from "../../types.js";

export type ChannelTaskPrimaryState =
  | "blocked"
  | "waiting"
  | "failed"
  | "running"
  | "queued"
  | "complete"
  | "ready";

export interface ChannelTaskPrimaryStateInput {
  readonly blockedByLease: boolean;
  readonly channelPaused: boolean;
  readonly linkedRunStatus: string;
  readonly pendingApprovalCount: number;
  readonly providerBlocked: boolean;
  readonly taskStatus: TaskStatus;
}

export interface ChannelTaskPrimaryStateView {
  readonly id: ChannelTaskPrimaryState;
  readonly label: string;
  readonly tone: StatusTone;
}

export function deriveChannelTaskPrimaryState(input: ChannelTaskPrimaryStateInput): ChannelTaskPrimaryStateView {
  if (input.channelPaused || input.providerBlocked || input.blockedByLease) {
    return { id: "blocked", label: "Blocked", tone: "danger" };
  }
  if (input.pendingApprovalCount > 0 || input.linkedRunStatus === "waiting_for_approval" || input.taskStatus === "review") {
    return { id: "waiting", label: "Waiting", tone: "warning" };
  }
  if (input.linkedRunStatus === "failed") {
    return { id: "failed", label: "Failed", tone: "danger" };
  }
  if (input.linkedRunStatus === "running" || input.taskStatus === "running") {
    return { id: "running", label: "Running", tone: "info" };
  }
  if (input.linkedRunStatus === "queued") {
    return { id: "queued", label: "Queued", tone: "info" };
  }
  if (input.linkedRunStatus === "succeeded" || input.taskStatus === "done") {
    return { id: "complete", label: "Complete", tone: "success" };
  }
  return { id: "ready", label: "Ready", tone: "neutral" };
}
