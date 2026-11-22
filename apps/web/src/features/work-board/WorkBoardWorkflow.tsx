import type { LingAppServerWorkItemStageDecision, LingAppServerWorkItemWorkflowStages } from "@ling-stack/contracts";
import { useEffect, useState } from "react";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, InspectorSection, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import { channelWorkflowStatusPresentation, channelWorkflowStepStatusPresentation } from "../workspace/channel-workflow-status-presentation.js";
import { workSummaryInvalidatedEvent } from "../workspace/work-summary/useWorkSummary.js";

const decisionStatus = {
  not_open: "Pending",
  waiting: "Waiting for votes",
  ready: "Ready",
  quorum_unmet: "Vote quorum was not met",
  decided: "Blocked",
  cancelled: "Cancelled",
  stale: "Blocked",
} as const satisfies Record<LingAppServerWorkItemStageDecision["status"], string>;

export function WorkBoardWorkflow({ cwd, workItemId, onOpenRun }: {
  readonly cwd: string;
  readonly workItemId: string;
  readonly onOpenRun: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ workflow?: LingAppServerWorkItemWorkflowStages; error: boolean }>();
  useEffect(() => {
    if (!open) return;
    const invalidate = (event: Event) => {
      if ((event as CustomEvent<{ cwd?: string }>).detail?.cwd === cwd) setRevision(value => value + 1);
    };
    window.addEventListener(workSummaryInvalidatedEvent, invalidate);
    return () => window.removeEventListener(workSummaryInvalidatedEvent, invalidate);
  }, [cwd, open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void daemonClient.getWorkItem(cwd, workItemId, offset).then(
      value => { if (current) setResult({ workflow: value.workflow, error: false }); },
      () => { if (current) setResult({ error: true }); },
    );
    return () => { current = false; };
  }, [cwd, workItemId, offset, revision, open]);

  const workflow = result?.workflow;
  const status = workflow && channelWorkflowStatusPresentation(workflow.status);
  function showPage(nextOffset: number): void {
    setResult(undefined);
    setOffset(nextOffset);
  }
  return <InspectorSection title={t("Workflow")} summary={status && t(status.labelKey)}
    onToggle={event => setOpen(event.currentTarget.open)}>
    {!result ? <Skeleton /> : result.error || !workflow
      ? <Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>{t("Retry")}</Button>
      : <>
        {workflow.admissionBlocker ? <InlineFeedback title={t("Blocked")} tone="warning" /> : null}
        <ol className="work-board-evidence-list" start={offset + 1}>
          {workflow.steps.map(step => {
            const state = channelWorkflowStepStatusPresentation(step.status);
            return <li key={step.stepId}>
              <div><strong dir="auto">{step.title}</strong>{" "}
                {step.admissionBlocker
                  ? <StatusIndicator label={t("Blocked")} tone="warning" />
                  : <StatusIndicator label={t(state.labelKey)} tone={state.tone} />}
              </div>
              <div dir="auto">{step.participantLabel}</div>
              {step.brief ? <p dir="auto">{step.brief}</p> : null}
              {step.decision ? <StageDecision decision={step.decision} /> : null}
              {step.runId ? <Button size="sm" variant="ghost" onClick={() => onOpenRun(step.runId!)}>{t("Open run")}</Button> : null}
            </li>;
          })}
        </ol>
        {offset > 0 ? <Button size="sm" variant="ghost" onClick={() => showPage(0)}>{t("Back")}</Button> : null}
        {workflow.nextOffset !== undefined
          ? <Button size="sm" variant="ghost" onClick={() => showPage(workflow.nextOffset!)}>{t("Load more")}</Button> : null}
      </>}
  </InspectorSection>;
}

function StageDecision({ decision }: { readonly decision: LingAppServerWorkItemStageDecision }): React.JSX.Element {
  const { t } = useI18n();
  const status = decision.ballot?.tied && decision.status === "ready" ? "Tied vote" : decisionStatus[decision.status];
  return <div>
    <strong>{t("Decision")}</strong> <span dir="auto">{decision.question}</span>
    <p dir="auto">{decision.selectedOption ?? t(status)}</p>
    {decision.ballot ? <ul>
      {decision.ballot.tally.map(({ option, count }) => <li key={option} dir="auto">{option} · {count}</li>)}
    </ul> : null}
    {decision.reason ? <p dir="auto">{decision.reason}</p> : null}
  </div>;
}
