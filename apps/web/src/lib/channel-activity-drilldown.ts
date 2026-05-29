import type {
  ChannelContextSummary,
  ChannelWorkflow,
  ChannelWorkflowStep,
  Task,
} from "../types.js";
import type { ChannelActivityAttention, ChannelActivityCategory, ChannelActivityItem } from "./channel-activity.js";

export type ChannelActivityDrilldownTarget =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "approval"; readonly runId?: string }
  | { readonly kind: "protocol"; readonly mode: "brief" | "decisions" | "handoffs" | "runtime" };

export interface ChannelActivitySourcePacket {
  readonly sourceId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly summary: string;
  readonly status?: string;
  readonly metadata: readonly ChannelActivityDrilldownField[];
  readonly relatedObjects: readonly ChannelActivityDrilldownField[];
}

export interface ChannelActivityDrilldownField {
  readonly label: string;
  readonly value: string;
}

export interface ChannelActivityDrilldownItem {
  readonly id: string;
  readonly activityItemId: string;
  readonly kind: ChannelActivityItem["kind"];
  readonly category: ChannelActivityCategory;
  readonly attention: ChannelActivityAttention;
  readonly createdAt: string;
  readonly source: ChannelActivitySourcePacket;
  readonly targets: readonly ChannelActivityDrilldownTarget[];
}

export function buildChannelActivityDrilldownItem(input: {
  readonly item: ChannelActivityItem;
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly tasks: readonly Task[];
}): ChannelActivityDrilldownItem {
  const { item } = input;
  return {
    id: `drilldown:${item.id}`,
    activityItemId: item.id,
    kind: item.kind,
    category: item.category,
    attention: item.attention,
    createdAt: item.createdAt,
    source: buildSourcePacket(input),
    targets: buildTargets(input),
  };
}

function buildSourcePacket(input: {
  readonly item: ChannelActivityItem;
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly tasks: readonly Task[];
}): ChannelActivitySourcePacket {
  const { item } = input;
  if (item.kind === "message") {
    return {
      sourceId: item.record.id,
      title: "Message",
      subtitle: item.record.intent,
      summary: item.record.body,
      status: item.record.status,
      metadata: compactFields([
        field("Kind", item.record.kind),
        field("Author", item.record.authorId ?? item.record.authorType),
        field("Intent", item.record.intent),
        field("Status", item.record.status),
      ]),
      relatedObjects: compactFields([
        field("Attachments", item.record.attachmentIds.length.toString()),
        field("Link previews", item.record.linkPreviewIds.length.toString()),
        field("Linked task", item.record.linkedTaskId),
      ]),
    };
  }
  if (item.kind === "decision") {
    return {
      sourceId: item.record.id,
      title: item.record.title,
      subtitle: "Decision log",
      summary: item.record.decision,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Rationale", item.record.rationale),
      ]),
      relatedObjects: compactFields([
        field("Alternatives", item.record.alternatives.length.toString()),
        field("Supersedes", item.record.supersedesDecisionId),
      ]),
    };
  }
  if (item.kind === "handoff") {
    return {
      sourceId: item.record.id,
      title: `${item.record.fromParticipantLabel} -> ${item.record.toParticipantLabel}`,
      subtitle: "Handoff",
      summary: item.record.reason,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Required input", item.record.requiredInput),
        field("Expected output", item.record.expectedOutput),
      ]),
      relatedObjects: compactFields([
        field("Source message", item.record.sourceMessageId),
        field("Source task", item.record.sourceTaskId),
      ]),
    };
  }
  if (item.kind === "summary") {
    return {
      sourceId: item.record.id,
      title: "Context summary",
      subtitle: item.record.targetType,
      summary: item.record.summary,
      metadata: compactFields([
        field("Target", `${item.record.targetType} ${item.record.targetId}`),
        field("Created by", item.record.authorId ?? item.record.authorType),
      ]),
      relatedObjects: compactFields([
        field("Source messages", item.record.sourceMessageIds.join(", ")),
        field("Decisions", item.record.decisionIds.join(", ")),
      ]),
    };
  }
  if (item.kind === "workflow") {
    const steps = input.workflowSteps.filter((step) => step.workflowId === item.record.id);
    return {
      sourceId: item.record.id,
      title: item.record.title,
      subtitle: "Workflow",
      summary: item.record.objective,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Created by", item.record.createdBy),
      ]),
      relatedObjects: compactFields([
        field("Source handoff", item.record.sourceHandoffId),
        field("Steps", steps.length.toString()),
      ]),
    };
  }
  if (item.kind === "workflow-step") {
    const workflow = input.workflows.find((record) => record.id === item.record.workflowId);
    const summary = item.record.contextSummaryId ? input.contextSummaries.find((record) => record.id === item.record.contextSummaryId) : undefined;
    return {
      sourceId: item.record.id,
      title: item.record.title,
      subtitle: "Workflow step",
      summary: item.record.blocker ?? item.record.resultSummary ?? item.record.prompt,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Participant", item.record.toParticipantLabel),
        field("Position", item.record.position.toString()),
      ]),
      relatedObjects: compactFields([
        field("Workflow", workflow?.title ?? item.record.workflowId),
        field("Task", item.record.taskId),
        field("Run", item.record.runId),
        field("Context summary", summary?.summary ?? item.record.contextSummaryId),
      ]),
    };
  }
  if (item.kind === "task") {
    return {
      sourceId: item.record.id,
      title: item.record.title,
      subtitle: "Task event",
      summary: item.record.prompt,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Assignee", item.record.assigneeTeammateId),
      ]),
      relatedObjects: compactFields([
        field("Current run", item.record.currentRunId),
      ]),
    };
  }
  if (item.kind === "run") {
    return {
      sourceId: item.record.id,
      title: `Run ${item.record.id}`,
      subtitle: item.task?.title ?? readRunSnapshotTitle(item.record.taskSnapshot) ?? item.record.taskId,
      summary: item.record.errorMessage ?? `${item.record.providerName} / ${item.record.providerModel}`,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Provider", item.record.providerName),
        field("Model", item.record.providerModel),
      ]),
      relatedObjects: compactFields([
        field("Task", item.task?.title ?? item.record.taskId),
        field("Event log", item.record.eventLogPath),
        field("Summary path", item.record.summaryPath),
      ]),
    };
  }
  if (item.kind === "approval") {
    return {
      sourceId: item.record.id,
      title: item.record.title,
      subtitle: "Approval event",
      summary: item.record.description,
      status: item.record.status,
      metadata: compactFields([
        field("Status", item.record.status),
        field("Action", item.record.actionType),
        field("Risk", item.record.risk),
      ]),
      relatedObjects: compactFields([
        field("Task", item.task?.title ?? item.record.taskId),
        field("Run", item.run?.id ?? item.record.runId),
      ]),
    };
  }
  return {
    sourceId: item.record.id,
    title: "State transition",
    subtitle: `${item.record.entityType} ${item.record.entityId}`,
    summary: `${item.record.fromStatus} -> ${item.record.toStatus} via ${item.record.event}`,
    status: item.record.toStatus,
    metadata: compactFields([
      field("Entity", `${item.record.entityType} ${item.record.entityId}`),
      field("From", item.record.fromStatus),
      field("To", item.record.toStatus),
      field("Actor", item.record.actor),
      field("Reason", item.record.reason),
    ]),
    relatedObjects: compactFields([
      field("Task", item.task?.title),
      field("Run", item.run?.id),
    ]),
  };
}

