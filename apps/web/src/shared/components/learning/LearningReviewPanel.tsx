import { useEffect, useState } from "react";
import { BookOpen, RefreshCw, Save } from "lucide-react";
import { getSkillCandidate } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { LearningReviewJob, SkillCandidate } from "../../../types.js";
import { Button, Field, InlineFeedback, Select, Textarea } from "../../ui/index.js";
import { useLearningReviews } from "./useLearningReviews.js";
import "./learning-review.css";

/** Closed conversation disclosures perform no reads and render no empty result cards. */
export function LearningReviewDisclosure(props: { readonly cwd: string; readonly runId?: string; readonly decisionId?: string;
  readonly onReviewCandidate?: (id: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <details className="learning-review-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("Experience review")}</summary>
    {open ? <LearningReviewPanel {...props} /> : null}
  </details>;
}

export function LearningReviewPanel(props: { readonly cwd: string; readonly runId?: string; readonly decisionId?: string;
  readonly onReviewCandidate?: (id: string) => void }): React.JSX.Element {
  return <LearningReviewPanelContent key={`${props.cwd}:${props.runId ?? props.decisionId ?? "workspace"}`} {...props} />;
}

function LearningReviewPanelContent({ cwd, runId, decisionId, onReviewCandidate }: {
  readonly cwd: string; readonly runId?: string; readonly decisionId?: string; readonly onReviewCandidate?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const state = useLearningReviews(cwd, runId, decisionId);
  const [correction, setCorrection] = useState("");
  return <section className="learning-review-panel" aria-label={t("Experience review")}>
    <header className="learning-review-toolbar">
      <strong><BookOpen size={15} aria-hidden /> {t("Experience review")}</strong>
      <Button size="sm" variant="ghost" leadingIcon={<RefreshCw size={14} />} disabled={Boolean(state.busy)} onClick={() => void state.refresh()}>{t("Refresh")}</Button>
    </header>
    <p>{t("Learning proposes reviewable changes. Skills and memories stay unchanged until review.")}</p>
    <Field label={t("Learning model")}>
      <Select value={state.providerId} disabled={Boolean(state.busy)} onChange={event => state.setProviderId(event.target.value)}>
        <option value="">{t("Select a learning model")}</option>
        {state.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>)}
      </Select>
    </Field>
    {state.policy && state.providers.length === 0 ? <InlineFeedback tone="info">{t("Configure a chat provider without reasoning to save experience.")}</InlineFeedback> : null}
    {runId || decisionId ? <>
      {runId ? <Field label={t("Correction for the selected skill (optional)")}>
        <Textarea rows={2} maxLength={4000} value={correction} disabled={Boolean(state.busy)} onChange={event => setCorrection(event.target.value)} />
      </Field> : null}
      <Button size="sm" variant="primary" leadingIcon={<Save size={14} />} disabled={!state.policy || !state.sourceAvailable || !state.providerId || Boolean(state.busy)}
        loading={state.busy === "save"} onClick={() => void state.save(correction)}>{t("Save experience")}</Button>
      <small>{decisionId ? t("Uses only the selected confirmed decision and one bounded model review.") : t("Uses the selected run evidence and one bounded model review. A correction requires a skill used in that run.")}</small>
      {state.policy && !state.sourceAvailable ? <InlineFeedback tone="info">{t("This source has no completed task evidence available for learning.")}</InlineFeedback> : null}
    </> : <div className="learning-review-toolbar">
      <span>{state.policy?.mode === "propose" ? t("Automatic proposals enabled") : t("Automatic learning is off")}</span>
      <Button size="sm" disabled={!state.policy || Boolean(state.busy) || (state.policy.mode === "off" && !state.providerId)}
        loading={state.busy === "policy"} onClick={() => void state.setMode(state.policy?.mode === "propose" ? "off" : "propose")}>
        {state.policy?.mode === "propose" ? t("Turn off automatic learning") : t("Enable automatic proposals")}
      </Button>
    </div>}
    {state.error ? <InlineFeedback tone="danger">{state.error}</InlineFeedback> : null}
    <div aria-live="polite" aria-atomic="false" className="learning-review-jobs">
      {state.jobs.map(job => <LearningReviewResult key={job.id} cwd={cwd} job={job} busy={Boolean(state.busy)}
        onCancel={() => void state.cancel(job.id)} onReviewCandidate={onReviewCandidate} />)}
      {state.policy && state.jobs.length === 0 ? <small>{t("No experience reviews yet")}</small> : null}
    </div>
  </section>;
}

function LearningReviewResult({ cwd, job, busy, onCancel, onReviewCandidate }: {
  readonly cwd: string; readonly job: LearningReviewJob; readonly busy: boolean; readonly onCancel: () => void;
  readonly onReviewCandidate?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const pending = job.status === "queued" || job.status === "running";
  const label = pending ? t("Reviewing selected experience") : job.status === "cancelled" ? t("Experience review cancelled") :
    job.status === "failed" ? t("Experience review failed") : job.candidateIds.length ? t("Experience available for review") : t("No reusable experience found");
  return <article className="learning-review-result" data-learning-job-id={job.id}>
    <div className="learning-review-toolbar"><strong>{label}</strong>
      {pending ? <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button> : null}
    </div>
    <small>{job.evidence.decisionId ? t("Decision") : t("Run")}: {job.evidence.decisionId ?? job.evidence.runId}</small>
    {job.candidateIds.map(id => <LearningCandidate key={id} cwd={cwd} candidateId={id} onReviewCandidate={onReviewCandidate} />)}
    <details><summary>{t("Review evidence")}</summary>
      <p>{t("Extracted from recorded evidence; not verified by a new execution.")}</p>
      {job.reason ? <p>{job.reason}</p> : null}
      {job.evidence.items.map(item => <details key={item.id}><summary>{item.kind} · {item.id}</summary><pre>{item.text}</pre></details>)}
      {job.evidence.missing.length > 0 ? <p>{job.evidence.missing.join(", ")}</p> : null}
    </details>
  </article>;
}

function LearningCandidate({ cwd, candidateId, onReviewCandidate }: {
  readonly cwd: string; readonly candidateId: string; readonly onReviewCandidate?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [candidate, setCandidate] = useState<SkillCandidate>();
  // Non-skill results keep their own memory/protocol/playbook review surfaces.
  useEffect(() => {
    let active = true;
    void getSkillCandidate(cwd, candidateId).then(response => { if (active) setCandidate(response.candidate); }).catch(() => undefined);
    return () => { active = false; };
  }, [cwd, candidateId]);
  if (!candidate) return <p>{t("Review this result in Memory or the channel review queue.")} <code>{candidateId}</code></p>;
  return <div>
    <strong>{candidate.status === "published" ? t("Skill updated") : t("Skill awaiting review")}: {candidate.title}</strong>
    <p>{candidate.summary}</p>
    <details><summary>{t("Procedure steps")}</summary>
      <ol>{candidate.definition.procedureSteps.map((step, i) => <li key={i}>{step.instruction ?? step.title}</li>)}</ol>
      <p>{t("How to verify")}</p><ul>{candidate.definition.validationSteps.map((step, i) => <li key={i}>{step.commandOrCheck ?? step.title}: {step.expectedResult}</li>)}</ul>
    </details>
    {onReviewCandidate && ["pending", "needs_edit", "approved_for_draft"].includes(candidate.status) ?
      <Button size="sm" onClick={() => onReviewCandidate(candidate.id)}>{t("Review changes")}</Button> :
      candidate.status !== "published" ? <small>{t("Review in Settings → Skills → AI evolution.")}</small> : null}
  </div>;
}
