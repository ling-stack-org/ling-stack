import type {
  ApprovalRequest,
  ChannelAttachment,
  ChannelContextSummary,
  ChannelDecision,
  ChannelHandoff,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunSession,
  StateTransitionEvent,
  Task,
} from "../types.js";
import { deriveChannelRuns, deriveChannelTasks } from "./channel-artifacts.js";

export type ChannelActivityCategory = "message" | "work" | "approval" | "protocol" | "runtime";
export type ChannelActivityAttention = "blocked" | "pending" | "failed" | "none";

interface ChannelActivityMetadata {
  readonly category: ChannelActivityCategory;
  readonly attention: ChannelActivityAttention;
  readonly searchText: string;
}

export type ChannelActivityItem =
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "message"; readonly createdAt: string; readonly record: ChannelMessage })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "decision"; readonly createdAt: string; readonly record: ChannelDecision })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "handoff"; readonly createdAt: string; readonly record: ChannelHandoff })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "summary"; readonly createdAt: string; readonly record: ChannelContextSummary })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "workflow"; readonly createdAt: string; readonly record: ChannelWorkflow })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "workflow-step"; readonly createdAt: string; readonly record: ChannelWorkflowStep })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "task"; readonly createdAt: string; readonly record: Task })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "run"; readonly createdAt: string; readonly record: RunSession; readonly task?: Task })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "approval"; readonly createdAt: string; readonly record: ApprovalRequest; readonly task?: Task; readonly run?: RunSession })
  | (ChannelActivityMetadata & { readonly id: string; readonly kind: "state-transition"; readonly createdAt: string; readonly record: StateTransitionEvent; readonly task?: Task; readonly run?: RunSession });

type ChannelActivityItemInput = ChannelActivityItem extends infer Item
  ? Item extends ChannelActivityMetadata
    ? Omit<Item, keyof ChannelActivityMetadata>
    : never
  : never;

