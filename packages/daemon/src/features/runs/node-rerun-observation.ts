import { createHash } from "node:crypto";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  resolveSessionRunPolicy,
  toRuntimeAttemptFence,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type EffectiveRunPolicySnapshot,
  type RunSession,
  type RunStore,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkflowGraph,
  type WorkflowGraphNode,
  isWorkflowStepSafetyPlanV1,
} from "@ling-stack/core";
import {
  evaluateNodeRerunAdmission,
  parseNodeRerunIntent,
  workflowGraphFingerprintV1,
  type NodeRerunAdmissionResult,
  type NodeRerunArtifactPinV1,
  type NodeRerunBlockerCode,
  type NodeRerunDependencyClosureV1,
  type NodeRerunDependencyPinV1,
  type NodeRerunIntentV1,
  type NodeRerunObservedSourceV1,
  type NodeRerunPermissionStatus,
  type NodeRerunSourceRefV1,
} from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";
import { readStoredEffectivePolicySnapshot } from "./existing-run-request.js";
import { readCurrentRunApprovalProfile } from "./run-approval-profile.js";
import { readUserInputSourcePolicyIntent } from "./user-input-source-policy.js";
import { readWorkUnitStopEvidence } from "../../runtime/work-unit-stop-evidence.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_WORK_UNIT_STATUSES = new Set(["succeeded", "failed", "cancelled", "stale"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_STEP_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);
const TERMINAL_RUNTIME_EVENTS = new Map([
  ["succeeded", "work_unit_succeeded"],
  ["failed", "work_unit_failed"],
  ["cancelled", "work_unit_cancelled"],
  ["lost", "work_unit_stale"],
] as const);

export interface NodeRerunSourceSnapshotProjectionV1 {
  readonly run: {
    readonly id: string;
    readonly status: RunSession["status"];
    readonly endedAt: string | null;
    readonly taskId: string;
    readonly channelId: string | null;
    readonly teammateId: string | null;
    readonly workflowStepId: string | null;
    readonly workUnitId: string | null;
  };
  readonly workUnit: {
    readonly id: string;
    readonly status: WorkUnit["status"];
    readonly endedAt: string | null;
    readonly linkedRunId: string | null;
    readonly activeAttemptId: string | null;
  };
  readonly attempt: {
    readonly id: string;
    readonly workUnitId: string;
    readonly attemptNumber: number;
    readonly runtimeInstanceId: string;
    readonly fencingToken: string;
    readonly status: WorkUnitAttempt["status"];
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
  };
  readonly workflow: {
    readonly id: string;
    readonly updatedAt: string;
    readonly graphVersionDigest: string;
    readonly nodeId: string;
  };
  readonly workflowStep: {
    readonly id: string;
    readonly channelId: string;
    readonly workflowId: string;
    readonly taskId: string | null;
    readonly runId: string | null;
    readonly toParticipantId: string;
    readonly status: ChannelWorkflowStep["status"];
    readonly updatedAt: string;
    readonly graphId: string | null;
    readonly graphNodeId: string | null;
    readonly contextArtifactId: string | null;
    readonly outputArtifactId: string | null;
    readonly outputArtifactIds: readonly string[];
  };
  readonly inputArtifact: NodeRerunArtifactPinV1;
  readonly dependencyClosure: NodeRerunDependencyClosureV1;
  readonly sourcePolicyFingerprint: string;
}

export type NodeRerunObservationBlockerCode =
  | "intent_invalid"
  | "observation_invalid"
  | "run_missing"
  | "work_unit_missing"
  | "attempt_missing"
  | "lineage_mismatch"
  | "workflow_missing"
  | "workflow_step_missing"
  | "graph_missing"
  | "graph_fingerprint_mismatch"
  | "source_node_missing"
  | "source_input_artifact_missing"
  | "source_input_artifact_digest_missing"
  | "dependency_closure_incomplete"
  | "dependency_step_missing"
  | "dependency_input_artifact_missing"
  | "dependency_output_artifact_missing"
  | "dependency_policy_missing"
  | "source_snapshot_mismatch"
  | "source_policy_missing"
  | "current_policy_unavailable"
  | "source_step_not_terminal";

export interface NodeRerunObservationBlocker {
  readonly code: NodeRerunObservationBlockerCode;
  readonly contractCode: NodeRerunBlockerCode;
  readonly message: string;
}

export interface NodeRerunObservationResult {
  readonly admission: NodeRerunAdmissionResult;
  readonly observed?: NodeRerunObservedSourceV1;
  readonly evaluationInvoked: boolean;
  readonly blockers: readonly NodeRerunObservationBlocker[];
}

export interface ObserveNodeRerunAdmissionInput {
  readonly store: RunStore;
  readonly activeRuns: ActiveRunRegistry;
  readonly intent: unknown;
  readonly now: string;
}

/**
 * SHA-256 digest of the complete persisted workflow graph used by the Host
 * observation boundary. The shorter workflowGraphFingerprintV1 remains a
 * legacy graph integrity marker; it is not used as the rerun contract digest.
 */
