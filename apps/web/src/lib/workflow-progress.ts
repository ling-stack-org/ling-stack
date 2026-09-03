import type { ApprovalRequest, ChannelWorkflow, ChannelWorkflowStep, ExecutionAction, RunArtifact, RunSession, TerminalReportDto, WorkflowEvidenceResponse, WorkflowHandoffIntent } from "../types.js";
import { projectConversationActivity, summarizeConversationActivity, terminalReportToViewModel } from "@ling-stack/conversation-ui-core";
import type { Translate } from "../i18n.js";
import type {
  ConversationAgentActivitySpan,
  ConversationActivitySummary,
  ConversationArtifactStripItem,
  ConversationWorkCellDetailsModel,
  ConversationWorkCellEvidenceLink,
  ConversationWorkCellGroup,
  ConversationWorkCellRow,
  ConversationWorkCellRowTone,
  ConversationWorkCellViewModel,
} from "./conversation-work-cell.js";
import { buildConversationApprovalCheckpointRows, buildConversationArtifactStripItems, buildConversationExecutionActionEvidenceRows, mainFeedArtifactEvidenceLinks, mainFeedEvidenceGroups, mergeConversationArtifactStripItems, normalizeConversationOperationCell } from "./conversation-work-cell.js";
import { truncatePreview } from "./data.js";

export type WorkflowProgressMode = "active" | "completed";
export type WorkflowProgressAttention = "none" | "waiting" | "blocked" | "failed";

export interface WorkflowProgressStat {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface WorkflowProgressModel {
  readonly id: string;
  readonly workflowId: string;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runIds: readonly string[];
  readonly anchorRunId: string;
  readonly mode: WorkflowProgressMode;
  readonly status: ChannelWorkflow["status"];
  readonly title: string;
  readonly summary: string;
  readonly currentRows: readonly ConversationWorkCellRow[];
  readonly agentSpans: readonly ConversationAgentActivitySpan[];
  readonly activitySummary: ConversationActivitySummary;
  readonly stats: readonly WorkflowProgressStat[];
  readonly elapsedMs?: number;
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly artifactStripItems: readonly ConversationArtifactStripItem[];
  readonly attention: WorkflowProgressAttention;
  readonly updatedAt: string;
  readonly terminalReport?: TerminalReportDto;
  readonly conversationVisibility: "default" | "audit_only";
}

export interface BuildWorkflowProgressInput {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly executionActions?: readonly ExecutionAction[];
  readonly t: Translate;
  readonly artifactHref?: (artifact: RunArtifact) => string;
  readonly terminalReport?: TerminalReportDto;
}

export function buildWorkflowProgressModel(input: BuildWorkflowProgressInput): WorkflowProgressModel {
  const orderedSteps = [...input.steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  const stepRunIds = orderedSteps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId));
  const stepIds = new Set(orderedSteps.map((step) => step.id));
  const workflowRuns = input.runs.filter((run) =>
    stepRunIds.includes(run.id) || Boolean(run.workflowStepId && stepIds.has(run.workflowStepId)),
  );
  const workflowRunsByStepId = groupWorkflowRunsByStepId(workflowRuns);
  const runIds = uniqueStrings([
    ...stepRunIds,
    ...workflowRuns.map((run) => run.id),
  ]);
  const artifacts = runIds.flatMap((runId) => input.artifactsByRun[runId] ?? []);
  const workflowRunIds = new Set(runIds);
  const workflowActions = (input.executionActions ?? [])
    .filter((action) => action.runId ? workflowRunIds.has(action.runId) : false)
    .sort(compareWorkflowActionTranscriptOrder);
  const workflowApprovals = input.approvals.filter((approval) => approvalBelongsToWorkflow(approval, orderedSteps, workflowRuns));
  const pendingApprovals = workflowApprovals.filter((approval) => approval.status === "pending");
  const completedSteps = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
  const blockedStep = orderedSteps.find((step) => step.status === "blocked");
  const waitingStep = orderedSteps.find((step) => step.status === "waiting_for_approval");
  const runningStep = orderedSteps.find((step) => step.status === "running" || step.status === "claimed");
  const queuedStep = orderedSteps.find((step) => step.status === "queued");
  const failedStep = orderedSteps.find((step) => step.status === "failed");
  const currentStep = blockedStep ?? waitingStep ?? runningStep ?? queuedStep ?? failedStep ?? orderedSteps[completedSteps] ?? orderedSteps.at(-1);
  const finalResultSummary = input.terminalReport
    ? undefined
    : readWorkflowFinalResultSummary(orderedSteps, input.workflow.status) ??
      readWorkflowApprovalFinalResultSummary(workflowApprovals, input.workflow.status);
  const attention: WorkflowProgressAttention = blockedStep
    ? "blocked"
    : failedStep || input.workflow.status === "failed"
      ? "failed"
      : waitingStep || pendingApprovals.length > 0 || input.workflow.status === "waiting_for_approval"
        ? "waiting"
        : "none";
  const mode: WorkflowProgressMode = input.workflow.status === "draft" || input.workflow.status === "ready" || input.workflow.status === "running" || input.workflow.status === "waiting_for_approval"
    ? "active"
    : "completed";
  const anchorRunId = latestRun(workflowRuns)?.id ?? `workflow:${input.workflow.id}`;
  const evidenceLinks = mainFeedArtifactEvidenceLinks(artifacts, input.artifactHref);
  const groups = mainFeedEvidenceGroups(
    buildWorkflowProgressGroups({ t: input.t, steps: orderedSteps, artifacts, approvals: workflowApprovals, actions: workflowActions }),
    input.t,
  );
  const agentSpans = buildWorkflowAgentActivitySpans({
    workflowId: input.workflow.id,
    t: input.t,
    steps: orderedSteps,
    actions: workflowActions,
    artifactsByRun: input.artifactsByRun,
    runsByStepId: workflowRunsByStepId,
  });