export function buildChannelActivityItems(input: {
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly attachments?: readonly ChannelAttachment[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly decisions: readonly ChannelDecision[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly summaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly extraRun?: RunSession;
}): readonly ChannelActivityItem[] {
  const channelTasks = deriveChannelTasks(input.channelId, input.tasks);
  const channelRuns = deriveChannelRuns(input.channelId, input.tasks, input.runs, input.extraRun);
  const attachmentById = new Map((input.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const attachmentsByMessageId = new Map<string, ChannelAttachment[]>();
  for (const attachment of input.attachments ?? []) {
    if (!attachment.messageId) {
      continue;
    }
    const messageAttachments = attachmentsByMessageId.get(attachment.messageId) ?? [];
    messageAttachments.push(attachment);
    attachmentsByMessageId.set(attachment.messageId, messageAttachments);
  }
  const taskById = new Map(channelTasks.map((task) => [task.id, task]));
  const runById = new Map(channelRuns.map((run) => [run.id, run]));
  const workflowIds = new Set(input.workflows.filter((workflow) => workflow.channelId === input.channelId).map((workflow) => workflow.id));
  const workflowStepIds = new Set(input.workflowSteps.filter((step) => step.channelId === input.channelId).map((step) => step.id));

  const approvalItems = input.approvals
    .filter((approval) => {
      if (approval.channelId === input.channelId) {
        return true;
      }
      return Boolean((approval.taskId && taskById.has(approval.taskId)) || (approval.runId && runById.has(approval.runId)));
    })
    .map((record) => withActivityMetadata({
      id: `approval:${record.id}`,
      kind: "approval" as const,
      createdAt: record.resolvedAt ?? record.createdAt,
      record,
      task: record.taskId ? taskById.get(record.taskId) : undefined,
      run: record.runId ? runById.get(record.runId) : undefined,
    }));

  const transitionItems = input.stateTransitions
    .filter((transition) => {
      if (transition.entityType === "task") {
        return taskById.has(transition.entityId);
      }
      if (transition.entityType === "run") {
        return runById.has(transition.entityId);
      }
      if (transition.entityType === "workflow") {
        return workflowIds.has(transition.entityId);
      }
      if (transition.entityType === "workflow_step") {
        return workflowStepIds.has(transition.entityId);
      }
      if (transition.entityType === "approval") {
        return approvalItems.some((item) => item.record.id === transition.entityId);
      }
      return false;
    })
    .map((record) => withActivityMetadata({
      id: `transition:${record.id}`,
      kind: "state-transition" as const,
      createdAt: record.createdAt,
      record,
      task: record.entityType === "task" ? taskById.get(record.entityId) : undefined,
      run: record.entityType === "run" ? runById.get(record.entityId) : undefined,
    }));

  return [
    ...input.messages
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata(
        { id: `message:${record.id}`, kind: "message" as const, createdAt: record.createdAt, record },
        messageAttachmentSearchParts(record, attachmentById, attachmentsByMessageId),
      )),
    ...input.decisions
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata({ id: `decision:${record.id}`, kind: "decision" as const, createdAt: record.createdAt, record })),
    ...input.handoffs
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata({ id: `handoff:${record.id}`, kind: "handoff" as const, createdAt: record.createdAt, record })),
    ...input.summaries
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata({ id: `summary:${record.id}`, kind: "summary" as const, createdAt: record.updatedAt, record })),
    ...input.workflows
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata({ id: `workflow:${record.id}`, kind: "workflow" as const, createdAt: record.updatedAt, record })),
    ...input.workflowSteps
      .filter((record) => record.channelId === input.channelId)
      .map((record) => withActivityMetadata({ id: `workflow-step:${record.id}`, kind: "workflow-step" as const, createdAt: record.updatedAt, record })),
    ...channelTasks.map((record) => withActivityMetadata({ id: `task:${record.id}`, kind: "task" as const, createdAt: record.updatedAt, record })),
    ...channelRuns.map((record) => withActivityMetadata({
      id: `run:${record.id}`,
      kind: "run" as const,
      createdAt: record.endedAt ?? record.startedAt ?? record.updatedAt,
      record,
      task: taskById.get(record.taskId),
    })),
    ...approvalItems,
    ...transitionItems,
  ].sort((left, right) => {
    const timeComparison = left.createdAt.localeCompare(right.createdAt);
    return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
  });
}

function withActivityMetadata<T extends ChannelActivityItemInput>(
  item: T,
  extraSearchParts: readonly string[] = [],
): T & ChannelActivityMetadata {
  return {
    ...item,
    category: activityCategory(item),
    attention: activityAttention(item),
    searchText: normalizeSearchText([...activitySearchParts(item), ...extraSearchParts]),
  };
}

function activityCategory(item: ChannelActivityItemInput): ChannelActivityCategory {
  if (item.kind === "message") {
    return "message";
  }
  if (item.kind === "task" || item.kind === "run") {
    return "work";
  }
  if (item.kind === "approval") {
    return "approval";
  }
  if (item.kind === "state-transition" || item.kind === "workflow" || item.kind === "workflow-step") {
    return "runtime";
  }
  return "protocol";
}

