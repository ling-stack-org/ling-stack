import {
  buildWorkflowCompletionExpectedReadSet,
  workflowCompletionGateBasisFingerprintV1,
  workflowDelegationCompletionFingerprintV1,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunStore,
  type WorkflowCompletionEvaluationV1,
  type WorkflowGraph,
} from "@ling-stack/core";
import {
  workflowCompletionBasisFingerprintV1,
  workflowGraphFingerprintV1,
  type DelegatedEvidenceRefV1,
  type RequiredParticipantV1,
  type WorkflowCompletionGateV1,
  type WorkflowParticipantCompletionResultV1,
} from "@ling-stack/contracts";
import { readWorkflowStepOutputPacketArtifact } from "./workflow-step-packets.js";
import { verifyWorkflowStepExecutionOperations } from "./workflow-operation-evidence.js";
import { listAllExecutionActionsForRun } from "../runs/execution-actions.js";

export function evaluateWorkflowCompletionGate(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly now: string;
}): WorkflowCompletionGateV1 | undefined {
  return evaluateWorkflowCompletion(input)?.gate;
}

export function evaluateWorkflowCompletion(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly now: string;
}): WorkflowCompletionEvaluationV1 | undefined {
  const manifest = input.workflow.metadata?.requiredParticipantManifest;
  const sourceIntentDecisionId = input.workflow.metadata?.sourceIntentDecisionId;
  const graph = input.workflow.metadata?.workflowGraph;
  if (!manifest) return undefined;
  if (!sourceIntentDecisionId || !graph) {
    return buildEvaluation(input, {
      sourceIntentDecisionId: sourceIntentDecisionId ?? "missing_source_intent_decision",
      graph,
      participantResults: manifest.participants.map((participant) =>
        result(participant.participantId, [], "missing", [], "completion_authority_missing")),
      forceStatus: "blocked",
    });
  }
  const sourceDecision = input.store.getChannelIntentDecision(sourceIntentDecisionId);
  const storedGraphFingerprint = input.workflow.metadata?.workflowGraphFingerprint;
  const canonicalGraphFingerprint = workflowGraphFingerprintV1(graph);
  const manifestMismatch = !sourceDecision || sourceDecision.participantManifest.fingerprint !== manifest.fingerprint;
  const graphFingerprintMismatch = !storedGraphFingerprint || storedGraphFingerprint !== canonicalGraphFingerprint;
  const participantResults = manifest.participants.map((participant) =>
    evaluateParticipant(input.store, input.workflow, input.steps, participant, input.now));
  const graphIncomplete = graphCoverageIncomplete(graph, input.steps);
  const fanInIncomplete = graphFanInIncomplete(graph, input.steps);
  const requiredResults = manifest.participants
    .map((participant, index) => ({ participant, result: participantResults[index]! }))
    .filter(({ participant }) => participant.requirement === "required")
    .map(({ result }) => result);
  const status: WorkflowCompletionGateV1["status"] = manifestMismatch || graphFingerprintMismatch || graphIncomplete
    ? "blocked"
    : fanInIncomplete
      ? "pending"
      : requiredResults.some((item) => item.status === "failed")
        ? "failed"
        : requiredResults.some((item) => item.status === "cancelled")
          ? "cancelled"
          : requiredResults.some((item) => item.status === "blocked")
            ? "blocked"
            : requiredResults.some((item) => item.status === "missing")
              ? "pending"
            : terminationAllowsSuccess(input.workflow, input.steps)
              ? "verified"
              : "blocked";
  return buildEvaluation(input, { sourceIntentDecisionId, graph, participantResults, forceStatus: status });
}