  return {
    id: `workflow-progress:${input.workflow.id}`,
    workflowId: input.workflow.id,
    steps: orderedSteps,
    runIds,
    anchorRunId,
    mode,
    status: input.workflow.status,
    title: input.workflow.title,
    summary: buildWorkflowProgressSummary({
      t: input.t,
      workflow: input.workflow,
      currentStep,
      completedSteps,
      totalSteps: orderedSteps.length,
      artifactCount: artifacts.length,
      pendingApprovalCount: pendingApprovals.length,
      finalResultSummary,
    }),
    currentRows: buildWorkflowOperationRows({
      t: input.t,
      steps: orderedSteps,
      pendingApprovalCount: pendingApprovals.length,
    }),
    agentSpans,
    activitySummary: summarizeConversationActivity(agentSpans.flatMap((span) => span.rows)),
    stats: [
      { id: "steps", label: input.t("Steps"), value: `${completedSteps}/${orderedSteps.length}` },
      { id: "evidence", label: input.t("Evidence"), value: String(artifacts.length) },
      { id: "approvals", label: input.t("Approvals"), value: String(mode === "completed" ? workflowApprovals.length : pendingApprovals.length) },
    ],
    elapsedMs: workflowElapsedMs(input.workflow, orderedSteps, workflowRuns),
    groups,
    evidenceLinks,
    artifactStripItems: buildConversationArtifactStripItems({ groups, evidenceLinks, artifacts, t: input.t }),
    attention,
    updatedAt: input.terminalReport?.committedAt && input.terminalReport.committedAt > input.workflow.updatedAt
      ? input.terminalReport.committedAt
      : input.workflow.updatedAt,
    terminalReport: input.terminalReport,
    conversationVisibility: isResolvedApprovalOnlyWorkflow(input.workflow, orderedSteps, workflowRuns, workflowApprovals, input.terminalReport)
      ? "audit_only"
      : "default",
  };
}

function isResolvedApprovalOnlyWorkflow(
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  runs: readonly RunSession[],
  approvals: readonly ApprovalRequest[],
  terminalReport: TerminalReportDto | undefined,
): boolean {
  if (terminalReport || !isTerminalWorkflowStatus(workflow.status) || steps.length === 0 || runs.length > 0) {
    return false;
  }
  const approvalStepIds = new Set(
    approvals
      .filter((approval) => approval.status !== "pending" && approval.workflowStepId)
      .map((approval) => approval.workflowStepId as string),
  );
  return approvals.length > 0 &&
    approvals.every((approval) => approval.status !== "pending") &&
    steps.every((step) => !step.runId && isTerminalWorkflowStepStatus(step.status) && approvalStepIds.has(step.id));
}