export function nodeRerunGraphVersionDigestV1(graph: WorkflowGraph): string {
  return sha256Json({ schemaVersion: 1, kind: "node_rerun_graph_v1", graph });
}

export function nodeRerunNodeVersionDigestV1(graphVersionDigest: string, node: WorkflowGraphNode): string {
  return sha256Json({ schemaVersion: 1, kind: "node_rerun_node_v1", graphVersionDigest, node });
}

export function nodeRerunPermissionFingerprintV1(snapshot: EffectiveRunPolicySnapshot): string {
  return sha256Json({ schemaVersion: 1, kind: "node_rerun_permission_v1", snapshot });
}

export function nodeRerunSourceSnapshotDigestV1(snapshot: NodeRerunSourceSnapshotProjectionV1): string {
  return sha256Json({ schemaVersion: 1, kind: "node_rerun_source_snapshot_v1", snapshot });
}

/**
 * Read one source snapshot under a single SQLite read snapshot and pass it to
 * the pure F5-01 evaluator only after all source identities and immutable pins
 * have been independently reverified. This function never creates or updates
 * a Run, Attempt, lease, approval, artifact, Provider request or effect.
 */
export function observeNodeRerunAdmission(input: ObserveNodeRerunAdmissionInput): NodeRerunObservationResult {
  let intent: NodeRerunIntentV1;
  try {
    intent = parseNodeRerunIntent(input.intent);
  } catch {
    return blocked(undefined, [observationBlocker("intent_invalid", "invalid_intent", "The node rerun intent is invalid.")]);
  }

  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== input.now) {
    return blocked(intent, [observationBlocker("observation_invalid", "invalid_observation", "The observation timestamp is invalid.")]);
  }

  try {
    return input.store.readSnapshot(() => observeWithinSnapshot(input, intent, nowMs));
  } catch {
    return blocked(intent, [observationBlocker("observation_invalid", "invalid_observation", "The Host source snapshot could not be read consistently.")]);
  }
}

