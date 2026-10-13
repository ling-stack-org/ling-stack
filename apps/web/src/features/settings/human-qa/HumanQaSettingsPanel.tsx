import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RunEvaluationHumanSubmissionV1 } from "@ling-stack/contracts";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Select, Textarea } from "../../../shared/ui/index.js";
import { canSubmitHumanQa, createHumanQaController, validHumanQaRationale, type HumanQaState } from "./human-qa-controller.js";

type Controller = ReturnType<typeof createHumanQaController>;

/** QA only. Opening this disclosure performs reads, never model calls or human authentication. */
export function HumanQaSettingsPanel({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const capability = typeof window === "undefined" ? undefined : window.lingDesktop?.humanEvaluation;
  const controller = useMemo(() => createHumanQaController(capability, cwd), [capability, cwd]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) void controller.activate();
    return () => controller.suspend();
  }, [controller, open]);
  return <details className="settings-human-qa" open={open}
    onToggle={event => setOpen(event.currentTarget.open)} data-human-qa-panel="">
    <summary>{t("Dedicated QA evaluation")}</summary>
    {open ? <HumanQaSettingsView state={state} controller={controller} /> : null}
  </details>;
}

export function HumanQaSettingsView({ state, controller }: {
  readonly state: HumanQaState; readonly controller: Controller;
}): React.JSX.Element {
  const { t } = useI18n();
  const busy = !!state.busy;
  const snapshot = state.snapshot;
  const selected = state.items.find(row => row.taskId === state.selectedTaskId);
  const unknown = snapshot?.lastSubmission === "unknown" || snapshot?.lastSubmission === "pending";
  return <div className="settings-human-qa-content" aria-busy={busy}>
    <p>{t("Only enrolled QA cases and reviewed, redacted artifacts. No daily conversations are collected. Reports do not authorize promotion.")}</p>
    {state.phase === "unavailable" ? <InlineFeedback tone="warning">{t("Human QA requires the packaged macOS Desktop client and its native confirmation helper.")}</InlineFeedback> : <>
      <div className="settings-human-qa-actions">
        <Button variant="secondary" disabled={busy} onClick={() => void controller.refresh()}>{t("Refresh QA cases")}</Button>
        {state.nextAfterEnrollmentId ? <Button variant="secondary" disabled={busy} onClick={() => void controller.loadMore()}>{t("Load more QA cases")}</Button> : null}
      </div>
      {busy ? <p role="status">{state.busy === "submit" ? t("Waiting for system confirmation and Host readback...") : t("Reading QA facts...")}</p> : null}
      {state.issue ? <InlineFeedback tone="warning" title={t("QA needs attention")}>{issueText(state.issue, t)}</InlineFeedback> : null}
      {state.phase === "ready" && !state.items.length ? <p>{t("No enrolled QA cases in this workspace. Ordinary runs are not included.")}</p> : null}
      <div className="settings-human-qa-layout">
        <div className="settings-human-qa-list" aria-label={t("Enrolled QA cases")}>
          {state.items.map(row => <Button key={row.enrollmentId} variant="ghost" disabled={busy}
            aria-pressed={state.selectedTaskId === row.taskId} onClick={() => void controller.select(row.taskId)}>
            <span><strong>{row.suiteId} / {row.caseId}</strong><small>{row.taskId} · {row.taskState}</small></span>
          </Button>)}
        </div>
        {selected ? <section className="settings-human-qa-item" aria-label={t("Selected QA case")}>
          <h3>{selected.suiteId} / {selected.caseId}</h3>
          <p>{t("Task")} <code>{selected.taskId}</code> · {t("Evaluation")} <code>{selected.evaluationId}</code></p>
          <div className="settings-human-qa-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void controller.inspect()}>{t("Inspect submission and history")}</Button>
            {state.busy === "submit" ? <Button variant="secondary" onClick={() => void controller.cancel()}>{t("Cancel confirmation")}</Button> : null}
          </div>
          {unknown ? <InlineFeedback tone="warning">{t("Submission is pending or unknown. Inspect before proceeding; do not submit again. Cancellation does not prove a committed event was rolled back.")}</InlineFeedback> : null}
          {snapshot?.head ? <p>{t("Current human event")} <code>{snapshot.head.eventId}</code> · r{snapshot.head.revision} · {snapshot.head.state}</p> : null}
          {snapshot?.head?.state === "revoked" ? <InlineFeedback tone="info">{t("This human decision was revoked. The prior decision and reports remain historical; no new decision is submitted automatically.")}</InlineFeedback> : null}
          {snapshot ? <HumanQaFeedbackForm key={`${snapshot.taskId}:${snapshot.head?.revision ?? 0}`}
            state={state} onSubmit={submission => void controller.submit(submission)} /> : null}
          {snapshot?.events.length ? <details className="settings-human-qa-history"><summary>{t("Human decision history")} ({snapshot.events.length})</summary>
            <ol>{snapshot.events.map(event => <li key={event.id}>
              <span>r{event.revision} · {event.submission.kind} · <code>{event.id}</code></span>
              <p>{event.submission.kind === "revoke" ? event.submission.rationale : `${event.submission.decision.verdict}: ${event.submission.decision.rationale}`}</p>
            </li>)}</ol>
          </details> : null}
          {snapshot?.nextAfterRevision !== undefined ? <Button variant="secondary" disabled={busy} onClick={() => void controller.loadMoreHistory()}>{t("Load more decision history")}</Button> : null}
          {snapshot?.headEvent ? <Button variant="secondary" disabled={busy} onClick={() => void controller.generateReport()}>{t("Generate a new report for this event")}</Button> : null}
          {state.report ? <HumanQaReportView state={state} /> : null}
        </section> : null}
      </div>
    </>}
  </div>;
}

