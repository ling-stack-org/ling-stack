import type { ApprovalRequest, ChannelWorkflow, ChannelWorkflowStep, RunArtifact, RunSession, WorkflowEvidenceResponse } from "../types.js";
import type { Translate } from "../i18n.js";
import type {
  ConversationWorkCellDetailsModel,
  ConversationWorkCellEvidenceLink,
  ConversationWorkCellGroup,
  ConversationWorkCellRow,
  ConversationWorkCellRowTone,
  ConversationWorkCellViewModel,
} from "./conversation-work-cell.js";
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
  readonly runIds: readonly string[];
  readonly anchorRunId: string;
  readonly mode: WorkflowProgressMode;
  readonly status: ChannelWorkflow["status"];
  readonly title: string;
  readonly summary: string;
  readonly currentRows: readonly ConversationWorkCellRow[];
  readonly stats: readonly WorkflowProgressStat[];
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly attention: WorkflowProgressAttention;
  readonly updatedAt: string;
}

export interface BuildWorkflowProgressInput {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly t: Translate;
  readonly artifactHref?: (artifact: RunArtifact) => string;
}

export function buildWorkflowProgressModel(input: BuildWorkflowProgressInput): WorkflowProgressModel {
  const orderedSteps = [...input.steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  const stepRunIds = orderedSteps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId));
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const workflowRuns = stepRunIds.map((runId) => runById.get(runId)).filter((run): run is RunSession => Boolean(run));
  const artifacts = stepRunIds.flatMap((runId) => input.artifactsByRun[runId] ?? []);
  const pendingApprovals = input.approvals.filter((approval) =>
    approval.status === "pending" && orderedSteps.some((step) => step.id === approval.workflowStepId || step.runId === approval.runId),
  );
  const completedSteps = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
  const blockedStep = orderedSteps.find((step) => step.status === "blocked");
  const waitingStep = orderedSteps.find((step) => step.status === "waiting_for_approval");
  const runningStep = orderedSteps.find((step) => step.status === "running" || step.status === "claimed");
  const queuedStep = orderedSteps.find((step) => step.status === "queued");
  const failedStep = orderedSteps.find((step) => step.status === "failed");
  const currentStep = blockedStep ?? waitingStep ?? runningStep ?? queuedStep ?? failedStep ?? orderedSteps[completedSteps] ?? orderedSteps.at(-1);
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
  const runIds = uniqueStrings(stepRunIds);
  const anchorRunId = latestRun(workflowRuns)?.id ?? `workflow:${input.workflow.id}`;
  const evidenceLinks = artifacts.slice(0, 5).map((artifact) => ({
    id: artifact.id,
    label: artifact.title || artifact.path || artifact.id,
    meta: [artifact.type, artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined].filter(Boolean).join(" · "),
    href: input.artifactHref?.(artifact),
  }));

  return {
    id: `workflow-progress:${input.workflow.id}`,
    workflowId: input.workflow.id,
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
    }),
    currentRows: buildCurrentRows({
      t: input.t,
      currentStep,
      blockedStep,
      waitingStep,
      runningStep,
      queuedStep,
      completedSteps,
      totalSteps: orderedSteps.length,
      artifactCount: artifacts.length,
      pendingApprovalCount: pendingApprovals.length,
    }),
    stats: [
      { id: "steps", label: input.t("Steps"), value: `${completedSteps}/${orderedSteps.length}` },
      { id: "evidence", label: input.t("Evidence"), value: String(artifacts.length) },
      { id: "approvals", label: input.t("Approvals"), value: String(pendingApprovals.length) },
    ],
    groups: buildWorkflowProgressGroups({ t: input.t, steps: orderedSteps, artifacts, pendingApprovals }),
    evidenceLinks,
    attention,
    updatedAt: input.workflow.updatedAt,
  };
}