function observeWithinSnapshot(
  input: ObserveNodeRerunAdmissionInput,
  intent: NodeRerunIntentV1,
  nowMs: number,
): NodeRerunObservationResult {
  const run = input.store.getRun(intent.source.runId);
  if (!run) return blocked(intent, [observationBlocker("run_missing", "source_identity_mismatch", "The source Run is missing.")]);
  if (!run.workUnitId) return blocked(intent, [observationBlocker("lineage_mismatch", "source_identity_mismatch", "The source Run has no WorkUnit lineage.")]);

  const workUnit = input.store.getWorkUnit(run.workUnitId);
  if (!workUnit) return blocked(intent, [observationBlocker("work_unit_missing", "source_identity_mismatch", "The source WorkUnit is missing.")]);
  if (workUnit.linkedRunId !== run.id
    || workUnit.taskId !== run.taskId
    || workUnit.channelId !== run.channelId
    || workUnit.teammateId !== run.teammateId) {
    return blocked(intent, [observationBlocker("lineage_mismatch", "source_identity_mismatch", "The Run and WorkUnit lineage does not match.")]);
  }

  const attempt = input.store.getWorkUnitAttempt(intent.source.attemptId);
  if (!attempt) return blocked(intent, [observationBlocker("attempt_missing", "source_identity_mismatch", "The source Attempt is missing.")]);
  if (attempt.workUnitId !== workUnit.id) {
    return blocked(intent, [observationBlocker("lineage_mismatch", "source_identity_mismatch", "The source Attempt belongs to a different WorkUnit.")]);
  }
  if (workUnit.activeAttemptId !== attempt.id) {
    return blocked(intent, [observationBlocker("lineage_mismatch", "source_identity_mismatch", "The source Attempt is not the WorkUnit's current Attempt.")]);
  }

  if (!run.workflowStepId) {
    return blocked(intent, [observationBlocker("workflow_step_missing", "source_identity_mismatch", "The source Run has no workflow-step lineage.")]);
  }
  const sourceStep = input.store.getChannelWorkflowStep(run.workflowStepId);
  if (!sourceStep) return blocked(intent, [observationBlocker("workflow_step_missing", "source_identity_mismatch", "The source WorkflowStep is missing.")]);
  if (sourceStep.runId !== run.id || sourceStep.workflowId.length === 0
    || sourceStep.channelId !== run.channelId
    || sourceStep.taskId !== run.taskId
    || sourceStep.toParticipantId !== run.teammateId
    || !TERMINAL_STEP_STATUSES.has(sourceStep.status)) {
    return blocked(intent, [observationBlocker("lineage_mismatch", "source_identity_mismatch", "The Run and WorkflowStep lineage does not match.")]);
  }

  const workflow = input.store.getChannelWorkflow(sourceStep.workflowId);
  if (!workflow) return blocked(intent, [observationBlocker("workflow_missing", "source_identity_mismatch", "The source Workflow is missing.")]);

  const graphResult = readGraphFacts(input.store, workflow, sourceStep, intent);
  if (graphResult.blockers.length > 0) return blocked(intent, graphResult.blockers);

  const sourceArtifactResult = readArtifactPin(input.store, sourceStep.metadata?.contextArtifactId, run.id,
    "source_input_artifact_missing", "source_input_artifact_digest_missing");
  if (sourceArtifactResult.blockers.length > 0) return blocked(intent, sourceArtifactResult.blockers);
  const inputArtifact = sourceArtifactResult.pin!;

  const closureResult = readDependencyClosure(input.store, workflow, graphResult.graph!, graphResult.graphVersionDigest!,
    graphResult.stepByNode!, intent.source.nodeId, sourceStep.id, input.activeRuns, input.now, nowMs);
  if (closureResult.blockers.length > 0) return blocked(intent, closureResult.blockers);

  const policyResult = readPolicyFacts(input.store, run);
  if (policyResult.blockers.length > 0) return blocked(intent, policyResult.blockers);

  const dependencyClosure = closureResult.closure!;
  const sourceSnapshot = nodeRerunSourceSnapshotDigestV1({
    run: {
      id: run.id,
      status: run.status,
      endedAt: run.endedAt ?? null,
      taskId: run.taskId,
      channelId: run.channelId ?? null,
      teammateId: run.teammateId ?? null,
      workflowStepId: run.workflowStepId ?? null,
      workUnitId: run.workUnitId ?? null,
    },
    workUnit: {
      id: workUnit.id,
      status: workUnit.status,
      endedAt: workUnit.endedAt ?? null,
      linkedRunId: workUnit.linkedRunId ?? null,
      activeAttemptId: workUnit.activeAttemptId ?? null,
    },
    attempt: {
      id: attempt.id,
      workUnitId: attempt.workUnitId,
      attemptNumber: attempt.attemptNumber,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      status: attempt.status,
      createdAt: attempt.createdAt,
      startedAt: attempt.startedAt ?? null,
      endedAt: attempt.endedAt ?? null,
    },
    workflow: {
      id: workflow.id,
      updatedAt: workflow.updatedAt,
      graphVersionDigest: graphResult.graphVersionDigest!,
      nodeId: intent.source.nodeId,
    },
    workflowStep: {
      id: sourceStep.id,
      channelId: sourceStep.channelId,
      workflowId: sourceStep.workflowId,
      taskId: sourceStep.taskId ?? null,
      runId: sourceStep.runId ?? null,
      toParticipantId: sourceStep.toParticipantId,
      status: sourceStep.status,
      updatedAt: sourceStep.updatedAt,
      graphId: sourceStep.metadata?.graphId ?? null,
      graphNodeId: sourceStep.metadata?.graphNodeId ?? null,
      contextArtifactId: sourceStep.metadata?.contextArtifactId ?? null,
      outputArtifactId: sourceStep.metadata?.outputArtifactId ?? null,
      outputArtifactIds: [...(sourceStep.metadata?.outputArtifactIds ?? [])],
    },
    inputArtifact,
    dependencyClosure,
    sourcePolicyFingerprint: policyResult.sourcePolicyFingerprint!,
  });

  const source: NodeRerunSourceRefV1 = {
    runId: run.id,
    attemptId: attempt.id,
    nodeId: intent.source.nodeId,
    graphVersionDigest: graphResult.graphVersionDigest!,
    inputArtifact,
    dependencyClosure,
    sourceSnapshotDigest: sourceSnapshot,
  };
  if (!sameSource(source, intent.source)) {
    return blocked(intent, [observationBlocker("source_snapshot_mismatch", "source_identity_mismatch", "The intent source pins do not match the current Host snapshot.")]);
  }

  const sourceFence = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  const stopEvidence = readWorkUnitStopEvidence(input.store, workUnit, [attempt], input.activeRuns).attempts[0];
  if (!stopEvidence) {
    return blocked(intent, [observationBlocker("observation_invalid", "invalid_observation", "The source Attempt stop evidence is unavailable.")]);
  }

  const leases = [
    ...input.store.listResourceLeases({ workUnitId: workUnit.id, attemptId: attempt.id, complete: true }),
    ...input.store.listResourceLeases({ ownerType: "run", ownerId: run.id, complete: true }),
    ...input.store.listResourceLeases({ ownerType: "workflow_step", ownerId: sourceStep.id, complete: true }),
  ];
  const uniqueLeases = [...new Map(leases.map((lease) => [lease.id, lease])).values()];
  const semaphoreSlots = input.store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, complete: true });
  const runtimeEvents = input.store.listRuntimeEvents(workUnit.id, { complete: true });
  const terminalEvent = terminalRuntimeEventFor(attempt.status);
  const terminalAudit = Boolean(terminalEvent && runtimeEvents.some((event) => event.type === terminalEvent
    && event.attemptId === attempt.id && event.runtimeInstanceId === attempt.runtimeInstanceId
    && event.fencingToken === attempt.fencingToken && timestampAtOrBefore(event.ts, nowMs)));

  const leaseStatus = readLeaseStatus(uniqueLeases, nowMs);
  const fenceStatus = readFenceStatus(input.store, run, workUnit, attempt, semaphoreSlots, runtimeEvents, terminalAudit, nowMs);
  const effectStatus = stopEvidence.effects === "settled" ? "settled" as const
    : stopEvidence.effects === "pending" ? "pending" as const : "unknown" as const;
  const externalEffectStatus = readExternalEffectStatus(input.store, sourceFence, run.cwd, input.now);
  const stopStatus = readStopStatus(attempt.status, stopEvidence.localExecution);
  const runLifecycle = readRunLifecycle(run, workUnit, attempt, sourceStep, nowMs);

  const observed: NodeRerunObservedSourceV1 = {
    source,
    runStatus: run.status,
    runLifecycle,
    attemptStatus: attempt.status,
    stopStatus,
    leaseStatus,
    fenceStatus,
    effectStatus,
    externalEffectStatus,
    sourcePolicyFingerprint: policyResult.sourcePolicyFingerprint!,
    currentPolicyFingerprint: policyResult.currentPolicyFingerprint!,
    currentPolicyAvailable: policyResult.currentPolicyAvailable,
    permissionStatus: policyResult.permissionStatus!,
  };
  return {
    admission: evaluateNodeRerunAdmission({ intent, observed }),
    observed,
    evaluationInvoked: true,
    blockers: [],
  };
}

