import type { WorkflowGraphReadModel, WorkflowGraphStatus } from "@ling-stack/conversation-ui-core";

/** Dependency activity is derived from the accepted snapshot, never from animation time. */
export function workflowGraphEdgeStates(model: WorkflowGraphReadModel): ReadonlyMap<string, WorkflowGraphStatus> {
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  const complete = (id: string): boolean => {
    const status = nodes.get(id)?.status;
    return status === "succeeded" || status === "skipped";
  };
  return new Map(model.edges.map(edge => {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    const status: WorkflowGraphStatus = model.observation !== "current" || !source || !target ||
      source.status === "unknown" || target.status === "unknown" ? "unknown"
      : complete(source.id) && target.dependencyIds.every(complete) ? target.status : "pending";
    return [edge.id, status];
  }));
}
