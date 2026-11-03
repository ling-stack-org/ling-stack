import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  projectWorkflowGraph, reconcileWorkflowGraphSelection, workflowGraphStatus,
  type ConversationProtocolAction, type ConversationTimelineApprovalItem, type ConversationTimelineItem,
  type ConversationTimelineProtocolEventItem, type WorkflowGraphStepInput,
} from "@ling-stack/conversation-ui-core";
import { Eye, GitBranch, GitMerge, List, Network } from "lucide-react";
import { SegmentedControl, SegmentedControlItem } from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import { useDaemonObservation } from "../../../shared/conversation/observation/daemon-observation.js";
import { ConversationTimelineProtocolActions } from "../../../shared/conversation/timeline/ConversationTimelineProtocolActions.js";
import { WorkflowGraphStatus, workflowGraphIssueLabel } from "./WorkflowGraphStatus.js";
import "./workflow-graph.css";

const WorkflowGraphCanvas = lazy(() => import("./WorkflowGraphCanvas.js"));

export interface WorkflowGraphDetailProps {
  readonly workflowId: string;
  readonly steps: readonly WorkflowGraphStepInput[];
  readonly timelineItems: readonly ConversationTimelineItem[];
  readonly stepProtocolItems: ReadonlyMap<string, ConversationTimelineProtocolEventItem>;
  readonly daemonHealthy?: boolean;
  readonly observationReady?: boolean;
  readonly onInvokeProtocolAction?: (item: ConversationTimelineProtocolEventItem | ConversationTimelineApprovalItem, action: ConversationProtocolAction) => void | Promise<void>;
  readonly onRevealFacts?: (ids: readonly string[]) => void;
}

