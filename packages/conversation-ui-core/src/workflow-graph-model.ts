import type { ConversationTimelineItem } from "./transcript-item.js";
import type {
  WorkflowGraphEdge, WorkflowGraphInput, WorkflowGraphIssue, WorkflowGraphNode,
  WorkflowGraphOverlay, WorkflowGraphReadModel, WorkflowGraphStatus,
} from "./workflow-graph-types.js";

export const workflowGraphLimits = Object.freeze({ steps: 128, dependenciesPerStep: 128, facts: 2048, overlay: 64, text: 4096 });

/** One stateless projection for initial reads and refreshed/SSE-invalidated reads. */
export function projectWorkflowGraph(input: WorkflowGraphInput): WorkflowGraphReadModel {
  const workflowSteps = input.steps.filter(step => step.workflowId === input.workflowId && Boolean(step.id));
  const steps = workflowSteps.sort((a, b) => a.position - b.position || compare(a.id, b.id))
    .slice(0, workflowGraphLimits.steps);
  const occurrences = new Map<string, number>();
  for (const step of steps) occurrences.set(step.id, (occurrences.get(step.id) ?? 0) + 1);
  const stepById = new Map(steps.map(step => [step.id, step]));
  const issuesById = new Map<string, Set<WorkflowGraphIssue>>();
  const missingById = new Map<string, string[]>();
  const dependenciesById = new Map<string, string[]>();
  const edges: WorkflowGraphEdge[] = [];
  for (const [id, step] of stepById) {
    const issues = new Set<WorkflowGraphIssue>();
    issuesById.set(id, issues);
    if (occurrences.get(id)! > 1) issues.add("duplicate_id");
    if (input.observation !== "current") issues.add("observation_unavailable");
    const raw = step.metadata?.dependsOnStepIds;
    const dependencies: string[] = [];
    const missing: string[] = [];
    dependenciesById.set(id, dependencies);
    missingById.set(id, missing);
    if (!Array.isArray(raw)) { issues.add("dependencies_unavailable"); continue; }
    if (raw.length > workflowGraphLimits.dependenciesPerStep) issues.add("truncated");
    for (const source of raw.slice(0, workflowGraphLimits.dependenciesPerStep)) {
      if (typeof source !== "string" || !source || source === id || dependencies.includes(source)) {
        issues.add("invalid_dependency");
        continue;
      }
      dependencies.push(source);
      if (!stepById.has(source)) { missing.push(source); issues.add("missing_dependency"); continue; }
      edges.push({ id: JSON.stringify([source, id]), source, target: id });
    }
    dependencies.sort(compare);
    missing.sort(compare);
  }
  edges.sort((a, b) => compare(a.id, b.id));
  // Reachability is bounded to 128 nodes. Mark only actual cycle members, not their descendants.
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  for (const id of stepById.keys()) {
    const pending = [...(outgoing.get(id) ?? [])];
    const seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === id) { issuesById.get(id)!.add("cycle"); break; }
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(outgoing.get(next) ?? []));
    }
  }
  const facts = collectFacts(input.timelineItems ?? [], stepById, input.observation);
  const nodes: WorkflowGraphNode[] = [...stepById].map(([id, step]) => {
    const issues = [...issuesById.get(id)!];
    return {
      id, title: bounded(step.title) || id, participantLabel: bounded(step.toParticipantLabel),
      reportedStatus: step.status, status: issues.length ? "unknown" : workflowGraphStatus(step.status),
      dependencyIds: dependenciesById.get(id)!, missingDependencyIds: missingById.get(id)!,
      branchGroupId: bounded(step.metadata?.branchGroupId), joinGroupId: bounded(step.metadata?.joinGroupId),
      dependencyMode: step.metadata?.dependencyMode,
      branches: (outgoing.get(id)?.length ?? 0) > 1,
      joins: edges.filter(edge => edge.target === id).length > 1,
      issues, blocker: bounded(step.blocker), resultSummary: bounded(step.resultSummary),
      factIds: [...(facts.idsByStep.get(id) ?? [])].sort(compare),
      approvals: [...facts.approvals.values()].filter(item => facts.idsByStep.get(id)?.has(item.id)).sort((a, b) => compare(a.id, b.id)),
    };
  });
  return {
    workflowId: input.workflowId, observation: input.observation, nodes, edges, overlay: facts.overlay,
    omittedStepCount: Math.max(0, workflowSteps.length - steps.length), factsTruncated: facts.truncated,
  };
}

