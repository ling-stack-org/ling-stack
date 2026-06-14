import type { Translate } from "../i18n.js";
import type { ConversationWorkCellBranch, ConversationWorkCellRow, ConversationWorkCellRowTone, ConversationWorkCellViewModel } from "./conversation-work-cell.js";
import { normalizeConversationOperationCell } from "./conversation-work-cell.js";
import type { CollaborationTaskCardModel, CollaborationTaskStepState } from "./collaboration-task-card.js";
import { workflowProgressToConversationWorkCell, type WorkflowProgressModel } from "./workflow-progress.js";

export function collaborationTaskCardToConversationWorkCell(input: {
  readonly card: CollaborationTaskCardModel;
  readonly progress: WorkflowProgressModel;
  readonly t: Translate;
}): ConversationWorkCellViewModel {
  const base = workflowProgressToConversationWorkCell(input.progress);
  const branchRows = buildCollaborationBranchRows(input.card, input.t);
  const operationRows = input.card.mode === "completed"
    ? []
    : branchRows && branchRows.length > 0
      ? buildCollaborationAttentionRows(input.card, input.t)
      : buildCollaborationActiveRows(input.card, input.t);
  const terminalReportRows = buildFinalLingReportRows(input.card, base, input.t);
  return normalizeConversationOperationCell({
    ...base,
    id: `collaboration-work-cell:${input.card.workflowId}`,
    sourceKind: "collaboration_task",
    presentation: "collaboration_task",
    kicker: collaborationTaskWorkCellKicker(input.card, input.t),
    showDiagnostics: false,
    title: input.card.title,
    summary: collaborationTaskWorkCellSummary(input.card, base.summary, input.t),
    stats: buildCollaborationWorkCellStats(input.card, input.t),
    operationRows,
    agentBranches: branchRows ?? [],
    terminalReportRows,
  });
}

function collaborationTaskWorkCellKicker(card: CollaborationTaskCardModel, t: Translate): string {
  if (card.mode === "completed") {
    return t("Work complete");
  }
  if (card.mode === "blocked") {
    return t("Work blocked");
  }
  if (card.mode === "failed") {
    return t("Work failed");
  }
  if (card.mode === "cancelled") {
    return t("Work cancelled");
  }
  if (card.mode === "waiting") {
    return t("Work waiting");
  }
  if (card.mode === "ready_for_confirmation") {
    return t("Ready to start");
  }
  return t("Work in progress");
}

function collaborationTaskWorkCellSummary(card: CollaborationTaskCardModel, fallbackSummary: string, t: Translate): string {
  if (card.mode === "completed") {
    const summary = readFinalStepSummary(card);
    if (summary && !isGenericRunSuccessSummary(summary)) {
      return t("Completed: {summary}", { summary });
    }
    return t("I finished {title}. Expand the evidence summary below for exact files, checks, and run details.", { title: card.title });
  }
  if (card.mode === "blocked") {
    return t("Blocked: {reason}", { reason: card.blocker ?? fallbackSummary });
  }
  if (card.mode === "failed") {
    const summary = readFailedStepSummary(card) ?? card.blocker ?? fallbackSummary;
    return t("Failed: {summary}", { summary });
  }
  if (card.mode === "cancelled") {
    return t("Work cancelled.");
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

function isGenericRunSuccessSummary(summary: string): boolean {
  return /^(run\s+succeeded|succeeded|completed)\.?$/iu.test(summary.trim());
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
      kind: "handoff",
      title: `${step.ownerLabel}: ${step.title}`,
      description: step.summary,
      meta: t(collaborationTaskStepStateLabel(step.state)),
      tone: collaborationStepTone(step.state),
    });
  }
  if (card.blocker && !visibleSteps.some((step) => step.state === "blocked" || step.state === "failed")) {
    rows.push({
      id: "collaboration-blocker",
      kind: "watch",
      title: t("Collaboration blocked"),
      description: card.blocker,
      tone: "failed",
    });
  }
  if (card.pendingApprovalCount > 0) {
    rows.push({
      id: "collaboration-approvals",
      kind: "approval",
      title: t("Waiting for approval"),
      description: t("{count} pending approvals", { count: card.pendingApprovalCount }),
      tone: "waiting",
    });
  }
  return rows.slice(0, 5);
}

