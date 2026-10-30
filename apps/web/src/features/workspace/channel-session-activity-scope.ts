import type { ChannelActivityItem } from "../../lib/channel-activity.js";

export interface ChannelSessionActivityScope {
  readonly threadId: string;
  readonly messageIds: ReadonlySet<string>;
  readonly runIds: ReadonlySet<string>;
  readonly taskIds: ReadonlySet<string>;
  readonly workflowIds: ReadonlySet<string>;
  readonly workflowStepIds: ReadonlySet<string>;
  readonly approvalIds: ReadonlySet<string>;
}


export function channelActivityItemBelongsToSession(
  item: ChannelActivityItem,
  scope: ChannelSessionActivityScope,
): boolean {
  switch (item.kind) {
    case "message":
      return item.record.threadId === scope.threadId;
    case "run":
      return scope.runIds.has(item.record.id);
    case "task":
      return scope.taskIds.has(item.record.id);
    case "approval":
      return Boolean(
        scope.approvalIds.has(item.record.id) ||
        (item.record.runId && scope.runIds.has(item.record.runId)) ||
        (item.record.taskId && scope.taskIds.has(item.record.taskId)),
      );
    case "state-transition":
      return (
        (item.record.entityType === "run" && scope.runIds.has(item.record.entityId)) ||
        (item.record.entityType === "task" && scope.taskIds.has(item.record.entityId)) ||
        (item.record.entityType === "workflow" && scope.workflowIds.has(item.record.entityId)) ||
        (item.record.entityType === "workflow_step" && scope.workflowStepIds.has(item.record.entityId))
      );
    case "workflow":
      return scope.workflowIds.has(item.record.id);
    case "workflow-step":
      return (
        scope.workflowIds.has(item.record.workflowId) ||
        Boolean(item.record.runId && scope.runIds.has(item.record.runId)) ||
        Boolean(item.record.metadata?.sourceMessageId && scope.messageIds.has(item.record.metadata.sourceMessageId))
      );
    case "decision":
    case "handoff":
      return Boolean(
        (item.record.sourceMessageId && scope.messageIds.has(item.record.sourceMessageId)) ||
        (item.record.sourceTaskId && scope.taskIds.has(item.record.sourceTaskId)) ||
        (item.record.sourceRunId && scope.runIds.has(item.record.sourceRunId))
      );
    case "summary":
      return (
        item.record.targetId === scope.threadId ||
        (item.record.targetType === "task" && scope.taskIds.has(item.record.targetId)) ||
        scope.messageIds.has(item.record.targetId) ||
        item.record.sourceMessageIds.some((messageId) => scope.messageIds.has(messageId))
      );
    default:
      return false;
  }
}
