import type { Translate } from "../i18n.js";
import type { ConversationWorkCellRow, ConversationWorkCellRowTone, ConversationWorkCellViewModel } from "./conversation-work-cell.js";
import type { CollaborationTaskCardModel, CollaborationTaskStepState } from "./collaboration-task-card.js";
import { workflowProgressToConversationWorkCell, type WorkflowProgressModel } from "./workflow-progress.js";

export function collaborationTaskCardToConversationWorkCell(input: {
  readonly card: CollaborationTaskCardModel;
  readonly progress: WorkflowProgressModel;
  readonly t: Translate;
}): ConversationWorkCellViewModel {
  const base = workflowProgressToConversationWorkCell(input.progress);
  return {
    ...base,
    id: `collaboration-work-cell:${input.card.workflowId}`,
    presentation: "collaboration_task",
    kicker: collaborationTaskWorkCellKicker(input.card, input.t),
    detailsLabel: input.t("Open workflow evidence"),
    showDiagnostics: false,
    title: input.card.title,
    summary: collaborationTaskWorkCellSummary(input.card, base.summary, input.t),
    stats: buildCollaborationWorkCellStats(input.card, input.t),
    activeRows: input.card.mode === "completed" ? [] : buildCollaborationActiveRows(input.card, input.t),
    finalReportRows: buildFinalLingReportRows(input.card, base, input.t),
  };
}

function collaborationTaskWorkCellKicker(card: CollaborationTaskCardModel, t: Translate): string {
  if (card.mode === "completed") {
    return t("Collaboration complete");
  }
  if (card.mode === "blocked") {
    return t("Collaboration blocked");
  }
  if (card.mode === "failed") {
    return t("Collaboration failed");
  }
  if (card.mode === "cancelled") {
    return t("Collaboration cancelled");
  }
  if (card.mode === "waiting") {
    return t("Collaboration waiting");
  }
  if (card.mode === "ready_for_confirmation") {
    return t("Ready to start");
  }
  return t("Collaboration in progress");
}

function collaborationTaskWorkCellSummary(card: CollaborationTaskCardModel, fallbackSummary: string, t: Translate): string {
  if (card.mode === "completed") {
    const summary = readFinalStepSummary(card);
    return summary ? t("Collaboration complete: {summary}", { summary }) : t("Collaboration complete.");
  }
  if (card.mode === "blocked") {
    return t("Collaboration blocked: {reason}", { reason: card.blocker ?? fallbackSummary });
  }
  if (card.mode === "failed") {
    const summary = readFailedStepSummary(card) ?? card.blocker ?? fallbackSummary;
    return t("Collaboration failed: {summary}", { summary });
  }
  if (card.mode === "cancelled") {
    return t("Collaboration cancelled.");
  }
  if (card.pendingApprovalCount > 0 || card.mode === "waiting") {
    return card.nextAction ?? fallbackSummary;
  }
  const focusStep = card.steps.find((step) => step.state === "active") ?? card.steps.find((step) => step.state !== "done");
  if (focusStep) {
    return t("{teammate} is working on {step}. {done} of {total} steps complete.", {
      teammate: focusStep.ownerLabel,
      step: focusStep.title,
      done: card.completedStepCount,
      total: card.totalStepCount,
    });
  }
  return fallbackSummary;
}

function buildCollaborationWorkCellStats(card: CollaborationTaskCardModel, t: Translate): ConversationWorkCellViewModel["stats"] {
  return [
    { id: "mode", label: t("Mode"), value: t(collaborationExecutionModeLabel(card.executionMode)) },
    { id: "steps", label: t("Steps"), value: `${card.completedStepCount}/${card.totalStepCount}` },
    { id: "approvals", label: t("Approvals"), value: String(card.pendingApprovalCount) },
  ];
}

function buildCollaborationActiveRows(card: CollaborationTaskCardModel, t: Translate): readonly ConversationWorkCellRow[] {
  const rows: ConversationWorkCellRow[] = [];
  const visibleSteps = visibleCollaborationTaskSteps(card).slice(0, 4);
  for (const step of visibleSteps) {
    rows.push({
      id: `collaboration-step:${step.id}`,
      title: `${step.ownerLabel}: ${step.title}`,
      description: step.summary,
      meta: t(collaborationTaskStepStateLabel(step.state)),
      tone: collaborationStepTone(step.state),
    });
  }
  if (card.blocker && !visibleSteps.some((step) => step.state === "blocked" || step.state === "failed")) {
    rows.push({
      id: "collaboration-blocker",
      title: t("Collaboration blocked"),
      description: card.blocker,
      tone: "failed",
    });
  }
  if (card.pendingApprovalCount > 0) {
    rows.push({
      id: "collaboration-approvals",
      title: t("Waiting for approval"),
      description: t("{count} pending approvals", { count: card.pendingApprovalCount }),
      tone: "waiting",
    });
  }
  return rows.slice(0, 5);
}

