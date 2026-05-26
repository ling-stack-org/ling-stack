import type { ApprovalStatus } from "./approval-types.js";
import type { MediaJobStatus } from "./media-types.js";
import type { RunStatus } from "./run-types.js";
import type { TaskStatus } from "./workspace-types.js";

export type StateTransitionActor = "system" | "local-user" | "ai-teammate" | "runner" | "provider";

export type StateEntityType = "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step";

export interface TransitionInput<TStatus extends string, TEvent extends string> {
  readonly entityId: string;
  readonly currentStatus: TStatus;
  readonly expectedStatus?: TStatus;
  readonly event: TEvent;
  readonly actor: StateTransitionActor;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export type TransitionResult<TStatus extends string> =
  | {
      readonly ok: true;
      readonly from: TStatus;
      readonly to: TStatus;
      readonly duplicate?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_transition" | "stale_transition" | "terminal_state";
      readonly currentStatus: TStatus;
    };

export type TaskTransitionEvent =
  | "claim"
  | "start_run"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled"
  | "run_waiting_for_human"
  | "human_resolved"
  | "retry"
  | "accept"
  | "cancel";

export type RunTransitionEvent =
  | "runner_started"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  | "runner_succeeded"
  | "runner_failed"
  | "cancel";

export type ApprovalTransitionEvent = "approve" | "deny" | "expire" | "cancel_owner";

export type MediaJobTransitionEvent =
  | "cost_approval_required"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  | "adapter_started"
  | "adapter_succeeded"
  | "adapter_failed"
  | "cancel";

export type WorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowTransitionEvent =
  | "prepare"
  | "start"
  | "approval_requested"
  | "approval_approved"
  | "step_blocked"
  | "step_failed"
  | "all_steps_succeeded"
  | "cancel";

export type WorkflowStepTransitionEvent =
  | "claim"
  | "start"
  | "approval_requested"
  | "approval_approved"
  | "blocked"
  | "resume"
  | "succeed"
  | "fail"
  | "skip"
  | "cancel";

const taskTerminalStatuses = new Set<TaskStatus>(["done", "cancelled"]);
const runTerminalStatuses = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);
const approvalTerminalStatuses = new Set<ApprovalStatus>(["approved", "denied", "expired", "cancelled"]);
const mediaJobTerminalStatuses = new Set<MediaJobStatus>(["succeeded", "failed", "cancelled"]);
const workflowTerminalStatuses = new Set<WorkflowStatus>(["succeeded", "failed", "cancelled"]);
const workflowStepTerminalStatuses = new Set<WorkflowStepStatus>(["succeeded", "failed", "skipped", "cancelled"]);

const taskTransitions: Readonly<Record<TaskStatus, Partial<Record<TaskTransitionEvent, TaskStatus>>>> = {
  todo: { claim: "claimed", cancel: "cancelled" },
  claimed: { start_run: "running", cancel: "cancelled" },
  running: {
    run_succeeded: "done",
    run_failed: "failed",
    run_cancelled: "cancelled",
    run_waiting_for_human: "blocked",
    cancel: "cancelled",
  },
  blocked: { human_resolved: "claimed", cancel: "cancelled" },
  review: { accept: "done", cancel: "cancelled" },
  failed: { retry: "claimed", cancel: "cancelled" },
  done: {},
  cancelled: {},
};

const runTransitions: Readonly<Record<RunStatus, Partial<Record<RunTransitionEvent, RunStatus>>>> = {
  queued: { runner_started: "running", cancel: "cancelled" },
  running: {
    approval_requested: "waiting_for_approval",
    runner_succeeded: "succeeded",
    runner_failed: "failed",
    cancel: "cancelled",
  },
  waiting_for_approval: {
    approval_approved: "running",
    approval_denied: "failed",
    approval_expired: "failed",
    cancel: "cancelled",
  },
  succeeded: {},
  failed: {},
  cancelled: {},
};

const approvalTransitions: Readonly<Record<ApprovalStatus, Partial<Record<ApprovalTransitionEvent, ApprovalStatus>>>> = {
  pending: {
    approve: "approved",
    deny: "denied",
    expire: "expired",
    cancel_owner: "cancelled",
  },
  approved: {},
  denied: {},
  expired: {},
  cancelled: {},
};