function HumanQaFeedbackForm({ state, onSubmit }: {
  readonly state: HumanQaState; readonly onSubmit: (submission: RunEvaluationHumanSubmissionV1) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [kind, setKind] = useState<"correct" | "revoke">("correct");
  const [verdict, setVerdict] = useState<"pass" | "fail" | "abstain" | "error">("abstain");
  const [rationale, setRationale] = useState("");
  const enabled = canSubmitHumanQa(state);
  const head = state.snapshot?.head;
  return <form className="settings-human-qa-form" onSubmit={event => {
    event.preventDefault();
    if (!enabled || !validHumanQaRationale(rationale)) return;
    const decision = { verdict, rationale };
    onSubmit(!head ? { kind: "adjudicate", decision } : kind === "correct"
      ? { kind: "correct", supersedesEventId: head.eventId, decision }
      : { kind: "revoke", revokesEventId: head.eventId, rationale });
  }}>
    {head?.state === "active" ? <Field label={t("Feedback action")}><Select aria-label={t("Feedback action")} value={kind} disabled={!enabled}
      onChange={event => setKind(event.target.value as "correct" | "revoke")}>
      <option value="correct">{t("Correct current decision")}</option><option value="revoke">{t("Revoke current decision")}</option>
    </Select></Field> : null}
    {!head || kind === "correct" ? <Field label={t("Verdict")}><Select aria-label={t("Verdict")} value={verdict} disabled={!enabled}
      onChange={event => setVerdict(event.target.value as typeof verdict)}>
      <option value="abstain">{t("Abstain")}</option><option value="pass">{t("Pass")}</option>
      <option value="fail">{t("Fail")}</option><option value="error">{t("Error")}</option>
    </Select></Field> : null}
    <Field label={t("Rationale")} description={t("Do not include secrets or daily conversation content. The system confirmation shows the frozen Host payload.")}>
      <Textarea aria-label={t("Rationale")} value={rationale} maxLength={2000} rows={4} disabled={!enabled}
        onChange={event => setRationale(event.target.value)} />
    </Field>
    <Button type="submit" variant="primary" disabled={!enabled || !validHumanQaRationale(rationale)}>{t("Submit for system confirmation")}</Button>
  </form>;
}

function HumanQaReportView({ state }: { readonly state: HumanQaState }): React.JSX.Element {
  const { t } = useI18n();
  const { report, currentness } = state.report!;
  const event = report.event;
  return <section className="settings-human-qa-report" aria-label={t("Fixed human QA report")}>
    <h3>{t("Fixed human QA report")}</h3>
    <InlineFeedback tone={currentness === "current" ? "info" : "warning"}>
      {currentness === "current" ? t("Current event. Report-only; not promotion authority.") : currentness === "stale"
        ? t("Historical report: the event was corrected or revoked. Its contents have not been changed.")
        : t("Report currentness unavailable. This historical report is not refreshed or trusted as current.")}
    </InlineFeedback>
    <p>{event.submission.kind === "revoke" ? event.submission.rationale : `${event.submission.decision.verdict}: ${event.submission.decision.rationale}`}</p>
    <dl><Detail name={t("Event")} value={`${report.ref.eventId} · r${report.ref.revision}`} />
      <Detail name={t("Enrollment")} value={report.lineage.enrollmentId} />
      <Detail name={t("Audit")} value={`${report.audit.seq} · ${report.audit.action}`} />
      <Detail name={t("Payload digest")} value={report.intent.payloadDigest} />
      <Detail name={t("Report digest")} value={report.reportDigest} />
      <Detail name={t("Configuration digest")} value={report.lineage.configDigest} />
      <Detail name={t("Rubric")} value={`${report.lineage.rubric.id} · ${report.lineage.rubric.version}`} /></dl>
  </section>;
}
function Detail({ name, value }: { readonly name: string; readonly value: string }): React.JSX.Element {
  return <div><dt>{name}</dt><dd><code>{value}</code></dd></div>;
}
function issueText(issue: HumanQaState["issue"], t: (key: string) => string): string {
  switch (issue) {
    case "scope_mismatch": return t("The QA Host belongs to a different workspace. No QA data is displayed.");
    case "submission_unknown": return t("Submission outcome is unknown. Inspect only; do not submit again.");
    case "cancelled": return t("System confirmation was cancelled.");
    case "native_unavailable": return t("The native confirmation helper is unavailable. No token-only fallback is allowed.");
    case "confirmation_failed": return t("System confirmation failed. No human decision was accepted.");
    case "authority_changed": case "unauthorized_sender": return t("Window or session authority changed. Read the current QA facts again.");
    case "invalid_submission": case "invalid_request": return t("Check the current event and feedback fields before submitting.");
    case "busy": return t("Another confirmation is still active. Wait for it to finish.");
    default: return t("QA facts are unavailable or invalid. No success or current report is inferred.");
  }
}
