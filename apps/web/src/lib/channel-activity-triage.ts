import type {
  ChannelContextSummary,
  ChannelContextSummaryTargetType,
  ChannelDecision,
  ChannelHandoff,
  Task,
} from "../types.js";
import type { ChannelActivityDrilldownItem, ChannelActivityDrilldownTarget } from "./channel-activity-drilldown.js";

export type ChannelActivityTriageActionKind = "follow_up_task" | "handoff" | "decision" | "context_summary";

export interface ChannelActivityTriageAction {
  readonly id: ChannelActivityTriageActionKind;
  readonly label: string;
  readonly description: string;
}

export interface ChannelActivityTriageSourceRefs {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly contextTargetType: ChannelContextSummaryTargetType;
  readonly contextTargetId: string;
  readonly sourceMessageIds: readonly string[];
}

interface ChannelActivityTriageDraftBase {
  readonly actionKind: ChannelActivityTriageActionKind;
  readonly sourceTitle: string;
  readonly sourceKind: ChannelActivityDrilldownItem["kind"];
  readonly sourceId: string;
  readonly sourceRefs: ChannelActivityTriageSourceRefs;
}

export type ChannelActivityTriageDraft =
  | (ChannelActivityTriageDraftBase & {
    readonly actionKind: "follow_up_task";
    readonly title: string;
    readonly prompt: string;
    readonly assigneeTeammateId?: string;
  })
  | (ChannelActivityTriageDraftBase & {
    readonly actionKind: "handoff";
    readonly reason: string;
    readonly requiredInput: string;
    readonly expectedOutput: string;
    readonly toParticipantId: string;
    readonly toParticipantLabel: string;
  })
  | (ChannelActivityTriageDraftBase & {
    readonly actionKind: "decision";
    readonly title: string;
    readonly decision: string;
    readonly rationale: string;
  })
  | (ChannelActivityTriageDraftBase & {
    readonly actionKind: "context_summary";
    readonly summary: string;
    readonly acceptanceCriteria: string;
    readonly openQuestions: string;
    readonly decisionIds: readonly string[];
  });

export type ChannelActivityTriageResult =
  | { readonly kind: "task"; readonly task: Task }
  | { readonly kind: "handoff"; readonly handoff: ChannelHandoff }
  | { readonly kind: "decision"; readonly decision: ChannelDecision }
  | { readonly kind: "context_summary"; readonly contextSummary: ChannelContextSummary };

const followUpTaskAction: ChannelActivityTriageAction = {
  id: "follow_up_task",
  label: "Create follow-up task",
  description: "Create a task from this event.",
};

const handoffAction: ChannelActivityTriageAction = {
  id: "handoff",
  label: "Create handoff",
  description: "Route this event to an AI teammate.",
};

const decisionAction: ChannelActivityTriageAction = {
  id: "decision",
  label: "Record decision",
  description: "Capture the decision or approval outcome.",
};

const contextSummaryAction: ChannelActivityTriageAction = {
  id: "context_summary",
  label: "Create context summary",
  description: "Save the source context for later work.",
};

export function buildChannelActivityTriageActions(
  drilldown: ChannelActivityDrilldownItem,
): readonly ChannelActivityTriageAction[] {
  const actions: ChannelActivityTriageAction[] = [];
  const addAction = (action: ChannelActivityTriageAction): void => {
    if (!actions.some((item) => item.id === action.id)) {
      actions.push(action);
    }
  };

  if (drilldown.kind === "approval" && drilldown.attention === "pending") {
    addAction(decisionAction);
  }
  if (canCreateFollowUpTask(drilldown)) {
    addAction(followUpTaskAction);
  }
  if (canCreateHandoff(drilldown)) {
    addAction(handoffAction);
  }
  if (canRecordDecision(drilldown)) {
    addAction(decisionAction);
  }
  addAction(contextSummaryAction);

  return actions;
}

export function buildChannelActivityTriageDraft(input: {
  readonly drilldown: ChannelActivityDrilldownItem;
  readonly actionKind: ChannelActivityTriageActionKind;
  readonly defaultTeammateId?: string;
  readonly activeDecisionIds?: readonly string[];
}): ChannelActivityTriageDraft {
  const sourceRefs = buildSourceRefs(input.drilldown);
  const sourceContext = buildSourceContext(input.drilldown);
  const sourceTitle = compactTitle(input.drilldown.source.title);
  const base = {
    actionKind: input.actionKind,
    sourceTitle,
    sourceKind: input.drilldown.kind,
    sourceId: input.drilldown.source.sourceId,
    sourceRefs,
  } satisfies ChannelActivityTriageDraftBase;

  if (input.actionKind === "handoff") {
    const teammateId = input.defaultTeammateId || "engineer";
    return {
      ...base,
      actionKind: "handoff",
      reason: `Follow up: ${sourceTitle}`,
      requiredInput: sourceContext,
      expectedOutput: "Resolve the blocker or report the next concrete step.",
      toParticipantId: teammateId,
      toParticipantLabel: teammateId,
    };
  }

  if (input.actionKind === "decision") {
    return {
      ...base,
      actionKind: "decision",
      title: `Decision: ${sourceTitle}`,
      decision: input.drilldown.source.summary,
      rationale: "Recorded from Activity triage.",
    };
  }

  if (input.actionKind === "context_summary") {
    return {
      ...base,
      actionKind: "context_summary",
      summary: sourceContext,
      acceptanceCriteria: "",
      openQuestions: "",
      decisionIds: input.activeDecisionIds ?? [],
    };
  }

  return {
    ...base,
    actionKind: "follow_up_task",
    title: `Follow up: ${sourceTitle}`,
    prompt: sourceContext,
    assigneeTeammateId: input.defaultTeammateId,
  };
}

