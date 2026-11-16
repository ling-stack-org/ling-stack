import type { WorkflowGraphReadModel } from "@ling-stack/conversation-ui-core";

export const workflowGraphNodeSize = Object.freeze({ width: 216, height: 96 });
export const workflowGraphNarrowNodeSize = Object.freeze({ width: 144, height: 84 });

/** Layout only. Dependencies and lifecycle have already been projected by the shared model. */
export function layoutWorkflowGraph(model: WorkflowGraphReadModel, narrow = false): ReadonlyMap<string, { x: number; y: number }> {
  const rank = new Map(model.nodes.map(node => [node.id, 0]));
  const incoming = new Map(model.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of model.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const ready = model.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, rank.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
  }
  const columnSizes = new Map<number, number>();
  for (const column of rank.values()) columnSizes.set(column, (columnSizes.get(column) ?? 0) + 1);
  const maxRows = Math.max(0, ...columnSizes.values());
  const rows = new Map<number, number>();
  return new Map(model.nodes.map(node => {
    const column = rank.get(node.id)!;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    const offset = (maxRows - columnSizes.get(column)!) / 2;
    return [node.id, narrow
      ? { x: (row + offset) * (workflowGraphNarrowNodeSize.width + 32), y: column * (workflowGraphNarrowNodeSize.height + 40) }
      : { x: column * (workflowGraphNodeSize.width + 80), y: (row + offset) * (workflowGraphNodeSize.height + 32) }];
  }));
}