interface GraphFacts {
  readonly graph?: WorkflowGraph;
  readonly graphVersionDigest?: string;
  readonly stepByNode?: ReadonlyMap<string, ChannelWorkflowStep>;
  readonly blockers: readonly NodeRerunObservationBlocker[];
}

function readGraphFacts(
  store: RunStore,
  workflow: ChannelWorkflow,
  sourceStep: ChannelWorkflowStep,
  intent: NodeRerunIntentV1,
): GraphFacts {
  const metadata = workflow.metadata;
  const graph = metadata?.workflowGraph;
  if (!graph || graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { blockers: [observationBlocker("graph_missing", "source_identity_mismatch", "The accepted workflow graph is missing or malformed.")] };
  }
  try {
    if (metadata?.workflowGraphId !== graph.id || metadata?.workflowGraphFingerprint !== workflowGraphFingerprintV1(graph)) {
      return { blockers: [observationBlocker("graph_fingerprint_mismatch", "source_identity_mismatch", "The stored workflow graph fingerprint is not current.")] };
    }
  } catch {
    return { blockers: [observationBlocker("graph_fingerprint_mismatch", "invalid_observation", "The workflow graph fingerprint could not be verified.")] };
  }
  const graphVersionDigest = nodeRerunGraphVersionDigestV1(graph);
  if (intent.source.graphVersionDigest !== graphVersionDigest) {
    return { blockers: [observationBlocker("graph_fingerprint_mismatch", "source_identity_mismatch", "The intent graph version does not match the accepted graph.")] };
  }

  const nodeById = new Map<string, WorkflowGraphNode>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || nodeById.has(node.id)) {
      return { blockers: [observationBlocker("graph_missing", "invalid_observation", "The workflow graph contains an invalid or duplicate node.")] };
    }
    nodeById.set(node.id, node);
  }
  const sourceNode = nodeById.get(intent.source.nodeId);
  if (!sourceNode || sourceNode.kind !== "step") {
    return { blockers: [observationBlocker("source_node_missing", "source_identity_mismatch", "The source graph node is missing or is not rerunnable.")] };
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== "string" || edgeIds.has(edge.id)
      || !nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) {
      return { blockers: [observationBlocker("graph_missing", "invalid_observation", "The workflow graph contains an invalid edge.")] };
    }
    edgeIds.add(edge.id);
  }

  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true, limit: 10_000 });
  const stepByNode = new Map<string, ChannelWorkflowStep>();
  for (const step of steps) {
    const nodeId = step.metadata?.graphNodeId;
    if (!nodeId) continue;
    if (step.metadata?.graphId !== graph.id || stepByNode.has(nodeId)) {
      return { blockers: [observationBlocker("dependency_closure_incomplete", "dependency_closure_incomplete", "Workflow steps do not bind uniquely to the accepted graph.")] };
    }
    stepByNode.set(nodeId, step);
  }
  if (stepByNode.size !== graph.nodes.length || stepByNode.get(sourceNode.id)?.id !== sourceStep.id
    || sourceStep.metadata?.graphId !== graph.id || sourceStep.metadata?.graphNodeId !== sourceNode.id) {
    return { blockers: [observationBlocker("dependency_closure_incomplete", "dependency_closure_incomplete", "The accepted graph has incomplete materialized workflow steps.")] };
  }

  const dependencyMismatches: NodeRerunObservationBlocker[] = [];
  for (const node of graph.nodes) {
    const step = stepByNode.get(node.id)!;
    const declared = [...(step.metadata?.dependsOnStepIds ?? [])].sort();
    const expected = graph.edges.filter((edge) => edge.toNodeId === node.id)
      .map((edge) => stepByNode.get(edge.fromNodeId)?.id)
      .filter((id): id is string => Boolean(id)).sort();
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      dependencyMismatches.push(observationBlocker("dependency_closure_incomplete", "dependency_closure_incomplete",
        "The materialized dependency list does not match the graph.") );
      break;
    }
  }
  if (dependencyMismatches.length > 0) return { blockers: dependencyMismatches };
  return { graph, graphVersionDigest, stepByNode, blockers: [] };
}