function isTerminalWorkflowStatus(status: ChannelWorkflow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalWorkflowStepStatus(status: ChannelWorkflowStep["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

export function workflowProgressToConversationWorkCell(model: WorkflowProgressModel): ConversationWorkCellViewModel {
  const terminalReport = model.terminalReport ? terminalReportToViewModel(model.terminalReport) : undefined;
  const evidenceLinks = uniqueBy([
    ...model.evidenceLinks,
    ...(terminalReport?.evidenceLinks ?? []),
  ], (item) => item.id);
  const hasBaseChangedItem = model.artifactStripItems.some((item) => item.kind === "changed");
  const artifactStripItems = mergeConversationArtifactStripItems(
    model.artifactStripItems,
    (terminalReport?.artifactStripItems ?? []).filter((item) => item.kind !== "changed" || !hasBaseChangedItem),
  ).map((item) => item.kind === "changed"
    ? { ...item, recoveryTarget: { kind: "workflow" as const, id: model.workflowId } }
    : item);
  return normalizeConversationOperationCell({
    id: model.id,
    sourceKind: "workflow",
    threadId: `workflow:${model.workflowId}`,
    anchorRunId: model.anchorRunId,
    runIds: model.runIds,
    mode: model.mode,
    status: model.status,
    title: model.title,
    summary: model.summary,
    stats: model.stats,
    elapsedMs: model.elapsedMs,
    operationRows: model.agentSpans.length > 0 ? [] : model.currentRows,
    agentSpans: model.agentSpans,
    agentBranches: model.agentSpans,
    ...(model.agentSpans.length === 0 ? { operationItems: projectConversationActivity(model.currentRows) } : {}),
    activitySummary: model.activitySummary,
    terminalReportId: terminalReport?.reportId,
    terminalReportRevisionKey: terminalReport?.revisionKey,
    terminalReportRows: terminalReport?.rows ?? [],
    groups: model.groups,
    evidenceLinks,
    artifactStripItems,
    updatedAt: model.updatedAt,
  });
}

export function buildConversationWorkCellDetailsFromWorkflowEvidence(input: {
  readonly evidence: WorkflowEvidenceResponse;
  readonly t: Translate;
  readonly artifactHref?: (artifact: RunArtifact) => string;
}): ConversationWorkCellDetailsModel {
  const t = input.t;
  const artifacts = uniqueArtifacts([
    ...input.evidence.artifacts,
    ...input.evidence.steps.flatMap((step) => [...step.packetArtifacts, ...step.linkedArtifacts]),
  ]);
  const changedArtifacts = artifacts.filter((artifact) => artifact.type === "diff" || artifact.type === "file");
  const changedRows: ConversationWorkCellRow[] = uniqueBy(changedArtifacts, (artifact) => artifact.path || artifact.id).slice(0, 10).map((artifact) => ({
    id: `changed:${artifact.id}`,
    kind: "edit",
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral",
  }));
  const checkedRows: ConversationWorkCellRow[] = input.evidence.steps.slice(0, 16).map(({ step, diagnostics }) => {
    const title = workflowStepDisplayTitle(step, t);
    return {
      id: `step:${step.id}`,
      kind: "verify",
      title,
      description: workflowStepDisplayDescription(step, 160, title),
      meta: workflowStepDisplayMeta(step.status, diagnostics.length, t),
      tone: workflowStepTone(step.status),
    };
  });
  const checkpointRows = buildConversationApprovalCheckpointRows({
    checkpoints: input.evidence.approvalCheckpoints ?? [],
    t,
  });
  const evidenceRows: ConversationWorkCellRow[] = [
    ...buildConversationExecutionActionEvidenceRows({
      actions: input.evidence.actions ?? [],
      artifacts,
      t,
      limit: 8,
    }),
    ...workflowHandoffIntentRows(input.evidence.handoffIntents ?? [], t, "evidence"),
    ...checkpointRows.evidenceRows,
    ...artifacts.slice(0, 10).map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: artifact.type === "diff" || artifact.type === "file" || artifact.path ? "edit" as const : "verify" as const,
      title: artifact.title || artifact.path || artifact.id,
      description: artifact.path,
      meta: artifact.type,
      tone: "neutral" as const,
    })),
  ];
  const diagnosticRows: ConversationWorkCellRow[] = input.evidence.steps.flatMap(({ step, diagnostics }) =>
    diagnostics.slice(0, 4).map((diagnostic) => ({
      id: `diagnostic:${step.id}:${diagnostic.kind}:${diagnostic.message}`,
      kind: "watch" as const,
      title: workflowStepDisplayTitle(step, t),
      description: diagnostic.message,
      meta: diagnostic.severity,
      tone: diagnostic.severity === "critical" ? "failed" as const : "waiting" as const,
    })),
  );
  const approvalRows: ConversationWorkCellRow[] = input.evidence.approvals
    .slice(0, 8)
    .map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval" as const,
      title: approval.title,
      description: approval.description,
      meta: approval.status === "pending" ? t("Waiting for approval") : t(approval.status),
      tone: approvalStatusTone(approval.status),
    }));
  const blockedRows: ConversationWorkCellRow[] = input.evidence.steps
    .filter(({ step }) => step.status === "blocked" || step.status === "failed")
    .slice(0, 8)
    .map(({ step }) => ({
      id: `attention-step:${step.id}`,
      kind: "watch" as const,
      title: workflowStepDisplayTitle(step, t),
      description: step.blocker ?? step.resultSummary ?? t("Needs attention"),
      meta: step.status,
      tone: step.status === "failed" ? "failed" as const : "waiting" as const,
    }));
  const handoffAttentionRows = workflowHandoffIntentRows(input.evidence.handoffIntents ?? [], t, "attention");
  const attentionRows = [...checkpointRows.attentionRows, ...approvalRows, ...handoffAttentionRows, ...blockedRows, ...diagnosticRows].slice(0, 16);
  const evidenceLinks = mainFeedArtifactEvidenceLinks(artifacts, input.artifactHref);

  return {
    groups: mainFeedEvidenceGroups([
      {
        id: "changed",
        label: t("Changed"),
        summary: changedRows.length > 0 ? t("{count} changed items", { count: changedRows.length }) : t("No changed files recorded"),
        rows: changedRows,
      },
      {
        id: "checked",
        label: t("Checks"),
        summary: t("{count} steps", { count: input.evidence.steps.length }),
        rows: checkedRows,
      },
      {
        id: "evidence",
        label: t("Evidence"),
        summary: t("{count} evidence items", { count: evidenceRows.length }),
        rows: evidenceRows,
      },
      {
        id: "attention",
        label: t("Attention"),
        summary: attentionRows.length > 0 ? t("{count} attention items", { count: attentionRows.length }) : t("No attention needed"),
        rows: attentionRows,
      },
    ], t),
    evidenceLinks,
  };
}

function workflowHandoffIntentRows(
  intents: readonly WorkflowHandoffIntent[],
  t: Translate,
  surface: "evidence" | "attention",
): readonly ConversationWorkCellRow[] {
  return intents
    .filter((intent) => surface === "attention" ? isWorkflowHandoffAttentionIntent(intent) : !isWorkflowHandoffAttentionIntent(intent))
    .slice(0, 8)
    .map((intent) => workflowHandoffIntentRow(intent, t));
}

function workflowHandoffIntentRow(intent: WorkflowHandoffIntent, t: Translate): ConversationWorkCellRow {
  const target = intent.toParticipantLabel?.trim() || intent.toParticipantId;
  const detailLines: ConversationWorkCellRow["detailLines"] = [
    { text: t("Required input: {value}", { value: truncatePreview(intent.requiredInput, 160) }) },
    { text: t("Expected output: {value}", { value: truncatePreview(intent.expectedOutput, 160) }) },
    intent.riskSummary ? { text: t("Risk: {value}", { value: truncatePreview(intent.riskSummary, 140) }) } : undefined,
    { text: t("Status: {status}", { status: workflowHandoffStatusLabel(intent.status, t) }) },
    ...workflowHandoffValidationLines(intent, t),
  ].filter((line): line is NonNullable<typeof line> => Boolean(line));
  return {
    id: `handoff-intent:${intent.id}`,
    kind: "handoff",
    title: t("Handoff: {from} -> {to}", {
      from: intent.fromParticipantLabel,
      to: target,
    }),
    description: truncatePreview(intent.reason, 180),
    detailLines,
    meta: workflowHandoffStatusLabel(intent.status, t),
    tone: workflowHandoffTone(intent),
  };
}