function buildEvaluation(
  input: {
    readonly store: RunStore;
    readonly workflow: ChannelWorkflow;
    readonly steps: readonly ChannelWorkflowStep[];
    readonly now: string;
  },
  values: {
    readonly sourceIntentDecisionId: string;
    readonly graph: WorkflowGraph | undefined;
    readonly participantResults: readonly WorkflowParticipantCompletionResultV1[];
    readonly forceStatus: WorkflowCompletionGateV1["status"];
  },
): WorkflowCompletionEvaluationV1 {
  const manifest = input.workflow.metadata!.requiredParticipantManifest!;
  const graphFingerprint = values.graph
    ? workflowGraphFingerprintV1(values.graph)
    : input.workflow.metadata?.workflowGraphFingerprint ?? "missing_graph";
  const actions = input.steps
    .flatMap((step) => step.runId ? listAllExecutionActionsForRun(input.store, step.runId) : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  const referencedActionIds = [...new Set(values.participantResults.flatMap((participant) => participant.evidenceRefs
    .filter((ref) => ref.kind === "execution_action")
    .map((ref) => ref.id)))].sort();
  const expectedReadSet = buildWorkflowCompletionExpectedReadSet({
    store: input.store,
    workflow: input.workflow,
    steps: input.steps,
    derivedEvidence: { referencedActionIds, executionActionProjectionFingerprint: workflowCompletionBasisFingerprintV1(actions) },
  });
  const basisFingerprint = workflowCompletionGateBasisFingerprintV1({
    workflowId: input.workflow.id,
    sourceIntentDecisionId: values.sourceIntentDecisionId,
    manifestFingerprint: manifest.fingerprint,
    graphFingerprint,
    participantResults: values.participantResults,
    steps: input.steps,
    delegationCompletionFingerprint: workflowDelegationCompletionFingerprintV1(expectedReadSet.delegations),
  });
  const gate: WorkflowCompletionGateV1 = {
    schemaVersion: 1,
    status: values.forceStatus === "verified" && expectedReadSet.delegations.status !== "satisfied"
      ? expectedReadSet.delegations.status : values.forceStatus,
    sourceIntentDecisionId: values.sourceIntentDecisionId,
    participantManifestFingerprint: manifest.fingerprint,
    graphFingerprint,
    basisFingerprint,
    participantResults: values.participantResults,
    checkedAt: input.now,
  };
  return { gate, expectedReadSet };
}

function evaluateParticipant(
  store: RunStore,
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  participant: RequiredParticipantV1,
  now: string,
): WorkflowParticipantCompletionResultV1 {
  const ownedSteps = steps.filter((step) => step.toParticipantId === participant.participantId);
  if (ownedSteps.length === 0) return result(participant.participantId, [], "missing", [], "required_participant_missing");
  if (ownedSteps.some((step) => !validDelegatedRequirement(workflow, step, participant))) {
    return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "delegated_requirement_invalid");
  }
  if (ownedSteps.some((step) => step.status === "failed")) return result(participant.participantId, ownedSteps, "failed", evidenceRefs(ownedSteps), "required_participant_failed");
  if (ownedSteps.some((step) => step.status === "cancelled")) return result(participant.participantId, ownedSteps, "cancelled", evidenceRefs(ownedSteps), "required_participant_cancelled");
  if (ownedSteps.some((step) => step.status === "blocked")) return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "required_participant_blocked");
  if (ownedSteps.some((step) => step.status !== "succeeded" && step.status !== "skipped")) {
    return result(participant.participantId, ownedSteps, "missing", evidenceRefs(ownedSteps), "required_participant_non_terminal");
  }
  const outcomes = ownedSteps.map((step) => step.metadata?.delegatedOutcome);
  if (outcomes.some((outcome) => outcome?.kind !== "completed" || outcome.participantId !== participant.participantId)) {
    return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "required_participant_outcome_missing");
  }
  if (participant.expectedOutcome === "execution" || participant.expectedOutcome === "verification") {
    const recomputedVerifications = ownedSteps.map((step) => verifyWorkflowStepExecutionOperations({ store, step, now }));
    const verifiedOperationIds = new Set(recomputedVerifications.flatMap((verification) => verification?.operationResults
      .filter((operation) => operation.status === "succeeded")
      .map((operation) => operation.operationId) ?? []));
    if (participant.requiredOperationIds.some((operationId) => !verifiedOperationIds.has(operationId))) {
      return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "required_participant_evidence_missing");
    }
    const canonicalEvidenceIds = new Set(ownedSteps.flatMap((step, index) => {
      const verification = recomputedVerifications[index];
      if (verification) {
        return verification.operationResults.flatMap((operation) => operation.evidenceActionIds);
      }
      return step.runId && participant.requiredOperationIds.length === 0
        ? listAllExecutionActionsForRun(store, step.runId)
          .filter((action) => action.status === "succeeded")
          .map((action) => action.id)
        : [];
    }));
    if (outcomes.some((outcome) => outcome?.kind === "completed" && (
      outcome.evidenceRefs.every((ref) => ref.kind !== "execution_action")
      || outcome.evidenceRefs.some((ref) => ref.kind === "execution_action" && !canonicalEvidenceIds.has(ref.id))
    ))) {
      return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "required_participant_action_evidence_missing");
    }
  } else if (participant.expectedOutcome === "synthesis") {
    if (ownedSteps.some((step) => !validSynthesisPacket(store, workflow, step))) {
      return result(participant.participantId, ownedSteps, "blocked", evidenceRefs(ownedSteps), "required_participant_output_packet_missing");
    }
  }
  return result(participant.participantId, ownedSteps, "satisfied", evidenceRefs(ownedSteps));
}

function validDelegatedRequirement(
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  participant: RequiredParticipantV1,
): boolean {
  const requirement = step.metadata?.delegatedRequirement;
  if (!requirement) return false;
  if (requirement.workflowId !== workflow.id || requirement.workflowStepId !== step.id
    || requirement.participantId !== participant.participantId
    || requirement.participantManifestFingerprint !== workflow.metadata?.requiredParticipantManifest?.fingerprint
    || requirement.expectedOutcome !== participant.expectedOutcome) return false;
  const operationIds = [...(step.metadata?.executionOperationIds ?? [])].sort();
  const dependencyIds = [...(step.metadata?.dependsOnStepIds ?? [])].sort();
  return JSON.stringify([...requirement.requiredOperationIds].sort()) === JSON.stringify(operationIds)
    && JSON.stringify([...requirement.requiredDependencyStepIds].sort()) === JSON.stringify(dependencyIds);
}