interface ArtifactPinRead {
  readonly pin?: NodeRerunArtifactPinV1;
  readonly blockers: readonly NodeRerunObservationBlocker[];
}

function readArtifactPin(
  store: RunStore,
  artifactId: string | undefined,
  expectedRunId: string,
  missingCode: NodeRerunObservationBlockerCode,
  digestMissingCode: NodeRerunObservationBlockerCode,
): ArtifactPinRead {
  if (!artifactId) {
    return { blockers: [observationBlocker(missingCode, missingCode === "source_input_artifact_missing" ? "source_identity_mismatch" : "dependency_evidence_missing",
      "The workflow step does not bind an input artifact.")] };
  }
  const artifact = store.getArtifact(artifactId);
  if (!artifact || artifact.runId !== expectedRunId) {
    return { blockers: [observationBlocker(missingCode, missingCode === "source_input_artifact_missing" ? "source_identity_mismatch" : "dependency_evidence_missing",
      "The bound input artifact is missing or belongs to another Run.")] };
  }
  if (!artifact.contentSha256 || !SHA256_PATTERN.test(artifact.contentSha256)) {
    return { blockers: [observationBlocker(digestMissingCode, digestMissingCode === "source_input_artifact_digest_missing" ? "source_identity_mismatch" : "dependency_evidence_missing",
      "The bound input artifact has no verified SHA-256 digest.")] };
  }
  return { pin: { artifactId: artifact.id, contentSha256: artifact.contentSha256 }, blockers: [] };
}

interface DependencyClosureRead {
  readonly closure?: NodeRerunDependencyClosureV1;
  readonly blockers: readonly NodeRerunObservationBlocker[];
}

