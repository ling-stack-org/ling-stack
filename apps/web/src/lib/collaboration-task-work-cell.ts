import type { Translate } from "../i18n.js";
import type { ChannelWorkflowStep } from "../types.js";
import type { ConversationAgentActivitySpan, ConversationWorkCellRow, ConversationWorkCellRowTone, ConversationWorkCellViewModel } from "./conversation-work-cell.js";
import { normalizeConversationOperationCell } from "./conversation-work-cell.js";
import type { CollaborationTaskCardModel, CollaborationTaskStepState } from "./collaboration-task-card.js";
import { workflowProgressToConversationWorkCell, type WorkflowProgressModel } from "./workflow-progress.js";

export function collaborationTaskCardToConversationWorkCell(input: {
  readonly card: CollaborationTaskCardModel;
  readonly progress: WorkflowProgressModel;
  readonly t: Translate;
}): ConversationWorkCellViewModel {
  const base = workflowProgressToConversationWorkCell(input.progress);
  const agentSpans = buildCollaborationAgentSpans(input.card, input.t, input.progress.steps);
  const hasAgentSpans = agentSpans.length > 0;
  const operationRows = hasAgentSpans
    ? buildCollaborationAttentionRows(input.card, input.t)
    : input.card.mode === "completed"
      ? base.operationRows
      : buildCollaborationActiveRows(input.card, input.t);
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
    agentSpans,
    agentBranches: agentSpans,
    terminalReportRows: [],
  });
}

function collaborationTaskWorkCellKicker(card: CollaborationTaskCardModel, t: Translate): string {
  if (card.mode === "completed") {
    return t("Completed");
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
      return summary;
    }
    return card.title;
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
      description: visibleCollaborationStepSummary(step),
      meta: collaborationTaskStepStateMeta(step.state, t),
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
  if (card.nextAction && (card.mode === "blocked" || card.mode === "failed" || card.mode === "waiting")) {
    rows.push({
      id: "collaboration-next-action",
      kind: "watch",
      title: t("Needs attention"),
      description: card.nextAction,
      tone: card.mode === "waiting" ? "waiting" : card.mode === "failed" ? "failed" : "neutral",
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
      title: t("Needs attention"),
      description: card.nextAction,
      tone: card.pendingApprovalCount > 0 ? "waiting" : "neutral",
    });
  }
  return rows.slice(0, 3);
}

function buildCollaborationAgentSpans(
  card: CollaborationTaskCardModel,
  t: Translate,
  workflowSteps: readonly ChannelWorkflowStep[],
): readonly ConversationAgentActivitySpan[] {
  const workflowStepById = new Map(workflowSteps.map((step) => [step.id, step]));
  const groups = card.branches.length > 0
    ? card.branches.map((branch) => {
      const latestStep = agentSpanFocusStep(branch.steps);
      return {
        id: branch.id,
        label: collaborationAgentSpanLabel(branch),
        summary: branch.summary,
        state: branch.state,
        completedStepCount: branch.completedStepCount,
        totalStepCount: branch.totalStepCount,
        updatedAt: branch.steps.reduce((latest, step) => step.updatedAt.localeCompare(latest) > 0 ? step.updatedAt : latest, branch.steps[0]?.updatedAt ?? card.updatedAt),
        latestStep,
        detailSteps: agentSpanDetailSteps(branch.steps),
        steps: branch.steps,
      };
    })
    : buildSerialAgentSpanGroups(card, t);
  if (groups.length === 0) {
    return [];
  }
  const sortedGroups = [...groups].sort((left, right) =>
    agentSpanStatePriority(right.state) - agentSpanStatePriority(left.state) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.label.localeCompare(right.label),
  );
  const visibleGroups = sortedGroups.slice(0, 3);
  const hiddenGroups = sortedGroups.slice(visibleGroups.length);
  const spans = visibleGroups.map((group) => ({
    id: group.id,
    kind: "agent" as const,
    label: group.label,
    summary: group.latestStep ? undefined : group.summary,
    meta: undefined,
    tone: collaborationStepTone(group.state),
    stateLabel: collaborationTaskStepStateMeta(group.state, t),
    latestRow: group.latestStep ? collaborationStepToAgentRow(group.latestStep, t, "latest", workflowStepById.get(group.latestStep.id)) : undefined,
    rows: group.detailSteps.map((step) => collaborationStepToAgentRow(step, t, "history", workflowStepById.get(step.id))),
  }));
  if (hiddenGroups.length === 0) {
    return spans;
  }
  const hiddenRows = hiddenGroups
    .map((group) => group.latestStep ? collaborationStepToAgentRow(group.latestStep, t, "overflow", workflowStepById.get(group.latestStep.id)) : undefined)
    .filter((row): row is ConversationWorkCellRow => Boolean(row));
  return [
    ...spans,
    {
      id: "agent-overflow",
      kind: "overflow" as const,
      label: t("{count} more teammates", { count: hiddenGroups.length }),
      summary: hiddenGroups.map((group) => group.label).slice(0, 3).join(", "),
      meta: undefined,
      tone: hiddenGroups.some((group) => group.state === "blocked" || group.state === "failed") ? "failed" : "neutral",
      stateLabel: undefined,
      rows: hiddenRows,
    },
  ];
}

