import {
  approvalActionTypes,
  buildEffectiveTeammateSkills,
  channelWorkflowStepStatuses,
  createBuiltinAiTeammateId,
  getBuiltinSkillPack,
  getEffectiveTeammateSkill,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  isRiskyRunTool,
  type ChannelExecutionProposalStepSource,
  type ChannelWorkflow,
  type ChannelWorkflowMetadata,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepMetadata,
  type RunStore,
  type RunTool,
  type SkillApprovalProfile,
  type WorkflowEdgeConditionKind,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowStepFailurePolicy,
  type WorkflowStepGate,
  type WorkflowStepPolicy,
} from "@ling-stack/core";
import {
  createWorkflowParticipantAuthorityV1,
  isWorkflowParticipantProviderBindingV1,
  workflowGraphFingerprintV1,
  type WorkflowParticipantAuthorityKindV1,
  type WorkflowParticipantAuthorityOriginV1,
} from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { isRecord, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import { listExecutableSkillDefinitions } from "../skills/registry.js";
import { resolveCouncilSlotParticipant } from "./council-slot-resolver.js";
import { createLingAgentExecutor, isLingAgentExecutorId } from "./ling-agent-executor.js";

export interface CompileWorkflowGraphInput {
  readonly channelId: string;
  readonly workflowGraph: WorkflowGraph;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
  readonly participantAuthority?: {
    readonly kind: WorkflowParticipantAuthorityKindV1;
    readonly origin: WorkflowParticipantAuthorityOriginV1;
    readonly sourceId: string;
  };
  readonly workflowMetadata?: ChannelWorkflowMetadata;
}

export function compileWorkflowGraph(
  store: RunStore,
  input: CompileWorkflowGraphInput,
  now = new Date().toISOString(),
  runnerRegistry?: RunnerRegistry,
): {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
} {
  validateWorkflowGraph(store, input, runnerRegistry);
  const graph = input.workflowGraph;
  const workflow = store.createChannelWorkflow(
    {
      channelId: input.channelId,
      title: input.title ?? graph.name,
      objective: input.objective,
      status: "ready",
      createdBy: input.createdBy ?? "local-user",
      metadata: {
        ...input.workflowMetadata,
        workflowGraphId: graph.id,
        workflowGraphSchemaVersion: graph.schemaVersion,
        workflowGraph: graph,
        workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
        termination: graph.termination,
        maxParallelSteps: graph.maxParallelSteps,
      },
    },
    now,
  );

  const orderedNodes = topologicalGraphNodes(graph);
  const steps: ChannelWorkflowStep[] = [];
  const stepByNodeId = new Map<string, ChannelWorkflowStep>();
  for (const [index, node] of orderedNodes.entries()) {
    const resolved = resolveGraphNodeParticipant(store, input.channelId, node);
    const dependencyMode = graphNodeDependencyMode(graph, node.id);
    const metadata: ChannelWorkflowStepMetadata = omitUndefined({
      workflowTemplateId: graph.id,
      templateVersion: `graph:${graph.schemaVersion}`,
      templateStepId: node.id,
      graphId: graph.id,
      graphNodeId: node.id,
      proposalStepSources: resolved.sources ?? node.proposalStepSources,
      teammateTemplateId: node.teammateTemplateId,
      councilSlotKey: node.councilSlotKey,
      skillId: node.skillId,
      requestedRunnerId: node.requestedRunnerId ?? input.runnerId,
      providerPresetId: node.providerPresetId ?? input.providerPresetId,
      providerBinding: node.providerBinding,
      requiredTools: node.requiredTools,
      autoStart: node.autoStart ?? input.autoStart ?? false,
      branchGroupId: node.branchGroupId,
      joinGroupId: node.joinGroupId,
      dependencyMode,
      maxParallelSiblings: graph.maxParallelSteps,
      policy: node.policy ?? defaultWorkflowGraphStepPolicy(graph),
      gates: node.gates,
    });
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        position: index + 1,
        title: node.name,
        prompt: renderGraphNodePrompt(node, input.objective),
        toParticipantId: resolved.toParticipantId,
        toParticipantLabel: resolved.toParticipantLabel,
        participantAuthority: createWorkflowParticipantAuthorityV1({
          kind: input.participantAuthority?.kind ?? "workflow_definition",
          origin: input.participantAuthority?.origin ?? "workflow_graph",
          participantId: resolved.toParticipantId,
          sourceId: input.participantAuthority?.sourceId ?? graph.id,
        }),
        metadata,
      },
      now,
    );
    steps.push(step);
    stepByNodeId.set(node.id, step);
  }

  const updatedSteps = steps.map((step) => {
    const graphNodeId = step.metadata?.graphNodeId ?? step.metadata?.templateStepId;
    if (!graphNodeId) {
      return step;
    }
    const dependsOnStepIds = graph.edges
      .filter((edge) => edge.toNodeId === graphNodeId)
      .map((edge) => stepByNodeId.get(edge.fromNodeId)?.id)
      .filter((stepId): stepId is string => typeof stepId === "string");
    if (dependsOnStepIds.length === 0) {
      return step;
    }
    return store.updateChannelWorkflowStep(
      step.id,
      {
        metadata: {
          ...step.metadata,
          dependsOnStepIds,
        },
      },
      now,
    ) ?? step;
  });

  return { workflow, workflowSteps: updatedSteps };
}