function readDependencyClosure(
  store: RunStore,
  workflow: ChannelWorkflow,
  graph: WorkflowGraph,
  graphVersionDigest: string,
  stepByNode: ReadonlyMap<string, ChannelWorkflowStep>,
  sourceNodeId: string,
  _sourceStepId: string,
  activeRuns: ActiveRunRegistry,
  now: string,
  nowMs: number,
): DependencyClosureRead {
  const ancestors = graphClosure(graph, sourceNodeId, false);
  const descendants = graphClosure(graph, sourceNodeId, true);
  const blockers: NodeRerunObservationBlocker[] = [];
  const upstream: NodeRerunDependencyPinV1[] = [];
  for (const nodeId of ancestors) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const step = stepByNode.get(nodeId);
    if (!node || !step) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_closure_incomplete", "An upstream graph node has no materialized WorkflowStep."));
      continue;
    }
    if (!TERMINAL_STEP_STATUSES.has(step.status) || !step.runId || step.channelId !== workflow.channelId
      || !timestampAtOrBefore(step.updatedAt, nowMs)) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream WorkflowStep has no terminal Run lineage."));
      continue;
    }
    const dependencyRun = store.getRun(step.runId);
    if (!dependencyRun || dependencyRun.workflowStepId !== step.id || dependencyRun.taskId !== step.taskId
      || dependencyRun.channelId !== step.channelId || dependencyRun.teammateId !== step.toParticipantId
      || !TERMINAL_RUN_STATUSES.has(dependencyRun.status) || !timestampAtOrBefore(dependencyRun.endedAt, nowMs)) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream Run is missing or not terminal."));
      continue;
    }
    if (!dependencyRun.workUnitId) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream Run has no WorkUnit lineage."));
      continue;
    }
    const dependencyUnit = store.getWorkUnit(dependencyRun.workUnitId);
    if (!dependencyUnit || dependencyUnit.linkedRunId !== dependencyRun.id || dependencyUnit.taskId !== dependencyRun.taskId
      || dependencyUnit.channelId !== dependencyRun.channelId || dependencyUnit.teammateId !== dependencyRun.teammateId
      || !dependencyUnit.activeAttemptId) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream WorkUnit lineage is missing or inconsistent."));
      continue;
    }
    const dependencyAttempt = store.getWorkUnitAttempt(dependencyUnit.activeAttemptId);
    if (!dependencyAttempt || dependencyAttempt.workUnitId !== dependencyUnit.id
      || !TERMINAL_ATTEMPT_STATUSES.has(dependencyAttempt.status)) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream WorkUnit Attempt is missing or not terminal."));
      continue;
    }
    if (!terminalStateIsConsistent(dependencyRun, dependencyUnit, dependencyAttempt, step, nowMs)) {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream terminal state is inconsistent or outside the observation boundary."));
      continue;
    }
    const dependencyEvents = store.listRuntimeEvents(dependencyUnit.id, { complete: true });
    const dependencyTerminalEvent = terminalRuntimeEventFor(dependencyAttempt.status);
    const dependencyTerminalAudit = Boolean(dependencyTerminalEvent && dependencyEvents.some((event) => event.type === dependencyTerminalEvent
      && event.attemptId === dependencyAttempt.id && event.runtimeInstanceId === dependencyAttempt.runtimeInstanceId
      && event.fencingToken === dependencyAttempt.fencingToken && timestampAtOrBefore(event.ts, nowMs)));
    const dependencyLeases = [
      ...store.listResourceLeases({ workUnitId: dependencyUnit.id, attemptId: dependencyAttempt.id, complete: true }),
      ...store.listResourceLeases({ ownerType: "run", ownerId: dependencyRun.id, complete: true }),
      ...store.listResourceLeases({ ownerType: "workflow_step", ownerId: step.id, complete: true }),
    ];
    const dependencyLeaseStatus = readLeaseStatus(
      [...new Map(dependencyLeases.map((lease) => [lease.id, lease])).values()], nowMs);
    const dependencyFenceStatus = readFenceStatus(store, dependencyRun, dependencyUnit, dependencyAttempt,
      store.listRuntimeSemaphoreSlots({ workUnitId: dependencyUnit.id, complete: true }), dependencyEvents,
      dependencyTerminalAudit, nowMs);
    const dependencyStop = readWorkUnitStopEvidence(store, dependencyUnit, [dependencyAttempt], activeRuns).attempts[0];
    const dependencyStopStatus = readStopStatus(dependencyAttempt.status, dependencyStop?.localExecution ?? "unverified");
    const dependencyExternalEffectStatus = readExternalEffectStatus(store,
      { runId: dependencyRun.id, ...toRuntimeAttemptFence(dependencyAttempt) }, dependencyRun.cwd, now);
    if (dependencyLeaseStatus === "active" || dependencyLeaseStatus === "unknown"
      || dependencyFenceStatus !== "released" || !dependencyStop || dependencyStop.effects !== "settled"
      || dependencyStopStatus === "unknown" || dependencyStopStatus === "unconfirmed"
      || dependencyExternalEffectStatus !== "none") {
      blockers.push(observationBlocker("dependency_step_missing", "dependency_evidence_missing", "An upstream execution has not established a settled, replay-safe terminal boundary."));
      continue;
    }
    const input = readArtifactPin(store, step.metadata?.contextArtifactId, dependencyRun.id,
      "dependency_input_artifact_missing", "dependency_input_artifact_missing");
    if (input.blockers.length > 0) {
      blockers.push(...input.blockers);
      continue;
    }
    const outputIds = [step.metadata?.outputArtifactId, ...(step.metadata?.outputArtifactIds ?? [])]
      .filter((id): id is string => Boolean(id));
    if (outputIds.length === 0 || new Set(outputIds).size !== outputIds.length) {
      blockers.push(observationBlocker("dependency_output_artifact_missing", "dependency_evidence_missing", "An upstream WorkflowStep has no complete output artifact list."));
      continue;
    }
    const outputs: NodeRerunArtifactPinV1[] = [];
    for (const artifactId of outputIds) {
      const output = readArtifactPin(store, artifactId, dependencyRun.id, "dependency_output_artifact_missing", "dependency_output_artifact_missing");
      if (output.blockers.length > 0) blockers.push(...output.blockers);
      else outputs.push(output.pin!);
    }
    const policy = readStoredEffectivePolicySnapshot(dependencyRun.requestSnapshot);
    if (!policy) {
      blockers.push(observationBlocker("dependency_policy_missing", "dependency_evidence_missing", "An upstream Run has no effective policy snapshot."));
      continue;
    }
    upstream.push({
      nodeId,
      nodeVersionDigest: nodeRerunNodeVersionDigestV1(graphVersionDigest, node),
      inputArtifact: input.pin!,
      outputArtifacts: outputs,
      permissionFingerprint: nodeRerunPermissionFingerprintV1(policy),
    });
  }
  const complete = blockers.length === 0 && ancestors.every((nodeId) => stepByNode.has(nodeId))
    && descendants.every((nodeId) => stepByNode.has(nodeId));
  const closure: NodeRerunDependencyClosureV1 = {
    complete,
    upstream: upstream.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    downstreamNodeIds: descendants.sort(),
  };
  if (blockers.length > 0) return { closure, blockers: dedupeBlockers(blockers) };
  if (!complete) return { closure, blockers: [observationBlocker("dependency_closure_incomplete", "dependency_closure_incomplete", "The upstream or downstream dependency closure is incomplete.")] };
  if (workflow.id.length === 0) return { closure, blockers: [observationBlocker("observation_invalid", "invalid_observation", "The workflow identity is invalid.")] };
  return { closure, blockers: [] };
}

