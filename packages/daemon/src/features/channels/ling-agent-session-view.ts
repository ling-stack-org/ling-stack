import type {
  ApprovalRequest,
  ApprovalStoreFacet,
  ChannelExecutionProposal,
  ChannelStoreFacet,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunArtifact,
  RunExecutionStoreFacet,
  RunIntervention,
  RunSession,
} from "@ling-stack/core";

type LingAgentSessionViewStore = ChannelStoreFacet & RunExecutionStoreFacet & ApprovalStoreFacet;

export type LingAgentSessionViewStatus =
  | "open"
  | "shaping"
  | "ready_for_confirmation"
  | "running"
  | "waiting_for_approval"
  | "reporting"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export type LingAgentEvidenceRefType =
  | "proposal"
  | "workflow"
  | "workflow_step"
  | "run"
  | "approval"
  | "intervention";

export interface LingAgentEvidenceRef {
  readonly type: LingAgentEvidenceRefType;
  readonly id: string;
  readonly label?: string;
}

export interface LingAgentConfirmationView {
  readonly proposalId: string;
  readonly title: string;
  readonly summary: string;
  readonly requiredTools: readonly ChannelExecutionProposal["requiredTools"][number][];
  readonly assigneeTeammateId: string;
  readonly sourceMessageId: string;
}

export interface LingAgentProgressView {
  readonly title: string;
  readonly summary: string;
  readonly workflowId?: string;
  readonly runId?: string;
  readonly activeStepId?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
}

export interface LingAgentResultCheck {
  readonly id: string;
  readonly title: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "skipped";
  readonly summary?: string;
}

export interface LingAgentResultApprovalSummary {
  readonly approvalId: string;
  readonly actionType: ApprovalRequest["actionType"];
  readonly status: ApprovalRequest["status"];
  readonly title: string;
}

export interface LingAgentFinalResultView {
  readonly title: string;
  readonly summary: string;
  readonly outcome: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly changedPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly checks: readonly LingAgentResultCheck[];
  readonly approvals: readonly LingAgentResultApprovalSummary[];
  readonly nextActions: readonly string[];
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}

export interface LingAgentSessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly status: LingAgentSessionViewStatus;
  readonly owner: "ling_agent";
  readonly objective: string;
  readonly activeWorkflowId?: string;
  readonly activeRunId?: string;
  readonly pendingApprovalIds: readonly string[];
  readonly pendingInterventionIds: readonly string[];
  readonly confirmation?: LingAgentConfirmationView;
  readonly progress?: LingAgentProgressView;
  readonly finalResult?: LingAgentFinalResultView;
  readonly evidenceRefs: readonly LingAgentEvidenceRef[];
}

interface LingAgentSessionViewSource {
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly interventions: readonly RunIntervention[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
}

export function buildLingAgentSessionViewForChannel(input: {
  readonly store: LingAgentSessionViewStore;
  readonly channelId: string;
}): LingAgentSessionView {
  const workflows = input.store.listChannelWorkflows({ channelId: input.channelId, limit: 100 });
  const workflowSteps = workflows.flatMap((workflow) => input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }));
  const workflowStepIds = new Set(workflowSteps.map((step) => step.id));
  const proposalRunIds = new Set<string>();
  const proposals = input.store.listChannelExecutionProposals({ channelId: input.channelId, limit: 100 });
  for (const proposal of proposals) {
    if (proposal.linkedRunId) {
      proposalRunIds.add(proposal.linkedRunId);
    }
  }
  const runs = input.store.listRuns({ limit: 200 }).filter((run) =>
    run.channelId === input.channelId ||
    proposalRunIds.has(run.id) ||
    Boolean(run.workflowStepId && workflowStepIds.has(run.workflowStepId)),
  );
  const runIds = new Set(runs.map((run) => run.id));
  const approvals = input.store.listApprovalRequests({ limit: 500 }).filter((approval) =>
    approval.channelId === input.channelId ||
    Boolean(approval.runId && runIds.has(approval.runId)) ||
    Boolean(approval.workflowStepId && workflowStepIds.has(approval.workflowStepId)),
  );
  const interventions = runs.flatMap((run) => input.store.listRunInterventions({ sourceRunId: run.id, limit: 100 }));
  const artifactsByRun = Object.fromEntries(runs.map((run) => [run.id, input.store.listArtifacts(run.id)]));
  return buildLingAgentSessionView({
    channelId: input.channelId,
    workspaceId: proposals[0]?.workspaceId ?? workflows[0]?.workspaceId ?? interventions[0]?.workspaceId,
    proposals,
    workflows,
    workflowSteps,
    runs,
    approvals,
    interventions,
    artifactsByRun,
  });
}