export function validateWorkflowGraph(store: RunStore, input: CompileWorkflowGraphInput, runnerRegistry?: RunnerRegistry): void {
  const channel = store.getChannel(input.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${input.channelId}`);
  }
  const graph = input.workflowGraph;
  if (graph.schemaVersion !== 1) {
    throw new HttpError(400, "workflow_graph_invalid", "Workflow graph schemaVersion must be 1");
  }
  if (graph.nodes.length === 0) {
    throw new HttpError(400, "workflow_graph_invalid", "Workflow graph must include at least one node");
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "step" && node.kind !== "join") {
      throw new HttpError(400, "workflow_graph_node_kind_unsupported", `Unsupported workflow graph node kind: ${String(node.kind)}`);
    }
    if (nodeIds.has(node.id)) {
      throw new HttpError(400, "workflow_graph_invalid", `Duplicate workflow graph node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }
  if (!nodeIds.has(graph.entryNodeId)) {
    throw new HttpError(400, "workflow_graph_invalid", `entryNodeId does not reference a node: ${graph.entryNodeId}`);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      throw new HttpError(400, "workflow_graph_invalid", `Duplicate workflow graph edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new HttpError(400, "workflow_graph_invalid", `Workflow graph edge has an unknown endpoint: ${edge.id}`);
    }
  }
  assertWorkflowGraphDag(graph);
  assertWorkflowGraphReachability(graph);
  for (const node of graph.nodes) {
    if (node.id !== graph.entryNodeId && graph.edges.every((edge) => edge.toNodeId !== node.id)) {
      throw new HttpError(400, "workflow_graph_invalid", `Workflow graph node has no inbound edge: ${node.id}`);
    }
    validateGraphNodeParticipantAndSkill(store, input.channelId, node);
    validateGraphNodeProviderBinding(node);
    validateGraphNodeRunner(store, node.requestedRunnerId ?? input.runnerId, runnerRegistry);
    graphNodeDependencyMode(graph, node.id);
  }
  const maxParallelSteps = graph.maxParallelSteps ?? Math.max(1, ...graph.nodes.map(() => 1));
  const channelMaxConcurrentRuns = channel.runtimePolicy?.maxConcurrentRuns ?? 1;
  if (maxParallelSteps > channelMaxConcurrentRuns) {
    throw new HttpError(
      400,
      "workflow_graph_parallel_limit",
      `Workflow graph maxParallelSteps ${maxParallelSteps} exceeds channel limit ${channelMaxConcurrentRuns}`,
    );
  }
  const unsafeAutoStartNodes = graph.nodes.filter((node) => {
    const autoStart = node.autoStart ?? input.autoStart ?? false;
    return autoStart && graphNodeHasSideEffects(store, node);
  });
  if (unsafeAutoStartNodes.length > 0 && !input.confirmUnsafeAutoStart) {
    throw new HttpError(
      400,
      "workflow_graph_unsafe_autostart",
      `Workflow graph autoStart requires confirmUnsafeAutoStart for side-effectful nodes: ${unsafeAutoStartNodes.map((node) => node.id).join(", ")}`,
    );
  }
}

export function readOptionalWorkflowGraph(record: Record<string, unknown>, key: string): WorkflowGraph | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(`${key}.schemaVersion must be 1`);
  }
  const nodesValue = value.nodes;
  if (!Array.isArray(nodesValue)) {
    throw new Error(`${key}.nodes must be an array`);
  }
  const edgesValue = value.edges;
  if (!Array.isArray(edgesValue)) {
    throw new Error(`${key}.edges must be an array`);
  }
  return {
    schemaVersion,
    id: readString(value, "id"),
    name: readString(value, "name"),
    summary: readOptionalString(value, "summary"),
    entryNodeId: readString(value, "entryNodeId"),
    nodes: nodesValue.map((node, index) => readWorkflowGraphNode(node, `${key}.nodes[${index}]`)),
    edges: edgesValue.map((edge, index) => readWorkflowGraphEdge(edge, `${key}.edges[${index}]`)),
    termination: readWorkflowTerminationPolicy(value, "termination"),
    maxParallelSteps: readOptionalPositiveInteger(value, "maxParallelSteps"),
  };
}

function readWorkflowGraphNode(value: unknown, location: string): WorkflowGraphNode {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  return {
    id: readString(value, "id"),
    kind: readString(value, "kind") as WorkflowGraphNode["kind"],
    name: readString(value, "name"),
    prompt: readString(value, "prompt"),
    teammateTemplateId: readOptionalString(value, "teammateTemplateId"),
    teammateId: readOptionalString(value, "teammateId"),
    councilSlotKey: readOptionalString(value, "councilSlotKey"),
    skillId: readOptionalString(value, "skillId"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    providerBinding: readOptionalWorkflowParticipantProviderBinding(value, "providerBinding"),
    requestedRunnerId: readOptionalString(value, "requestedRunnerId"),
    branchGroupId: readOptionalString(value, "branchGroupId"),
    joinGroupId: readOptionalString(value, "joinGroupId"),
    policy: readOptionalWorkflowStepPolicy(value, "policy"),
    gates: readOptionalWorkflowStepGates(value, "gates"),
    requiredTools: readOptionalStringArray(value, "requiredTools", ["read", "grep", "find", "ls", "bash", "edit", "write"] satisfies readonly RunTool[]),
    autoStart: readOptionalBoolean(value, "autoStart"),
  };
}

function readOptionalWorkflowParticipantProviderBinding(
  record: Record<string, unknown>,
  key: string,
): WorkflowGraphNode["providerBinding"] {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isWorkflowParticipantProviderBindingV1(value)) {
    throw new Error(`${key} must be a valid WorkflowParticipantProviderBindingV1`);
  }
  return value;
}

function validateGraphNodeProviderBinding(node: WorkflowGraphNode): void {
  const binding = node.providerBinding;
  if (!binding) return;
  if (!node.teammateId || binding.participantId !== node.teammateId) {
    throw new HttpError(
      400,
      "workflow_participant_provider_binding_invalid",
      `Workflow graph node ${node.id} provider binding does not match its participant.`,
    );
  }
  if (!node.providerPresetId || binding.providerPresetId !== node.providerPresetId) {
    throw new HttpError(
      400,
      "workflow_participant_provider_binding_invalid",
      `Workflow graph node ${node.id} provider binding does not match its provider preset.`,
    );
  }
}

function readWorkflowGraphEdge(value: unknown, location: string): WorkflowGraphEdge {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  return {
    id: readString(value, "id"),
    fromNodeId: readString(value, "fromNodeId"),
    toNodeId: readString(value, "toNodeId"),
    condition: readWorkflowEdgeCondition(value, "condition"),
  };
}

function readWorkflowEdgeCondition(record: Record<string, unknown>, key: string): WorkflowGraphEdge["condition"] {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const kind = readString(value, "kind");
  if (kind !== "always" && kind !== "all_succeeded" && kind !== "all_terminal" && kind !== "any_succeeded") {
    throw new Error(`${key}.kind must be always, all_succeeded, all_terminal, or any_succeeded`);
  }
  return { kind };
}

function readWorkflowTerminationPolicy(record: Record<string, unknown>, key: string): WorkflowGraph["termination"] {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const success = readString(value, "success");
  const onFailedRequiredNode = readString(value, "onFailedRequiredNode");
  const onApprovalDenied = readString(value, "onApprovalDenied");
  if (success !== "all_terminal" && success !== "all_required_succeeded") {
    throw new Error(`${key}.success must be all_terminal or all_required_succeeded`);
  }
  if (onFailedRequiredNode !== "block_for_user" && onFailedRequiredNode !== "fail_workflow") {
    throw new Error(`${key}.onFailedRequiredNode must be block_for_user or fail_workflow`);
  }
  if (onApprovalDenied !== "block_for_user" && onApprovalDenied !== "fail_workflow") {
    throw new Error(`${key}.onApprovalDenied must be block_for_user or fail_workflow`);
  }
  return omitUndefined({
    success,
    onFailedRequiredNode,
    onApprovalDenied,
    maxTicks: readOptionalPositiveInteger(value, "maxTicks"),
  });
}

function graphNodeDependencyMode(graph: WorkflowGraph, nodeId: string): ChannelWorkflowStepMetadata["dependencyMode"] | undefined {
  const inboundConditions = graph.edges
    .filter((edge) => edge.toNodeId === nodeId)
    .map((edge) => normalizeEdgeCondition(edge.condition.kind));
  if (inboundConditions.length === 0) {
    return undefined;
  }
  const first = inboundConditions[0];
  if (!inboundConditions.every((condition) => condition === first)) {
    throw new HttpError(400, "workflow_graph_mixed_edge_conditions", `Mixed inbound edge conditions are not supported for node: ${nodeId}`);
  }
  return first;
}

function normalizeEdgeCondition(condition: WorkflowEdgeConditionKind): ChannelWorkflowStepMetadata["dependencyMode"] {
  if (condition === "all_terminal") {
    return "all_terminal";
  }
  if (condition === "any_succeeded") {
    return "any_succeeded";
  }
  return "all_succeeded";
}

function assertWorkflowGraphDag(graph: WorkflowGraph): void {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(nodeId: string, path: readonly string[]): void {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new HttpError(400, "workflow_graph_cycle", `Workflow graph has a cycle: ${[...path, nodeId].join(" -> ")}`);
    }
    visiting.add(nodeId);
    for (const nextNodeId of outgoing.get(nodeId) ?? []) {
      visit(nextNodeId, [...path, nodeId]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  for (const node of graph.nodes) {
    visit(node.id, []);
  }
}

function assertWorkflowGraphReachability(graph: WorkflowGraph): void {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  const reachable = new Set<string>();
  const queue = [graph.entryNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    queue.push(...(outgoing.get(nodeId) ?? []));
  }
  const unreachable = graph.nodes.filter((node) => !reachable.has(node.id));
  if (unreachable.length > 0) {
    throw new HttpError(400, "workflow_graph_unreachable_node", `Workflow graph has unreachable nodes: ${unreachable.map((node) => node.id).join(", ")}`);
  }
}

function topologicalGraphNodes(graph: WorkflowGraph): readonly WorkflowGraphNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const incomingCount = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incomingCount.set(edge.toNodeId, (incomingCount.get(edge.toNodeId) ?? 0) + 1);
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  const queue = graph.nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .sort((left, right) => (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0));
  const ordered: WorkflowGraphNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    ordered.push(node);
    const nextIds = [...(outgoing.get(node.id) ?? [])].sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));
    for (const nextId of nextIds) {
      const nextCount = (incomingCount.get(nextId) ?? 0) - 1;
      incomingCount.set(nextId, nextCount);
      if (nextCount === 0) {
        const next = nodeById.get(nextId);
        if (next) {
          queue.push(next);
        }
      }
    }
    queue.sort((left, right) => (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0));
  }
  return ordered;
}

function validateGraphNodeParticipantAndSkill(store: RunStore, channelId: string, node: WorkflowGraphNode): void {
  const resolved = resolveGraphNodeParticipant(store, channelId, node);
  if (!node.skillId) {
    return;
  }
  const executableSkills = listExecutableSkillDefinitions(store);
  const skill = executableSkills.find((candidate) => candidate.id === node.skillId);
  if (!skill) {
    throw new HttpError(400, "skill_not_found", `Skill definition not found: ${node.skillId}`);
  }
  const teammate = store.getAiTeammate(resolved.toParticipantId);
  if (!teammate) {
    throw new HttpError(400, "teammate_not_found", `AI teammate not found: ${resolved.toParticipantId}`);
  }
  const effective = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({
    teammate,
    bindings: store.listTeammateSkillBindings(teammate.id),
    skills: executableSkills,
  }), node.skillId);
  if (!effective) {
    throw new HttpError(400, "skill_not_executable", `Skill is not bound to teammate ${teammate.id}: ${node.skillId}`);
  }
  if (!effective.executable) {
    throw new HttpError(
      400,
      "skill_not_executable",
      `Skill is not executable for teammate ${teammate.id}: ${effective.blockedReasons.map((reason) => reason.code).join(", ")}`,
    );
  }
}

function resolveGraphNodeParticipant(store: RunStore, channelId: string, node: WorkflowGraphNode): {
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly sources?: readonly ChannelExecutionProposalStepSource[];
} {
  const selectorCount = [node.teammateId, node.teammateTemplateId, node.councilSlotKey].filter(isString).length;
  if (selectorCount !== 1) {
    throw new HttpError(400, "workflow_graph_invalid", `Node ${node.id} must use exactly one of teammateId, teammateTemplateId, or councilSlotKey`);
  }
  if (node.councilSlotKey) {
    const resolved = resolveCouncilSlotParticipant(store, channelId, node.councilSlotKey);
    if (!resolved) {
      throw new HttpError(400, "council_slot_not_found", `No effective AI council member found for slot ${node.councilSlotKey} in channel ${channelId}`);
    }
    return resolved;
  }
  if (node.teammateId) {
    if (isLingAgentExecutorId(node.teammateId)) {
      const lingAgent = store.getAiTeammate(node.teammateId) ?? createLingAgentExecutor();
      return { toParticipantId: lingAgent.id, toParticipantLabel: lingAgent.displayName };
    }
    const teammate = store.getAiTeammate(node.teammateId);
    if (!teammate) {
      throw new HttpError(400, "teammate_not_found", `AI teammate not found: ${node.teammateId}`);
    }
    return { toParticipantId: teammate.id, toParticipantLabel: teammate.displayName };
  }
  if (node.teammateTemplateId) {
    const skillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
    const teammateTemplate = skillPack?.teammateTemplates.find((candidate) => candidate.id === node.teammateTemplateId);
    if (!teammateTemplate) {
      throw new HttpError(400, "teammate_template_not_found", `AI teammate template not found: ${node.teammateTemplateId}`);
    }
    const teammateId = createBuiltinAiTeammateId(node.teammateTemplateId);
    if (!store.getAiTeammate(teammateId)) {
      throw new HttpError(400, "teammate_not_found", `AI teammate not found for template: ${node.teammateTemplateId}`);
    }
    return { toParticipantId: teammateId, toParticipantLabel: teammateTemplate.name };
  }
  throw new HttpError(400, "workflow_graph_invalid", `Node ${node.id} must resolve to teammateId, teammateTemplateId, or councilSlotKey`);
}

function validateGraphNodeRunner(store: RunStore, requestedRunnerId: string | undefined, runnerRegistry: RunnerRegistry | undefined): void {
  if (!requestedRunnerId || !runnerRegistry) {
    return;
  }
  const settings = loadWorkspaceRuntimeSettings(store, runnerRegistry);
  runnerRegistry.resolve({
    requestedRunnerId,
    defaultRunnerId: settings.defaultRunnerId,
    allowedRunnerIds: settings.allowedRunnerIds,
    requestSource: "workflow_step",
    explicitFallbackPolicy: settings.explicitRunnerFallback,
    implicitFallbackPolicy: settings.implicitRunnerFallback,
  });
}

function graphNodeHasSideEffects(store: RunStore, node: WorkflowGraphNode): boolean {
  if (node.gates && node.gates.length > 0) {
    return false;
  }
  const skillTools = node.skillId
    ? listExecutableSkillDefinitions(store).find((skill) => skill.id === node.skillId)?.requiredTools ?? []
    : [];
  return skillTools.some(isRiskyRunTool);
}

function defaultWorkflowGraphStepPolicy(graph: WorkflowGraph): WorkflowStepPolicy {
  const terminalFailure = graph.termination.onFailedRequiredNode === "fail_workflow" ? "fail_workflow" : "block_for_user";
  const approvalFailure = graph.termination.onApprovalDenied === "fail_workflow" ? "fail_workflow" : "block_for_user";
  return {
    onRunFailed: terminalFailure,
    onRunCancelled: "block_for_user",
    onApprovalDenied: approvalFailure,
    retryable: true,
  };
}

function renderGraphNodePrompt(node: WorkflowGraphNode, objective: string): string {
  return [
    `Workflow objective:\n${objective}`,
    `Current graph node: ${node.name}`,
    node.skillId ? `Skill: ${node.skillId}` : undefined,
    node.prompt,
    "Complete this graph node only. Do not start or approve later workflow nodes.",
    "Return a concise terminal summary and any artifacts or follow-up decisions needed by later nodes.",
  ].filter(isString).join("\n\n");
}

function readOptionalWorkflowStepPolicy(record: Record<string, unknown>, key: string): WorkflowStepPolicy | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return {
    onRunFailed: readWorkflowStepFailurePolicy(value, "onRunFailed"),
    onRunCancelled: readWorkflowStepFailurePolicy(value, "onRunCancelled"),
    onApprovalDenied: readWorkflowStepFailurePolicy(value, "onApprovalDenied"),
    retryable: readOptionalBoolean(value, "retryable") ?? true,
    maxRetries: readOptionalPositiveInteger(value, "maxRetries"),
  };
}

function readOptionalWorkflowStepGates(record: Record<string, unknown>, key: string): readonly WorkflowStepGate[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => readWorkflowStepGate(item, `${key}[${index}]`));
}

function readWorkflowStepGate(value: unknown, location: string): WorkflowStepGate {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  const stage = value.stage;
  if (stage !== "pre" && stage !== "post") {
    throw new Error(`${location}.stage must be pre or post`);
  }
  return {
    stage,
    approvalProfile: readSkillApprovalProfile(value, "approvalProfile"),
    title: readString(value, "title"),
    reason: readString(value, "reason"),
    requiredForStatuses: readOptionalStringArray(value, "requiredForStatuses", channelWorkflowStepStatuses),
  };
}

function readSkillApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const mode = value.mode;
  if (mode !== "none" && mode !== "standard" && mode !== "strict") {
    throw new Error(`${key}.mode must be none, standard, or strict`);
  }
  return {
    mode,
    risk: readOptionalApprovalRisk(value, "risk"),
    requiredForTools: readOptionalStringArray(value, "requiredForTools", ["read", "grep", "find", "ls", "bash", "edit", "write"] satisfies readonly RunTool[]),
    requiredForActions: readOptionalStringArray(value, "requiredForActions", approvalActionTypes),
  };
}

function readWorkflowStepFailurePolicy(record: Record<string, unknown>, key: string): WorkflowStepFailurePolicy {
  const value = readString(record, key);
  if (value === "block_for_user" || value === "fail_workflow" || value === "cancel_workflow" || value === "skip_if_optional") {
    return value;
  }
  throw new Error(`${key} must be a valid workflow step failure policy`);
}

function readOptionalApprovalRisk(record: Record<string, unknown>, key: string): SkillApprovalProfile["risk"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined || value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  throw new Error(`${key} must be low, medium, high, or critical`);
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function omitUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
