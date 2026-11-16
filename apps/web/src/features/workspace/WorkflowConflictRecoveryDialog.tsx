import { useEffect, useRef } from "react";
import { GitBranch, GitPullRequestArrow, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { canRetryWorkflowConflictRecoveryPlanning, validWorkflowRepairInstruction } from "../../lib/workflow-conflict-recovery.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, InlineFeedback, Textarea } from "../../shared/ui/index.js";
import type { WorkflowConflictRecoveryController } from "./useWorkflowConflictRecovery.js";
import "./workflow-conflict-recovery.css";

export function WorkflowConflictRecoveryDialog({ controller }: { readonly controller: WorkflowConflictRecoveryController }): React.JSX.Element | null {
  const { t } = useI18n();
  const returnFocusRef = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const instructionRef = useRef<HTMLTextAreaElement | null>(null);
  const { session, phase, busy, connected } = controller;
  useEffect(() => {
    if (phase === "editing" && connected) instructionRef.current?.focus({ preventScroll: true });
  }, [phase, connected]);
  if (!session || !phase) return null;
  const response = session.response;
  const canStart = phase === "ready" && response?.workflow.status === "ready"
    && response.workflowSteps.every(step => step.status === "queued" && !step.runId && !step.taskId);
  const canRetry = canRetryWorkflowConflictRecoveryPlanning(phase, response);
  const statusKey = !connected ? "Daemon unavailable" : phase === "checking" ? "Checking recovery..."
    : phase === "creating" ? "Creating repair plan..." : phase === "unknown" ? "Repair result unconfirmed"
    : phase === "retry" || phase === "planning" ? canRetry ? "Repair planning incomplete" : "Repair plan retained"
    : phase === "unavailable" ? "Repair unavailable for this round"
    : phase === "starting" ? "Starting repair workflow..." : phase === "started" ? "Repair start requested"
    : phase === "ready" ? canStart ? "Repair plan ready; not started" : "Repair plan retained" : "Integration conflicted";
  return <Dialog open busy={busy} onOpenChange={open => { if (!open) controller.close(); }}>
    <DialogContent size="md" className="workflow-conflict-recovery-dialog" aria-label={t("Repair workflow conflict")}
      onCloseAutoFocus={event => {
        event.preventDefault();
        globalThis.requestAnimationFrame(() => {
          const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-workflow-conflict-recovery]"))
            .find(button => button.dataset.workflowConflictRecovery === session.workflow.id);
          const target = trigger ?? (returnFocusRef.current?.isConnected ? returnFocusRef.current : null);
          target?.focus({ preventScroll: true });
        });
      }}>
      <form onSubmit={event => { event.preventDefault(); if (phase === "editing") void controller.submit(); }}>
        <DialogHeader title={t("Repair workflow conflict")} closeLabel={t("Close")} />
        <DialogBody className="workflow-conflict-recovery-body">
          <strong>{session.workflow.title}</strong>
          <p role="status">{t(statusKey)}</p>
          <dl>
            <div><dt>{t("Integration round")}</dt><dd>{session.round.roundId}</dd></div>
            {response ? <div><dt>{t("Repair plan {sequence}", { sequence: response.recovery.sequence })}</dt><dd>{response.workflow.id}</dd></div> : null}
            <div><dt>{t("Mode")}</dt><dd>{t("Candidate-only round")}</dd></div>
          </dl>
          <Field label={t("Repair requirements")}>
            <Textarea ref={instructionRef} aria-label={t("Repair requirements")} value={session.instruction} maxLength={4000} rows={6}
              readOnly={phase !== "editing" || Boolean(session.request)} disabled={busy || !connected}
              onChange={event => controller.setInstruction(event.target.value)} />
          </Field>
          {session.error ? <InlineFeedback tone="danger" role="alert">{session.error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter className="workflow-conflict-recovery-footer">
          <Button type="button" size="sm" disabled={busy} onClick={controller.close}>{t("Close")}</Button>
          {["unknown", "retry", "planning", "ready", "unavailable", "started"].includes(phase) ?
            <Button type="button" size="sm" leadingIcon={<Search size={14} />} disabled={busy || !connected} onClick={() => void controller.check()}>{t("Check recovery")}</Button> : null}
          {canRetry ?
            <Button type="button" size="sm" variant="primary" leadingIcon={<RotateCcw size={14} />} disabled={busy || !connected}
              onClick={() => void controller.retry()}>{t("Retry repair planning")}</Button> : null}
          {phase === "editing" || phase === "creating" ?
            <Button type="submit" size="sm" variant="primary" leadingIcon={<GitPullRequestArrow size={14} />} loading={phase === "creating"}
              loadingLabel={t("Creating repair plan...")} disabled={busy || !connected || !validWorkflowRepairInstruction(session.instruction)}>{t("Create repair plan")}</Button> : null}
          {canStart || phase === "starting" ?
            <Button type="button" size="sm" variant="primary" leadingIcon={phase === "starting" ? <RefreshCw size={14} /> : <GitBranch size={14} />}
              loading={phase === "starting"} loadingLabel={t("Starting repair workflow...")} disabled={busy || !connected}
              onClick={() => void controller.start()}>{t("Start isolated branches (candidate only)")}</Button> : null}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
