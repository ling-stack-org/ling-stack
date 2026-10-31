import { createHash } from "node:crypto";
import type { RunStore } from "./run-types.js";
import type { ChannelWorkflowStep, CreateTaskInput, Task } from "./workspace-types.js";

/** Durable start generation. A Task is unique per start; a lease is not a logical step id. */
export interface WorkflowStepStartOwnerV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly leaseId: string;
  readonly phase: "preparing" | "linked";
  readonly authorityBasis: string;
}

export interface WorkflowStepStartExpectedBasis {
  readonly status: ChannelWorkflowStep["status"];
  readonly taskId?: string;
  readonly runId?: string;
  readonly updatedAt: string;
}

export interface BeginChannelWorkflowStepStartInput {
  readonly workflowStepId: string;
  readonly expected: WorkflowStepStartExpectedBasis;
  readonly leaseId: string;
  readonly executionPermit?: import("./workflow-pre-gate.js").WorkflowPreGateExecutionPermitV1;
  readonly task: CreateTaskInput;
  readonly createTaskOnly?: boolean;
  readonly fanInContextReviews?: NonNullable<ChannelWorkflowStep["metadata"]>["fanInContextReviews"];
  readonly now: string;
}
export type BeginChannelWorkflowStepStartResult =
  | { readonly status: "begun"; readonly task: Task; readonly owner: WorkflowStepStartOwnerV1 }
  | { readonly status: "stale" | "invalid"; readonly code: string };

export interface WorkflowStepStartCommitInput {
  readonly workflowStepId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  /** Host-only conflict queue handoff; canonical queue lineage is still mandatory. */
  readonly claimQueuedTask?: boolean;
  readonly now: string;
}
export type WorkflowStepStartCommitResult = { readonly status: "linked" | "duplicate" | "stale" | "invalid"; readonly code?: string };
export interface WorkflowStepPostApprovalInput {
  readonly workflowStepId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  readonly approval: Pick<import("./approval-types.js").CreateApprovalRequestInput,
    "risk" | "title" | "description" | "expiresAt"> & {
      readonly payload: Extract<import("./approval-types.js").ApprovalPayload, { readonly type: "workflow_step" }>;
    };
  readonly now: string;
}
export type WorkflowStepPostApprovalResult =
  | { readonly status: "requested" | "duplicate"; readonly approval: import("./approval-types.js").ApprovalRequest }
  | { readonly status: "stale" | "invalid"; readonly code: string };
export interface WorkflowStepPostApprovalResolvedInput {
  readonly workflowStepId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  readonly approvalId: string;
  readonly actor?: "system" | "local-user";
  readonly now: string;
}
export interface WorkflowStepStartFailureInput {
  readonly workflowStepId: string;
  readonly owner?: WorkflowStepStartOwnerV1;
  readonly expected?: WorkflowStepStartExpectedBasis;
  readonly leaseId?: string;
  readonly mode?: "start_failure" | "startup_recovery" | "invalid_owner";
  readonly delegatedBlock?: {
    readonly code: import("@ling-stack/contracts").DelegatedBlockCodeV1;
    readonly reason: string;
    readonly missingRequirements: readonly string[];
  };
  readonly fanInContextReviews?: NonNullable<ChannelWorkflowStep["metadata"]>["fanInContextReviews"];
  readonly blocker: string;
  readonly now: string;
}

export type WorkflowStepStartReadStore = Pick<RunStore,
  "getChannelWorkflowStep" | "getChannelWorkflow" | "getChannel" | "getTask" | "getRun"
  | "getChannelIntentDecision" | "getLingTurn" | "getConversationItem" | "listResourceLeases"
>;

export function isWorkflowStepStartOwnerV1(value: unknown): value is WorkflowStepStartOwnerV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === 1 && (v.phase === "preparing" || v.phase === "linked")
    && [v.taskId, v.leaseId].every((s) => typeof s === "string" && s.length > 0)
    && typeof v.authorityBasis === "string" && /^wso1_[a-f0-9]{64}$/u.test(v.authorityBasis);
}