function buildFinalLingReportRows(
  card: CollaborationTaskCardModel,
  base: ConversationWorkCellViewModel,
  t: Translate,
): readonly ConversationWorkCellRow[] {
  if (card.mode !== "completed" && card.mode !== "blocked" && card.mode !== "failed" && card.mode !== "cancelled") {
    return [];
  }

  const rows: ConversationWorkCellRow[] = [];
  const finalSummary = readFinalStepSummary(card) ?? card.blocker ?? base.summary;
  rows.push({
    id: "final-outcome",
    title: t("Outcome"),
    description: finalSummary,
    meta: t(collaborationTaskCardModeLabel(card.mode)),
    tone: card.mode === "completed" ? "success" : card.mode === "blocked" ? "waiting" : "failed",
  });

  const changedGroup = base.groups.find((group) => group.id === "changed");
  const evidenceGroup = base.groups.find((group) => group.id === "evidence");
  const changedCount = changedGroup?.rows.length ?? 0;
  const evidenceCount = base.evidenceLinks.length || evidenceGroup?.rows.length || 0;
  if (changedCount > 0 || evidenceCount > 0) {
    rows.push({
      id: "final-evidence",
      title: t("Evidence and changes"),
      description: changedCount > 0
        ? t("{changed} changed items, {evidence} evidence items", { changed: changedCount, evidence: evidenceCount })
        : t("{count} evidence items", { count: evidenceCount }),
      tone: "neutral",
    });
  }

  if (card.blocker || card.mode === "blocked" || card.mode === "failed") {
    rows.push({
      id: "final-next-action",
      title: t("Next action"),
      description: card.blocker ?? card.nextAction ?? t("Review workflow evidence"),
      tone: card.mode === "blocked" ? "waiting" : "failed",
    });
  } else if (card.mode === "completed") {
    rows.push({
      id: "final-next-action",
      title: t("Next action"),
      description: t("Open workflow evidence for details if needed."),
      tone: "neutral",
    });
  }

  return rows.slice(0, 4);
}

function visibleCollaborationTaskSteps(card: CollaborationTaskCardModel): readonly CollaborationTaskCardModel["steps"][number][] {
  const active = card.steps.filter((step) => step.state !== "done");
  if (active.length > 0) {
    const completedBeforeActive = card.steps.filter((step) => step.state === "done").slice(-2);
    return [...completedBeforeActive, ...active].slice(0, 6);
  }
  return card.steps.slice(-6);
}

function readFinalStepSummary(card: CollaborationTaskCardModel): string | undefined {
  for (let index = card.steps.length - 1; index >= 0; index -= 1) {
    const step = card.steps[index];
    if (step.state === "done" && step.summary?.trim()) {
      return step.summary.trim();
    }
  }
  return undefined;
}

function readFailedStepSummary(card: CollaborationTaskCardModel): string | undefined {
  const failed = card.steps.find((step) => step.state === "failed" || step.state === "blocked");
  return failed?.summary?.trim();
}

function collaborationExecutionModeLabel(mode: CollaborationTaskCardModel["executionMode"]): string {
  if (mode === "parallel") {
    return "Parallel";
  }
  if (mode === "mixed") {
    return "Mixed";
  }
  return "Serial";
}

function collaborationTaskStepStateLabel(state: CollaborationTaskStepState): string {
  if (state === "active") {
    return "Active";
  }
  if (state === "waiting" || state === "queued") {
    return "Waiting";
  }
  if (state === "blocked") {
    return "Blocked";
  }
  if (state === "done") {
    return "Done";
  }
  if (state === "failed") {
    return "Failed";
  }
  return "Cancelled";
}

function collaborationTaskCardModeLabel(mode: CollaborationTaskCardModel["mode"]): string {
  if (mode === "completed") {
    return "Completed";
  }
  if (mode === "blocked") {
    return "Blocked";
  }
  if (mode === "failed") {
    return "Failed";
  }
  if (mode === "cancelled") {
    return "Cancelled";
  }
  if (mode === "waiting") {
    return "Waiting";
  }
  if (mode === "ready_for_confirmation") {
    return "Ready";
  }
  return "Running";
}

function collaborationStepTone(state: CollaborationTaskStepState): ConversationWorkCellRowTone {
  if (state === "done") {
    return "success";
  }
  if (state === "active") {
    return "running";
  }
  if (state === "waiting" || state === "queued") {
    return "waiting";
  }
  return "failed";
}
