import { LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS, type LingAppServerStageHandoffProgress,
  type LingAppServerStageHandoffReturnReason, type LingAppServerWorkItemStageDecision,
  type LingAppServerWorkItemWorkflowStages } from "@ling-stack/contracts";
import { useEffect, useRef, useState } from "react";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, InspectorSection, Select, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
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

const handoffStatus = {
  awaiting_source: "Waiting for source",
  awaiting_acceptance: "Awaiting acceptance",
  accepted: "Accepted",
  returned: "Returned for repair",
} as const satisfies Record<LingAppServerStageHandoffProgress["status"], string>;

const handoffReasons = {
  missing_artifact: "Missing artifact",
  required_check_incomplete: "Required check incomplete",
  candidate_stale: "Candidate changed",
  scope_unavailable: "Scope unavailable",
  upstream_effect_unknown: "Upstream result unconfirmed",
} as const satisfies Record<LingAppServerStageHandoffReturnReason, string>;

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
            const recipientUnavailable = step.admissionBlocker === "work_item_handoff_recipient_unavailable";
            return <li key={step.stepId}>
              <div><strong dir="auto">{step.title}</strong>{" "}
                {step.admissionBlocker
                  ? <StatusIndicator label={t("Blocked")} tone="warning" />
                  : <StatusIndicator label={t(state.labelKey)} tone={state.tone} />}
              </div>
              <div dir="auto">{step.participantLabel}{" "}
                {recipientUnavailable ? <StatusIndicator label={t("Unavailable")} tone="warning" /> : null}
              </div>
              {step.brief ? <p dir="auto">{step.brief}</p> : null}
              {step.decision ? <StageDecision decision={step.decision} /> : null}
              {step.handoffs?.map(handoff => <StageHandoff
                key={JSON.stringify([handoff.sourceStepId, handoff.sourceRevision])}
                cwd={cwd} workItemId={workItemId} workflow={workflow} step={step} handoff={handoff}
                onRefresh={() => setRevision(value => value + 1)} />)}
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

function StageHandoff({ cwd, workItemId, workflow, step, handoff, onRefresh }: {
  readonly cwd: string;
  readonly workItemId: string;
  readonly workflow: LingAppServerWorkItemWorkflowStages;
  readonly step: LingAppServerWorkItemWorkflowStages["steps"][number];
  readonly handoff: LingAppServerStageHandoffProgress;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState<LingAppServerStageHandoffReturnReason | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lastRequest = useRef<{ fingerprint: string; key: string }>(undefined);
  const recipientUnavailable = step.admissionBlocker === "work_item_handoff_recipient_unavailable";
  const canDecide = handoff.status === "awaiting_acceptance" && step.status === "queued" && !workflow.admissionBlocker
    && step.admissionBlocker !== "work_item_plan_change_pending" && workflow.workItemRevision !== undefined;

  async function settle(action: "accepted" | "returned"): Promise<void> {
    if (busy || !canDecide || workflow.workItemRevision === undefined
      || (action === "accepted" ? recipientUnavailable : !reason)) return;
    const decisionReason = action === "returned" && reason ? reason : undefined;
    const fingerprint = JSON.stringify([action, decisionReason, workflow.workItemRevision, step.updatedAt]);
    const key = lastRequest.current?.fingerprint === fingerprint ? lastRequest.current.key : crypto.randomUUID();
    lastRequest.current = { fingerprint, key };
    setBusy(true);
    setError(false);
    try {
      await daemonClient.settleWorkItemStageHandoff(cwd, workItemId, action, {
        planRevision: workflow.planRevision, sourceStepId: handoff.sourceStepId, targetStepId: step.stepId,
        expectedSourceRevision: handoff.sourceRevision, expectedTargetRevision: step.updatedAt,
        expectedWorkItemRevision: workflow.workItemRevision, idempotencyKey: key, reason: decisionReason,
      });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  return <div>
    <strong>{t("Handoff")}</strong>{handoff.sourceStageId ? <span dir="auto"> {handoff.sourceStageId}</span> : null}
    {" "}<StatusIndicator label={t(handoffStatus[handoff.status])} tone={handoff.status === "returned" ? "warning" : "neutral"} />
    {handoff.reason ? <p>{t(handoffReasons[handoff.reason])}</p> : null}
    {canDecide ? <div>
      <Button size="sm" variant="ghost" disabled={busy || recipientUnavailable} onClick={() => void settle("accepted")}>{t("Accept handoff")}</Button>
      <Select aria-label={t("Return reason")} size="sm" disabled={busy} value={reason}
        onChange={event => setReason(event.target.value as typeof reason)}>
        <option value="">{t("Return reason")}</option>
        {LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS.map(choice =>
          <option key={choice} value={choice}>{t(handoffReasons[choice])}</option>)}
      </Select>
      <Button size="sm" variant="ghost" disabled={busy || !reason} onClick={() => void settle("returned")}>{t("Return handoff")}</Button>
    </div> : null}
    {error ? <InlineFeedback title={t("Could not update handoff")} tone="warning" /> : null}
  </div>;
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