/** Only semantic inputs enter this fingerprint, never mutable progress/audit timestamps. */
export function workflowStepStartAuthorityBasis(store: WorkflowStepStartReadStore, step: ChannelWorkflowStep): string | undefined {
  const workflow = store.getChannelWorkflow(step.workflowId);
  const channel = store.getChannel(step.channelId);
  if (!workflow || !channel || workflow.channelId !== step.channelId) return undefined;
  const metadata = step.metadata;
  const wm = workflow.metadata;
  const decision = wm?.sourceIntentDecisionId ? store.getChannelIntentDecision(wm.sourceIntentDecisionId) : undefined;
  if (wm?.sourceIntentDecisionId && (!decision || decision.channelId !== step.channelId)) return undefined;
  if (wm?.requiredParticipantManifest && (!decision || !wm.workflowGraph
    || !wm.workflowGraphFingerprint || !metadata?.delegatedRequirement || !metadata.providerBinding)) return undefined;
  const sourceId = metadata?.sourceMessageId ?? wm?.sourceMessageId ?? decision?.sourceItemId;
  const source = sourceId ? store.getConversationItem(sourceId) : undefined;
  if (sourceId && !source) return undefined;
  const turnId = wm?.sourceTurnId ?? source?.turnId ?? decision?.sourceTurnId;
  const turn = turnId ? store.getLingTurn(turnId) : undefined;
  if (turnId && (!turn || turn.status === "superseded" || turn.status === "cancelled")) return undefined;
  const basis = {
    workflow: { id: workflow.id, channelId: workflow.channelId, objective: workflow.objective,
      graph: wm?.workflowGraph, graphFingerprint: wm?.workflowGraphFingerprint,
      manifest: wm?.requiredParticipantManifest, sourceIntentDecisionId: wm?.sourceIntentDecisionId,
      sourceTurnId: wm?.sourceTurnId, termination: wm?.termination },
    step: { id: step.id, title: step.title, prompt: step.prompt, position: step.position,
      participant: step.toParticipantId, authority: step.participantAuthority,
      providerBinding: metadata?.providerBinding, providerPresetId: metadata?.providerPresetId,
      executionPlan: metadata?.executionPlan, operationIds: metadata?.executionOperationIds,
      requirement: metadata?.delegatedRequirement, dependsOnStepIds: metadata?.dependsOnStepIds,
      dependencyMode: metadata?.dependencyMode, gates: metadata?.gates, approvalGate: metadata?.approvalGate,
      policy: metadata?.policy, requiredTools: metadata?.requiredTools, runnerId: metadata?.requestedRunnerId },
    decision: decision && { id: decision.id, sourceItemId: decision.sourceItemId, sourceTurnId: decision.sourceTurnId,
      execution: decision.execution, manifest: decision.participantManifest, action: decision.action },
    source: source && { id: source.id, revision: source.revision, turnId: source.turnId },
    turn: turn && { id: turn.id, sourceItemId: turn.sourceItemId },
    channel: { id: channel.id, allowedTools: channel.allowedTools, defaultProviderPresetId: channel.defaultProviderPresetId },
  };
  return `wso1_${createHash("sha256").update(JSON.stringify(basis)).digest("hex")}`;
}

export function workflowStepStartOwnerMatches(left: WorkflowStepStartOwnerV1 | undefined, right: WorkflowStepStartOwnerV1): boolean {
  return isWorkflowStepStartOwnerV1(left) && left.taskId === right.taskId && left.leaseId === right.leaseId
    && left.authorityBasis === right.authorityBasis;
}

/** A malformed/missing owner never means preparing. Callers must explicitly block it. */
export function classifyWorkflowStepStartOwner(store: WorkflowStepStartReadStore, step: ChannelWorkflowStep, now: string,
  options: { readonly requireActiveLease?: boolean; readonly allowWaitingForInput?: boolean } = {},
): { readonly status: "preparing" | "linked"; readonly owner: WorkflowStepStartOwnerV1 } | { readonly status: "invalid"; readonly code: string } {
  const owner = step.metadata?.startOwner;
  if (!isWorkflowStepStartOwnerV1(owner)) return { status: "invalid", code: "workflow_start_owner_missing" };
  const workflow = store.getChannelWorkflow(step.workflowId);
  const task = store.getTask(owner.taskId);
  if (!workflow || !["running", "waiting_for_approval", "blocked", ...(options.allowWaitingForInput ? ["waiting_for_input"] : [])].includes(workflow.status)
    || !["running", "waiting_for_approval", ...(options.allowWaitingForInput ? ["waiting_for_input"] : [])].includes(step.status)
    || step.taskId !== owner.taskId || !task || task.channelId !== step.channelId
    || task.assigneeTeammateId !== step.toParticipantId
    || workflowStepStartAuthorityBasis(store, step) !== owner.authorityBasis) return { status: "invalid", code: "workflow_start_owner_stale" };
  const lease = store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 })
    .find((entry) => entry.id === owner.leaseId);
  if (!lease || lease.ownerType !== "workflow_step" || lease.ownerId !== step.id
    || (options.requireActiveLease !== false && (lease.status !== "active" || lease.expiresAt <= now))) {
    return { status: "invalid", code: "workflow_start_lease_stale" };
  }
  if (owner.phase === "preparing") {
    return !step.runId && !task.currentRunId ? { status: "preparing", owner } : { status: "invalid", code: "workflow_start_owner_corrupt" };
  }
  const run = step.runId ? store.getRun(step.runId) : undefined;
  return run && run.taskId === owner.taskId && run.workflowStepId === step.id
    && run.channelId === step.channelId && run.teammateId === step.toParticipantId
    && task.currentRunId === run.id
    ? { status: "linked", owner } : { status: "invalid", code: "workflow_start_owner_corrupt" };
}