export function buildLingAgentSessionView(input: LingAgentSessionViewSource): LingAgentSessionView {
  const sortedProposals = sortByRecentActivity(input.proposals);
  const draftProposal = sortedProposals.find((proposal) => proposal.status === "draft");
  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending");
  const pendingInterventions = input.interventions.filter((intervention) => isOpenInterventionStatus(intervention.status));
  const sortedWorkflows = sortByRecentActivity(input.workflows);
  const activeWorkflow = sortedWorkflows.find((workflow) => isActiveWorkflowStatus(workflow.status));
  const terminalWorkflow = sortedWorkflows.find((workflow) => isTerminalWorkflowStatus(workflow.status));
  const sortedRuns = sortByRecentActivity(input.runs);
  const activeRun = sortedRuns.find((run) => isActiveRunStatus(run.status));
  const terminalRun = sortedRuns.find((run) => isTerminalRunStatus(run.status));
  const primaryWorkflow = activeWorkflow ?? terminalWorkflow;
  const workflowSteps = primaryWorkflow ? input.workflowSteps.filter((step) => step.workflowId === primaryWorkflow.id) : [];
  const workflowRuns = runsForWorkflowSteps(input.runs, workflowSteps);
  const primaryRun = activeRun ?? terminalRun ?? newestRunForSteps(input.runs, workflowSteps);
  const workflowApprovals = primaryWorkflow ? approvalsForWorkflow(input.approvals, workflowSteps) : [];
  const runApprovals = primaryRun ? approvalsForRun(input.approvals, primaryRun.id) : [];
  const artifactsByRun = input.artifactsByRun ?? {};
  const finalResult = activeWorkflow || activeRun
    ? undefined
    : terminalWorkflow
      ? buildWorkflowFinalResult(terminalWorkflow, workflowSteps, workflowRuns, workflowApprovals, artifactsByRun)
      : terminalRun
        ? buildRunFinalResult(terminalRun, runApprovals, artifactsByRun[terminalRun.id] ?? [])
        : undefined;
  const status = resolveSessionStatus({
    draftProposal,
    activeWorkflow,
    activeRun,
    terminalWorkflow,
    terminalRun,
    pendingApprovals,
    finalResult,
  });
  const confirmation = draftProposal ? buildConfirmationView(draftProposal) : undefined;
  const progress = activeWorkflow
    ? buildWorkflowProgressView(activeWorkflow, workflowSteps, activeRun)
    : activeRun
      ? buildRunProgressView(activeRun)
      : undefined;
  const evidenceRefs = buildEvidenceRefs({
    proposals: draftProposal ? [draftProposal] : [],
    workflows: primaryWorkflow ? [primaryWorkflow] : [],
    workflowSteps,
    runs: primaryRun ? [primaryRun] : [],
    approvals: pendingApprovals,
    interventions: pendingInterventions,
  });

  return {
    id: `ling-agent-session:${input.channelId}`,
    workspaceId: input.workspaceId ?? input.proposals[0]?.workspaceId ?? input.workflows[0]?.workspaceId ?? "default",
    channelId: input.channelId,
    threadId: primaryRun?.threadId,
    status,
    owner: "ling_agent",
    objective: draftProposal?.title ?? primaryWorkflow?.objective ?? readRunTaskTitle(primaryRun) ?? "Ling Agent session",
    activeWorkflowId: activeWorkflow?.id,
    activeRunId: activeRun?.id,
    pendingApprovalIds: pendingApprovals.map((approval) => approval.id),
    pendingInterventionIds: pendingInterventions.map((intervention) => intervention.id),
    confirmation,
    progress,
    finalResult,
    evidenceRefs: finalResult ? uniqueEvidenceRefs([...evidenceRefs, ...finalResult.evidenceRefs]) : evidenceRefs,
  };
}

