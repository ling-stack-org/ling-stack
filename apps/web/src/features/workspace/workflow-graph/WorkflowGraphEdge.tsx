import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { WorkflowGraphStatus } from "@ling-stack/conversation-ui-core";

export type WorkflowDependencyEdge = Edge<{ status: WorkflowGraphStatus }, "workflowDependency">;

export function WorkflowGraphEdge({ id, data, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  markerEnd }: EdgeProps<WorkflowDependencyEdge>): React.JSX.Element {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 16 });
  const status = data?.status ?? "unknown";
  return <g className="workflow-graph-edge" data-status={status} data-workflow-edge-id={id}>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={0} />
    {status === "running" ? <>
      <path className="workflow-graph-edge-flow-glow" d={path} pathLength={100} aria-hidden="true" />
      <path className="workflow-graph-edge-signal" d={path} pathLength={100} aria-hidden="true" />
    </> : null}
  </g>;
}