function workflowHandoffValidationLines(intent: WorkflowHandoffIntent, t: Translate): readonly NonNullable<ConversationWorkCellRow["detailLines"]>[number][] {
  const blockers = intent.validation?.blockers ?? [];
  if (blockers.length === 0) {
    return [];
  }
  const summary = blockers.length === 1
    ? truncatePreview(blockers[0] ?? "", 140)
    : t("{count} blockers", { count: blockers.length });
  return [{ text: t("Validation blockers: {summary}", { summary }) }];
}

function isWorkflowHandoffAttentionIntent(intent: WorkflowHandoffIntent): boolean {
  const blockers = intent.validation?.blockers ?? [];
  return intent.status === "failed" ||
    intent.status === "declined" ||
    (intent.status === "proposed" && blockers.length > 0);
}

function workflowHandoffStatusLabel(status: WorkflowHandoffIntent["status"], t: Translate): string {
  if (status === "proposed") {
    return t("Proposed");
  }
  if (status === "validated") {
    return t("Validated");
  }
  if (status === "accepted") {
    return t("Accepted");
  }
  if (status === "declined") {
    return t("Declined");
  }
  if (status === "converted") {
    return t("Converted");
  }
  if (status === "failed") {
    return t("Failed");
  }
  return status;
}

function workflowHandoffTone(intent: WorkflowHandoffIntent): ConversationWorkCellRowTone {
  if (intent.status === "failed" || intent.status === "declined") {
    return "failed";
  }
  if (isWorkflowHandoffAttentionIntent(intent) || intent.status === "proposed") {
    return "waiting";
  }
  if (intent.status === "validated" || intent.status === "accepted" || intent.status === "converted") {
    return "success";
  }
  return "neutral";
}

function buildWorkflowProgressSummary(input: {
  readonly t: Translate;
  readonly workflow: ChannelWorkflow;
  readonly currentStep?: ChannelWorkflowStep;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly artifactCount: number;
  readonly pendingApprovalCount: number;
  readonly finalResultSummary?: string;
}): string {
  if (input.workflow.status === "succeeded") {
    return input.finalResultSummary ?? (input.workflow.objective.trim() || input.workflow.title);
  }
  if (input.workflow.status === "failed" || input.workflow.status === "cancelled") {
    if (input.finalResultSummary) {
      return input.t("Task did not complete: {summary}", { summary: input.finalResultSummary });
    }
    return input.t("Stopped at {step}: {status}.", {
      step: input.currentStep?.title ?? input.workflow.title,
      status: input.workflow.status,
    });
  }
  if (input.workflow.status === "blocked" || input.currentStep?.status === "blocked") {
    return input.t("Blocked: {reason}", { reason: input.currentStep?.blocker ?? input.finalResultSummary ?? input.t("waiting for user input") });
  }
  if (input.pendingApprovalCount > 0 || input.workflow.status === "waiting_for_approval" || input.currentStep?.status === "waiting_for_approval") {
    return input.t("{teammate} is waiting for approval.", { teammate: input.currentStep?.toParticipantLabel ?? input.t("Work") });
  }
  if (input.currentStep && (input.currentStep.status === "running" || input.currentStep.status === "claimed")) {
    return input.t("{teammate} is working on {step}. {done} of {total} steps complete.", {
      teammate: input.currentStep.toParticipantLabel,
      step: input.currentStep.title,
      done: input.completedSteps,
      total: input.totalSteps,
    });
  }
  return input.t("Ready: {done} of {total} steps complete.", {
    done: input.completedSteps,
    total: input.totalSteps,
  });
}

function readWorkflowFinalResultSummary(
  steps: readonly ChannelWorkflowStep[],
  workflowStatus: ChannelWorkflow["status"],
): string | undefined {
  const terminalStatuses = workflowStatus === "succeeded"
    ? new Set<ChannelWorkflowStep["status"]>(["succeeded", "skipped"])
    : new Set<ChannelWorkflowStep["status"]>(["failed", "cancelled", "blocked", "succeeded"]);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const summary = step.resultSummary?.trim();
    if (summary && terminalStatuses.has(step.status) && !isGenericWorkflowSuccessSummary(summary)) {
      return summary;
    }
  }
  return undefined;
}

function readWorkflowApprovalFinalResultSummary(
  approvals: readonly ApprovalRequest[],
  workflowStatus: ChannelWorkflow["status"],
): string | undefined {
  if (workflowStatus !== "blocked" && workflowStatus !== "failed" && workflowStatus !== "cancelled") {
    return undefined;
  }
  const denied = approvals.find((approval) => approval.status === "denied");
  if (denied) {
    return `Approval denied: ${denied.title}.`;
  }
  const expired = approvals.find((approval) => approval.status === "expired");
  if (expired) {
    return `Approval expired: ${expired.title}.`;
  }
  const cancelled = approvals.find((approval) => approval.status === "cancelled");
  return cancelled ? `Approval cancelled: ${cancelled.title}.` : undefined;
}

function buildWorkflowOperationRows(input: {
  readonly t: Translate;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly pendingApprovalCount: number;
}): readonly ConversationWorkCellRow[] {
  const rows: ConversationWorkCellRow[] = visibleWorkflowOperationSteps(input.steps).map((step) => {
    const title = workflowStepOperationTitle(step, input.t);
    return {
      id: `step:${step.id}`,
      kind: "handoff",
      title,
      description: workflowStepOperationSummary(step, 140, title),
      meta: workflowStepDisplayMeta(step.status, 0, input.t),
      tone: workflowStepTone(step.status),
    };
  });
  if (input.pendingApprovalCount > 0) {
    rows.push({
      id: "approvals",
      kind: "approval",
      title: input.t("Waiting for approval"),
      description: input.t("{count} pending approvals", { count: input.pendingApprovalCount }),
      tone: "waiting",
    });
  }
  return rows;
}

