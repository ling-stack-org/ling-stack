import type { RunTool } from "./approval-policy.js";
import type { WorkflowStepGate, WorkflowStepPolicy } from "./workspace-types.js";

export type WorkflowGraphNodeKind = "step" | "join";

export type WorkflowEdgeConditionKind =
  | "always"
  | "all_succeeded"
  | "all_terminal"
  | "any_succeeded";

export interface WorkflowEdgeCondition {
  readonly kind: WorkflowEdgeConditionKind;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly condition: WorkflowEdgeCondition;
}

export type WorkflowTerminationSuccessPolicy = "all_terminal" | "all_required_succeeded";
export type WorkflowTerminationFailurePolicy = "block_for_user" | "fail_workflow";

export interface WorkflowTerminationPolicy {
  readonly success: WorkflowTerminationSuccessPolicy;
  readonly onFailedRequiredNode: WorkflowTerminationFailurePolicy;
  readonly onApprovalDenied: WorkflowTerminationFailurePolicy;
  readonly maxTicks?: number;
}

export interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly requiredTools?: readonly RunTool[];
  readonly autoStart?: boolean;
}

export interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly termination: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}