function resolveSessionStatus(input: {
  readonly draftProposal?: ChannelExecutionProposal;
  readonly activeWorkflow?: ChannelWorkflow;
  readonly activeRun?: RunSession;
  readonly terminalWorkflow?: ChannelWorkflow;
  readonly terminalRun?: RunSession;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly finalResult?: LingAgentFinalResultView;
}): LingAgentSessionViewStatus {
  if (input.pendingApprovals.length > 0 || input.activeWorkflow?.status === "waiting_for_approval" || input.activeRun?.status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (input.activeWorkflow || input.activeRun) {
    return "running";
  }
  if (input.draftProposal) {
    return "ready_for_confirmation";
  }
  if (input.finalResult) {
    return input.finalResult.outcome;
  }
  if (input.terminalWorkflow || input.terminalRun) {
    return "reporting";
  }
  return "open";
}

function buildConfirmationView(proposal: ChannelExecutionProposal): LingAgentConfirmationView {
  return {
    proposalId: proposal.id,
    title: proposal.title,
    summary: proposal.riskSummary ?? truncate(proposal.prompt, 180),
    requiredTools: proposal.requiredTools,
    assigneeTeammateId: proposal.assigneeTeammateId,
    sourceMessageId: proposal.sourceMessageId,
  };
}

function buildWorkflowProgressView(workflow: ChannelWorkflow, steps: readonly ChannelWorkflowStep[], activeRun?: RunSession): LingAgentProgressView {
  const orderedSteps = sortWorkflowSteps(steps);
  const completedStepCount = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
  const currentStep = orderedSteps.find((step) => isActiveWorkflowStepStatus(step.status)) ?? orderedSteps[completedStepCount] ?? orderedSteps.at(-1);
  return {
    title: workflow.title,
    summary: currentStep
      ? `${currentStep.toParticipantLabel}: ${currentStep.title} (${currentStep.status})`
      : `${workflow.title} (${workflow.status})`,
    workflowId: workflow.id,
    runId: activeRun?.id ?? currentStep?.runId,
    activeStepId: currentStep?.id,
    completedStepCount,
    totalStepCount: orderedSteps.length,
  };
}

function buildRunProgressView(run: RunSession): LingAgentProgressView {
  return {
    title: readRunTaskTitle(run) ?? run.taskId,
    summary: run.status === "waiting_for_approval" ? "Waiting for approval" : `Run is ${run.status}`,
    runId: run.id,
    completedStepCount: 0,
    totalStepCount: 1,
  };
}

function buildWorkflowFinalResult(
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  runs: readonly RunSession[],
  approvals: readonly ApprovalRequest[],
  artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>,
): LingAgentFinalResultView {
  const orderedSteps = sortWorkflowSteps(steps);
  const outcome = workflowStatusToOutcome(workflow.status);
  const attentionStep = orderedSteps.find((step) => step.status === "blocked" || step.status === "failed" || step.status === "cancelled");
  const summaryStep = [...orderedSteps].reverse().find((step) => step.resultSummary);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const artifacts = uniqueArtifacts(runs.flatMap((run) => artifactsByRun[run.id] ?? []));
  const artifactIds = uniqueStrings([
    ...orderedSteps.flatMap((step) => [
      step.metadata?.outputArtifactId,
      ...(step.metadata?.outputArtifactIds ?? []),
    ]),
    ...artifacts.map((artifact) => artifact.id),
  ].filter((value): value is string => Boolean(value)));
  const deniedApproval = approvals.find((approval) => approval.status === "denied");
  const failedRun = runs.find((run) => run.status === "failed" && run.errorMessage);
  const summary = attentionStep?.blocker ??
    summaryStep?.resultSummary ??
    failedRun?.errorMessage ??
    approvalTerminalSummary(deniedApproval) ??
    `${workflow.title} ${workflow.status}.`;
  const nextActions = uniqueStrings([
    attentionStep?.blocker,
    failedRun?.errorMessage,
    deniedApproval ? approvalNextAction(deniedApproval) : undefined,
  ].filter((value): value is string => Boolean(value)));
  const evidenceRefs = buildEvidenceRefs({
    proposals: [],
    workflows: [workflow],
    workflowSteps: orderedSteps,
    runs,
    approvals,
    interventions: [],
  });
  return {
    title: workflow.title,
    summary,
    outcome,
    changedPaths: changedPathsFromArtifacts(artifacts),
    artifactIds,
    checks: orderedSteps.map((step) => ({
      id: step.id,
      title: step.title,
      status: workflowStepStatusToCheckStatus(step.status),
      summary: step.resultSummary ?? step.blocker ?? (step.runId ? runById.get(step.runId)?.errorMessage : undefined),
    })),
    approvals: approvals.map((approval) => ({
      approvalId: approval.id,
      actionType: approval.actionType,
      status: approval.status,
      title: approval.title,
    })),
    nextActions,
    evidenceRefs,
  };
}

function buildRunFinalResult(
  run: RunSession,
  approvals: readonly ApprovalRequest[],
  artifacts: readonly RunArtifact[],
): LingAgentFinalResultView {
  const outcome = runStatusToOutcome(run.status);
  const title = readRunTaskTitle(run) ?? run.taskId;
  const deniedApproval = approvals.find((approval) => approval.status === "denied");
  const summary = run.errorMessage ?? approvalTerminalSummary(deniedApproval) ?? `Run ${run.status}.`;
  const nextActions = uniqueStrings([
    run.errorMessage,
    deniedApproval ? approvalNextAction(deniedApproval) : undefined,
  ].filter((value): value is string => Boolean(value)));
  return {
    title,
    summary,
    outcome,
    changedPaths: changedPathsFromArtifacts(artifacts),
    artifactIds: uniqueStrings(artifacts.map((artifact) => artifact.id)),
    checks: [{
      id: run.id,
      title,
      status: runStatusToCheckStatus(run.status),
      summary: run.errorMessage,
    }],
    approvals: approvals.map((approval) => ({
      approvalId: approval.id,
      actionType: approval.actionType,
      status: approval.status,
      title: approval.title,
    })),
    nextActions,
    evidenceRefs: buildEvidenceRefs({ proposals: [], workflows: [], workflowSteps: [], runs: [run], approvals, interventions: [] }),
  };
}

function buildEvidenceRefs(input: {
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly interventions: readonly RunIntervention[];
}): readonly LingAgentEvidenceRef[] {
  return uniqueEvidenceRefs([
    ...input.proposals.map((proposal) => ({ type: "proposal" as const, id: proposal.id, label: proposal.title })),
    ...input.workflows.map((workflow) => ({ type: "workflow" as const, id: workflow.id, label: workflow.title })),
    ...input.workflowSteps.map((step) => ({ type: "workflow_step" as const, id: step.id, label: step.title })),
    ...input.runs.map((run) => ({ type: "run" as const, id: run.id, label: readRunTaskTitle(run) ?? run.taskId })),
    ...input.approvals.map((approval) => ({ type: "approval" as const, id: approval.id, label: approval.title })),
    ...input.interventions.map((intervention) => ({ type: "intervention" as const, id: intervention.id, label: intervention.mode })),
  ]);
}

function isActiveWorkflowStatus(status: ChannelWorkflow["status"]): boolean {
  return status === "draft" || status === "ready" || status === "running" || status === "waiting_for_approval";
}

function isTerminalWorkflowStatus(status: ChannelWorkflow["status"]): boolean {
  return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled";
}

function isActiveWorkflowStepStatus(status: ChannelWorkflowStep["status"]): boolean {
  return status === "queued" || status === "claimed" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

function isActiveRunStatus(status: RunSession["status"]): boolean {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isOpenInterventionStatus(status: RunIntervention["status"]): boolean {
  return status === "queued" || status === "cancelling_source" || status === "starting_continuation" || status === "started";
}

function approvalsForWorkflow(
  approvals: readonly ApprovalRequest[],
  steps: readonly ChannelWorkflowStep[],
): readonly ApprovalRequest[] {
  const stepIds = new Set(steps.map((step) => step.id));
  const runIds = new Set(steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  return approvals.filter((approval) =>
    Boolean(approval.workflowStepId && stepIds.has(approval.workflowStepId)) ||
    Boolean(approval.runId && runIds.has(approval.runId)),
  );
}

function approvalsForRun(approvals: readonly ApprovalRequest[], runId: string): readonly ApprovalRequest[] {
  return approvals.filter((approval) => approval.runId === runId);
}

function runsForWorkflowSteps(runs: readonly RunSession[], steps: readonly ChannelWorkflowStep[]): readonly RunSession[] {
  const stepRunIds = new Set(steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  return sortByRecentActivity(runs.filter((run) => stepRunIds.has(run.id)));
}

function workflowStatusToOutcome(status: ChannelWorkflow["status"]): LingAgentFinalResultView["outcome"] {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed") {
    return "failed";
  }
  return "blocked";
}

function runStatusToOutcome(status: RunSession["status"]): LingAgentFinalResultView["outcome"] {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

function workflowStepStatusToCheckStatus(status: ChannelWorkflowStep["status"]): LingAgentResultCheck["status"] {
  if (status === "succeeded" || status === "skipped" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "blocked" || status === "waiting_for_approval") {
    return "blocked";
  }
  return "blocked";
}

function runStatusToCheckStatus(status: RunSession["status"]): LingAgentResultCheck["status"] {
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "blocked";
}

function newestRunForSteps(runs: readonly RunSession[], steps: readonly ChannelWorkflowStep[]): RunSession | undefined {
  const stepRunIds = new Set(steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  return sortByRecentActivity(runs.filter((run) => stepRunIds.has(run.id)))[0];
}

function sortWorkflowSteps(steps: readonly ChannelWorkflowStep[]): readonly ChannelWorkflowStep[] {
  return [...steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
}

function sortByRecentActivity<T extends { readonly createdAt: string; readonly updatedAt?: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) => activityAt(right).localeCompare(activityAt(left)) || right.createdAt.localeCompare(left.createdAt));
}

function activityAt(item: { readonly createdAt: string; readonly updatedAt?: string }): string {
  return item.updatedAt ?? item.createdAt;
}

function readRunTaskTitle(run: RunSession | undefined): string | undefined {
  if (!run) {
    return undefined;
  }
  const snapshot = run.taskSnapshot;
  if (isRecord(snapshot)) {
    const title = snapshot.title;
    if (typeof title === "string" && title.trim()) {
      return title.trim();
    }
  }
  return undefined;
}

function uniqueEvidenceRefs(refs: readonly LingAgentEvidenceRef[]): readonly LingAgentEvidenceRef[] {
  const seen = new Set<string>();
  const unique: LingAgentEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueArtifacts(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const artifact of artifacts) {
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function changedPathsFromArtifacts(artifacts: readonly RunArtifact[]): readonly string[] {
  return uniqueStrings(
    artifacts
      .filter((artifact) => artifact.type === "diff" || artifact.type === "file")
      .map((artifact) => artifact.path)
      .filter(Boolean),
  );
}

function approvalTerminalSummary(approval: ApprovalRequest | undefined): string | undefined {
  if (!approval) {
    return undefined;
  }
  return `Approval denied: ${approval.title}.`;
}

function approvalNextAction(approval: ApprovalRequest): string {
  return approval.decisionReason?.trim() || approval.description;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