function buildWorkflowAgentActivitySpans(input: {
  readonly workflowId: string;
  readonly t: Translate;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly actions: readonly ExecutionAction[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runsByStepId: ReadonlyMap<string, readonly RunSession[]>;
}): readonly ConversationAgentActivitySpan[] {
  const actionsByRun = groupWorkflowActionsByRun(input.actions);
  const groups = new Map<string, ChannelWorkflowStep[]>();
  for (const step of input.steps) {
    if (isCoordinatorWorkflowParticipant(step)) {
      continue;
    }
    const key = step.toParticipantId || step.toParticipantLabel || step.id;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  if (groups.size === 0) {
    return [];
  }

  return [...groups.entries()]
    .map(([participantId, steps], index) => {
      const orderedSteps = [...steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
      const latestStep = workflowAgentFocusStep(orderedSteps);
      const groupStatus = workflowAgentGroupStatus(orderedSteps);
      const canonicalParticipantId = orderedSteps.find((step) => step.toParticipantId.trim())?.toParticipantId.trim();
      const participantScope = canonicalParticipantId ?? participantId;
      const latestActionRow = latestStep ? workflowLatestActionRowForStep({
        step: latestStep,
        actionsByRun,
        artifactsByRun: input.artifactsByRun,
        runsByStepId: input.runsByStepId,
        t: input.t,
        participantId: participantScope,
      }) : undefined;
      const rows = buildWorkflowAgentActivityRows({
        steps: orderedSteps,
        actionsByRun,
        artifactsByRun: input.artifactsByRun,
        runsByStepId: input.runsByStepId,
        t: input.t,
        participantId: participantScope,
      });
      return {
        sortIndex: index,
        // Participant IDs are stable across workflows. Scope the synthetic
        // span identity by workflow so channel fan-in cannot dedupe a later
        // operation's Agent activity as a duplicate of an earlier one.
        id: `agent:${input.workflowId}:${participantId}`,
        ...(canonicalParticipantId ? { participantId: canonicalParticipantId } : {}),
        kind: "agent" as const,
        label: latestStep?.toParticipantLabel.trim() || orderedSteps[0]?.toParticipantLabel.trim() || participantId,
        tone: workflowStepTone(groupStatus),
        stateLabel: workflowStepStatusMeta(groupStatus, input.t),
        latestRow: latestActionRow ?? (latestStep ? workflowStepToAgentRow(latestStep, input.t, "latest") : undefined),
        rows,
        items: projectConversationActivity(rows, { participantScope }),
      } satisfies ConversationAgentActivitySpan & { readonly sortIndex: number };
    })
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .map(({ sortIndex: _sortIndex, ...span }) => span);
}

function buildWorkflowAgentActivityRows(input: {
  readonly steps: readonly ChannelWorkflowStep[];
  readonly actionsByRun: ReadonlyMap<string, readonly ExecutionAction[]>;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runsByStepId: ReadonlyMap<string, readonly RunSession[]>;
  readonly t: Translate;
  readonly participantId: string;
}): readonly ConversationWorkCellRow[] {
  return input.steps.flatMap((step) => [
    workflowStepToAgentRow(step, input.t, "history"),
    ...workflowActionRowsForStep({
      step,
      actionsByRun: input.actionsByRun,
      artifactsByRun: input.artifactsByRun,
      runsByStepId: input.runsByStepId,
      t: input.t,
      participantId: input.participantId,
      scope: "history",
    }),
  ]);
}

function workflowLatestActionRowForStep(input: {
  readonly step: ChannelWorkflowStep;
  readonly actionsByRun: ReadonlyMap<string, readonly ExecutionAction[]>;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runsByStepId: ReadonlyMap<string, readonly RunSession[]>;
  readonly t: Translate;
  readonly participantId: string;
}): ConversationWorkCellRow | undefined {
  return workflowActionRowsForStep({ ...input, scope: "latest" }).at(-1);
}

function workflowActionRowsForStep(input: {
  readonly step: ChannelWorkflowStep;
  readonly actionsByRun: ReadonlyMap<string, readonly ExecutionAction[]>;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runsByStepId: ReadonlyMap<string, readonly RunSession[]>;
  readonly t: Translate;
  readonly participantId: string;
  readonly scope: "latest" | "history";
}): readonly ConversationWorkCellRow[] {
  const runIds = uniqueStrings([
    input.step.runId,
    ...(input.runsByStepId.get(input.step.id) ?? []).map((run) => run.id),
  ].filter((runId): runId is string => Boolean(runId)));
  if (runIds.length === 0) {
    return [];
  }
  const actions = runIds
    .flatMap((runId) => input.actionsByRun.get(runId) ?? [])
    .sort(compareWorkflowActionTranscriptOrder);
  if (actions.length === 0) {
    return [];
  }
  return buildConversationExecutionActionEvidenceRows({
    actions,
    artifacts: runIds.flatMap((runId) => input.artifactsByRun[runId] ?? []),
    t: input.t,
    participantId: input.participantId,
    workflowStepId: input.step.id,
    limit: input.scope === "latest" ? 8 : undefined,
  }).map((row) => ({
    ...row,
    id: `${input.scope}:workflow-step:${input.step.id}:${row.id}`,
  }));
}

function groupWorkflowRunsByStepId(runs: readonly RunSession[]): ReadonlyMap<string, readonly RunSession[]> {
  const groups = new Map<string, RunSession[]>();
  for (const run of runs) {
    if (!run.workflowStepId) {
      continue;
    }
    groups.set(run.workflowStepId, [...(groups.get(run.workflowStepId) ?? []), run]);
  }
  return new Map([...groups.entries()].map(([workflowStepId, stepRuns]) => [
    workflowStepId,
    [...stepRuns].sort(compareWorkflowRunActivity),
  ]));
}

function groupWorkflowActionsByRun(actions: readonly ExecutionAction[]): ReadonlyMap<string, readonly ExecutionAction[]> {
  const groups = new Map<string, ExecutionAction[]>();
  for (const action of actions) {
    if (!action.runId) {
      continue;
    }
    groups.set(action.runId, [...(groups.get(action.runId) ?? []), action]);
  }
  return new Map([...groups.entries()].map(([runId, runActions]) => [
    runId,
    [...runActions].sort(compareWorkflowActionTranscriptOrder),
  ]));
}

function isCoordinatorWorkflowParticipant(step: ChannelWorkflowStep): boolean {
  const id = step.toParticipantId.trim().toLowerCase();
  const label = step.toParticipantLabel.trim().toLowerCase();
  return id === "ling_agent" || id === "ling-agent" || label === "ling agent" || label === "ling";
}

function workflowAgentFocusStep(steps: readonly ChannelWorkflowStep[]): ChannelWorkflowStep | undefined {
  return steps.find((step) => step.status === "blocked") ??
    steps.find((step) => step.status === "failed") ??
    steps.find((step) => step.status === "waiting_for_approval") ??
    steps.find((step) => step.status === "running" || step.status === "claimed") ??
    steps.find((step) => step.status === "queued") ??
    steps.at(-1);
}

function workflowAgentGroupStatus(steps: readonly ChannelWorkflowStep[]): ChannelWorkflowStep["status"] {
  return workflowAgentFocusStep(steps)?.status ?? "succeeded";
}

function workflowStepToAgentRow(
  step: ChannelWorkflowStep,
  t: Translate,
  scope: "latest" | "history",
): ConversationWorkCellRow {
  const title = workflowStepOperationTitle(step, t);
  const sourceLabel = workflowStepProposalSourceLabel(step, t);
  return {
    id: `${scope}:workflow-step:${step.id}`,
    kind: workflowStepOperationKind(step),
    presentation: step.status === "succeeded" ? "note" : undefined,
    title,
    description: workflowStepOperationSummary(step, 160, title),
    meta: [workflowStepStatusMeta(step.status, t), sourceLabel].filter(Boolean).join(" · "),
    tone: workflowStepTone(step.status),
  };
}

function workflowStepOperationKind(step: ChannelWorkflowStep): ConversationWorkCellRow["kind"] {
  const text = `${step.title}\n${step.prompt}\n${step.resultSummary ?? ""}`.toLowerCase();
  if (/\b(rg|grep|find|search)\b|搜索/u.test(text)) {
    return "search";
  }
  if (/\b(read|list|ls|inspect)\b|读取|查看/u.test(text)) {
    return "read";
  }
  if (/\b(edit|write|create|modify|patch)\b|创建|修改|写入/u.test(text)) {
    return "edit";
  }
  if (/\b(test|check|verify|pnpm|npm|node|playwright|typecheck)\b|检查|验证|测试/u.test(text)) {
    return "verify";
  }
  return "handoff";
}

function visibleWorkflowOperationSteps(steps: readonly ChannelWorkflowStep[]): readonly ChannelWorkflowStep[] {
  if (steps.length <= 6) {
    return steps;
  }
  const focusIndex = steps.findIndex((step) =>
    step.status === "blocked" ||
    step.status === "failed" ||
    step.status === "waiting_for_approval" ||
    step.status === "running" ||
    step.status === "claimed" ||
    step.status === "queued"
  );
  if (focusIndex < 0) {
    return steps.slice(-6);
  }
  const start = Math.max(0, focusIndex - 3);
  return steps.slice(start, start + 6);
}

function workflowStepOperationTitle(step: ChannelWorkflowStep, t: Translate): string {
  const owner = step.toParticipantLabel.trim();
  const title = stripWorkflowStepOwnerPrefix(step.title, owner);
  const summary = workflowStepDisplaySummary(step, 140);
  if ((step.status === "succeeded" || step.status === "skipped") && summary) {
    return summary;
  }
  if ((step.status === "failed" || step.status === "blocked") && summary) {
    return summary;
  }
  if (summary && isGenericWorkflowStepTitle(title)) {
    return workflowStepLifecycleTitle(step.status, summary, t);
  }
  const baseTitle = !title || isGenericWorkflowStepTitle(title)
    ? summary ?? genericWorkflowStepTitle(title, t)
    : title;
  return workflowStepLifecycleTitle(step.status, baseTitle, t);
}

function workflowStepLifecycleTitle(
  status: ChannelWorkflowStep["status"],
  title: string,
  t: Translate,
): string {
  if (status === "running" || status === "claimed") {
    return t("Working on {title}", { title });
  }
  if (status === "queued") {
    return t("Waiting to start {title}", { title });
  }
  if (status === "waiting_for_approval") {
    return t("Waiting for approval: {title}", { title });
  }
  if (status === "cancelled") {
    return t("Stopped {title}", { title });
  }
  if (status === "succeeded" || status === "skipped") {
    return t("Finished {title}", { title });
  }
  if (!title || isGenericWorkflowStepTitle(title)) {
    return title || genericWorkflowStepTitle(title, t);
  }
  return title;
}

function workflowStepOperationSummary(step: ChannelWorkflowStep, maxLength: number, title: string): string | undefined {
  const summary = workflowStepDisplaySummary(step, maxLength);
  if (summary) {
    return summary === title ? undefined : summary;
  }
  if (step.status === "running" || step.status === "claimed" || step.status === "queued" || step.status === "waiting_for_approval") {
    return truncatePreview(step.prompt, maxLength);
  }
  return undefined;
}

function buildWorkflowProgressGroups(input: {
  readonly t: Translate;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifacts: readonly RunArtifact[];
  readonly approvals: readonly ApprovalRequest[];
  readonly actions: readonly ExecutionAction[];
}): readonly ConversationWorkCellGroup[] {
  const changedArtifacts = input.artifacts.filter((artifact) => artifact.type === "diff" || artifact.type === "file");
  const changedRows = uniqueBy(changedArtifacts, (artifact) => artifact.path || artifact.id).slice(0, 8).map((artifact) => ({
    id: `changed:${artifact.id}`,
    kind: "edit" as const,
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral" as const,
  }));
  const checkedRows = input.steps.slice(0, 12).map((step) => {
    const title = workflowStepDisplayTitle(step, input.t);
    return {
      id: `step:${step.id}`,
      kind: "verify" as const,
      title,
      description: workflowStepDisplayDescription(step, 140, title),
      meta: workflowStepDisplayMeta(step.status, 0, input.t),
      tone: workflowStepTone(step.status),
    };
  });
  const evidenceRows: ConversationWorkCellRow[] = [
    ...buildConversationExecutionActionEvidenceRows({
      actions: input.actions,
      artifacts: input.artifacts,
      t: input.t,
      limit: 10,
    }),
    ...input.artifacts.slice(0, 10).map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: artifact.type === "diff" || artifact.type === "file" ? "edit" as const : "verify" as const,
      title: artifact.title || artifact.path || artifact.id,
      description: artifact.path,
      meta: artifact.type,
      tone: "neutral" as const,
    })),
  ];
  evidenceRows.push(...input.approvals.slice(0, 8).map((approval) => ({
    id: `approval-evidence:${approval.id}`,
    kind: "approval" as const,
    title: approval.title,
    description: approval.description,
    meta: approval.status,
    tone: approvalStatusTone(approval.status),
  })));
  const attentionRows: ConversationWorkCellRow[] = [
    ...input.approvals
      .filter((approval) => approval.status !== "approved")
      .slice(0, 5)
      .map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval" as const,
      title: approval.title,
      description: approval.description,
      meta: approval.status === "pending" ? input.t("Waiting for approval") : input.t(approval.status),
      tone: approval.status === "pending" ? "waiting" as const : "failed" as const,
    })),
    ...input.steps.filter((step) => step.status === "blocked" || step.status === "failed").slice(0, 5).map((step) => ({
      id: `attention-step:${step.id}`,
      kind: "watch" as const,
      title: workflowStepDisplayTitle(step, input.t),
      description: step.blocker ?? step.resultSummary ?? input.t("Needs attention"),
      meta: step.status,
      tone: step.status === "failed" ? "failed" as const : "waiting" as const,
    })),
  ];
  return [
    {
      id: "changed",
      label: input.t("Changed"),
      summary: changedRows.length > 0 ? input.t("{count} changed items", { count: changedRows.length }) : input.t("No changed files recorded"),
      rows: changedRows,
    },
    {
      id: "checked",
      label: input.t("Checks"),
      summary: input.t("{count} steps", { count: input.steps.length }),
      rows: checkedRows,
    },
    {
      id: "evidence",
      label: input.t("Evidence"),
      summary: input.t("{count} evidence items", { count: evidenceRows.length }),
      rows: evidenceRows,
    },
    {
      id: "attention",
      label: input.t("Attention"),
      summary: attentionRows.length > 0 ? input.t("{count} attention items", { count: attentionRows.length }) : input.t("No attention needed"),
      rows: attentionRows,
    },
  ];
}