function collaborationAgentSpanLabel(branch: CollaborationTaskCardModel["branches"][number]): string {
  const owners = branch.ownerLabels.map((owner) => owner.trim()).filter(Boolean);
  if (owners.length > 0) {
    return owners.slice(0, 2).join(", ");
  }
  return branch.label.replace(/\s+branch$/iu, "").trim() || branch.label;
}

function buildSerialAgentSpanGroups(card: CollaborationTaskCardModel, t: Translate): readonly AgentSpanGroup[] {
  const groups = new Map<string, CollaborationTaskCardModel["steps"][number][]>();
  for (const step of card.steps) {
    const key = step.ownerLabel.trim() || step.id;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  const entries = [...groups.entries()].filter(([owner, steps]) =>
    groups.size > 1 || shouldProjectSingleAgentSpan(owner, steps)
  );
  if (entries.length === 0) {
    return [];
  }
  return entries.map(([owner, steps]) => {
    const focusStep = agentSpanFocusStep(steps);
    return {
      id: `agent:${owner}`,
      label: owner,
      summary: focusStep ? agentSpanLatestSummary(focusStep, t) : undefined,
      state: agentSpanGroupState(steps),
      completedStepCount: steps.filter((step) => step.state === "done").length,
      totalStepCount: steps.length,
      updatedAt: steps.reduce((latest, step) => step.updatedAt.localeCompare(latest) > 0 ? step.updatedAt : latest, steps[0]?.updatedAt ?? card.updatedAt),
      latestStep: focusStep,
      detailSteps: agentSpanDetailSteps(steps),
      steps,
    };
  });
}

function agentSpanDetailSteps(
  steps: readonly CollaborationTaskCardModel["steps"][number][],
): readonly CollaborationTaskCardModel["steps"][number][] {
  return steps.filter(hasSemanticAgentProcessStep).slice(-6);
}

function agentSpanFocusStep(
  steps: readonly CollaborationTaskCardModel["steps"][number][],
): CollaborationTaskCardModel["steps"][number] | undefined {
  return steps.find((step) => step.state === "blocked") ??
    steps.find((step) => step.state === "failed") ??
    steps.find((step) => step.state === "active") ??
    steps.find((step) => step.state === "waiting" || step.state === "queued") ??
    steps.at(-1);
}

function collaborationStepToAgentRow(
  step: CollaborationTaskCardModel["steps"][number],
  t: Translate,
  scope: "latest" | "history" | "overflow",
  workflowStep?: ChannelWorkflowStep,
): ConversationWorkCellRow {
  const title = agentActionTitle(step, t, workflowStep);
  const description = agentActionDescription(step, title, t, workflowStep);
  return {
    id: `${scope}-step:${step.id}`,
    kind: "handoff",
    title: scope === "overflow" ? `${step.ownerLabel}: ${title}` : title,
    description,
    meta: collaborationTaskStepStateMeta(step.state, t),
    tone: collaborationStepTone(step.state),
  };
}

function agentSpanLatestSummary(step: CollaborationTaskCardModel["steps"][number], t: Translate): string {
  return agentActionTitle(step, t);
}

function agentActionTitle(step: CollaborationTaskCardModel["steps"][number], t: Translate, workflowStep?: ChannelWorkflowStep): string {
  const title = stripOwnerPrefix(step.title, step.ownerLabel);
  const summary = visibleCollaborationStepSummary(step, workflowStep);
  if (summary && isGenericAgentActionTitle(title)) {
    return summary;
  }
  if (!title || isGenericAgentActionTitle(title)) {
    return summary ?? fallbackAgentActionTitle(step, t);
  }
  return title || summary || step.title;
}

function agentActionDescription(step: CollaborationTaskCardModel["steps"][number], title: string, t: Translate, workflowStep?: ChannelWorkflowStep): string | undefined {
  const summary = visibleCollaborationStepSummary(step, workflowStep);
  if (!summary || summary === title || title === fallbackAgentActionTitle(step, t)) {
    return undefined;
  }
  return summary;
}

function stripOwnerPrefix(title: string, ownerLabel: string): string {
  const trimmedTitle = title.trim();
  const trimmedOwner = ownerLabel.trim();
  if (!trimmedOwner) {
    return trimmedTitle;
  }
  const prefixPattern = new RegExp(`^${escapeRegExp(trimmedOwner)}\\s*[:：]\\s*`, "iu");
  return trimmedTitle.replace(prefixPattern, "").trim();
}

function isGenericAgentActionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "coordinate" ||
    normalized === "coordinated" ||
    normalized === "consult" ||
    normalized === "consulted" ||
    normalized === "review" ||
    normalized === "reviewed" ||
    normalized === "flagged_risk" ||
    normalized === "flagged risk";
}