function buildCollaborationAttentionRows(card: CollaborationTaskCardModel, t: Translate): readonly ConversationWorkCellRow[] {
  const rows: ConversationWorkCellRow[] = [];
  if (card.blocker) {
    rows.push({
      id: "collaboration-blocker",
      kind: "watch",
      title: t("Work blocked"),
      description: card.blocker,
      tone: "failed",
    });
  }
  if (card.pendingApprovalCount > 0) {
    rows.push({
      id: "collaboration-approvals",
      kind: "approval",
      title: t("Waiting for approval"),
      description: t("{count} pending approvals", { count: card.pendingApprovalCount }),
      tone: "waiting",
    });
  }
  if (card.nextAction && rows.length > 0) {
    rows.push({
      id: "collaboration-next-action",
      kind: "watch",
      title: t("Next action"),
      description: card.nextAction,
      tone: card.pendingApprovalCount > 0 ? "waiting" : "neutral",
    });
  }
  return rows.slice(0, 3);
}

function buildCollaborationBranchRows(card: CollaborationTaskCardModel, t: Translate): readonly ConversationWorkCellBranch[] | undefined {
  if (card.branches.length === 0) {
    return undefined;
  }
  return card.branches.slice(0, 6).map((branch) => ({
    id: branch.id,
    label: branch.label,
    summary: branch.summary,
    meta: t("{done} of {total} steps complete", { done: branch.completedStepCount, total: branch.totalStepCount }),
    tone: collaborationStepTone(branch.state),
    stateLabel: t(collaborationTaskStepStateLabel(branch.state)),
    rows: branch.steps.slice(0, 6).map((step) => ({
      id: `branch-step:${step.id}`,
      kind: "handoff" as const,
      title: `${step.ownerLabel}: ${step.title}`,
      description: step.summary,
      meta: t(collaborationTaskStepStateLabel(step.state)),
      tone: collaborationStepTone(step.state),
    })),
  }));
}

function buildFinalLingReportRows(
  card: CollaborationTaskCardModel,
  base: ConversationWorkCellViewModel,
  t: Translate,
): readonly ConversationWorkCellRow[] {
  if (card.mode !== "completed" && card.mode !== "blocked" && card.mode !== "failed" && card.mode !== "cancelled") {
    return [];
  }

  const changedGroup = base.groups.find((group) => group.id === "changed");
  const checkedGroup = base.groups.find((group) => group.id === "checked");
  const evidenceGroup = base.groups.find((group) => group.id === "evidence");
  const attentionGroup = base.groups.find((group) => group.id === "attention");
  const changedRows = changedGroup?.rows ?? [];
  const validationRows = buildValidationRows({ checkedRows: checkedGroup?.rows ?? [], evidenceRows: evidenceGroup?.rows ?? [] });
  const attentionRows = attentionGroup?.rows ?? [];
  const evidenceCount = base.evidenceLinks.length || evidenceGroup?.rows.length || 0;
  const blocker = readFailedStepSummary(card) ?? card.blocker;
  const rows: ConversationWorkCellRow[] = [{
    id: "final-outcome",
    kind: "verify",
    title: t("Outcome"),
    description: buildFinalOutcomeSummary(card, base, t),
    meta: t(collaborationTaskCardModeLabel(card.mode)),
    tone: card.mode === "completed" ? "success" : card.mode === "blocked" ? "waiting" : "failed",
  }];

  if (card.blocker || card.mode === "blocked" || card.mode === "failed") {
    rows.push(buildFinalBlockerRow({ card, blocker, attentionRows, t }));
    rows.push(buildFinalNextActionRow(card, t));
  }

  rows.push({
    id: "final-changed",
    kind: "edit",
    title: t("Changed"),
    description: changedRows.length > 0
      ? t("Changed: {items}. Evidence recorded: {evidence}.", { items: summarizeFinalReportRows(changedRows, t), evidence: evidenceCount })
      : t("No changed files recorded. Evidence recorded: {evidence}.", { evidence: evidenceCount }),
    meta: changedRows.length > 0 ? t("{count} changed items", { count: changedRows.length }) : undefined,
    tone: changedRows.length > 0 ? "success" : "neutral",
  });

  rows.push({
    id: "final-validated",
    kind: "verify",
    title: t("Validated"),
    description: validationRows.length > 0
      ? t("{count} validation records: {items}", { count: validationRows.length, items: summarizeFinalReportRows(validationRows, t) })
      : t("No validation commands recorded."),
    meta: validationRows.length > 0 ? String(validationRows.length) : undefined,
    tone: validationRows.length > 0 ? "success" : "neutral",
  });

  if (card.mode === "completed") {
    rows.push(buildFinalBlockerRow({ card, blocker, attentionRows, t }));
    rows.push(buildFinalNextActionRow(card, t));
  } else if (card.mode === "cancelled") {
    rows.push(buildFinalNextActionRow(card, t));
  }

  return rows.slice(0, 5);
}