export function workflowProgressToConversationWorkCell(model: WorkflowProgressModel): ConversationWorkCellViewModel {
  return {
    id: model.id,
    threadId: `workflow:${model.workflowId}`,
    anchorRunId: model.anchorRunId,
    runIds: model.runIds,
    mode: model.mode,
    status: model.status,
    title: model.title,
    summary: model.summary,
    stats: model.stats,
    activeRows: model.currentRows,
    groups: model.groups,
    evidenceLinks: model.evidenceLinks,
    updatedAt: model.updatedAt,
  };
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
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral",
  }));
  const checkedRows: ConversationWorkCellRow[] = input.evidence.steps.slice(0, 16).map(({ step, diagnostics }) => ({
    id: `step:${step.id}`,
    title: `${step.toParticipantLabel}: ${step.title}`,
    description: step.resultSummary ?? step.blocker ?? truncatePreview(step.prompt, 160),
    meta: diagnostics.length > 0 ? `${step.status} · ${diagnostics.length} diagnostics` : step.status,
    tone: workflowStepTone(step.status),
  }));
  const evidenceRows: ConversationWorkCellRow[] = [
    ...artifacts.slice(0, 10).map((artifact) => ({
      id: `artifact:${artifact.id}`,
      title: artifact.title || artifact.path || artifact.id,
      description: artifact.path,
      meta: artifact.type,
      tone: "neutral" as const,
    })),
    ...input.evidence.selectorDecisions.slice(0, 8).map((decision) => ({
      id: `selector:${decision.id}`,
      title: t("Speaker selection"),
      description: decision.reason,
      meta: decision.status,
      tone: decision.status === "accepted" ? "success" as const : "neutral" as const,
    })),
    ...input.evidence.handoffIntents.slice(0, 8).map((intent) => ({
      id: `handoff-intent:${intent.id}`,
      title: t("Handoff intent"),
      description: `${intent.fromParticipantLabel} -> ${intent.toParticipantLabel ?? intent.toParticipantId}: ${intent.reason}`,
      meta: intent.status,
      tone: intent.status === "failed" ? "failed" as const : intent.status === "accepted" || intent.status === "validated" ? "success" as const : "neutral" as const,
    })),
    ...input.evidence.memoryCandidates.slice(0, 8).map((candidate) => ({
      id: `memory-candidate:${candidate.memory.id}`,
      title: t("Memory candidate"),
      description: candidate.memory.title,
      meta: candidate.memory.reviewState,
      tone: "waiting" as const,
    })),
  ];
  const diagnosticRows: ConversationWorkCellRow[] = input.evidence.steps.flatMap(({ step, diagnostics }) =>
    diagnostics.slice(0, 4).map((diagnostic) => ({
      id: `diagnostic:${step.id}:${diagnostic.kind}:${diagnostic.message}`,
      title: step.title,
      description: diagnostic.message,
      meta: diagnostic.severity,
      tone: diagnostic.severity === "critical" ? "failed" as const : "waiting" as const,
    })),
  );
  const approvalRows: ConversationWorkCellRow[] = input.evidence.approvals
    .filter((approval) => approval.status === "pending")
    .slice(0, 8)
    .map((approval) => ({
      id: `approval:${approval.id}`,
      title: approval.title,
      description: approval.description,
      meta: t("Waiting for approval"),
      tone: "waiting" as const,
    }));
  const blockedRows: ConversationWorkCellRow[] = input.evidence.steps
    .filter(({ step }) => step.status === "blocked" || step.status === "failed")
    .slice(0, 8)
    .map(({ step }) => ({
      id: `attention-step:${step.id}`,
      title: step.title,
      description: step.blocker ?? step.resultSummary ?? t("Needs attention"),
      meta: step.status,
      tone: step.status === "failed" ? "failed" as const : "waiting" as const,
    }));
  const attentionRows = [...approvalRows, ...blockedRows, ...diagnosticRows].slice(0, 16);
  const evidenceLinks = artifacts.slice(0, 8).map((artifact) => ({
    id: artifact.id,
    label: artifact.title || artifact.path || artifact.id,
    meta: [artifact.type, artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined].filter(Boolean).join(" · "),
    href: input.artifactHref?.(artifact),
  }));

  return {
    groups: [
      {
        id: "changed",
        label: t("Changed"),
        summary: changedRows.length > 0 ? t("{count} changed items", { count: changedRows.length }) : t("No changed files recorded"),
        rows: changedRows,
      },
      {
        id: "checked",
        label: t("Checked work"),
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
    ],
    evidenceLinks,
  };
}