function fallbackAgentActionTitle(step: CollaborationTaskCardModel["steps"][number], t: Translate): string {
  if (step.state === "blocked") {
    return step.summary ?? t("Resolve blocker");
  }
  if (step.state === "failed") {
    return step.summary ?? t("Failed");
  }
  if (step.state === "active") {
    return step.summary ?? t("Waiting for agent result");
  }
  if (step.state === "waiting") {
    return step.summary ?? t("Waiting for approval");
  }
  if (step.state === "queued") {
    return step.summary ?? t("Queued");
  }
  if (step.state === "cancelled") {
    return step.summary ?? t("Work cancelled.");
  }
  return step.summary ?? t("Done for this segment.");
}

function collaborationTaskStepStateMeta(state: CollaborationTaskStepState, t: Translate): string | undefined {
  if (state === "blocked") {
    return t("Blocked");
  }
  if (state === "failed") {
    return t("Failed");
  }
  if (state === "waiting") {
    return t("Waiting for approval");
  }
  if (state === "cancelled") {
    return t("Stopped");
  }
  return undefined;
}

function shouldProjectSingleAgentSpan(
  owner: string,
  steps: readonly CollaborationTaskCardModel["steps"][number][],
): boolean {
  return !isCoordinatorAgentOwner(owner) && steps.some(hasSemanticAgentProcessStep);
}

function isCoordinatorAgentOwner(owner: string): boolean {
  const normalized = owner.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return normalized === "ling" ||
    normalized === "ling agent" ||
    normalized === "main agent" ||
    normalized === "coordinator" ||
    normalized === "主 agent" ||
    normalized === "主agent";
}

