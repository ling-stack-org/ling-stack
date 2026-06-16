import type {
  ApprovalRequest,
  ChannelWorkflow,
  ChannelWorkflowStep,
  CollaborationExecutionMode,
  CollaborationTaskBranch,
  CollaborationTaskCardModel,
  CollaborationTaskCardStep,
  CollaborationTaskStepState,
  RunSession,
  RunStore,
} from "@ling-stack/core";

export function buildChannelCollaborationCardsFromStore(input: {
  readonly store: RunStore;
  readonly channelId: string;
  readonly limit?: number;
}): readonly CollaborationTaskCardModel[] {
  return input.store
    .listChannelWorkflows({ channelId: input.channelId, limit: input.limit ?? 50 })
    .map((workflow) => buildWorkflowCollaborationCardFromStore({ store: input.store, workflow }))
    .filter((card): card is CollaborationTaskCardModel => Boolean(card));
}

export function buildWorkflowCollaborationCardFromStore(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
}): CollaborationTaskCardModel | undefined {
  const steps = input.store.listChannelWorkflowSteps({ workflowId: input.workflow.id, limit: 500 });
  if (steps.length === 0) {
    return undefined;
  }
  const runs = collectWorkflowRuns(input.store, steps);
  const approvals = collectWorkflowApprovals(input.store, steps, runs);
  return buildWorkflowCollaborationCard({
    workflow: input.workflow,
    steps,
    runs,
    approvals,
  });
}

