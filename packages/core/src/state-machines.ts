import type { ApprovalStatus } from "./approval-types.js";
import type { MediaJobStatus } from "./media-types.js";
import type { LingTurnStatus, RunStatus } from "./run-types.js";
import type { WorkUnitStatus } from "./runtime-supervisor-types.js";
import type { TaskStatus } from "./workspace-types.js";

export type StateTransitionActor = "system" | "local-user" | "ai-teammate" | "runner" | "provider";

export type StateEntityType = "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step" | "work_unit" | "turn";

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
  | "user_input_requested"
  | "user_input_answered"
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
  | "runner_yielded"
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
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowTransitionEvent =
  | "prepare"
  | "user_input_requested"
  | "user_input_answered"
  | "start"
  | "approval_requested"
  | "approval_approved"
  | "step_blocked"
  | "step_failed"
  | "all_steps_succeeded"
  | "cancel";

export type WorkflowStepTransitionEvent =
  | "claim"
  | "user_input_requested"
  | "user_input_answered"
  | "start"
  | "approval_requested"
  | "approval_approved"
  | "blocked"
  | "resume"
  | "succeed"
  | "fail"
  | "skip"
  | "cancel";

export type WorkUnitTransitionEvent =
  | "user_input_cancelled"
  | "claim"
  | "user_input_requested"
  | "user_input_answered"
  | "runner_started"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  | "runner_succeeded"
  | "runner_failed"
  | "idle_timeout"
  | "hard_timeout"
  | "execution_loop_detected"
  | "runner_lost"
  | "runner_cancelled"
  | "cancel_timeout"
  | "reconcile_failed"
  | "reconcile_cancelled"
  | "retry"
  | "cancel";

export type LingTurnTransitionEvent =
  | "start"
  | "user_input_requested"
  | "user_input_answered"
  | "approval_requested"
  | "approval_approved"
  | "block"
  | "succeed"
  | "fail"
  | "cancel";

const taskTerminalStatuses = new Set<TaskStatus>(["done", "cancelled"]);
// State-machine immutability is physical closure, not business completion.
const runTerminalStatuses = new Set<RunStatus>(["yielded", "succeeded", "failed", "cancelled"]);
const approvalTerminalStatuses = new Set<ApprovalStatus>(["approved", "denied", "expired", "cancelled"]);
const mediaJobTerminalStatuses = new Set<MediaJobStatus>(["succeeded", "failed", "cancelled"]);
const workflowTerminalStatuses = new Set<WorkflowStatus>(["succeeded", "failed", "cancelled"]);
const workflowStepTerminalStatuses = new Set<WorkflowStepStatus>(["succeeded", "failed", "skipped", "cancelled"]);
const workUnitTerminalStatuses = new Set<WorkUnitStatus>(["succeeded", "failed", "cancelled"]);
const lingTurnTerminalStatuses = new Set<LingTurnStatus>(["succeeded", "failed", "cancelled", "superseded"]);

const taskTransitions: Readonly<Record<TaskStatus, Partial<Record<TaskTransitionEvent, TaskStatus>>>> = {
  todo: { claim: "claimed", cancel: "cancelled" },
  claimed: { start_run: "running", cancel: "cancelled" },
  running: {
    run_succeeded: "done",
    user_input_requested: "waiting_for_input",
    run_failed: "failed",
    run_cancelled: "cancelled",
    run_waiting_for_human: "blocked",
    cancel: "cancelled",
  },
  blocked: { human_resolved: "claimed", cancel: "cancelled" },
  waiting_for_input: { user_input_answered: "claimed", cancel: "cancelled" },
  review: { accept: "done", cancel: "cancelled" },
  failed: { retry: "claimed", cancel: "cancelled" },
  done: {},
  cancelled: {},
};

const runTransitions: Readonly<Record<RunStatus, Partial<Record<RunTransitionEvent, RunStatus>>>> = {
  queued: { runner_started: "running", cancel: "cancelled" },
  running: {
    runner_yielded: "yielded",
    approval_requested: "waiting_for_approval",
    runner_succeeded: "succeeded",
    runner_failed: "failed",
    cancel: "cancelled",
  },
  waiting_for_approval: {
    approval_approved: "running",
    approval_denied: "failed",
    approval_expired: "failed",
    runner_failed: "failed",
    cancel: "cancelled",
  },
  yielded: {},
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
    user_input_requested: "waiting_for_input",
    approval_requested: "waiting_for_approval",
    step_blocked: "blocked",
    step_failed: "failed",
    all_steps_succeeded: "succeeded",
    cancel: "cancelled",
  },
  waiting_for_approval: { approval_approved: "running", step_blocked: "blocked", step_failed: "failed", cancel: "cancelled" },
  blocked: { start: "running", step_failed: "failed", cancel: "cancelled" },
  waiting_for_input: { user_input_answered: "running", step_blocked: "blocked", step_failed: "failed", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  cancelled: {},
};