function hasSemanticAgentProcessStep(step: CollaborationTaskCardModel["steps"][number]): boolean {
  const title = stripOwnerPrefix(step.title, step.ownerLabel);
  return Boolean(visibleCollaborationStepSummary(step) || (title && !isGenericAgentActionTitle(title)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visibleCollaborationStepSummary(step: CollaborationTaskCardModel["steps"][number], workflowStep?: ChannelWorkflowStep): string | undefined {
  const summary = step.summary?.trim();
  if (!summary || (step.state === "done" && isGenericRunSuccessSummary(summary))) {
    return semanticWorkflowStepSummary(workflowStep);
  }
  return summary;
}

function semanticWorkflowStepSummary(step: ChannelWorkflowStep | undefined): string | undefined {
  if (!step) {
    return undefined;
  }
  const resultSummary = step.resultSummary?.trim();
  if (resultSummary && !isGenericRunSuccessSummary(resultSummary)) {
    return truncateStepPreview(resultSummary, 140);
  }
  const promptSummary = semanticWorkflowPromptSummary(step.prompt);
  return promptSummary ? truncateStepPreview(promptSummary, 140) : undefined;
}

function semanticWorkflowPromptSummary(prompt: string): string | undefined {
  const stepSummaryMatch = /(?:^|\n)Step summary:\s*\n([\s\S]*?)(?=\n\n[A-Z][^:\n]{0,80}:\s*\n|$)/u.exec(prompt);
  const extracted = stepSummaryMatch?.[1]?.trim();
  if (extracted) {
    return extracted;
  }
  const assignedTaskMatch = /(?:^|\n)(?:Assigned task|Task|Prompt|User request|Original request)\s*:\s*([\s\S]*?)(?=\n[A-Z][^:\n]{0,80}:\s*|$)/iu.exec(prompt);
  const assignedTask = assignedTaskMatch?.[1]?.trim();
  if (assignedTask) {
    return assignedTask;
  }
  const trimmed = prompt.trim();
  if (!trimmed || isStructuredWorkflowPrompt(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isStructuredWorkflowPrompt(prompt: string): boolean {
  return /\bConfirmed proposal:\b/u.test(prompt) ||
    /\bOverall scope:\b/u.test(prompt) ||
    /\bAssigned teammate:\b/u.test(prompt) ||
    /\bStep action:\b/u.test(prompt) ||
    /\bAcceptance criteria:\b/u.test(prompt) ||
    /\bComplete only this step\./u.test(prompt) ||
    /\bruntime permission\b/iu.test(prompt);
}

function truncateStepPreview(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

interface AgentSpanGroup {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly state: CollaborationTaskStepState;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly updatedAt: string;
  readonly latestStep?: CollaborationTaskCardModel["steps"][number];
  readonly detailSteps: readonly CollaborationTaskCardModel["steps"][number][];
  readonly steps: readonly CollaborationTaskCardModel["steps"][number][];
}

function agentSpanStatePriority(state: CollaborationTaskStepState): number {
  if (state === "blocked") {
    return 60;
  }
  if (state === "failed") {
    return 50;
  }
  if (state === "active") {
    return 40;
  }
  if (state === "waiting" || state === "queued") {
    return 30;
  }
  if (state === "done") {
    return 20;
  }
  return 0;
}

function agentSpanGroupState(steps: readonly CollaborationTaskCardModel["steps"][number][]): CollaborationTaskStepState {
  if (steps.some((step) => step.state === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => step.state === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.state === "active")) {
    return "active";
  }
  if (steps.some((step) => step.state === "waiting")) {
    return "waiting";
  }
  if (steps.some((step) => step.state === "queued")) {
    return "queued";
  }
  if (steps.every((step) => step.state === "done")) {
    return "done";
  }
  if (steps.every((step) => step.state === "cancelled")) {
    return "cancelled";
  }
  return "waiting";
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