interface PolicyFacts {
  readonly sourcePolicyFingerprint?: string;
  readonly currentPolicyFingerprint?: string;
  readonly currentPolicyAvailable: boolean;
  readonly permissionStatus?: NodeRerunPermissionStatus;
  readonly blockers: readonly NodeRerunObservationBlocker[];
}

function readPolicyFacts(store: RunStore, run: RunSession): PolicyFacts {
  const source = readStoredEffectivePolicySnapshot(run.requestSnapshot);
  if (!source) {
    return { currentPolicyAvailable: false, blockers: [observationBlocker("source_policy_missing", "policy_unavailable", "The source Run has no effective policy snapshot.")] };
  }
  const sourcePolicyFingerprint = nodeRerunPermissionFingerprintV1(source);
  let current: EffectiveRunPolicySnapshot;
  try {
    const request = isRecord(run.requestSnapshot) ? run.requestSnapshot : {};
    const policyIntent = readUserInputSourcePolicyIntent(request);
    const rawWorkflowSafetyPlan = request.workflowSafetyPlan;
    if (rawWorkflowSafetyPlan !== undefined && !isWorkflowStepSafetyPlanV1(rawWorkflowSafetyPlan)) throw new Error("invalid workflow safety plan");
    const workflowSafetyProfile = isRecord(rawWorkflowSafetyPlan) ? rawWorkflowSafetyPlan.profile : undefined;
    const workspaceAccessMode = workflowSafetyProfile === "pi_host_readonly_v1"
      ? "read_only" as const : policyIntent.workspaceAccessMode;
    const approvalProfile = readCurrentRunApprovalProfile(store, run);
    const channel = run.channelId ? store.getChannel(run.channelId) : undefined;
    const currentThread = run.threadId ? store.getLingThread(run.threadId) : undefined;
    const resolved = resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(),
      permissionMode: policyIntent.permissionMode ?? source.mode,
      ...(policyIntent.permissionPreset ? { permissionPreset: policyIntent.permissionPreset } : {}),
      ...(policyIntent.authorizationMode ? { authorizationMode: policyIntent.authorizationMode } : {}),
      ...(workspaceAccessMode ? { workspaceAccessMode } : {}),
      channelBoundPath: channel?.boundPath ?? run.cwd,
      approvalProfile,
    });
    current = applyConversationModeToEffectiveRunPolicySnapshot(resolved.snapshot,
      currentThread?.conversationMode.mode ?? source.conversationMode);
  } catch {
    return {
      sourcePolicyFingerprint,
      currentPolicyAvailable: false,
      permissionStatus: "unknown",
      blockers: [observationBlocker("current_policy_unavailable", "policy_unavailable", "The current policy could not be re-resolved.")],
    };
  }
  const currentPolicyFingerprint = nodeRerunPermissionFingerprintV1(current);
  return {
    sourcePolicyFingerprint,
    currentPolicyFingerprint,
    currentPolicyAvailable: true,
    permissionStatus: sourcePolicyFingerprint === currentPolicyFingerprint ? "current" : "expired",
    blockers: [],
  };
}

function readLeaseStatus(
  leases: readonly { readonly status: string; readonly expiresAt: string }[],
  nowMs: number,
): "none" | "expired" | "active" | "unknown" {
  let sawExpired = false;
  for (const lease of leases) {
    if (lease.status === "active") {
      const expiresAt = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAt)) return "unknown";
      if (expiresAt > nowMs) return "active";
      sawExpired = true;
    } else if (lease.status === "expired") {
      sawExpired = true;
    } else if (lease.status !== "released") {
      return "unknown";
    }
  }
  return sawExpired ? "expired" : "none";
}

function readFenceStatus(
  store: RunStore,
  run: RunSession,
  workUnit: WorkUnit,
  attempt: WorkUnitAttempt,
  slots: readonly { readonly status: string; readonly expiresAt: string }[],
  _events: readonly unknown[],
  terminalAudit: boolean,
  nowMs: number,
): "released" | "active" | "unknown" {
  for (const slot of slots) {
    if (slot.status !== "active" && slot.status !== "released" && slot.status !== "expired") return "unknown";
    if (slot.status !== "active") continue;
    const expiresAt = Date.parse(slot.expiresAt);
    if (!Number.isFinite(expiresAt)) return "unknown";
    if (expiresAt > nowMs) return "active";
  }
  if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    try {
      if (store.isCurrentRunExecutionOwner(run.id, toRuntimeAttemptFence(attempt), false)) return "active";
    } catch {
      return "unknown";
    }
    return "unknown";
  }
  if (terminalAudit && Boolean(run.endedAt) && Boolean(workUnit.endedAt) && Boolean(attempt.endedAt)) return "released";
  return "unknown";
}

function readStopStatus(
  attemptStatus: WorkUnitAttempt["status"],
  localExecution: "draining" | "drained" | "unverified",
): NodeRerunObservedSourceV1["stopStatus"] {
  if (attemptStatus === "succeeded" || attemptStatus === "failed") return "not_required";
  if (attemptStatus === "cancelled" || attemptStatus === "lost") {
    return localExecution === "drained" ? "confirmed" : localExecution === "unverified" ? "unknown" : "unconfirmed";
  }
  return "unknown";
}

