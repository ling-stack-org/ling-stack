import { Loader2, Save, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  splitLines,
  type RunSkillRecordingDraft,
  type SkillRecordingDestinationHint,
} from "../../lib/skill-recording.js";
import type { SkillRecordingObservationResponse } from "../../types.js";

export function SkillRecordingReviewSheet({
  draft,
  submitting,
  error,
  result,
  onChange,
  onClose,
  onSubmit,
}: {
  readonly draft: RunSkillRecordingDraft;
  readonly submitting: boolean;
  readonly error?: string;
  readonly result?: SkillRecordingObservationResponse;
  readonly onChange: (patch: Partial<RunSkillRecordingDraft>) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const validationMissing = splitLines(draft.validationStepsText).length === 0;
  const submitDisabled = submitting || validationMissing || !draft.title.trim() || !draft.normalizedGoal.trim();

  return (
    <section className="run-recording-sheet" role="dialog" aria-modal="false" aria-label={t("Review recording")}>
      <div className="run-recording-sheet-head">
        <span>
          <strong>{t("Review recording")}</strong>
          {draft.sourceLabel ? <small>{t("Source")}: {draft.sourceLabel}</small> : null}
          <small>{t("No model call is used for this precheck.")}</small>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={submitting} aria-label={t("Close")}>
          <X size={14} />
        </button>
      </div>
      {draft.duplicateHint ? (
        <div className="run-recording-warning">
          <strong>{t("Duplicate match")}</strong>
          <span>{draft.duplicateHint}</span>
        </div>
      ) : null}
      <div className="run-recording-grid">
        <label className="field">
          <span>{t("Destination")}</span>
          <select
            value={draft.destinationHint}
            onChange={(event) => onChange({ destinationHint: event.target.value as SkillRecordingDestinationHint })}
          >
            <option value="skill">{t("Skill")}</option>
            <option value="channel_protocol">{t("Channel protocol")}</option>
            <option value="playbook">{t("Playbook")}</option>
            <option value="automation">{t("Automation")}</option>
            <option value="memory">{t("Memory")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("Title")}</span>
          <input value={draft.title} onChange={(event) => onChange({ title: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Summary")}</span>
          <textarea rows={3} value={draft.summary} onChange={(event) => onChange({ summary: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Normalized goal")}</span>
          <input value={draft.normalizedGoal} onChange={(event) => onChange({ normalizedGoal: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Positive triggers")}</span>
          <textarea rows={3} value={draft.positiveTriggersText} onChange={(event) => onChange({ positiveTriggersText: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Negative triggers")}</span>
          <textarea rows={3} value={draft.negativeTriggersText} onChange={(event) => onChange({ negativeTriggersText: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Procedure steps")}</span>
          <textarea rows={4} value={draft.procedureStepsText} onChange={(event) => onChange({ procedureStepsText: event.target.value })} />
        </label>
        <label className="field wide">
          <span>{t("Validation steps")}</span>
          <textarea rows={3} value={draft.validationStepsText} onChange={(event) => onChange({ validationStepsText: event.target.value })} />
        </label>
      </div>
      <div className="run-recording-token-row">
        <span>{t("Tools")}: {draft.toolLabels.length > 0 ? draft.toolLabels.join(", ") : t("None")}</span>
        <span>{t("Artifacts")}: {draft.artifactRefs.length > 0 ? draft.artifactRefs.length : t("None")}</span>
        <span>{t("Run")}: <code>{draft.runId}</code></span>
      </div>
      {validationMissing ? (
        <div className="run-recording-warning">{t("Add at least one validation step before submitting.")}</div>
      ) : null}
      {error ? <div className="run-recording-error">{error}</div> : null}
      {result ? <RecordingResultSummary result={result} /> : null}
      <div className="run-recording-actions">
        <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={submitting}>
          {t("Cancel")}
        </button>
        <button
          className="primary-button compact-button"
          type="button"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitting ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
          {draft.duplicateHint ? t("Append evidence to existing") : t("Create candidate")}
        </button>
      </div>
    </section>
  );
}

function RecordingResultSummary({
  result,
}: {
  readonly result: SkillRecordingObservationResponse;
}): JSX.Element {
  const { t } = useI18n();

  if (result.action === "candidate_created" && result.candidate) {
    return (
      <div className="run-recording-success">
        <strong>{t("Skill candidate created")}</strong>
        <span>{result.candidate.title}</span>
        <code>{result.candidate.id}</code>
      </div>
    );
  }
  const decision = result.duplicateAnalysis?.decision ?? result.generationDecision?.decision ?? result.action;
  const reason = result.generationDecision?.reason || result.route.reasonCode;
  return (
    <div className="run-recording-warning">
      <strong>{result.action === "blocked" ? t("Recording blocked") : t("Evidence recorded")}</strong>
      <span>{t("Decision")}: {decision}</span>
      <span>{reason}</span>
    </div>
  );
}