/** Selection is shared by list and graph and survives status/order refreshes. */
export function reconcileWorkflowGraphSelection(model: WorkflowGraphReadModel, selectedStepId?: string): string | undefined {
  return model.nodes.some(node => node.id === selectedStepId) ? selectedStepId : model.nodes[0]?.id;
}

export function workflowGraphStatus(status: string | undefined): WorkflowGraphStatus {
  if (status === "queued" || status === "pending") return "pending";
  if (status === "claimed" || status === "running") return "running";
  if (status === "waiting_for_approval" || status === "waiting_for_input" || status === "waiting") return "waiting";
  if (status === "succeeded" || status === "skipped" || status === "failed" || status === "blocked" || status === "cancelled") return status;
  return "unknown";
}

function collectFacts(
  items: readonly ConversationTimelineItem[],
  steps: ReadonlyMap<string, WorkflowGraphInput["steps"][number]>,
  observation: WorkflowGraphInput["observation"],
): { idsByStep: Map<string, Set<string>>; approvals: Map<string, Extract<ConversationTimelineItem, { kind: "approval" }>>; overlay: WorkflowGraphOverlay[]; truncated: boolean } {
  const idsByStep = new Map<string, Set<string>>();
  const approvals = new Map<string, Extract<ConversationTimelineItem, { kind: "approval" }>>();
  const overlayById = new Map<string, WorkflowGraphOverlay>();
  const byRun = new Map<string, string | null>();
  for (const step of steps.values()) if (step.runId) byRun.set(step.runId, byRun.has(step.runId) ? null : step.id);
  const pending = items.slice(0, workflowGraphLimits.facts).map(item => ({ item, parentStepId: undefined as string | undefined }));
  let visited = 0;
  let truncated = items.length > workflowGraphLimits.facts;
  while (pending.length && visited < workflowGraphLimits.facts) {
    const { item, parentStepId } = pending.pop()!;
    visited++;
    const stepId = item.workflowStepId === null ? undefined : item.workflowStepId !== undefined
      ? (steps.has(item.workflowStepId) ? item.workflowStepId : undefined)
      : item.runId ? byRun.get(item.runId) ?? undefined : parentStepId;
    if (stepId) {
      const ids = idsByStep.get(stepId) ?? new Set<string>();
      ids.add(item.id);
      idsByStep.set(stepId, ids);
      if (item.kind === "approval") approvals.set(item.id, item);
      if (item.kind === "collabAgentToolCall") {
        if (overlayById.size < workflowGraphLimits.overlay) overlayById.set(item.id, {
          id: `overlay:${item.id}`, factId: item.id, stepId, title: bounded(item.title) || item.toolName,
          status: observation === "current" ? workflowGraphStatus(item.status) : "unknown",
        });
        else truncated = true;
      }
    }
    if (item.kind === "subAgentActivity") {
      const room = workflowGraphLimits.facts - visited - pending.length;
      if (item.childItems.length > room) truncated = true;
      for (const child of item.childItems.slice(0, Math.max(0, room))) pending.push({ item: child, parentStepId: stepId });
    }
  }
  return { idsByStep, approvals, overlay: [...overlayById.values()].sort((a, b) => compare(a.id, b.id)), truncated: truncated || pending.length > 0 };
}

function bounded(value: string | undefined): string | undefined { return value?.slice(0, workflowGraphLimits.text); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
