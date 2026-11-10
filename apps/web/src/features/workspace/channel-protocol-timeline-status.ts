import type { ConversationTimelineItemStatus } from "@ling-stack/conversation-ui-core";
import type { LingTurnStatus, MediaJobStatus, WorkUnitStatus } from "@ling-stack/contracts";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";

type ProtocolTimelineStatus = ConversationTimelineItemStatus | undefined;
type ActivityStatus<Kind extends ChannelActivityItem["kind"]> = Extract<
  ChannelActivityItem,
  { readonly kind: Kind }
>["record"] extends { readonly status: infer Status }
  ? Extract<Status, string>
  : never;

const approvalStatusMap = {
  pending: "waiting",
  approved: "succeeded",
  denied: "failed",
  expired: "failed",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"approval">, ProtocolTimelineStatus>>;

const decisionStatusMap = {
  // An active decision is a current protocol fact, not work that is still running.
  // Keep its domain state in `meta` without inventing an execution lifecycle.
  active: undefined,
  superseded: "cancelled",
  rejected: "failed",
} as const satisfies Readonly<Record<ActivityStatus<"decision">, ProtocolTimelineStatus>>;

const handoffStatusMap = {
  proposed: "pending",
  accepted: "running",
  declined: "failed",
  completed: "succeeded",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"handoff">, ProtocolTimelineStatus>>;

const workflowStatusMap = {
  waiting_for_input: "waiting",
  draft: "pending",
  ready: "pending",
  running: "running",
  waiting_for_approval: "waiting",
  blocked: "blocked",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"workflow">, ProtocolTimelineStatus>>;

const workflowStepStatusMap = {
  waiting_for_input: "waiting",
  queued: "pending",
  claimed: "running",
  running: "running",
  waiting_for_approval: "waiting",
  blocked: "blocked",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "succeeded",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"workflow-step">, ProtocolTimelineStatus>>;

const taskStatusMap = {
  waiting_for_input: "waiting",
  todo: "pending",
  claimed: "running",
  running: "running",
  blocked: "blocked",
  review: "pending",
  done: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"task">, ProtocolTimelineStatus>>;

const runStatusMap = {
  yielded: "waiting",
  queued: "pending",
  running: "running",
  waiting_for_approval: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<ActivityStatus<"run">, ProtocolTimelineStatus>>;

const turnStatusMap = {
  waiting_for_input: "waiting",
  open: "pending",
  running: "running",
  waiting_for_approval: "waiting",
  blocked: "blocked",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "cancelled",
} as const satisfies Readonly<Record<LingTurnStatus, ProtocolTimelineStatus>>;

const mediaJobStatusMap = {
  queued: "pending",
  running: "running",
  waiting_for_approval: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<MediaJobStatus, ProtocolTimelineStatus>>;

const workUnitStatusMap = {
  waiting_for_input: "waiting",
  queued: "pending",
  claimed: "running",
  running: "running",
  waiting_for_approval: "waiting",
  cancelling: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  stale: "failed",
} as const satisfies Readonly<Record<WorkUnitStatus, ProtocolTimelineStatus>>;

export function channelApprovalTimelineStatus(status: ActivityStatus<"approval">): ProtocolTimelineStatus {
  return approvalStatusMap[status];
}

export function channelDecisionTimelineStatus(status: ActivityStatus<"decision">): ProtocolTimelineStatus {
  return decisionStatusMap[status];
}

export function channelHandoffTimelineStatus(status: ActivityStatus<"handoff">): ProtocolTimelineStatus {
  return handoffStatusMap[status];
}

export function channelWorkflowTimelineStatus(status: ActivityStatus<"workflow">): ProtocolTimelineStatus {
  return workflowStatusMap[status];
}

export function channelWorkflowStepTimelineStatus(status: ActivityStatus<"workflow-step">): ProtocolTimelineStatus {
  return workflowStepStatusMap[status];
}

export function channelTaskTimelineStatus(status: ActivityStatus<"task">): ProtocolTimelineStatus {
  return taskStatusMap[status];
}

export function channelRunTimelineStatus(status: ActivityStatus<"run">): ProtocolTimelineStatus {
  return runStatusMap[status];
}

export function channelStateTransitionTimelineStatus(
  transition: Extract<ChannelActivityItem, { readonly kind: "state-transition" }>["record"],
): ProtocolTimelineStatus {
  if (transition.entityType === "task") return statusFromUnknown(taskStatusMap, transition.toStatus);
  if (transition.entityType === "run") return statusFromUnknown(runStatusMap, transition.toStatus);
  if (transition.entityType === "approval") return statusFromUnknown(approvalStatusMap, transition.toStatus);
  if (transition.entityType === "media_job") return statusFromUnknown(mediaJobStatusMap, transition.toStatus);
  if (transition.entityType === "workflow") return statusFromUnknown(workflowStatusMap, transition.toStatus);
  if (transition.entityType === "workflow_step") return statusFromUnknown(workflowStepStatusMap, transition.toStatus);
  if (transition.entityType === "work_unit") return statusFromUnknown(workUnitStatusMap, transition.toStatus);
  if (transition.entityType === "turn") return statusFromUnknown(turnStatusMap, transition.toStatus);
  return undefined;
}

function statusFromUnknown<Status extends string>(
  map: Readonly<Record<Status, ProtocolTimelineStatus>>,
  status: string,
): ProtocolTimelineStatus {
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status as Status] : undefined;
}