function readRunLifecycle(
  run: RunSession,
  workUnit: WorkUnit,
  attempt: WorkUnitAttempt,
  sourceStep: ChannelWorkflowStep,
  nowMs: number,
): NodeRerunObservedSourceV1["runLifecycle"] {
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return terminalStateIsConsistent(run, workUnit, attempt, sourceStep, nowMs) ? "ended" : "unknown";
  }
  return run.endedAt ? "unknown" : "active";
}

function readExternalEffectStatus(
  store: RunStore,
  source: { readonly runId: string; readonly workUnitId: string; readonly attemptId: string; readonly runtimeInstanceId: string; readonly fencingToken: string },
  cwd: string,
  stoppedAt: string,
): NodeRerunObservedSourceV1["externalEffectStatus"] {
  const operations = store.listHostOperations(source, stoppedAt);
  const commands = store.listHostCommandWriteBlockers(cwd).filter((command) => command.runId === source.runId
    && command.attemptId === source.attemptId);
  if (operations.some((operation) => operation.phase === "unknown_outcome")
    || commands.some((command) => command.state === "stop_unconfirmed")) return "unknown";
  if (operations.some((operation) => operation.phase === "admitted" || operation.phase === "launched")
    || commands.some((command) => command.state === "prepared")) return "pending";
  if (operations.some((operation) => operation.phase === "safe" && operation.settlementKind !== "known_no_start")) return "non_idempotent";
  return "none";
}

function terminalRuntimeEventFor(status: WorkUnitAttempt["status"]): "work_unit_succeeded" | "work_unit_failed" | "work_unit_cancelled" | "work_unit_stale" | undefined {
  if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost") {
    return TERMINAL_RUNTIME_EVENTS.get(status);
  }
  return undefined;
}

function terminalStateIsConsistent(
  run: RunSession,
  workUnit: WorkUnit,
  attempt: WorkUnitAttempt,
  sourceStep: ChannelWorkflowStep,
  nowMs: number,
): boolean {
  if (!timestampAtOrBefore(run.endedAt, nowMs)
    || !timestampAtOrBefore(workUnit.endedAt, nowMs)
    || !timestampAtOrBefore(attempt.endedAt, nowMs)
    || !timestampAtOrBefore(sourceStep.updatedAt, nowMs)) return false;
  return run.status === "succeeded" && workUnit.status === "succeeded" && attempt.status === "succeeded"
    || run.status === "failed" && workUnit.status === "failed" && attempt.status === "failed"
    || run.status === "failed" && workUnit.status === "stale" && attempt.status === "lost"
    || run.status === "cancelled" && workUnit.status === "cancelled" && attempt.status === "cancelled";
}

function timestampAtOrBefore(value: string | undefined, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed <= nowMs;
}

function graphClosure(graph: WorkflowGraph, sourceNodeId: string, downstream: boolean): string[] {
  const edges = downstream
    ? graph.edges.map((edge) => [edge.fromNodeId, edge.toNodeId] as const)
    : graph.edges.map((edge) => [edge.toNodeId, edge.fromNodeId] as const);
  const next = new Map<string, string[]>();
  for (const [from, to] of edges) next.set(from, [...(next.get(from) ?? []), to]);
  const seen = new Set<string>();
  const queue = [...(next.get(sourceNodeId) ?? [])];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    queue.push(...(next.get(nodeId) ?? []));
  }
  return [...seen].sort();
}

function sameSource(left: NodeRerunSourceRefV1, right: NodeRerunSourceRefV1): boolean {
  return stableJson(left) === stableJson(right);
}

function observationBlocker(
  code: NodeRerunObservationBlockerCode,
  contractCode: NodeRerunBlockerCode,
  message: string,
): NodeRerunObservationBlocker {
  return { code, contractCode, message };
}

function dedupeBlockers(blockers: readonly NodeRerunObservationBlocker[]): NodeRerunObservationBlocker[] {
  return [...new Map(blockers.map((blocker) => [`${blocker.code}:${blocker.contractCode}`, blocker])).values()];
}

function blocked(
  intent: NodeRerunIntentV1 | undefined,
  blockers: readonly NodeRerunObservationBlocker[],
): NodeRerunObservationResult {
  const unique = dedupeBlockers(blockers);
  return {
    admission: {
      schemaVersion: 1,
      kind: "node_rerun_admission",
      decision: "blocked",
      executionAuthorized: false,
      intentId: intent?.intentId ?? null,
      source: intent ? { runId: intent.source.runId, attemptId: intent.source.attemptId, nodeId: intent.source.nodeId } : null,
      blockers: [...new Set(unique.map((blocker) => blocker.contractCode))],
      nextStep: "manual_review_required",
    },
    evaluationInvoked: false,
    blockers: unique,
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}