function buildTargets(input: {
  readonly item: ChannelActivityItem;
}): readonly ChannelActivityDrilldownTarget[] {
  const { item } = input;
  if (item.kind === "decision") {
    return [{ kind: "protocol", mode: "decisions" }];
  }
  if (item.kind === "handoff") {
    return [{ kind: "protocol", mode: "handoffs" }];
  }
  if (item.kind === "summary") {
    return [{ kind: "protocol", mode: "brief" }];
  }
  if (item.kind === "workflow" || item.kind === "workflow-step") {
    return compactTargets([
      item.kind === "workflow-step" && item.record.taskId ? { kind: "task", taskId: item.record.taskId } : undefined,
      item.kind === "workflow-step" && item.record.runId ? { kind: "run", runId: item.record.runId } : undefined,
      { kind: "protocol", mode: "runtime" },
    ]);
  }
  if (item.kind === "task") {
    return compactTargets([
      { kind: "task", taskId: item.record.id },
      item.record.currentRunId ? { kind: "run", runId: item.record.currentRunId } : undefined,
    ]);
  }
  if (item.kind === "run") {
    return [
      { kind: "run", runId: item.record.id },
      { kind: "task", taskId: item.record.taskId },
    ];
  }
  if (item.kind === "approval") {
    return compactTargets([
      { kind: "approval", runId: item.record.runId },
      item.record.taskId ? { kind: "task", taskId: item.record.taskId } : undefined,
      item.record.runId ? { kind: "run", runId: item.record.runId } : undefined,
    ]);
  }
  if (item.kind === "state-transition") {
    if (item.record.entityType === "task") {
      return [{ kind: "task", taskId: item.record.entityId }];
    }
    if (item.record.entityType === "run") {
      return [{ kind: "run", runId: item.record.entityId }];
    }
    if (item.record.entityType === "approval") {
      return [{ kind: "approval" }];
    }
    return [{ kind: "protocol", mode: "runtime" }];
  }
  return item.kind === "message" && item.record.linkedTaskId
    ? [{ kind: "task", taskId: item.record.linkedTaskId }]
    : [];
}

function compactTargets(targets: readonly (ChannelActivityDrilldownTarget | undefined)[]): readonly ChannelActivityDrilldownTarget[] {
  return targets.filter((target): target is ChannelActivityDrilldownTarget => target !== undefined);
}

function field(label: string, value: string | undefined): ChannelActivityDrilldownField | undefined {
  return value && value.trim() ? { label, value } : undefined;
}

function compactFields(fields: readonly (ChannelActivityDrilldownField | undefined)[]): readonly ChannelActivityDrilldownField[] {
  return fields.filter((fieldItem): fieldItem is ChannelActivityDrilldownField => fieldItem !== undefined);
}

function readRunSnapshotTitle(snapshot: unknown): string | undefined {
  return isRecord(snapshot) && typeof snapshot.title === "string" ? snapshot.title : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
