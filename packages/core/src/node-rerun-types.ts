import type { NodeRerunIntentV1 } from "@ling-stack/contracts";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workspace-types.js";

export interface NodeRerunSubmission {
  readonly id: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly sourceRunId: string;
  readonly sourceWorkflowId: string;
  readonly sourceSnapshotDigest: string;
  readonly planFingerprint: string;
  readonly successorWorkflowId: string;
  readonly invalidatedNodeIds: readonly string[];
  readonly steps: readonly { readonly nodeId: string; readonly sourceStepId: string; readonly successorStepId: string; readonly reused: boolean; readonly sourceStepDigest: string; readonly artifactPins: readonly { readonly id: string; readonly sha256: string }[] }[];
  readonly createdAt: string;
}
export interface NodeRerunSubmissionStore {
  getByKey(key: string): NodeRerunSubmission | undefined;
  getBySource(workflowId: string): NodeRerunSubmission | undefined;
  getBySuccessor(workflowId: string): NodeRerunSubmission | undefined;
  listPending(limit?: number): NodeRerunSubmission[];
  submit(input: { readonly intent: NodeRerunIntentV1; readonly planFingerprint: string; readonly now: string;
    readonly authorize: () => { readonly workflow: ChannelWorkflow; readonly steps: readonly ChannelWorkflowStep[] };
  }): { readonly submission: NodeRerunSubmission; readonly duplicate: boolean };
}
