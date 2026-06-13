import type { Translate } from "../i18n.js";
import type { CollaborationTaskCardModel, CollaborationTaskStepState } from "./collaboration-task-card.js";

export type CollaborationProgressProjectionTone = "neutral" | "running" | "waiting" | "blocked" | "success" | "failed";
export type CollaborationProgressProjectionIcon = "workflow" | "running" | "waiting" | "blocked" | "success" | "failed";

export interface CollaborationProgressProjectionItem {
  readonly id: string;
  readonly cardId: string;
  readonly workflowId: string;
  readonly icon: CollaborationProgressProjectionIcon;
  readonly tone: CollaborationProgressProjectionTone;
  readonly primary: string;
  readonly secondary?: string;
}

export function buildCollaborationProgressProjection(input: {
  readonly cards: readonly CollaborationTaskCardModel[];
  readonly t: Translate;
  readonly limit?: number;
}): readonly CollaborationProgressProjectionItem[] {
  const limit = Math.max(1, Math.min(input.limit ?? 6, 6));
  const cards = [...input.cards]
    .filter((card) => card.mode !== "completed" || card.steps.some((step) => step.state === "done"))
    .sort((left, right) => collaborationCardPriority(right) - collaborationCardPriority(left) || right.updatedAt.localeCompare(left.updatedAt));
  const rows: CollaborationProgressProjectionItem[] = [];

  for (const card of cards) {
    if (rows.length >= limit) {
      break;
    }
    rows.push({
      id: `${card.id}:summary`,
      cardId: card.id,
      workflowId: card.workflowId,
      icon: collaborationCardIcon(card),
      tone: collaborationCardTone(card),
      primary: collaborationCardPrimary(card, input.t),
      secondary: collaborationCardSecondary(card, input.t),
    });

    if (rows.length >= limit) {
      break;
    }
    for (const step of prioritizedSteps(card).slice(0, limit - rows.length)) {
      rows.push({
        id: `${card.id}:step:${step.id}`,
        cardId: card.id,
        workflowId: card.workflowId,
        icon: collaborationStepIcon(step.state),
        tone: collaborationStepTone(step.state),
        primary: `${step.ownerLabel}: ${step.title}`,
        secondary: step.summary,
      });
    }
  }

  return rows.slice(0, limit);
}

function collaborationCardPriority(card: CollaborationTaskCardModel): number {
  if (card.mode === "blocked") {
    return 60;
  }
  if (card.mode === "failed") {
    return 50;
  }
  if (card.mode === "waiting") {
    return 40;
  }
  if (card.mode === "running") {
    return 30;
  }
  if (card.mode === "ready_for_confirmation") {
    return 20;
  }
  if (card.mode === "completed") {
    return 10;
  }
  return 0;
}

function collaborationCardPrimary(card: CollaborationTaskCardModel, t: Translate): string {
  if (card.mode === "blocked") {
    return t("Collaboration blocked");
  }
  if (card.mode === "failed") {
    return t("Collaboration needs attention");
  }
  if (card.mode === "waiting") {
    return t("Waiting for confirmation");
  }
  if (card.mode === "completed") {
    return t("Collaboration complete");
  }
  if (card.mode === "ready_for_confirmation") {
    return t("Ready to start");
  }
  return t("Collaboration in progress");
}

function collaborationCardSecondary(card: CollaborationTaskCardModel, t: Translate): string {
  const owner = card.currentOwnerLabel ? `${card.currentOwnerLabel} · ` : "";
  const nextAction = card.nextAction ? `${card.nextAction} · ` : "";
  return `${owner}${nextAction}${card.title} · ${card.completedStepCount}/${card.totalStepCount} ${t("steps")}`;
}

function collaborationCardTone(card: CollaborationTaskCardModel): CollaborationProgressProjectionTone {
  if (card.mode === "blocked") {
    return "blocked";
  }
  if (card.mode === "failed" || card.mode === "cancelled") {
    return "failed";
  }
  if (card.mode === "waiting" || card.mode === "ready_for_confirmation") {
    return "waiting";
  }
  if (card.mode === "completed") {
    return "success";
  }
  return "running";
}

function collaborationCardIcon(card: CollaborationTaskCardModel): CollaborationProgressProjectionIcon {
  if (card.mode === "blocked") {
    return "blocked";
  }
  if (card.mode === "failed" || card.mode === "cancelled") {
    return "failed";
  }
  if (card.mode === "waiting" || card.mode === "ready_for_confirmation") {
    return "waiting";
  }
  if (card.mode === "completed") {
    return "success";
  }
  return "running";
}

function prioritizedSteps(card: CollaborationTaskCardModel): readonly CollaborationTaskCardModel["steps"][number][] {
  const open = card.steps.filter((step) => step.state !== "done");
  if (open.length > 0) {
    return open.sort((left, right) => stepStatePriority(right.state) - stepStatePriority(left.state) || right.updatedAt.localeCompare(left.updatedAt));
  }
  return card.steps.slice(-2).reverse();
}

function stepStatePriority(state: CollaborationTaskStepState): number {
  if (state === "blocked") {
    return 50;
  }
  if (state === "failed") {
    return 40;
  }
  if (state === "waiting") {
    return 30;
  }
  if (state === "active") {
    return 20;
  }
  if (state === "queued") {
    return 10;
  }
  return 0;
}

function collaborationStepTone(state: CollaborationTaskStepState): CollaborationProgressProjectionTone {
  if (state === "blocked") {
    return "blocked";
  }
  if (state === "failed" || state === "cancelled") {
    return "failed";
  }
  if (state === "waiting" || state === "queued") {
    return "waiting";
  }
  if (state === "done") {
    return "success";
  }
  return "running";
}

function collaborationStepIcon(state: CollaborationTaskStepState): CollaborationProgressProjectionIcon {
  if (state === "blocked") {
    return "blocked";
  }
  if (state === "failed" || state === "cancelled") {
    return "failed";
  }
  if (state === "waiting" || state === "queued") {
    return "waiting";
  }
  if (state === "done") {
    return "success";
  }
  return "running";
}
