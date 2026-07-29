import { Save } from "lucide-react";
import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import { splitLines, type RunSkillRecordingDraft, type SkillRecordingDestinationHint } from "../../lib/skill-recording.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import type { SkillRecordingObservationResponse } from "../../types.js";

export function RunSkillRecordingDialog({ draft, submitting, error, precheckError, result, returnFocusRef, onChange, onClose, onSubmit }: {
  readonly draft: RunSkillRecordingDraft | undefined;
  readonly submitting: boolean;
  readonly error?: string;
  readonly precheckError?: string;
  readonly result?: SkillRecordingObservationResponse;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onChange: (patch: Partial<RunSkillRecordingDraft>) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const validationMissing = Boolean(draft && splitLines(draft.validationStepsText).length === 0);
  const titleMissing = Boolean(draft && !draft.title.trim());
  const goalMissing = Boolean(draft && !draft.normalizedGoal.trim());
  const submitDisabled = submitting || validationMissing || titleMissing || goalMissing;
  return (
    <Dialog busy={submitting} open={Boolean(draft)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-label={t("Review recording")}
        className="runs-recording-dialog"
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
        size="lg"
      >
        <DialogHeader
          closeLabel={t("Close")}
          description={draft?.sourceLabel ? `${t("Source")}: ${draft.sourceLabel}` : t("No model call is used for this precheck.")}
          title={t("Review recording")}
        />
        {draft ? <DialogBody className="runs-recording-body">
          <p className="runs-readable-copy">{t("No model call is used for this precheck.")}</p>
          {draft.duplicateHint ? <InlineFeedback title={t("Duplicate match")} tone="warning">{draft.duplicateHint}</InlineFeedback> : null}
          {precheckError ? <InlineFeedback tone="warning">{t("Using local recording precheck because daemon eligibility is unavailable.")}</InlineFeedback> : null}
          <div className="runs-recording-grid">
            <Field label={t("Destination")}>
              <Select value={draft.destinationHint} onChange={(event) => onChange({ destinationHint: event.target.value as SkillRecordingDestinationHint })}>
                <option value="skill">{t("Skill")}</option><option value="channel_protocol">{t("Channel protocol")}</option><option value="playbook">{t("Playbook")}</option><option value="automation">{t("Automation")}</option><option value="memory">{t("Memory")}</option>
              </Select>
            </Field>
            <Field error={titleMissing ? t("Title") : undefined} label={t("Title")} required>
              <Input value={draft.title} onChange={(event) => onChange({ title: event.target.value })} />
            </Field>
            <Field className="runs-recording-wide" label={t("Summary")}><Textarea rows={3} value={draft.summary} onChange={(event) => onChange({ summary: event.target.value })} /></Field>
            <Field className="runs-recording-wide" error={goalMissing ? t("Normalized goal") : undefined} label={t("Normalized goal")} required><Input value={draft.normalizedGoal} onChange={(event) => onChange({ normalizedGoal: event.target.value })} /></Field>
            <Field className="runs-recording-wide" label={t("Positive triggers")}><Textarea rows={3} value={draft.positiveTriggersText} onChange={(event) => onChange({ positiveTriggersText: event.target.value })} /></Field>
            <Field className="runs-recording-wide" label={t("Negative triggers")}><Textarea rows={3} value={draft.negativeTriggersText} onChange={(event) => onChange({ negativeTriggersText: event.target.value })} /></Field>
            <Field className="runs-recording-wide" label={t("Procedure steps")}><Textarea rows={4} value={draft.procedureStepsText} onChange={(event) => onChange({ procedureStepsText: event.target.value })} /></Field>
            <Field className="runs-recording-wide" error={validationMissing ? t("Add at least one validation step before submitting.") : undefined} label={t("Validation steps")} required><Textarea rows={3} value={draft.validationStepsText} onChange={(event) => onChange({ validationStepsText: event.target.value })} /></Field>
          </div>
          <div className="runs-recording-tokens"><span>{t("Tools")}: {draft.toolLabels.length ? draft.toolLabels.join(", ") : t("None")}</span><span>{t("Artifacts")}: {draft.artifactRefs.length || t("None")}</span><span>{t("Run")}: <code>{draft.runId}</code></span></div>
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
          {result ? <RecordingResultSummary result={result} /> : null}
        </DialogBody> : null}
        <DialogFooter>
          <Button ref={cancelRef} disabled={submitting} onClick={onClose}>{t("Cancel")}</Button>
          <Button disabled={submitDisabled} leadingIcon={<Save size={14} />} loading={submitting} onClick={onSubmit} variant="primary">{draft?.duplicateHint ? t("Append evidence to existing") : t("Create candidate")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordingResultSummary({ result }: { readonly result: SkillRecordingObservationResponse }): JSX.Element {
  const { t } = useI18n();
  if (result.action === "candidate_created" && result.candidate) {
    return <InlineFeedback title={t("Skill candidate created")} tone="success"><span>{result.candidate.title}</span><code>{result.candidate.id}</code></InlineFeedback>;
  }
  const decision = result.duplicateAnalysis?.decision ?? result.generationDecision?.decision ?? result.action;
  const reason = result.generationDecision?.reason || result.route.reasonCode;
  return <InlineFeedback title={result.action === "blocked" ? t("Recording blocked") : t("Evidence recorded")} tone={result.action === "blocked" ? "warning" : "success"}><span>{t("Decision")}: {decision}</span><span>{reason}</span></InlineFeedback>;
}
