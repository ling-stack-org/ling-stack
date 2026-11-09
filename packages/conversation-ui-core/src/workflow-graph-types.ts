import type { ConversationTimelineApprovalItem, ConversationTimelineItem } from "./transcript-item.js";

export type WorkflowGraphStatus = "pending" | "running" | "waiting" | "blocked" | "failed" | "cancelled" | "succeeded" | "skipped" | "unknown";
export type WorkflowGraphObservation = "current" | "stale" | "unknown";
export type WorkflowGraphIssue = "dependencies_unavailable" | "missing_dependency" | "invalid_dependency" | "duplicate_id" | "cycle" | "truncated" | "observation_unavailable";

/** Structural input: clients pass their accepted store projection, never a draft graph. */
export interface WorkflowGraphStepInput {
  readonly id: string;
  readonly workflowId: string;
  readonly position: number;
  readonly title: string;
  readonly status: string;
  readonly runId?: string;
  readonly toParticipantLabel?: string;
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly metadata?: {
    readonly dependsOnStepIds?: readonly string[];
    readonly branchGroupId?: string;
    readonly joinGroupId?: string;
    readonly dependencyMode?: string;
  };
}

export interface WorkflowGraphNode {
  /** Exactly the durable workflow step id. */
  readonly id: string;
  readonly title: string;
  readonly participantLabel?: string;
  readonly reportedStatus: string;
  readonly status: WorkflowGraphStatus;
  readonly dependencyIds: readonly string[];
  readonly missingDependencyIds: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: string;
  readonly branches: boolean;
  readonly joins: boolean;
  readonly issues: readonly WorkflowGraphIssue[];
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly factIds: readonly string[];
  readonly approvals: readonly ConversationTimelineApprovalItem[];
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface WorkflowGraphOverlay {
  readonly id: string;
  readonly factId: string;
  readonly stepId: string;
  readonly title: string;
  readonly status: WorkflowGraphStatus;
}

export interface WorkflowGraphReadModel {
  readonly workflowId: string;
  readonly observation: WorkflowGraphObservation;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  /** Dynamic collaboration evidence is separate from the accepted nodes/edges. */
  readonly overlay: readonly WorkflowGraphOverlay[];
  readonly omittedStepCount: number;
  readonly factsTruncated: boolean;
}

export interface WorkflowGraphInput {
  readonly workflowId: string;
  readonly steps: readonly WorkflowGraphStepInput[];
  readonly timelineItems?: readonly ConversationTimelineItem[];
  readonly observation: WorkflowGraphObservation;
}