export function channelActivityTriageDraftIsValid(draft: ChannelActivityTriageDraft | undefined): boolean {
  if (!draft) {
    return false;
  }
  if (draft.actionKind === "follow_up_task") {
    return Boolean(draft.title.trim() && draft.prompt.trim());
  }
  if (draft.actionKind === "handoff") {
    return Boolean(
      draft.reason.trim() &&
      draft.requiredInput.trim() &&
      draft.expectedOutput.trim() &&
      draft.toParticipantId.trim() &&
      draft.toParticipantLabel.trim(),
    );
  }
  if (draft.actionKind === "decision") {
    return Boolean(draft.title.trim() && draft.decision.trim());
  }
  return Boolean(draft.summary.trim());
}

export function channelActivityTriageResultLabel(result: ChannelActivityTriageResult): string {
  if (result.kind === "task") {
    return result.task.title;
  }
  if (result.kind === "handoff") {
    return result.handoff.reason;
  }
  if (result.kind === "decision") {
    return result.decision.title;
  }
  return result.contextSummary.summary;
}

function canCreateFollowUpTask(drilldown: ChannelActivityDrilldownItem): boolean {
  return drilldown.kind === "message" ||
    drilldown.kind === "task" ||
    drilldown.kind === "run" ||
    drilldown.kind === "workflow-step" ||
    drilldown.kind === "state-transition";
}

function canCreateHandoff(drilldown: ChannelActivityDrilldownItem): boolean {
  return drilldown.attention === "blocked" ||
    drilldown.attention === "failed" ||
    drilldown.kind === "message" ||
    drilldown.kind === "task" ||
    drilldown.kind === "run" ||
    drilldown.kind === "workflow-step" ||
    drilldown.kind === "state-transition" ||
    drilldown.kind === "decision" ||
    drilldown.kind === "summary";
}

function canRecordDecision(drilldown: ChannelActivityDrilldownItem): boolean {
  return drilldown.kind === "message" ||
    drilldown.kind === "task" ||
    drilldown.kind === "run" ||
    drilldown.kind === "approval" ||
    drilldown.kind === "state-transition" ||
    drilldown.kind === "workflow-step" ||
    drilldown.kind === "handoff" ||
    drilldown.kind === "summary";
}

function buildSourceRefs(drilldown: ChannelActivityDrilldownItem): ChannelActivityTriageSourceRefs {
  const taskTarget = findTarget(drilldown.targets, "task");
  const runTarget = findTarget(drilldown.targets, "run");
  const sourceTaskId = drilldown.kind === "task" ? drilldown.source.sourceId : taskTarget?.taskId;
  const sourceRunId = drilldown.kind === "run" ? drilldown.source.sourceId : runTarget?.runId;
  return {
    sourceMessageId: drilldown.kind === "message" ? drilldown.source.sourceId : undefined,
    sourceTaskId,
    sourceRunId,
    contextTargetType: sourceTaskId ? "task" : "thread",
    contextTargetId: sourceTaskId ?? drilldown.source.sourceId,
    sourceMessageIds: drilldown.kind === "message" ? [drilldown.source.sourceId] : [],
  };
}

function findTarget<TKind extends ChannelActivityDrilldownTarget["kind"]>(
  targets: readonly ChannelActivityDrilldownTarget[],
  kind: TKind,
): Extract<ChannelActivityDrilldownTarget, { readonly kind: TKind }> | undefined {
  return targets.find((target): target is Extract<ChannelActivityDrilldownTarget, { readonly kind: TKind }> => target.kind === kind);
}

function buildSourceContext(drilldown: ChannelActivityDrilldownItem): string {
  const lines = [
    `Source: ${drilldown.source.title}`,
    `Type: ${drilldown.kind}`,
    `Status: ${drilldown.source.status ?? drilldown.attention}`,
    `Time: ${drilldown.createdAt}`,
    `Source id: ${drilldown.source.sourceId}`,
    "",
    drilldown.source.summary,
  ];
  const related = drilldown.source.relatedObjects
    .map((field) => `${field.label}: ${field.value}`)
    .join("\n");
  return related ? `${lines.join("\n")}\n\nRelated objects:\n${related}` : lines.join("\n");
}

function compactTitle(value: string): string {
  const title = value.trim() || "Activity item";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}
