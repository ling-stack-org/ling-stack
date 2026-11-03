import { useMemo } from "react";
import { Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { WorkflowGraphNode, WorkflowGraphReadModel } from "@ling-stack/conversation-ui-core";
import { GitBranch, GitMerge } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { WorkflowGraphStatus, workflowGraphStatusLabel } from "./WorkflowGraphStatus.js";
import { layoutWorkflowGraph, workflowGraphNodeSize } from "./workflow-graph-layout.js";

type StepNode = Node<{ step: WorkflowGraphNode }, "workflowStep">;
const nodeTypes = { workflowStep: WorkflowStepNode };
const fitOptions = { padding: 0.15, maxZoom: 1 };

export default function WorkflowGraphCanvas({ model, selectedStepId, onSelect }: {
  readonly model: WorkflowGraphReadModel;
  readonly selectedStepId?: string;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const positions = useMemo(() => layoutWorkflowGraph(model), [model]);
  const nodes: StepNode[] = useMemo(() => model.nodes.map(step => ({
    id: step.id, type: "workflowStep", data: { step }, position: positions.get(step.id)!,
    width: workflowGraphNodeSize.width, height: workflowGraphNodeSize.height,
    selected: step.id === selectedStepId, draggable: false, connectable: false, deletable: false,
    ariaLabel: `${step.title} · ${t(workflowGraphStatusLabel(step.status))}`,
  })), [model, positions, selectedStepId, t]);
  const edges: Edge[] = useMemo(() => model.edges.map(edge => ({ ...edge, type: "smoothstep", selectable: false,
    deletable: false, animated: false, markerEnd: { type: MarkerType.ArrowClosed },
    ariaLabel: `${model.nodes.find(node => node.id === edge.source)?.title} → ${model.nodes.find(node => node.id === edge.target)?.title}`,
  })), [model]);
  return <div className="workflow-graph-canvas" data-workflow-graph-canvas onFocusCapture={event => {
    if (!(event.target instanceof Element)) return;
    const id = event.target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset.id;
    if (id && model.nodes.some(node => node.id === id)) onSelect(id);
  }}>
    <ReactFlow<StepNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      onNodesChange={changes => { for (const change of changes) if (change.type === "select" && change.selected) onSelect(change.id); }}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      nodesFocusable edgesFocusable={false} elementsSelectable deleteKeyCode={null}
      selectionOnDrag={false} selectNodesOnDrag={false} panOnDrag zoomOnScroll={false}
      autoPanOnNodeFocus autoPanOnNodeDrag={false} fitView fitViewOptions={fitOptions}
      minZoom={0.1} maxZoom={1.5} proOptions={{ hideAttribution: true }}
      ariaLabelConfig={{ "node.a11yDescription.default": t("Workflow step"), "controls.zoomIn.ariaLabel": t("Zoom in"),
        "controls.zoomOut.ariaLabel": t("Zoom out"), "controls.fitView.ariaLabel": t("Fit view") }}>
      <Controls showInteractive={false} position="bottom-right" fitViewOptions={{ ...fitOptions, duration: 0 }} />
    </ReactFlow>
  </div>;
}

function WorkflowStepNode({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const { t } = useI18n();
  const step = data.step;
  return <div className="workflow-graph-node" data-status={step.status} data-selected={selected || undefined}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <strong title={step.title}>{step.title}</strong>
    <WorkflowGraphStatus status={step.status} />
    <span className="workflow-graph-node-groups">
      {step.branches || step.branchGroupId ? <span><GitBranch size={12} aria-hidden="true" />{t("Branch")}</span> : null}
      {step.joins || step.joinGroupId ? <span><GitMerge size={12} aria-hidden="true" />{t("Join")}</span> : null}
    </span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