function buildWorkflowProgressSummary(input: {
  readonly t: Translate;
  readonly workflow: ChannelWorkflow;
  readonly currentStep?: ChannelWorkflowStep;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly artifactCount: number;
  readonly pendingApprovalCount: number;
}): string {
  if (input.workflow.status === "succeeded") {
    return input.t("Done: {steps} steps complete, {artifacts} artifacts captured.", {
      steps: input.completedSteps,
      artifacts: input.artifactCount,
    });
  }
  if (input.workflow.status === "failed" || input.workflow.status === "cancelled") {
    return input.t("Stopped at {step}: {status}.", {
      step: input.currentStep?.title ?? input.workflow.title,
      status: input.workflow.status,
    });
  }
  if (input.workflow.status === "blocked" || input.currentStep?.status === "blocked") {
    return input.t("Blocked: {reason}", { reason: input.currentStep?.blocker ?? input.t("waiting for user input") });
  }
  if (input.pendingApprovalCount > 0 || input.workflow.status === "waiting_for_approval" || input.currentStep?.status === "waiting_for_approval") {
    return input.t("{teammate} is waiting for approval.", { teammate: input.currentStep?.toParticipantLabel ?? input.t("Workflow") });
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

function buildCurrentRows(input: {
  readonly t: Translate;
  readonly currentStep?: ChannelWorkflowStep;
  readonly blockedStep?: ChannelWorkflowStep;
  readonly waitingStep?: ChannelWorkflowStep;
  readonly runningStep?: ChannelWorkflowStep;
  readonly queuedStep?: ChannelWorkflowStep;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly artifactCount: number;
  readonly pendingApprovalCount: number;
}): readonly ConversationWorkCellRow[] {
  const rows: ConversationWorkCellRow[] = [];
  const prioritized = input.blockedStep ?? input.waitingStep ?? input.runningStep ?? input.queuedStep ?? input.currentStep;
  if (prioritized) {
    rows.push({
      id: `step:${prioritized.id}`,
      title: workflowStepProgressTitle(prioritized, input.t),
      description: prioritized.blocker ?? prioritized.prompt,
      meta: prioritized.status,
      tone: workflowStepTone(prioritized.status),
    });
  }
  if (input.pendingApprovalCount > 0) {
    rows.push({
      id: "approvals",
      title: input.t("Waiting for approval"),
      description: input.t("{count} pending approvals", { count: input.pendingApprovalCount }),
      tone: "waiting",
    });
  }
  rows.push({
    id: "completed",
    title: input.t("Step progress"),
    description: input.t("{done} of {total} steps complete", { done: input.completedSteps, total: input.totalSteps }),
    tone: input.completedSteps === input.totalSteps && input.totalSteps > 0 ? "success" : "neutral",
  });
  if (input.artifactCount > 0) {
    rows.push({
      id: "artifacts",
      title: input.t("Evidence captured"),
      description: input.t("{count} artifacts", { count: input.artifactCount }),
      tone: "success",
    });
  }
  return rows;
}

function buildWorkflowProgressGroups(input: {
  readonly t: Translate;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifacts: readonly RunArtifact[];
  readonly pendingApprovals: readonly ApprovalRequest[];
}): readonly ConversationWorkCellGroup[] {
  const changedArtifacts = input.artifacts.filter((artifact) => artifact.type === "diff" || artifact.type === "file");
  const changedRows = uniqueBy(changedArtifacts, (artifact) => artifact.path || artifact.id).slice(0, 8).map((artifact) => ({
    id: `changed:${artifact.id}`,
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral" as const,
  }));
  const checkedRows = input.steps.slice(0, 12).map((step) => ({
    id: `step:${step.id}`,
    title: `${step.toParticipantLabel}: ${step.title}`,
    description: step.resultSummary ?? step.blocker ?? truncatePreview(step.prompt, 140),
    meta: step.status,
    tone: workflowStepTone(step.status),
  }));
  const evidenceRows: ConversationWorkCellRow[] = input.artifacts.slice(0, 10).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    title: artifact.title || artifact.path || artifact.id,
    description: artifact.path,
    meta: artifact.type,
    tone: "neutral" as const,
  }));
  for (const step of input.steps) {
    if (step.metadata?.contextArtifactId) {
      evidenceRows.push({
        id: `context-packet:${step.id}`,
        title: input.t("Context packet"),
        description: step.title,
        meta: step.metadata.contextArtifactId,
        tone: "neutral",
      });
    }
    if (step.metadata?.outputArtifactId) {
      evidenceRows.push({
        id: `output-packet:${step.id}`,
        title: input.t("Output packet"),
        description: step.title,
        meta: step.metadata.outputArtifactId,
        tone: "neutral",
      });
    }
  }
  const attentionRows: ConversationWorkCellRow[] = [
    ...input.pendingApprovals.slice(0, 5).map((approval) => ({
      id: `approval:${approval.id}`,
      title: approval.title,
      description: approval.description,
      meta: input.t("Waiting for approval"),
      tone: "waiting" as const,
    })),
    ...input.steps.filter((step) => step.status === "blocked" || step.status === "failed").slice(0, 5).map((step) => ({
      id: `attention-step:${step.id}`,
      title: step.title,
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
      label: input.t("Checked work"),
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

function latestRun(runs: readonly RunSession[]): RunSession | undefined {
  return [...runs].sort((left, right) => {
    const leftTime = left.endedAt ?? left.startedAt ?? left.updatedAt;
    const rightTime = right.endedAt ?? right.startedAt ?? right.updatedAt;
    return rightTime.localeCompare(leftTime);
  })[0];
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
