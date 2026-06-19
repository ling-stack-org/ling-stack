import type { RunStatus } from "./shared.js";

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

export type LingTraceStatus = RunStatus | "skipped";

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
  readonly status: RunStatus;
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

export interface LingTraceListResponse {
  readonly cwd: string;
  readonly traces: readonly LingTrace[];
}

export interface LingTraceDetailResponse {
  readonly cwd: string;
  readonly trace: LingTrace;
  readonly spans: readonly LingTraceSpan[];
}

export interface LingTraceSpansResponse {
  readonly cwd: string;
  readonly traceId: string;
  readonly spans: readonly LingTraceSpan[];
}