function activityAttention(item: ChannelActivityItemInput): ChannelActivityAttention {
  if (item.kind === "decision") {
    return item.record.status === "rejected" ? "failed" : "none";
  }
  if (item.kind === "handoff") {
    if (item.record.status === "declined" || item.record.status === "cancelled") {
      return "failed";
    }
    if (item.record.status === "proposed" || item.record.status === "accepted") {
      return "pending";
    }
  }
  if (item.kind === "approval") {
    return item.record.status === "pending" ? "pending" : item.record.status === "denied" || item.record.status === "expired" ? "failed" : "none";
  }
  if (item.kind === "task" || item.kind === "run" || item.kind === "workflow" || item.kind === "workflow-step") {
    const status = item.record.status;
    if (status === "blocked") {
      return "blocked";
    }
    if (status === "failed" || status === "cancelled") {
      return "failed";
    }
    if (status === "todo" || status === "queued" || status === "running" || status === "waiting_for_approval" || status === "claimed" || status === "ready" || status === "review") {
      return "pending";
    }
  }
  if (item.kind === "state-transition") {
    if (item.record.toStatus === "blocked") {
      return "blocked";
    }
    if (item.record.toStatus === "failed" || item.record.toStatus === "cancelled" || item.record.toStatus === "denied" || item.record.toStatus === "expired") {
      return "failed";
    }
    if (item.record.toStatus === "queued" || item.record.toStatus === "running" || item.record.toStatus === "waiting_for_approval" || item.record.toStatus === "pending") {
      return "pending";
    }
  }
  return "none";
}

function activitySearchParts(item: ChannelActivityItemInput): readonly string[] {
  if (item.kind === "message") {
    return [
      item.kind,
      item.record.kind,
      item.record.intent,
      item.record.authorId ?? "",
      item.record.body,
      item.record.linkedTaskId ?? "",
      item.record.linkedRunId ?? "",
      ...(item.record.fileRefs ?? []).flatMap((fileRef) => [fileRef.label ?? "", fileRef.path]),
    ];
  }
  if (item.kind === "decision") {
    return [item.kind, item.record.status, item.record.title, item.record.decision, item.record.rationale, ...item.record.alternatives];
  }
  if (item.kind === "handoff") {
    return [item.kind, item.record.status, item.record.fromParticipantLabel, item.record.toParticipantLabel, item.record.reason, item.record.requiredInput, item.record.expectedOutput];
  }
  if (item.kind === "summary") {
    return [item.kind, item.record.targetType, item.record.targetId, item.record.summary];
  }
  if (item.kind === "workflow") {
    return [item.kind, item.record.id, item.record.status, item.record.title, item.record.objective];
  }
  if (item.kind === "workflow-step") {
    return [item.kind, item.record.id, item.record.status, item.record.title, item.record.prompt, item.record.toParticipantLabel, item.record.blocker ?? "", item.record.resultSummary ?? ""];
  }
  if (item.kind === "task") {
    return [item.kind, item.record.id, item.record.status, item.record.title, item.record.prompt, item.record.assigneeTeammateId ?? "", item.record.currentRunId ?? ""];
  }
  if (item.kind === "run") {
    return [item.kind, item.record.id, item.record.status, item.record.taskId, item.task?.title ?? "", item.record.providerName, item.record.providerModel, item.record.errorMessage ?? ""];
  }
  if (item.kind === "approval") {
    return [item.kind, item.record.id, item.record.status, item.record.actionType, item.record.risk, item.record.title, item.record.description, item.task?.title ?? "", item.run?.id ?? ""];
  }
  return [
    item.kind,
    item.record.id,
    item.record.entityType,
    item.record.entityId,
    item.record.fromStatus,
    item.record.toStatus,
    item.record.event,
    item.record.actor,
    item.record.reason ?? "",
  ];
}

function messageAttachmentSearchParts(
  message: ChannelMessage,
  attachmentById: ReadonlyMap<string, ChannelAttachment>,
  attachmentsByMessageId: ReadonlyMap<string, readonly ChannelAttachment[]>,
): readonly string[] {
  const attachments = new Map<string, ChannelAttachment>();
  for (const attachmentId of message.attachmentIds ?? []) {
    const attachment = attachmentById.get(attachmentId);
    if (attachment) {
      attachments.set(attachment.id, attachment);
    }
  }
  for (const attachment of attachmentsByMessageId.get(message.id) ?? []) {
    attachments.set(attachment.id, attachment);
  }
  return [...attachments.values()].flatMap((attachment) => [
    attachment.fileName,
    attachment.path,
    attachment.contentType,
  ]);
}

function normalizeSearchText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}
