import {
  type ChannelHandoff,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type LingApprovalCheckpoint,
  type MemoryObject,
  type RunArtifact,
  type RunStore,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { listAllExecutionActionsForRun, listExecutionActions } from "../runs/execution-actions.js";
import { buildWorkflowContextInspectSummary, type WorkflowContextInspectSummary } from "./context-processing/inspect.js";
import {
  readWorkflowStepContextPacketArtifact,
  readWorkflowStepOutputPacketArtifact,
} from "./workflow-step-packets.js";

export interface WorkflowEvidenceDiagnostic {
  readonly kind:
    | "missing_context_packet"
    | "missing_output_packet"
    | "missing_run"
    | "bad_packet"
    | "operation_unverified"
    | "blocked"
    | "failed";
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export interface WorkflowEvidence {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly {
    readonly step: ChannelWorkflowStep;
    readonly contextPacket?: ReturnType<typeof readWorkflowStepContextPacketArtifact>;
    readonly contextInspect: WorkflowContextInspectSummary;
    readonly outputPacket?: ReturnType<typeof readWorkflowStepOutputPacketArtifact>;
    readonly linkedRun?: ReturnType<RunStore["getRun"]>;
    readonly packetArtifacts: readonly RunArtifact[];
    readonly linkedArtifacts: readonly RunArtifact[];
    readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
  }[];
  readonly selectorDecisions: ReturnType<RunStore["listWorkflowSelectorDecisions"]>;
  readonly handoffIntents: ReturnType<RunStore["listWorkflowHandoffIntents"]>;
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: ReturnType<RunStore["listApprovalRequests"]>;
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
  readonly actions: ReturnType<typeof listExecutionActions>;
  readonly artifacts: readonly RunArtifact[];
  readonly memoryCandidates: readonly {
    readonly memory: MemoryObject;
    readonly sourceWorkflowId: string;
    readonly sourceWorkflowStepIds: readonly string[];
  }[];
}

export function buildWorkflowEvidence(store: RunStore, workflowId: string): WorkflowEvidence {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${workflowId}`);
  }
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  const evidenceSteps = steps.map((step) => buildWorkflowEvidenceStep(store, step));
  const selectorDecisions = store.listWorkflowSelectorDecisions({ workflowId, limit: 500 });
  const handoffIntents = store.listWorkflowHandoffIntents({ workflowId, limit: 500 });
  const handoffIds = uniqueStrings([
    workflow.sourceHandoffId,
    ...steps.map((step) => step.sourceHandoffId),
    ...handoffIntents.map((intent) => intent.channelHandoffId),
  ]);
  const handoffs = handoffIds
    .map((handoffId) => store.getChannelHandoff(handoffId))
    .filter((handoff): handoff is ChannelHandoff => Boolean(handoff));
  const approvals = steps.flatMap((step) => store.listApprovalRequests({ workflowStepId: step.id, complete: true }));
  const approvalCheckpoints = approvals
    .map((approval) => store.getApprovalCheckpointForApproval(approval.id))
    .filter((checkpoint): checkpoint is LingApprovalCheckpoint => Boolean(checkpoint));
  const actions = uniqueExecutionActions(evidenceSteps.flatMap((step) =>
    step.linkedRun ? listAllExecutionActionsForRun(store, step.linkedRun.id) : [],
  ));
  const artifacts = uniqueArtifacts(evidenceSteps.flatMap((step) => [...step.packetArtifacts, ...step.linkedArtifacts]));
  return {
    workflow,
    steps: evidenceSteps,
    selectorDecisions,
    handoffIntents,
    handoffs,
    approvals,
    approvalCheckpoints,
    actions,
    artifacts,
    memoryCandidates: collectWorkflowMemoryCandidates(store, workflow, steps, artifacts),
  };
}

function buildWorkflowEvidenceStep(store: RunStore, step: ChannelWorkflowStep): WorkflowEvidence["steps"][number] {
  const diagnostics: WorkflowEvidenceDiagnostic[] = [];
  const contextArtifact = step.metadata?.contextArtifactId ? store.getArtifact(step.metadata.contextArtifactId) : undefined;
  const outputArtifact = step.metadata?.outputArtifactId ? store.getArtifact(step.metadata.outputArtifactId) : undefined;
  const contextPacket = contextArtifact
    ? readWorkflowStepContextPacketArtifact({ store, artifactId: contextArtifact.id })
    : undefined;
  const outputPacket = outputArtifact
    ? readWorkflowStepOutputPacketArtifact({ store, artifactId: outputArtifact.id })
    : undefined;
  if (step.metadata?.contextArtifactId && !contextPacket) {
    diagnostics.push({ kind: "bad_packet", severity: "warning", message: "Context packet evidence could not be read." });
  } else if ((step.status === "running" || step.status === "succeeded") && !step.metadata?.contextArtifactId) {
    diagnostics.push({ kind: "missing_context_packet", severity: "info", message: "No context packet has been captured for this step." });
  }
  if (step.metadata?.outputArtifactId && !outputPacket) {
    diagnostics.push({ kind: "bad_packet", severity: "warning", message: "Output packet evidence could not be read." });
  } else if ((step.status === "succeeded" || step.status === "failed" || step.status === "blocked") && !step.metadata?.outputArtifactId) {
    diagnostics.push({ kind: "missing_output_packet", severity: "info", message: "No output packet has been captured for this terminal step." });
  }
  const linkedRun = step.runId ? store.getRun(step.runId) : undefined;
  if (step.runId && !linkedRun) {
    diagnostics.push({ kind: "missing_run", severity: "warning", message: "Linked run was not found." });
  }
  if (step.status === "blocked") {
    diagnostics.push({ kind: "blocked", severity: "warning", message: step.blocker ?? "Workflow step is blocked." });
  }
  if (step.status === "failed") {
    diagnostics.push({ kind: "failed", severity: "critical", message: step.blocker ?? step.resultSummary ?? "Workflow step failed." });
  }
  const executionVerification = step.metadata?.executionVerification;
  const missingRequiredOperationIds = requiredExecutionOperationIdsForStep(step)
    .filter((operationId) => !executionVerification?.operationResults.some((result) =>
      result.operationId === operationId && result.status === "succeeded"));
  if (missingRequiredOperationIds.length > 0) {
    diagnostics.push({
      kind: "operation_unverified",
      severity: step.status === "succeeded" ? "critical" : "warning",
      message: `Required operations are not verified: ${missingRequiredOperationIds.join(", ")}.`,
    });
  }
  return {
    step,
    contextPacket,
    contextInspect: buildWorkflowContextInspectSummary({
      step,
      contextPacket,
      contextArtifactMissing: Boolean(step.metadata?.contextArtifactId && !contextArtifact),
      contextPacketUnreadable: Boolean(contextArtifact && !contextPacket),
    }),
    outputPacket,
    linkedRun,
    packetArtifacts: [contextArtifact, outputArtifact].filter((artifact): artifact is RunArtifact => Boolean(artifact)),
    linkedArtifacts: linkedRun ? store.listArtifacts(linkedRun.id) : [],
    diagnostics,
  };
}

function requiredExecutionOperationIdsForStep(step: ChannelWorkflowStep): readonly string[] {
  const requirement = step.metadata?.delegatedRequirement;
  if (requirement) {
    return [...new Set(requirement.requiredOperationIds)];
  }
  const plan = step.metadata?.executionPlan;
  if (!plan) {
    return [];
  }
  const requiredIds = new Set(plan.operations
    .filter((operation) => operation.required)
    .map((operation) => operation.id));
  const ownedIds = step.metadata?.executionOperationIds;
  return ownedIds === undefined
    ? [...requiredIds]
    : [...new Set(ownedIds.filter((operationId) => requiredIds.has(operationId)))];
}

function collectWorkflowMemoryCandidates(
  store: RunStore,
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  artifacts: readonly RunArtifact[],
): WorkflowEvidence["memoryCandidates"] {
  const sourceIds = new Set<string>([
    workflow.id,
    ...steps.map((step) => step.id),
    ...steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)),
    ...artifacts.map((artifact) => artifact.id),
  ]);
  return store.listMemoryObjects({ workspaceId: workflow.workspaceId, reviewState: "candidate", limit: 500 })
    .filter((memory) => memory.sourceRefs.some((ref) => sourceIds.has(ref.id)))
    .map((memory) => ({
      memory,
      sourceWorkflowId: workflow.id,
      sourceWorkflowStepIds: steps
        .filter((step) => memory.sourceRefs.some((ref) => buildWorkflowStepEvidenceSourceIds(store, step).has(ref.id)))
        .map((step) => step.id),
    }));
}

function buildWorkflowStepEvidenceSourceIds(store: RunStore, step: ChannelWorkflowStep): ReadonlySet<string> {
  return new Set([
    step.id,
    step.runId,
    step.metadata?.contextArtifactId,
    step.metadata?.outputArtifactId,
    step.metadata?.fanInSummaryArtifactId,
    ...(step.metadata?.outputArtifactIds ?? []),
    ...(step.runId ? store.listArtifacts(step.runId).map((artifact) => artifact.id) : []),
  ].filter((id): id is string => Boolean(id)));
}

function uniqueExecutionActions(actions: ReturnType<typeof listExecutionActions>): ReturnType<typeof listExecutionActions> {
  const seen = new Set<string>();
  const result: ReturnType<typeof listExecutionActions> = [];
  for (const action of actions) {
    if (seen.has(action.id)) {
      continue;
    }
    seen.add(action.id);
    result.push(action);
  }
  return result.sort((left, right) =>
    (right.completedAt ?? right.executedAt ?? right.resolvedAt ?? right.createdAt)
      .localeCompare(left.completedAt ?? left.executedAt ?? left.resolvedAt ?? left.createdAt) ||
    right.id.localeCompare(left.id),
  );
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function uniqueArtifacts(values: readonly RunArtifact[]): readonly RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const artifact of values) {
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}