function approvalBelongsToWorkflow(
  approval: ApprovalRequest,
  steps: readonly ChannelWorkflowStep[],
  runs: readonly RunSession[],
): boolean {
  const stepIds = new Set(steps.map((step) => step.id));
  const runIds = new Set([
    ...steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)),
    ...runs.map((run) => run.id),
  ]);
  return Boolean(approval.workflowStepId && stepIds.has(approval.workflowStepId)) ||
    Boolean(approval.runId && runIds.has(approval.runId));
}

function workflowStepProgressTitle(step: ChannelWorkflowStep, t: Translate): string {
  if (step.status === "blocked") {
    return t("{teammate} is blocked", { teammate: step.toParticipantLabel });
  }
  if (step.status === "waiting_for_approval") {
    return t("{teammate} is waiting for approval", { teammate: step.toParticipantLabel });
  }
  if (step.status === "running" || step.status === "claimed") {
    return t("{teammate} is working", { teammate: step.toParticipantLabel });
  }
  if (step.status === "queued") {
    return t("{teammate} is queued", { teammate: step.toParticipantLabel });
  }
  return t("{teammate} finished {step}", { teammate: step.toParticipantLabel, step: step.title });
}

function workflowStepDisplayTitle(step: ChannelWorkflowStep, t: Translate): string {
  const owner = step.toParticipantLabel.trim();
  const title = stripWorkflowStepOwnerPrefix(step.title, owner);
  const summary = workflowStepDisplaySummary(step, 120);
  const displayTitle = summary && isGenericWorkflowStepTitle(title)
    ? summary
    : isGenericWorkflowStepTitle(title)
      ? genericWorkflowStepTitle(title, t)
      : title;
  if (!owner) {
    return displayTitle || title;
  }
  return `${owner}: ${displayTitle || title}`;
}

