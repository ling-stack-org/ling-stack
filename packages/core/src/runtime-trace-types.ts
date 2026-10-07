import type { ApprovalRequest } from "./approval-types.js";
import type { ExecutionAction, RunArtifact, RunEventEnvelope, RunIntervention, RunSession } from "./run-types.js";
import type { RuntimeEvent } from "./runtime-supervisor-types.js";
import type { StateTransitionEvent } from "./channel-runtime-types.js";

export type LingTraceSubjectKind =
  | "thread"
  | "run"
  | "work_unit"
  | "workflow"
  | "workflow_step"
  | "external_work"
  | "media_job";

export type LingTraceSpanKind =
  | "workflow"
  | "workflow_step"
  | "agent_run"
  | "model_generation"
  | "tool_call"
  | "approval"
  | "handoff"
  | "sandbox"
  | "artifact"
  | "state_transition"
  | "runtime_event"
  | "memory"
  | "external_action"
  | "error";

export type LingTraceStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "yielded"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface LingTraceRefs {
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly approvalId?: string;
  readonly executionActionId?: string;
  readonly artifactId?: string;
  readonly handoffId?: string;
  readonly sandboxSessionId?: string;
  readonly stateTransitionId?: string;
  readonly runtimeEventId?: string;
  readonly interventionId?: string;
  readonly toolCallId?: string;
}

export interface LingTrace {
  readonly id: string;
  readonly workspaceId: string;
  readonly subjectKind: LingTraceSubjectKind;
  readonly subjectId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: Exclude<LingTraceStatus, "skipped">;
  readonly generatedAt: string;
}

export interface LingTraceSpan {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly kind: LingTraceSpanKind;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: LingTraceStatus;
  readonly refs: LingTraceRefs;
  readonly summary?: string;
  readonly redactedAttributes?: Readonly<Record<string, unknown>>;
}

export interface ProjectLingTraceInput {
  readonly workspaceId: string;
  readonly subjectKind: LingTraceSubjectKind;
  readonly subjectId: string;
  readonly title?: string;
  readonly status?: Exclude<LingTraceStatus, "skipped">;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly runs: readonly RunSession[];
  readonly eventsByRunId: Readonly<Record<string, readonly RunEventEnvelope[]>>;
  readonly runtimeEventsByWorkUnitId?: Readonly<Record<string, readonly RuntimeEvent[]>>;
  readonly artifacts?: readonly RunArtifact[];
  readonly executionActions?: readonly ExecutionAction[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly transitions?: readonly StateTransitionEvent[];
  readonly interventions?: readonly RunIntervention[];
  readonly generatedAt?: string;
}

export interface ProjectLingTraceResult {
  readonly trace: LingTrace;
  readonly spans: readonly LingTraceSpan[];
}
