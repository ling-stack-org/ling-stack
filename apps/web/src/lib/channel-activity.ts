import type {
  ApprovalRequest,
  ChannelContextSummary,
  ChannelDecision,
  ChannelHandoff,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunSession,
  StateTransitionEvent,
  Task,
} from "../types.js";
import { deriveChannelRuns, deriveChannelTasks } from "./channel-artifacts.js";

export type ChannelActivityItem =
  | { readonly id: string; readonly kind: "message"; readonly createdAt: string; readonly record: ChannelMessage }
  | { readonly id: string; readonly kind: "decision"; readonly createdAt: string; readonly record: ChannelDecision }
  | { readonly id: string; readonly kind: "handoff"; readonly createdAt: string; readonly record: ChannelHandoff }
  | { readonly id: string; readonly kind: "summary"; readonly createdAt: string; readonly record: ChannelContextSummary }
  | { readonly id: string; readonly kind: "workflow"; readonly createdAt: string; readonly record: ChannelWorkflow }
  | { readonly id: string; readonly kind: "workflow-step"; readonly createdAt: string; readonly record: ChannelWorkflowStep }
  | { readonly id: string; readonly kind: "task"; readonly createdAt: string; readonly record: Task }
  | { readonly id: string; readonly kind: "run"; readonly createdAt: string; readonly record: RunSession; readonly task?: Task }
  | { readonly id: string; readonly kind: "approval"; readonly createdAt: string; readonly record: ApprovalRequest; readonly task?: Task; readonly run?: RunSession }
  | { readonly id: string; readonly kind: "state-transition"; readonly createdAt: string; readonly record: StateTransitionEvent; readonly task?: Task; readonly run?: RunSession };

export function buildChannelActivityItems(input: {
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly decisions: readonly ChannelDecision[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly summaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly extraRun?: RunSession;
}): readonly ChannelActivityItem[] {
  const channelTasks = deriveChannelTasks(input.channelId, input.tasks);
  const channelRuns = deriveChannelRuns(input.channelId, input.tasks, input.runs, input.extraRun);
  const taskById = new Map(channelTasks.map((task) => [task.id, task]));
  const runById = new Map(channelRuns.map((run) => [run.id, run]));
  const workflowIds = new Set(input.workflows.filter((workflow) => workflow.channelId === input.channelId).map((workflow) => workflow.id));
  const workflowStepIds = new Set(input.workflowSteps.filter((step) => step.channelId === input.channelId).map((step) => step.id));

  const approvalItems = input.approvals
    .filter((approval) => {
      if (approval.channelId === input.channelId) {
        return true;
      }
      return Boolean((approval.taskId && taskById.has(approval.taskId)) || (approval.runId && runById.has(approval.runId)));
    })
    .map((record) => ({
      id: `approval:${record.id}`,
      kind: "approval" as const,
      createdAt: record.resolvedAt ?? record.createdAt,
      record,
      task: record.taskId ? taskById.get(record.taskId) : undefined,
      run: record.runId ? runById.get(record.runId) : undefined,
    }));

  const transitionItems = input.stateTransitions
    .filter((transition) => {
      if (transition.entityType === "task") {
        return taskById.has(transition.entityId);
      }
      if (transition.entityType === "run") {
        return runById.has(transition.entityId);
      }
      if (transition.entityType === "workflow") {
        return workflowIds.has(transition.entityId);
      }
      if (transition.entityType === "workflow_step") {
        return workflowStepIds.has(transition.entityId);
      }
      if (transition.entityType === "approval") {
        return approvalItems.some((item) => item.record.id === transition.entityId);
      }
      return false;
    })
    .map((record) => ({
      id: `transition:${record.id}`,
      kind: "state-transition" as const,
      createdAt: record.createdAt,
      record,
      task: record.entityType === "task" ? taskById.get(record.entityId) : undefined,
      run: record.entityType === "run" ? runById.get(record.entityId) : undefined,
    }));

  return [
    ...input.messages
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `message:${record.id}`, kind: "message" as const, createdAt: record.createdAt, record })),
    ...input.decisions
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `decision:${record.id}`, kind: "decision" as const, createdAt: record.createdAt, record })),
    ...input.handoffs
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `handoff:${record.id}`, kind: "handoff" as const, createdAt: record.createdAt, record })),
    ...input.summaries
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `summary:${record.id}`, kind: "summary" as const, createdAt: record.updatedAt, record })),
    ...input.workflows
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `workflow:${record.id}`, kind: "workflow" as const, createdAt: record.updatedAt, record })),
    ...input.workflowSteps
      .filter((record) => record.channelId === input.channelId)
      .map((record) => ({ id: `workflow-step:${record.id}`, kind: "workflow-step" as const, createdAt: record.updatedAt, record })),
    ...channelTasks.map((record) => ({ id: `task:${record.id}`, kind: "task" as const, createdAt: record.updatedAt, record })),
    ...channelRuns.map((record) => ({
      id: `run:${record.id}`,
      kind: "run" as const,
      createdAt: record.endedAt ?? record.startedAt ?? record.updatedAt,
      record,
      task: taskById.get(record.taskId),
    })),
    ...approvalItems,
    ...transitionItems,
  ].sort((left, right) => {
    const timeComparison = left.createdAt.localeCompare(right.createdAt);
    return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
  });
}
