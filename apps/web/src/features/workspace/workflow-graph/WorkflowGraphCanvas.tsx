import { useEffect, useMemo, useRef, useState } from "react";
import { Controls, Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { WorkflowGraphNode, WorkflowGraphReadModel } from "@ling-stack/conversation-ui-core";
import { Bot, GitBranch, GitMerge, Maximize, Minus, Plus } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { IconButton } from "../../../shared/ui/index.js";
import { WorkflowGraphStatus, workflowGraphStatusLabel } from "./WorkflowGraphStatus.js";
import { WorkflowGraphEdge, type WorkflowDependencyEdge } from "./WorkflowGraphEdge.js";
import { layoutWorkflowGraph, workflowGraphNarrowNodeSize, workflowGraphNodeSize } from "./workflow-graph-layout.js";
import { workflowGraphEdgeStates } from "./workflow-graph-presentation.js";
import { useWorkflowGraphMotion } from "./use-workflow-graph-motion.js";

type StepNode = Node<{ step: WorkflowGraphNode; narrow: boolean }, "workflowStep">;
const nodeTypes = { workflowStep: WorkflowStepNode };
const edgeTypes = { workflowDependency: WorkflowGraphEdge };
const fitOptions = { padding: { x: "24px", top: "24px", bottom: "56px" }, maxZoom: 1 } as const;
const edgeColors = {
  pending: "var(--ling-border-strong)", running: "var(--ling-status-info)", succeeded: "var(--ling-status-success)",
  skipped: "var(--ling-text-soft)", waiting: "var(--ling-status-warning)", blocked: "var(--ling-status-warning)",
  failed: "var(--ling-status-danger)", cancelled: "var(--ling-text-soft)", unknown: "var(--ling-text-soft)",
};

export default function WorkflowGraphCanvas({ model, selectedStepId, onSelect }: {
  readonly model: WorkflowGraphReadModel;
  readonly selectedStepId?: string;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<StepNode, WorkflowDependencyEdge> | null>(null);
  const [narrow, setNarrow] = useState(false);
  const motion = useWorkflowGraphMotion(root, model.observation === "current" && model.nodes.some(node => node.status === "running"));
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      setNarrow(element.clientWidth < 560);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        void flow.current?.fitView({ ...fitOptions, duration: 0 });
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  const positions = useMemo(() => layoutWorkflowGraph(model, narrow), [model, narrow]);
  const nodeSize = narrow ? workflowGraphNarrowNodeSize : workflowGraphNodeSize;
  const nodes: StepNode[] = useMemo(() => model.nodes.map(step => ({
    id: step.id, type: "workflowStep", data: { step, narrow }, position: positions.get(step.id)!,
    width: nodeSize.width, height: nodeSize.height,
    // Fixed geometry retains handle measurements when a polling snapshot replaces node data.
    measured: nodeSize,
    selected: step.id === selectedStepId, draggable: false, connectable: false, deletable: false,
    ariaLabel: `${step.title} · ${t(workflowGraphStatusLabel(step.status))}`,
  })), [model, positions, narrow, nodeSize, selectedStepId, t]);
  const edges: WorkflowDependencyEdge[] = useMemo(() => {
    const states = workflowGraphEdgeStates(model);
    const steps = new Map(model.nodes.map(node => [node.id, node]));
    return model.edges.map(edge => {
      const status = states.get(edge.id)!;
      return { ...edge, type: "workflowDependency", data: { status }, selectable: false, deletable: false,
        animated: false, markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[status], width: 14, height: 14 },
        ariaLabel: `${steps.get(edge.source)?.title} → ${steps.get(edge.target)?.title}` };
    });
  }, [model]);
  return <div className="workflow-graph-canvas" ref={root} data-workflow-graph-canvas data-layout={narrow ? "vertical" : "horizontal"}
    data-motion={motion ? "running" : "paused"} onFocusCapture={event => {
    if (!(event.target instanceof Element)) return;
    const id = event.target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset.id;
    if (id && model.nodes.some(node => node.id === id)) onSelect(id);
  }}>
    <ReactFlow<StepNode, WorkflowDependencyEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onInit={instance => { flow.current = instance; }}
      onNodeClick={(_, node) => onSelect(node.id)}
      onNodesChange={changes => { for (const change of changes) if (change.type === "select" && change.selected) onSelect(change.id); }}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      nodesFocusable edgesFocusable={false} elementsSelectable deleteKeyCode={null}
      selectionOnDrag={false} selectNodesOnDrag={false} panOnDrag zoomOnScroll={false}
      autoPanOnNodeFocus autoPanOnNodeDrag={false} fitView fitViewOptions={fitOptions}
      minZoom={0.1} maxZoom={1.5} proOptions={{ hideAttribution: true }}
      ariaLabelConfig={{ "node.a11yDescription.default": t("Workflow step"), "controls.zoomIn.ariaLabel": t("Zoom in"),
        "controls.zoomOut.ariaLabel": t("Zoom out"), "controls.fitView.ariaLabel": t("Fit view") }}>
      <Controls showInteractive={false} showZoom={false} showFitView={false} position="bottom-right">
        <IconButton icon={Plus} label={t("Zoom in")} onClick={() => void flow.current?.zoomIn({ duration: 0 })} />
        <IconButton icon={Minus} label={t("Zoom out")} onClick={() => void flow.current?.zoomOut({ duration: 0 })} />
        <IconButton icon={Maximize} label={t("Fit view")} onClick={() => void flow.current?.fitView({ ...fitOptions, duration: 0 })} />
      </Controls>
    </ReactFlow>
  </div>;
}

function WorkflowStepNode({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const { t } = useI18n();
  const step = data.step;
  return <div className="workflow-graph-node" data-status={step.status} data-selected={selected || undefined}>
    <Handle type="target" position={data.narrow ? Position.Top : Position.Left} isConnectable={false} />
    <div className="workflow-graph-node-heading"><Bot size={17} aria-hidden="true" /><strong title={step.title}>{step.title}</strong></div>
    <small className="workflow-graph-node-participant" title={step.participantLabel}>
      {step.participantLabel !== step.title ? step.participantLabel : null}
    </small>
    <div className="workflow-graph-node-footer"><WorkflowGraphStatus status={step.status} />
      <span className="workflow-graph-node-groups">
        {step.branches || step.branchGroupId ? <span title={t("Branch")}><GitBranch size={12} aria-label={t("Branch")} /></span> : null}
        {step.joins || step.joinGroupId ? <span title={t("Join")}><GitMerge size={12} aria-label={t("Join")} /></span> : null}
      </span>
    </div>
    <Handle type="source" position={data.narrow ? Position.Bottom : Position.Right} isConnectable={false} />
  </div>;
}