export function WorkflowGraphDetail({ workflowId, steps, timelineItems, stepProtocolItems, daemonHealthy, observationReady, onInvokeProtocolAction, onRevealFacts }: WorkflowGraphDetailProps): React.JSX.Element {
  const { t } = useI18n();
  const paused = useDaemonObservation().paused;
  const root = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const [mode, setMode] = useState("list");
  const [narrow, setNarrow] = useState(false);
  const [selected, setSelected] = useState<string>();
  const model = useMemo(() => projectWorkflowGraph({ workflowId, steps, timelineItems,
    observation: paused || daemonHealthy === false || observationReady === false ? "stale"
      : daemonHealthy === true && observationReady === true ? "current" : "unknown" }),
  [workflowId, steps, timelineItems, paused, daemonHealthy, observationReady]);
  const selectedStepId = reconcileWorkflowGraphSelection(model, selected);
  const node = model.nodes.find(candidate => candidate.id === selectedStepId);
  const protocol = node ? stepProtocolItems.get(node.id) : undefined;
  const view = narrow ? "list" : mode;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setNarrow(element.getBoundingClientRect().width < 520);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const list = <ol className="workflow-graph-list" aria-label={t("Workflow steps")}>
    {model.nodes.map(step => <li key={step.id}>
      <button type="button" data-workflow-step-id={step.id} aria-pressed={step.id === selectedStepId} aria-controls={detailId}
        onClick={() => setSelected(step.id)}>
        <span className="workflow-graph-list-copy"><strong>{step.title}</strong>
          <small>{step.participantLabel ?? step.id}</small></span>
        <WorkflowGraphStatus status={step.status} />
        <span className="workflow-graph-list-groups">
          {step.branches || step.branchGroupId ? <GitBranch size={14} aria-label={t("Branch")} /> : null}
          {step.joins || step.joinGroupId ? <GitMerge size={14} aria-label={t("Join")} /> : null}
        </span>
      </button>
    </li>)}
  </ol>;

  return <div ref={root} className="workflow-graph-detail" data-workflow-graph={workflowId} data-workflow-view={view}
    data-observation={model.observation}>
    <div className="workflow-graph-toolbar">
      <strong>{t("Steps")} <span>{model.nodes.length}</span></strong>
      <SegmentedControl value={view} onValueChange={setMode} size="sm" aria-label={t("Workflow view")}>
        <SegmentedControlItem value="list"><List size={14} aria-hidden="true" />{t("List")}</SegmentedControlItem>
        <SegmentedControlItem value="graph" disabled={narrow} title={narrow ? t("Graph requires a wider view") : undefined}>
          <Network size={14} aria-hidden="true" />{t("Graph")}</SegmentedControlItem>
      </SegmentedControl>
    </div>
    {model.observation !== "current" ? <p className="workflow-graph-notice" role="status">{t("Stale snapshot")} · {t("Unknown")}</p> : null}
    {model.omittedStepCount > 0 ? <p className="workflow-graph-notice" role="status">{t("Showing {shown} of {total} steps", { shown: model.nodes.length, total: model.nodes.length + model.omittedStepCount })}</p> : null}
    {!model.nodes.length ? <p className="workflow-graph-notice">{t("Workflow steps unavailable")} · {t("Unknown")}</p>
      : view === "graph" ? <Suspense fallback={list}><WorkflowGraphCanvas model={model} selectedStepId={selectedStepId} onSelect={setSelected} /></Suspense> : list}
    {node ? <section id={detailId} className="workflow-graph-selection" aria-label={t("Selected step")} data-selected-step-id={node.id}>
      <div className="workflow-graph-selection-heading"><h4>{node.title}</h4><WorkflowGraphStatus status={node.status} /></div>
      <dl>
        <div><dt>{t("Step ID")}</dt><dd>{node.id}</dd></div>
        <div><dt>{t("Dependencies")}</dt><dd>{node.issues.includes("dependencies_unavailable") ? t("Unknown")
          : node.dependencyIds.length ? node.dependencyIds.map(id => model.nodes.find(step => step.id === id)?.title ?? `${id} (${t("Unknown")})`).join(", ") : t("None")}</dd></div>
        {node.dependencyMode ? <div><dt>{t("Dependency mode")}</dt><dd>{node.dependencyMode}</dd></div> : null}
        {node.branchGroupId ? <div><dt>{t("Branch")}</dt><dd>{node.branchGroupId}</dd></div> : null}
        {node.joinGroupId ? <div><dt>{t("Join")}</dt><dd>{node.joinGroupId}</dd></div> : null}
      </dl>
      {node.issues.length ? <p className="workflow-graph-notice">{node.issues.map(issue => t(workflowGraphIssueLabel(issue))).join(" · ")}</p> : null}
      {node.status === "unknown" ? <div className="workflow-graph-last-status">{t("Last observed")}: <WorkflowGraphStatus status={workflowGraphStatus(node.reportedStatus)} /></div> : null}
      {node.blocker ? <p className="workflow-graph-blocker">{node.blocker}</p> : null}
      {node.resultSummary ? <p className="workflow-graph-result">{node.resultSummary}</p> : null}
      {protocol ? <ConversationTimelineProtocolActions item={protocol} onInvoke={onInvokeProtocolAction} /> : null}
      {node.approvals.map(approval => <div key={approval.id} className="workflow-graph-approval"><strong>{approval.title}</strong>
        <ConversationTimelineProtocolActions item={approval} onInvoke={onInvokeProtocolAction} /></div>)}
      {onRevealFacts ? <button type="button" className="secondary-button compact-button" disabled={!node.factIds.length}
        onClick={() => onRevealFacts(node.factIds)}><Eye size={14} aria-hidden="true" />{t("Show step facts")}</button> : null}
    </section> : null}
    {model.overlay.length ? <section className="workflow-graph-overlay" aria-label={t("Dynamic collaboration overlay")}>
      <h4>{t("Dynamic collaboration overlay")}</h4>
      <ul>{model.overlay.map(item => <li key={item.id} data-overlay-fact-id={item.factId}>
        <span>{item.title}<small>{model.nodes.find(step => step.id === item.stepId)?.title}</small></span>
        <WorkflowGraphStatus status={item.status} />
      </li>)}</ul>
    </section> : null}
    {model.factsTruncated ? <p className="workflow-graph-notice">{t("Additional facts omitted")}</p> : null}
  </div>;
}