const workflowStepTransitions: Readonly<Record<WorkflowStepStatus, Partial<Record<WorkflowStepTransitionEvent, WorkflowStepStatus>>>> = {
  queued: { claim: "claimed", skip: "skipped", cancel: "cancelled" },
  claimed: { start: "running", cancel: "cancelled" },
  running: {
    user_input_requested: "waiting_for_input",
    approval_requested: "waiting_for_approval",
    blocked: "blocked",
    succeed: "succeeded",
    fail: "failed",
    skip: "skipped",
    cancel: "cancelled",
  },
  waiting_for_approval: { approval_approved: "running", blocked: "blocked", fail: "failed", skip: "skipped", cancel: "cancelled" },
  blocked: { resume: "claimed", fail: "failed", cancel: "cancelled" },
  waiting_for_input: { user_input_answered: "claimed", blocked: "blocked", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  skipped: {},
  cancelled: {},
};

const workUnitTransitions: Readonly<Record<WorkUnitStatus, Partial<Record<WorkUnitTransitionEvent, WorkUnitStatus>>>> = {
  queued: { claim: "claimed", runner_failed: "failed", cancel: "cancelling" },
  claimed: {
    runner_started: "running",
    runner_failed: "failed",
    idle_timeout: "cancelling",
    hard_timeout: "cancelling",
    execution_loop_detected: "cancelling",
    runner_lost: "stale",
    cancel: "cancelling",
  },
  running: {
    user_input_requested: "waiting_for_input",
    approval_requested: "waiting_for_approval",
    runner_succeeded: "succeeded",
    runner_failed: "failed",
    idle_timeout: "cancelling",
    hard_timeout: "cancelling",
    execution_loop_detected: "cancelling",
    runner_lost: "stale",
    cancel: "cancelling",
  },
  waiting_for_approval: {
    approval_approved: "running",
    approval_denied: "failed",
    approval_expired: "failed",
    runner_succeeded: "succeeded",
    runner_failed: "failed",
    idle_timeout: "cancelling",
    hard_timeout: "cancelling",
    execution_loop_detected: "cancelling",
    cancel: "cancelling",
  },
  cancelling: {
    runner_cancelled: "cancelled",
    runner_failed: "failed",
    cancel_timeout: "stale",
    runner_lost: "stale",
  },
  stale: {
    reconcile_failed: "failed",
    reconcile_cancelled: "cancelled",
    retry: "queued",
  },
  failed: { retry: "queued" },
  waiting_for_input: { user_input_answered: "claimed", user_input_cancelled: "cancelled", cancel: "cancelling" },
  succeeded: {},
  cancelled: { retry: "queued" },
};

const lingTurnTransitions: Readonly<Record<LingTurnStatus, Partial<Record<LingTurnTransitionEvent, LingTurnStatus>>>> = {
  open: { start: "running", approval_requested: "waiting_for_approval", block: "blocked", succeed: "succeeded", fail: "failed", cancel: "cancelled" },
  running: { user_input_requested: "waiting_for_input", approval_requested: "waiting_for_approval", block: "blocked", succeed: "succeeded", fail: "failed", cancel: "cancelled" },
  waiting_for_input: { user_input_answered: "running", block: "blocked", cancel: "cancelled" },
  waiting_for_approval: { approval_approved: "running", block: "blocked", succeed: "succeeded", fail: "failed", cancel: "cancelled" },
  blocked: { start: "running", fail: "failed", cancel: "cancelled" },
  succeeded: {},
  failed: {},
  cancelled: {},
  superseded: {},
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

export function transitionWorkUnit(input: TransitionInput<WorkUnitStatus, WorkUnitTransitionEvent>): TransitionResult<WorkUnitStatus> {
  return transitionState(input, workUnitTransitions, workUnitTerminalStatuses);
}

export function transitionLingTurn(
  input: TransitionInput<LingTurnStatus, LingTurnTransitionEvent>,
): TransitionResult<LingTurnStatus> {
  return transitionState(input, lingTurnTransitions, lingTurnTerminalStatuses);
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