function workflowStepDisplaySummary(step: ChannelWorkflowStep, maxLength: number): string | undefined {
  const summary = step.resultSummary?.trim();
  if (summary && !isGenericWorkflowSuccessSummary(summary)) {
    return summary;
  }
  const blocker = step.blocker?.trim();
  if (blocker) {
    return blocker;
  }
  return semanticWorkflowPromptSummary(step.prompt, maxLength);
}

function workflowStepDisplayDescription(step: ChannelWorkflowStep, maxLength: number, title: string): string | undefined {
  const summary = workflowStepDisplaySummary(step, maxLength);
  if (!summary || title.endsWith(summary)) {
    return undefined;
  }
  return summary;
}

function workflowStepProposalSourceLabel(step: ChannelWorkflowStep, t: Translate): string | undefined {
  const councilSource = step.metadata?.proposalStepSources?.find((source) => source.kind === "council");
  if (councilSource) {
    return t("From {source}", { source: councilSource.councilDisplayName ?? t("AI council") });
  }
  const directSource = step.metadata?.proposalStepSources?.find((source) => source.kind === "direct");
  if (directSource?.isDefault) {
    return t("Default channel teammate");
  }
  return directSource ? t("Direct channel teammate") : undefined;
}

function semanticWorkflowPromptSummary(prompt: string, maxLength: number): string | undefined {
  const stepSummaryMatch = /(?:^|\n)Step summary:\s*\n([\s\S]*?)(?=\n\n[A-Z][^:\n]{0,80}:\s*\n|$)/u.exec(prompt);
  const extracted = stepSummaryMatch?.[1]?.trim();
  if (extracted) {
    return truncatePreview(extracted, maxLength);
  }
  const trimmed = prompt.trim();
  if (!trimmed || isStructuredWorkflowPrompt(trimmed)) {
    return undefined;
  }
  return truncatePreview(trimmed, maxLength);
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

function stripWorkflowStepOwnerPrefix(title: string, owner: string): string {
  const trimmedTitle = title.trim();
  const trimmedOwner = owner.trim();
  if (!trimmedOwner) {
    return trimmedTitle;
  }
  return trimmedTitle.replace(new RegExp(`^${escapeRegExp(trimmedOwner)}\\s*[:：]\\s*`, "iu"), "").trim();
}

function isGenericWorkflowStepTitle(title: string): boolean {
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

function genericWorkflowStepTitle(title: string, t: Translate): string {
  const normalized = title.trim().toLowerCase();
  if (normalized === "review" || normalized === "reviewed") {
    return t("Review scope");
  }
  if (normalized === "consult" || normalized === "consulted") {
    return t("Clarify scope");
  }
  if (normalized === "flagged_risk" || normalized === "flagged risk") {
    return t("Review risk");
  }
  return t("Coordinate work");
}

function workflowStepDisplayMeta(
  status: ChannelWorkflowStep["status"],
  diagnosticCount: number,
  t: Translate,
): string | undefined {
  if (diagnosticCount > 0) {
    return t("{count} diagnostics", { count: diagnosticCount });
  }
  if (status === "succeeded" || status === "skipped") {
    return undefined;
  }
  return workflowStepStatusMeta(status, t);
}

function isGenericWorkflowSuccessSummary(value: string): boolean {
  return /^(run\s+succeeded(?:\s+and\s+post-step\s+approval\s+was\s+granted)?|succeeded|completed)\.?$/iu.test(value.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workflowStepTone(status: ChannelWorkflowStep["status"]): ConversationWorkCellRowTone {
  if (status === "succeeded" || status === "skipped") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "waiting_for_approval" || status === "blocked") {
    return "waiting";
  }
  if (status === "running" || status === "claimed" || status === "queued") {
    return "running";
  }
  return "neutral";
}

function workflowStepStatusMeta(status: ChannelWorkflowStep["status"], t: Translate): string | undefined {
  if (status === "failed") {
    return t("Failed");
  }
  if (status === "blocked") {
    return t("Blocked");
  }
  if (status === "waiting_for_approval") {
    return t("Waiting for approval");
  }
  if (status === "cancelled") {
    return t("Stopped");
  }
  return undefined;
}

function workflowElapsedMs(
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  runs: readonly RunSession[],
): number | undefined {
  const starts = [
    parseIsoMs(workflow.createdAt),
    ...steps.map((step) => parseIsoMs(step.createdAt)),
    ...runs.map((run) => parseIsoMs(run.startedAt ?? run.createdAt)),
  ].filter((value): value is number => value !== undefined);
  const ends = [
    parseIsoMs(workflow.updatedAt),
    ...steps.map((step) => parseIsoMs(step.updatedAt)),
    ...runs.map((run) => parseIsoMs(run.endedAt ?? run.updatedAt)),
  ].filter((value): value is number => value !== undefined);
  if (starts.length === 0 || ends.length === 0) {
    return undefined;
  }
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(...ends);
  return endedAt > startedAt ? endedAt - startedAt : undefined;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function approvalStatusTone(status: ApprovalRequest["status"]): ConversationWorkCellRowTone {
  if (status === "approved") {
    return "success";
  }
  if (status === "pending") {
    return "waiting";
  }
  if (status === "denied" || status === "expired" || status === "cancelled") {
    return "failed";
  }
  return "neutral";
}

function latestRun(runs: readonly RunSession[]): RunSession | undefined {
  return [...runs].sort(compareWorkflowRunActivity)[0];
}

function compareWorkflowRunActivity(left: RunSession, right: RunSession): number {
  const leftTime = left.endedAt ?? left.startedAt ?? left.updatedAt;
  const rightTime = right.endedAt ?? right.startedAt ?? right.updatedAt;
  const timeComparison = rightTime.localeCompare(leftTime);
  return timeComparison === 0 ? right.id.localeCompare(left.id) : timeComparison;
}

function compareWorkflowActionTranscriptOrder(left: ExecutionAction, right: ExecutionAction): number {
  const leftTime = left.executedAt ?? left.resolvedAt ?? left.completedAt ?? left.createdAt;
  const rightTime = right.executedAt ?? right.resolvedAt ?? right.completedAt ?? right.createdAt;
  const timeComparison = leftTime.localeCompare(rightTime);
  return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
}

function uniqueArtifacts(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  return uniqueBy(artifacts, (artifact) => artifact.id);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