function buildFinalOutcomeSummary(
  card: CollaborationTaskCardModel,
  base: ConversationWorkCellViewModel,
  t: Translate,
): string {
  if (card.mode === "completed") {
    const summary = readFinalStepSummary(card);
    return summary && !isGenericRunSuccessSummary(summary)
      ? summary
      : t("Task finished successfully.");
  }
  if (card.mode === "blocked") {
    return t("Collaboration blocked: {reason}", { reason: card.blocker ?? readFailedStepSummary(card) ?? base.summary });
  }
  if (card.mode === "failed") {
    return readFailedStepSummary(card) ?? card.blocker ?? t("No failure reason was recorded.");
  }
  return t("Task was cancelled before completion.");
}

function buildFinalBlockerRow(input: {
  readonly card: CollaborationTaskCardModel;
  readonly blocker?: string;
  readonly attentionRows: readonly ConversationWorkCellRow[];
  readonly t: Translate;
}): ConversationWorkCellRow {
  const attentionSummary = input.attentionRows.length > 0 ? summarizeFinalReportRows(input.attentionRows, input.t) : undefined;
  const isHealthy = input.card.mode === "completed" && !input.blocker && !attentionSummary;
  return {
    id: "final-blockers-risks",
    kind: "watch",
    title: input.t("Blockers / risks"),
    description: input.blocker
      ? input.t("Blocker: {reason}", { reason: input.blocker })
      : attentionSummary
        ? input.t("Risks: {items}", { items: attentionSummary })
        : input.t("No blockers or risks recorded."),
    tone: isHealthy ? "success" : input.card.mode === "blocked" ? "waiting" : input.card.mode === "completed" ? "neutral" : "failed",
  };
}

function buildFinalNextActionRow(card: CollaborationTaskCardModel, t: Translate): ConversationWorkCellRow {
  if (card.mode === "blocked") {
    return {
      id: "final-next-action",
      kind: "watch",
      title: t("Next action"),
      description: card.nextAction ?? t("Review the blocker, then expand the evidence summary for source records."),
      tone: "waiting",
    };
  }
  if (card.mode === "failed") {
    return {
      id: "final-next-action",
      kind: "watch",
      title: t("Next action"),
      description: card.nextAction ?? t("Review the failure, then expand the evidence summary for source records."),
      tone: "failed",
    };
  }
  return {
    id: "final-next-action",
    kind: "watch",
    title: t("Next action"),
    description: t("Expand the evidence summary for details if needed."),
    tone: "neutral",
  };
}

function buildValidationRows(input: {
  readonly checkedRows: readonly ConversationWorkCellRow[];
  readonly evidenceRows: readonly ConversationWorkCellRow[];
}): readonly ConversationWorkCellRow[] {
  const checkedRows = input.checkedRows.filter((row) =>
    (row.tone === "success" || row.tone === "neutral") && finalReportRowLooksLikeValidation(row, { includeDescription: true }),
  );
  const evidenceRows = input.evidenceRows.filter((row) =>
    (row.tone === "success" || row.tone === "neutral") && finalReportRowLooksLikeValidation(row, { includeDescription: false }),
  );
  return uniqueFinalReportRows([...checkedRows, ...evidenceRows]);
}

function finalReportRowLooksLikeValidation(
  row: ConversationWorkCellRow,
  options: { readonly includeDescription: boolean },
): boolean {
  const haystack = [row.title, options.includeDescription ? row.description : undefined, row.meta]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(test|tests|tested|typecheck|lint|build|validate|validated|validation|verify|verified|verification|check|checked|qa|coverage|e2e|passed)\b/.test(haystack);
}

function summarizeFinalReportRows(rows: readonly ConversationWorkCellRow[], t: Translate): string {
  const labels = uniqueFinalReportRows(rows).slice(0, 3).map((row) => row.title);
  const summary = labels.join(", ");
  const hiddenCount = Math.max(0, rows.length - labels.length);
  return hiddenCount > 0 ? t("{items} and {count} more", { items: summary, count: hiddenCount }) : summary;
}

function uniqueFinalReportRows(rows: readonly ConversationWorkCellRow[]): readonly ConversationWorkCellRow[] {
  const seen = new Set<string>();
  const result: ConversationWorkCellRow[] = [];
  for (const row of rows) {
    const key = `${row.title}\n${row.description ?? ""}\n${row.meta ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
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