const mediaJobTransitions: Readonly<Record<MediaJobStatus, Partial<Record<MediaJobTransitionEvent, MediaJobStatus>>>> = {
  queued: { cost_approval_required: "waiting_for_approval", adapter_started: "running", cancel: "cancelled" },
  waiting_for_approval: {
    approval_approved: "queued",
    approval_denied: "failed",
    approval_expired: "failed",
    cancel: "cancelled",
  },
  running: { adapter_succeeded: "succeeded", adapter_failed: "failed", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  cancelled: {},
};

const workflowTransitions: Readonly<Record<WorkflowStatus, Partial<Record<WorkflowTransitionEvent, WorkflowStatus>>>> = {
  draft: { prepare: "ready", cancel: "cancelled" },
  ready: { start: "running", cancel: "cancelled" },
  running: {
    approval_requested: "waiting_for_approval",
    step_blocked: "blocked",
    step_failed: "failed",
    all_steps_succeeded: "succeeded",
    cancel: "cancelled",
  },
  waiting_for_approval: { approval_approved: "running", cancel: "cancelled" },
  blocked: { start: "running", step_failed: "failed", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  cancelled: {},
};

const workflowStepTransitions: Readonly<Record<WorkflowStepStatus, Partial<Record<WorkflowStepTransitionEvent, WorkflowStepStatus>>>> = {
  queued: { claim: "claimed", skip: "skipped", cancel: "cancelled" },
  claimed: { start: "running", cancel: "cancelled" },
  running: {
    approval_requested: "waiting_for_approval",
    blocked: "blocked",
    succeed: "succeeded",
    fail: "failed",
    cancel: "cancelled",
  },
  waiting_for_approval: { approval_approved: "running", fail: "failed", cancel: "cancelled" },
  blocked: { resume: "claimed", fail: "failed", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  skipped: {},
  cancelled: {},
};

export function transitionTask(input: TransitionInput<TaskStatus, TaskTransitionEvent>): TransitionResult<TaskStatus> {
  return transitionState(input, taskTransitions, taskTerminalStatuses);
}

export function transitionRun(input: TransitionInput<RunStatus, RunTransitionEvent>): TransitionResult<RunStatus> {
  return transitionState(input, runTransitions, runTerminalStatuses);
}

export function transitionApproval(input: TransitionInput<ApprovalStatus, ApprovalTransitionEvent>): TransitionResult<ApprovalStatus> {
  return transitionState(input, approvalTransitions, approvalTerminalStatuses);
}

export function transitionMediaJob(input: TransitionInput<MediaJobStatus, MediaJobTransitionEvent>): TransitionResult<MediaJobStatus> {
  return transitionState(input, mediaJobTransitions, mediaJobTerminalStatuses);
}

export function transitionWorkflow(input: TransitionInput<WorkflowStatus, WorkflowTransitionEvent>): TransitionResult<WorkflowStatus> {
  return transitionState(input, workflowTransitions, workflowTerminalStatuses);
}

export function transitionWorkflowStep(
  input: TransitionInput<WorkflowStepStatus, WorkflowStepTransitionEvent>,
): TransitionResult<WorkflowStepStatus> {
  return transitionState(input, workflowStepTransitions, workflowStepTerminalStatuses);
}

function transitionState<TStatus extends string, TEvent extends string>(
  input: TransitionInput<TStatus, TEvent>,
  transitions: Readonly<Record<TStatus, Partial<Record<TEvent, TStatus>>>>,
  terminalStatuses: ReadonlySet<TStatus>,
): TransitionResult<TStatus> {
  if (input.expectedStatus !== undefined && input.expectedStatus !== input.currentStatus) {
    return { ok: false, code: "stale_transition", currentStatus: input.currentStatus };
  }

  const nextStatus = transitions[input.currentStatus]?.[input.event];
  if (!nextStatus) {
    return {
      ok: false,
      code: terminalStatuses.has(input.currentStatus) ? "terminal_state" : "invalid_transition",
      currentStatus: input.currentStatus,
    };
  }

  return { ok: true, from: input.currentStatus, to: nextStatus };
}