function validSynthesisPacket(store: RunStore, workflow: ChannelWorkflow, step: ChannelWorkflowStep): boolean {
  const outputRef = step.metadata?.delegatedOutcome?.kind === "completed"
    ? step.metadata.delegatedOutcome.evidenceRefs.find((ref) => ref.kind === "workflow_output_packet")
    : undefined;
  if (!outputRef || outputRef.id !== step.metadata?.outputArtifactId) return false;
  const packet = readWorkflowStepOutputPacketArtifact({ store, artifactId: outputRef.id });
  if (!packet || packet.workflowId !== workflow.id || packet.workflowStepId !== step.id
    || packet.teammateId !== step.toParticipantId || packet.status !== "succeeded") return false;
  const requiredDependencies = new Set(step.metadata?.dependsOnStepIds ?? []);
  const packetDependencies = new Set((packet.sourceRefs ?? [])
    .filter((ref) => ref.type === "workflow_step")
    .map((ref) => ref.id));
  return [...requiredDependencies].every((id) => packetDependencies.has(id));
}

function graphCoverageIncomplete(graph: WorkflowGraph, steps: readonly ChannelWorkflowStep[]): boolean {
  const graphNodeIds = graph.nodes.map((node) => node.id).sort();
  const materializedNodeIds = steps.flatMap((step) => step.metadata?.graphNodeId ? [step.metadata.graphNodeId] : []).sort();
  if (steps.length !== graph.nodes.length
    || materializedNodeIds.length !== steps.length
    || new Set(materializedNodeIds).size !== materializedNodeIds.length
    || JSON.stringify(materializedNodeIds) !== JSON.stringify(graphNodeIds)) return true;
  const stepIdByNode = new Map(steps.flatMap((step) => step.metadata?.graphNodeId
    ? [[step.metadata.graphNodeId, step.id] as const]
    : []));
  return graph.nodes.some((node) => {
    const step = steps.find((candidate) => candidate.metadata?.graphNodeId === node.id);
    if (!step) return true;
    const declaredDependencies = graph.edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => stepIdByNode.get(edge.fromNodeId))
      .filter((id): id is string => Boolean(id))
      .sort();
    const materializedDependencies = [...(step.metadata?.dependsOnStepIds ?? [])].sort();
    return JSON.stringify(declaredDependencies) !== JSON.stringify(materializedDependencies);
  });
}

function graphFanInIncomplete(graph: WorkflowGraph, steps: readonly ChannelWorkflowStep[]): boolean {
  const byNode = new Map(steps.flatMap((step) => step.metadata?.graphNodeId ? [[step.metadata.graphNodeId, step] as const] : []));
  for (const step of steps) {
    if (!step.metadata?.fanInPolicy?.requireAllBranchesTerminal || !step.metadata.graphNodeId) continue;
    const inbound = graph.edges.filter((edge) => edge.toNodeId === step.metadata!.graphNodeId!);
    if (inbound.length === 0 || inbound.some((edge) => !isTerminalStep(byNode.get(edge.fromNodeId)))) return true;
  }
  return false;
}

function terminationAllowsSuccess(workflow: ChannelWorkflow, steps: readonly ChannelWorkflowStep[]): boolean {
  const policy = workflow.metadata?.termination;
  if (!policy || policy.success === "all_required_succeeded") {
    return steps.every((step) => step.status === "succeeded" || step.status === "skipped");
  }
  return steps.every((step) => isTerminalStep(step));
}

function result(
  participantId: string,
  steps: readonly ChannelWorkflowStep[],
  status: WorkflowParticipantCompletionResultV1["status"],
  refs: readonly DelegatedEvidenceRefV1[],
  reasonCode?: string,
): WorkflowParticipantCompletionResultV1 {
  return { participantId, workflowStepIds: steps.map((step) => step.id), status, evidenceRefs: refs, ...(reasonCode ? { reasonCode } : {}) };
}

function evidenceRefs(steps: readonly ChannelWorkflowStep[]): readonly DelegatedEvidenceRefV1[] {
  const refs = steps.flatMap((step) => step.metadata?.delegatedOutcome?.kind === "completed"
    ? step.metadata.delegatedOutcome.evidenceRefs
    : []);
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref] as const)).values()];
}

function isTerminalStep(step: ChannelWorkflowStep | undefined): boolean {
  return Boolean(step && (step.status === "succeeded" || step.status === "failed" || step.status === "skipped"
    || step.status === "cancelled" || step.status === "blocked"));
}
