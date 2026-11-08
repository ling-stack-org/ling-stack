import { lazy, Suspense, useMemo, useState } from "react";
import {
  projectWorkflowGraph, reconcileWorkflowGraphSelection,
  type ConversationTimelineItem, type WorkflowGraphStepInput,
} from "@ling-stack/conversation-ui-core";
import { GitBranch, GitMerge, List, Network } from "lucide-react";
import { SegmentedControl, SegmentedControlItem } from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import { useDaemonObservation } from "../../../shared/conversation/observation/daemon-observation.js";
import { WorkflowGraphStatus } from "./WorkflowGraphStatus.js";
import "./workflow-graph.css";

const WorkflowGraphCanvas = lazy(() => import("./WorkflowGraphCanvas.js"));

export interface WorkflowGraphDetailProps {
  readonly workflowId: string;
  readonly steps: readonly WorkflowGraphStepInput[];
  readonly timelineItems: readonly ConversationTimelineItem[];
  readonly daemonHealthy?: boolean;
  readonly observationReady?: boolean;
}

export function WorkflowGraphDetail({ workflowId, steps, timelineItems, daemonHealthy, observationReady }: WorkflowGraphDetailProps): React.JSX.Element {
  const { t } = useI18n();
  const paused = useDaemonObservation().paused;
  const [mode, setMode] = useState("graph");
  const [selected, setSelected] = useState<string>();
  const model = useMemo(() => projectWorkflowGraph({ workflowId, steps, timelineItems,
    observation: paused || daemonHealthy === false || observationReady === false ? "stale"
      : daemonHealthy === true && observationReady === true ? "current" : "unknown" }),
  [workflowId, steps, timelineItems, paused, daemonHealthy, observationReady]);
  const selectedStepId = selected ? reconcileWorkflowGraphSelection(model, selected) : undefined;

  const list = <ol className="workflow-graph-list" aria-label={t("Workflow steps")}>
    {model.nodes.map(step => <li key={step.id}>
      <button type="button" data-workflow-step-id={step.id} aria-pressed={step.id === selectedStepId}
        onClick={() => setSelected(step.id)}>
        <span className="workflow-graph-list-copy"><strong>{step.title}</strong>
          {step.participantLabel && step.participantLabel !== step.title ? <small>{step.participantLabel}</small> : null}</span>
        <WorkflowGraphStatus status={step.status} />
        <span className="workflow-graph-list-groups">
          {step.branches || step.branchGroupId ? <GitBranch size={14} aria-label={t("Branch")} /> : null}
          {step.joins || step.joinGroupId ? <GitMerge size={14} aria-label={t("Join")} /> : null}
        </span>
      </button>
    </li>)}
  </ol>;

  return <div className="workflow-graph-detail" data-workflow-graph={workflowId} data-workflow-view={mode}
    data-observation={model.observation}>
    <div className="workflow-graph-toolbar">
      <strong>{t("Steps")} <span>{model.observation === "current" ? model.nodes.filter(step => step.status === "succeeded" || step.status === "skipped").length : "?"}/{model.nodes.length + model.omittedStepCount}</span></strong>
      <SegmentedControl value={mode} onValueChange={setMode} size="sm" aria-label={t("Workflow view")}>
        <SegmentedControlItem value="list"><List size={14} aria-hidden="true" />{t("List")}</SegmentedControlItem>
        <SegmentedControlItem value="graph">
          <Network size={14} aria-hidden="true" />{t("Graph")}</SegmentedControlItem>
      </SegmentedControl>
    </div>
    {model.observation !== "current" ? <p className="workflow-graph-notice" role="status">{t("Stale snapshot")} · {t("Unknown")}</p> : null}
    {model.omittedStepCount > 0 ? <p className="workflow-graph-notice" role="status">{t("Showing {shown} of {total} steps", { shown: model.nodes.length, total: model.nodes.length + model.omittedStepCount })}</p> : null}
    <div className="workflow-graph-visual">
      {!model.nodes.length ? <p className="workflow-graph-notice">{t("Workflow steps unavailable")} · {t("Unknown")}</p>
        : mode === "graph" ? <Suspense fallback={list}><WorkflowGraphCanvas model={model} selectedStepId={selectedStepId} onSelect={setSelected} /></Suspense> : list}
    </div>
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