export function buildWorkflowCollaborationCard(input: {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
}): CollaborationTaskCardModel | undefined {
  const orderedSteps = [...input.steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  if (orderedSteps.length === 0) {
    return undefined;
  }

  const stepRunIds = new Set(orderedSteps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  const stepIds = new Set(orderedSteps.map((step) => step.id));
  const workflowRuns = input.runs.filter((run) => (run.workflowStepId ? stepIds.has(run.workflowStepId) : false) || stepRunIds.has(run.id));
  const workflowApprovals = input.approvals.filter((approval) =>
    (approval.workflowStepId ? stepIds.has(approval.workflowStepId) : false) ||
    (approval.runId ? workflowRuns.some((run) => run.id === approval.runId) : false),
  );
  const pendingApprovals = workflowApprovals.filter((approval) => approval.status === "pending");
  const blockedStep = orderedSteps.find((step) => step.status === "blocked");
  const failedStep = orderedSteps.find((step) => step.status === "failed");
  const waitingStep = orderedSteps.find((step) => step.status === "waiting_for_approval");
  const activeStep = orderedSteps.find((step) => step.status === "running" || step.status === "claimed");
  const queuedStep = orderedSteps.find((step) => step.status === "queued");
  const focusStep = blockedStep ?? failedStep ?? waitingStep ?? activeStep ?? queuedStep;
  const completedStepCount = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
  const steps = orderedSteps.map((step) => ({
    id: step.id,
    title: step.title,
    ownerLabel: step.toParticipantLabel,
    state: collaborationStepState(step),
    summary: collaborationStepSummary(step),
    branchGroupId: step.metadata?.branchGroupId,
    joinGroupId: step.metadata?.joinGroupId,
    updatedAt: step.updatedAt,
  }));
  const executionMode = collaborationExecutionMode(orderedSteps);

  return {
    id: `collaboration-task-card:${input.workflow.id}`,
    workflowId: input.workflow.id,
    title: input.workflow.title,
    objective: input.workflow.objective,
    mode: collaborationTaskCardMode(input.workflow, orderedSteps, pendingApprovals),
    executionMode,
    currentOwnerLabel: focusStep?.toParticipantLabel,
    blocker: blockedStep?.blocker ?? failedStep?.blocker,
    nextAction: collaborationNextAction({ workflow: input.workflow, focusStep, pendingApprovalCount: pendingApprovals.length }),
    completedStepCount,
    totalStepCount: orderedSteps.length,
    pendingApprovalCount: pendingApprovals.length,
    steps,
    branches: buildCollaborationBranches({ steps, executionMode }),
    updatedAt: input.workflow.updatedAt,
  };
}

function collectWorkflowRuns(store: RunStore, steps: readonly ChannelWorkflowStep[]): readonly RunSession[] {
  const runs = new Map<string, RunSession>();
  for (const step of steps) {
    if (step.runId) {
      const run = store.getRun(step.runId);
      if (run) {
        runs.set(run.id, run);
      }
    }
    for (const run of store.listRuns({ workflowStepId: step.id, limit: 100 })) {
      runs.set(run.id, run);
    }
  }
  return [...runs.values()];
}

function collectWorkflowApprovals(
  store: RunStore,
  steps: readonly ChannelWorkflowStep[],
  runs: readonly RunSession[],
): readonly ApprovalRequest[] {
  const approvals = new Map<string, ApprovalRequest>();
  for (const step of steps) {
    for (const approval of store.listApprovalRequests({ workflowStepId: step.id, limit: 100 })) {
      approvals.set(approval.id, approval);
    }
  }
  for (const run of runs) {
    for (const approval of store.listApprovalRequests({ runId: run.id, limit: 100 })) {
      approvals.set(approval.id, approval);
    }
  }
  return [...approvals.values()];
}

function buildCollaborationBranches(input: {
  readonly steps: readonly CollaborationTaskCardStep[];
  readonly executionMode: CollaborationExecutionMode;
}): readonly CollaborationTaskBranch[] {
  if (input.executionMode === "serial") {
    return [];
  }
  const hasExplicitBranchGroup = input.steps.some((step) => Boolean(step.branchGroupId));
  const groups = new Map<string, CollaborationTaskCardStep[]>();
  for (const step of input.steps) {
    if (step.joinGroupId && !step.branchGroupId) {
      continue;
    }
    const groupId = step.branchGroupId ?? step.id;
    groups.set(groupId, [...(groups.get(groupId) ?? []), step]);
  }
  const branchEntries = [...groups.entries()];
  if (!hasExplicitBranchGroup && branchEntries.length < 2) {
    return [];
  }
  return branchEntries.map(([groupId, steps], index) => {
    const ownerLabels = uniqueStrings(steps.map((step) => step.ownerLabel));
    const completedStepCount = steps.filter((step) => step.state === "done").length;
    const focusStep =
      steps.find((step) => step.state === "blocked") ??
      steps.find((step) => step.state === "failed") ??
      steps.find((step) => step.state === "active") ??
      steps.find((step) => step.state === "waiting" || step.state === "queued") ??
      steps.at(-1);
    const label = ownerLabels.length > 0
      ? `${ownerLabels.slice(0, 2).join(", ")} branch`
      : `Branch ${index + 1}`;
    return {
      id: `branch:${groupId}`,
      label,
      state: collaborationBranchState(steps),
      summary: focusStep?.summary ?? focusStep?.title,
      completedStepCount,
      totalStepCount: steps.length,
      ownerLabels,
      steps,
    };
  }).sort((left, right) =>
    branchStatePriority(right.state) - branchStatePriority(left.state) ||
    right.totalStepCount - left.totalStepCount ||
    left.label.localeCompare(right.label),
  );
}

function collaborationTaskCardMode(
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  pendingApprovals: readonly ApprovalRequest[],
): CollaborationTaskCardModel["mode"] {
  if (workflow.status === "cancelled") {
    return "cancelled";
  }
  if (workflow.status === "succeeded") {
    return "completed";
  }
  if (workflow.status === "failed" || steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (workflow.status === "blocked" || steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (workflow.status === "waiting_for_approval" || pendingApprovals.length > 0 || steps.some((step) => step.status === "waiting_for_approval")) {
    return "waiting";
  }
  if (workflow.status === "draft" || workflow.status === "ready") {
    return "ready_for_confirmation";
  }
  return "running";
}

function collaborationExecutionMode(steps: readonly ChannelWorkflowStep[]): CollaborationExecutionMode {
  const hasParallelMetadata = steps.some((step) => step.metadata?.branchGroupId || step.metadata?.joinGroupId || step.metadata?.maxParallelSiblings);
  const runningCount = steps.filter((step) => step.status === "running" || step.status === "claimed").length;
  const hasDependencies = steps.some((step) => (step.metadata?.dependsOnStepIds?.length ?? 0) > 0);
  if (hasParallelMetadata && hasDependencies) {
    return "mixed";
  }
  if (hasParallelMetadata || runningCount > 1) {
    return "parallel";
  }
  return "serial";
}

function collaborationStepState(step: ChannelWorkflowStep): CollaborationTaskStepState {
  if (step.status === "succeeded" || step.status === "skipped") {
    return "done";
  }
  if (step.status === "running" || step.status === "claimed") {
    return "active";
  }
  if (step.status === "waiting_for_approval") {
    return "waiting";
  }
  if (step.status === "blocked") {
    return "blocked";
  }
  if (step.status === "failed") {
    return "failed";
  }
  if (step.status === "cancelled") {
    return "cancelled";
  }
  return "queued";
}

function collaborationStepSummary(step: ChannelWorkflowStep): string | undefined {
  if (step.resultSummary?.trim()) {
    return step.resultSummary.trim();
  }
  if (step.blocker?.trim()) {
    return step.blocker.trim();
  }
  return semanticPromptSummary(step.prompt);
}

function semanticPromptSummary(prompt: string): string | undefined {
  const stepSummaryMatch = /(?:^|\n)Step summary:\s*\n([\s\S]*?)(?=\n\n[A-Z][^:\n]{0,80}:\s*\n|$)/u.exec(prompt);
  const extracted = stepSummaryMatch?.[1]?.trim();
  if (extracted) {
    return truncatePreview(extracted, 120);
  }
  const trimmed = prompt.trim();
  if (!trimmed || isStructuredWorkflowPrompt(trimmed)) {
    return undefined;
  }
  return truncatePreview(trimmed, 120);
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

function collaborationBranchState(steps: readonly CollaborationTaskCardStep[]): CollaborationTaskStepState {
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

function branchStatePriority(state: CollaborationTaskStepState): number {
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

function collaborationNextAction(input: {
  readonly workflow: ChannelWorkflow;
  readonly focusStep?: ChannelWorkflowStep;
  readonly pendingApprovalCount: number;
}): string | undefined {
  if (input.pendingApprovalCount > 0) {
    return "Review approval request";
  }
  if (!input.focusStep) {
    return undefined;
  }
  if (input.focusStep.status === "blocked") {
    return "Resolve blocker";
  }
  if (input.focusStep.status === "failed") {
    return "Review failed step";
  }
  if (input.focusStep.status === "queued" && (input.workflow.status === "draft" || input.workflow.status === "ready")) {
    return "Start task";
  }
  if (input.focusStep.status === "running" || input.focusStep.status === "claimed") {
    return "Waiting for agent result";
  }
  return undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function truncatePreview(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
