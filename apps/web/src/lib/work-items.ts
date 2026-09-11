import { effectiveApprovalStatus } from "./approvals.js";
import { readTaskTitle } from "./run-evidence.js";
import type {
  ApprovalRequest,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunArtifact,
  RunSession,
  Task,
  WorkItemClaim,
  WorkItemView as DurableWorkItemView,
} from "../types.js";

const defaultWorkspaceId = "workspace_default";

export type WorkItemStatus =
  | "intake"
  | "triage"
  | "backlog"
  | "ready"
  | "running"
  | "waiting"
  | "review"
  | "blocked"
  | "done"
  | "archived";

export type WorkItemSourceType =
  | "channel_task"
  | "channel_workflow_step"
  | "external_work"
  | "external_work_action"
  | "approval"
  | "run"
  | "manual";

export type WorkItemWaitingReason = "approval" | "external" | "handoff" | "resource" | "user" | "scheduler" | "provider";

export type WorkItemActionGroup = "needs_action" | "in_progress" | "ready" | "recent_done" | "archived";

export interface WorkItemView {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly sourceType: WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: WorkItemStatus;
  readonly waitingReason?: WorkItemWaitingReason;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly labels: readonly string[];
  readonly assigneeTeammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly externalWorkActionId?: string;
  readonly approvalId?: string;
  readonly artifactIds: readonly string[];
  readonly proofArtifactIds: readonly string[];
  readonly claim?: WorkItemClaim;
  readonly attemptCount?: number;
  readonly retryBudget?: number;
  readonly durable?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BuildWorkItemViewsInput {
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps?: readonly ChannelWorkflowStep[];
  readonly externalActions?: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage?: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly durableWorkItems?: readonly DurableWorkItemView[];
}

export const workItemStatusOrder: readonly WorkItemStatus[] = [
  "intake",
  "triage",
  "backlog",
  "ready",
  "running",
  "waiting",
  "review",
  "blocked",
  "done",
  "archived",
];

export const workItemActionGroupOrder: readonly WorkItemActionGroup[] = [
  "needs_action",
  "in_progress",
  "ready",
  "recent_done",
  "archived",
];

export function buildWorkItemViews(input: BuildWorkItemViewsInput): WorkItemView[] {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const workflowStepByTaskId = new Map((input.workflowSteps ?? []).filter((step) => step.taskId).map((step) => [step.taskId as string, step]));
  const approvalByOwnerId = new Map<string, ApprovalRequest[]>();
  for (const approval of input.approvals) {
    for (const ownerId of [approval.taskId, approval.runId, approval.workflowStepId, approval.externalWorkActionId].filter(Boolean) as string[]) {
      const existing = approvalByOwnerId.get(ownerId) ?? [];
      existing.push(approval);
      approvalByOwnerId.set(ownerId, existing);
    }
  }

  const items: WorkItemView[] = input.tasks.map((task) => {
    const run = task.currentRunId ? runById.get(task.currentRunId) : undefined;
    const workflowStep = workflowStepByTaskId.get(task.id);
    const approvals = [
      ...(approvalByOwnerId.get(task.id) ?? []),
      ...(run?.id ? approvalByOwnerId.get(run.id) ?? [] : []),
      ...(workflowStep?.id ? approvalByOwnerId.get(workflowStep.id) ?? [] : []),
    ];
    const pendingApproval = approvals.find((approval) => effectiveApprovalStatus(approval) === "pending");
    return {
      id: `task:${task.id}`,
      workspaceId: task.workspaceId,
      channelId: task.channelId,
      sourceType: "channel_task",
      sourceId: task.id,
      title: task.title,
      subtitle: task.prompt,
      status: pendingApproval ? "waiting" : statusFromTaskAndRun(task.status, run?.status),
      waitingReason: pendingApproval ? "approval" : undefined,
      priority: "normal",
      labels: workflowStep ? ["workflow"] : [],
      assigneeTeammateId: task.assigneeTeammateId,
      taskId: task.id,
      runId: run?.id,
      workflowId: workflowStep?.workflowId,
      workflowStepId: workflowStep?.id,
      approvalId: pendingApproval?.id,
      artifactIds: run?.id ? (input.artifactsByRun?.[run.id] ?? []).map((artifact) => artifact.id) : [],
      proofArtifactIds: [],
      createdAt: task.createdAt,
      updatedAt: maxDate([task.updatedAt, run?.updatedAt, pendingApproval?.createdAt]),
    } satisfies WorkItemView;
  });

  for (const run of input.runs) {
    if (run.taskId && taskById.has(run.taskId)) {
      continue;
    }
    const pendingApproval = (approvalByOwnerId.get(run.id) ?? []).find((approval) => effectiveApprovalStatus(approval) === "pending");
    items.push({
      id: `run:${run.id}`,
      workspaceId: defaultWorkspaceId,
      channelId: run.channelId,
      sourceType: "run",
      sourceId: run.id,
      title: readTaskTitle(run.taskSnapshot) || run.taskId || run.id,
      subtitle: run.errorMessage,
      status: pendingApproval ? "waiting" : statusFromRun(run.status),
      waitingReason: pendingApproval ? "approval" : undefined,
      priority: "normal",
      labels: ["run"],
      taskId: run.taskId || undefined,
      runId: run.id,
      approvalId: pendingApproval?.id,
      artifactIds: (input.artifactsByRun?.[run.id] ?? []).map((artifact) => artifact.id),
      proofArtifactIds: [],
      createdAt: run.createdAt,
      updatedAt: maxDate([run.updatedAt, pendingApproval?.createdAt]),
    });
  }

  for (const step of input.workflowSteps ?? []) {
    if (step.taskId && taskById.has(step.taskId)) {
      continue;
    }
    const pendingApproval = (approvalByOwnerId.get(step.id) ?? []).find((approval) => effectiveApprovalStatus(approval) === "pending");
    items.push({
      id: `workflow-step:${step.id}`,
      workspaceId: step.workspaceId,
      channelId: step.channelId,
      sourceType: "channel_workflow_step",
      sourceId: step.id,
      title: step.title,
      subtitle: step.blocker || step.prompt,
      status: pendingApproval ? "waiting" : statusFromWorkflowStep(step.status),
      waitingReason: pendingApproval ? "approval" : step.status === "blocked" ? "user" : undefined,
      priority: "normal",
      labels: ["workflow"],
      taskId: step.taskId,
      runId: step.runId,
      workflowId: step.workflowId,
      workflowStepId: step.id,
      approvalId: pendingApproval?.id,
      artifactIds: [],
      proofArtifactIds: [],
      createdAt: step.createdAt,
      updatedAt: maxDate([step.updatedAt, pendingApproval?.createdAt]),
    });
  }

  for (const actionView of Object.values(input.externalActions ?? {})) {
    const approval = actionView.approval ?? (actionView.action.approvalId ? input.approvals.find((item) => item.id === actionView.action.approvalId) : undefined);
    items.push({
      id: `external-action:${actionView.action.id}`,
      workspaceId: actionView.action.workspaceId,
      channelId: actionView.action.channelId,
      sourceType: "external_work_action",
      sourceId: actionView.action.id,
      title: externalActionTitle(actionView),
      subtitle: actionView.action.target.url ?? actionView.action.target.repository,
      status: statusFromExternalAction(actionView.action.status),
      waitingReason: actionView.action.status === "waiting_for_approval" ? "approval" : actionView.action.status === "approved" ? "external" : undefined,
      priority: approvalPriority(approval),
      labels: [actionView.action.sourceKind, actionView.action.actionKind],
      externalWorkId: actionView.action.externalWorkId,
      externalWorkActionId: actionView.action.id,
      approvalId: approval?.id,
      artifactIds: actionView.artifacts.map((artifact) => artifact.id),
      proofArtifactIds: [],
      createdAt: actionView.action.createdAt,
      updatedAt: maxDate([actionView.action.updatedAt, approval?.createdAt]),
    });
  }

  for (const triage of input.externalWorkCiTriage ?? []) {
    items.push({
      id: `external-ci:${triage.triage.id}`,
      workspaceId: triage.triage.workspaceId,
      channelId: triage.triage.channelId,
      sourceType: "external_work",
      sourceId: triage.triage.externalWorkId,
      title: `${triage.triage.repository} #${triage.triage.subjectNumber}`,
      subtitle: triage.triage.checkName,
      status: statusFromCiTriage(triage.triage.status),
      waitingReason: triage.triage.status === "blocked" ? "user" : undefined,
      priority: "normal",
      labels: ["ci", triage.triage.conclusion],
      taskId: triage.triage.taskId,
      runId: triage.triage.runId,
      externalWorkId: triage.triage.externalWorkId,
      artifactIds: triage.artifacts.map((artifact) => artifact.id),
      proofArtifactIds: triage.artifacts.map((artifact) => artifact.id),
      createdAt: triage.triage.createdAt,
      updatedAt: triage.triage.updatedAt,
    });
  }

  for (const approval of input.approvals) {
    if (approval.taskId || approval.runId || approval.workflowStepId || approval.externalWorkActionId || effectiveApprovalStatus(approval) !== "pending") {
      continue;
    }
    items.push({
      id: `approval:${approval.id}`,
      workspaceId: defaultWorkspaceId,
      channelId: approval.channelId,
      sourceType: "approval",
      sourceId: approval.id,
      title: approval.title,
      subtitle: approval.description,
      status: "waiting",
      waitingReason: "approval",
      priority: approvalPriority(approval),
      labels: [approval.actionType],
      approvalId: approval.id,
      artifactIds: [],
      proofArtifactIds: [],
      createdAt: approval.createdAt,
      updatedAt: approval.resolvedAt ?? approval.createdAt,
    });
  }

  return mergeDurableWorkItems(input.durableWorkItems ?? [], dedupeWorkItems(items))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function filterWorkItemsByChannel(items: readonly WorkItemView[], channelId: string): WorkItemView[] {
  return items.filter((item) => item.channelId === channelId);
}

export function workItemStatusLabel(status: WorkItemStatus): string {
  return status.replaceAll("_", " ");
}

export function isTerminalWorkItemView(item: WorkItemView): boolean {
  return item.status === "done" || item.status === "archived";
}

export function isActionableWorkItem(item: WorkItemView): boolean {
  if (isTerminalWorkItemView(item)) {
    return false;
  }
  return item.status === "waiting" ||
    item.status === "blocked" ||
    item.status === "review" ||
    Boolean(item.approvalId) ||
    Boolean(item.claim) ||
    Boolean(item.durable && !item.claim) ||
    Boolean(!item.channelId && !item.assigneeTeammateId && !item.claim);
}

export function workItemActionGroup(item: WorkItemView): WorkItemActionGroup {
  if (item.status === "archived") {
    return "archived";
  }
  if (item.status === "done") {
    return "recent_done";
  }
  if (item.status === "running") {
    return "in_progress";
  }
  if (isActionableWorkItem(item)) {
    return "needs_action";
  }
  return "ready";
}

export function workItemActionGroupLabel(group: WorkItemActionGroup): string {
  switch (group) {
    case "needs_action":
      return "Needs action";
    case "in_progress":
      return "In progress";
    case "ready":
      return "Ready or queued";
    case "recent_done":
      return "Recently completed";
    case "archived":
      return "Archived";
  }
}

export function workItemNextActionLabel(item: WorkItemView): string {
  if (item.approvalId || item.waitingReason === "approval") {
    return "Handle approval";
  }
  if (item.status === "blocked") {
    return item.runId ? "View failure" : "Review blocker";
  }
  if (item.durable && !item.claim && !isTerminalWorkItemView(item)) {
    return "Claim to handle";
  }
  if (item.claim) {
    return "Work is claimed";
  }
  if (item.status === "running") {
    return "Open running work";
  }
  if (item.status === "review") {
    return "Review result";
  }
  if (item.status === "ready") {
    return "Open ready work";
  }
  if (item.status === "done") {
    return "Work completed";
  }
  if (item.status === "archived") {
    return "Archived work";
  }
  return "Review work item";
}

function statusFromTaskAndRun(taskStatus: Task["status"], runStatus: RunSession["status"] | undefined): WorkItemStatus {
  if (taskStatus === "waiting_for_input") return "waiting";
  if (runStatus) {
    return statusFromRun(runStatus);
  }
  switch (taskStatus) {
    case "todo":
      return "backlog";
    case "claimed":
      return "ready";
    case "running":
      return "running";
    case "blocked":
    case "failed":
      return "blocked";
    case "review":
      return "review";
    case "done":
      return "done";
    case "cancelled":
      return "archived";
  }
}

function statusFromRun(status: RunSession["status"]): WorkItemStatus {
  switch (status) {
    case "yielded":
      return "waiting";
    case "queued":
      return "ready";
    case "running":
      return "running";
    case "waiting_for_approval":
      return "waiting";
    case "succeeded":
      return "done";
    case "failed":
      return "blocked";
    case "cancelled":
      return "archived";
  }
}

function statusFromWorkflowStep(status: ChannelWorkflowStep["status"]): WorkItemStatus {
  switch (status) {
    case "waiting_for_input":
      return "waiting";
    case "queued":
      return "ready";
    case "claimed":
    case "running":
      return "running";
    case "waiting_for_approval":
      return "waiting";
    case "blocked":
    case "failed":
      return "blocked";
    case "succeeded":
      return "done";
    case "skipped":
    case "cancelled":
      return "archived";
  }
}

function statusFromExternalAction(status: string): WorkItemStatus {
  if (status === "waiting_for_approval" || status === "approved") {
    return "waiting";
  }
  if (status === "executing") {
    return "running";
  }
  if (status === "succeeded") {
    return "done";
  }
  if (status === "failed" || status === "stale_target" || status === "denied" || status === "expired") {
    return "blocked";
  }
  if (status === "cancelled") {
    return "archived";
  }
  return "review";
}

function statusFromCiTriage(status: string): WorkItemStatus {
  if (status === "triaged") {
    return "triage";
  }
  if (status === "task_created" || status === "run_requested") {
    return "running";
  }
  if (status === "blocked" || status === "failed" || status === "stale") {
    return "blocked";
  }
  return "review";
}

function approvalPriority(approval: ApprovalRequest | undefined): WorkItemView["priority"] {
  if (!approval) {
    return "normal";
  }
  if (approval.risk === "critical") {
    return "urgent";
  }
  if (approval.risk === "high") {
    return "high";
  }
  if (approval.risk === "low") {
    return "low";
  }
  return "normal";
}

function externalActionTitle(actionView: ExternalWorkActionView): string {
  const subject = `${actionView.action.target.subjectKind} #${actionView.action.target.number}`;
  return `${actionView.action.actionKind} · ${subject}`;
}

function maxDate(values: readonly (string | undefined)[]): string {
  return values.filter(Boolean).sort().at(-1) ?? new Date(0).toISOString();
}

function dedupeWorkItems(items: readonly WorkItemView[]): WorkItemView[] {
  const byId = new Map<string, WorkItemView>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function mergeDurableWorkItems(
  durableItems: readonly DurableWorkItemView[],
  derivedItems: readonly WorkItemView[],
): WorkItemView[] {
  if (durableItems.length === 0) {
    return [...derivedItems];
  }
  const durableBySource = new Map<string, WorkItemView>();
  const merged: WorkItemView[] = [];
  for (const item of durableItems) {
    const view = durableToWorkItemView(item);
    durableBySource.set(sourceKey(view), view);
    merged.push(view);
  }
  for (const item of derivedItems) {
    if (!durableBySource.has(sourceKey(item))) {
      merged.push(item);
    }
  }
  return dedupeWorkItems(merged);
}

function durableToWorkItemView(item: DurableWorkItemView): WorkItemView {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    channelId: item.channelId,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    title: item.title,
    subtitle: item.description,
    status: item.status,
    waitingReason: item.waitingReason,
    priority: item.priority,
    labels: item.labels,
    assigneeTeammateId: item.assigneeTeammateId,
    taskId: item.taskId,
    runId: item.runId,
    workflowId: item.workflowId,
    workflowStepId: item.workflowStepId,
    externalWorkId: item.externalWorkId,
    externalWorkActionId: item.externalWorkActionId,
    approvalId: item.approvalId,
    artifactIds: item.artifactIds,
    proofArtifactIds: item.proofArtifactIds,
    claim: item.claim,
    attemptCount: item.attemptCount,
    retryBudget: item.retryBudget,
    durable: true,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function sourceKey(item: Pick<WorkItemView, "sourceType" | "sourceId">): string {
  return `${item.sourceType}:${item.sourceId}`;
}
