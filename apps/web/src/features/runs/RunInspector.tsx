import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Save, Search } from "lucide-react";
import { getSkillRecordingEligibility, recordSkillRecording } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { readDataString } from "../../lib/data.js";
import {
  buildRunSkillRecordingDraft,
  buildRunSkillRecordingEligibility,
  buildSkillRecordingRequestFromDraft,
  mergeRunSkillRecordingEligibility,
  splitLines,
  type RunSkillRecordingDraft,
} from "../../lib/skill-recording.js";
import { MetaRow } from "../../shared/components/index.js";
import type {
  RunEventEnvelope,
  RunSession,
  RunArtifact,
  SkillRecordingEligibilityResponse,
  SkillRecordingObservationResponse,
} from "../../types.js";
import { SkillRecordingReviewSheet } from "./SkillRecordingReviewSheet.js";

export function RunInspector({
  activeRunId,
  lookupRunId,
  run,
  events,
  artifacts = [],
  onLookupRunIdChange,
  onLoadRun,
}: {
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts?: readonly RunArtifact[];
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const localRecordingEligibility = useMemo(() => buildRunSkillRecordingEligibility(run, events), [events, run]);
  const [recordingDraft, setRecordingDraft] = useState<RunSkillRecordingDraft | undefined>();
  const [recordingSubmitting, setRecordingSubmitting] = useState(false);
  const [recordingResult, setRecordingResult] = useState<SkillRecordingObservationResponse | undefined>();
  const [recordingPrecheck, setRecordingPrecheck] = useState<SkillRecordingEligibilityResponse | undefined>();
  const [recordingPrecheckError, setRecordingPrecheckError] = useState("");
  const [recordingError, setRecordingError] = useState("");
  void activeRunId;
  void lookupRunId;
  void onLookupRunIdChange;
  void onLoadRun;

  useEffect(() => {
    if (!run) {
      setRecordingPrecheck(undefined);
      setRecordingPrecheckError("");
      return;
    }
    const workspaceCwd = readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd;
    if (!workspaceCwd || !localRecordingEligibility.visible) {
      setRecordingPrecheck(undefined);
      setRecordingPrecheckError("");
      return;
    }
    let cancelled = false;
    void getSkillRecordingEligibility(workspaceCwd, run.id)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setRecordingPrecheck(response);
        setRecordingPrecheckError("");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setRecordingPrecheck(undefined);
        setRecordingPrecheckError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [localRecordingEligibility.visible, run]);

  const recordingEligibility = mergeRunSkillRecordingEligibility(localRecordingEligibility, recordingPrecheck);

  function openRecordingDraft(): void {
    if (!run) {
      return;
    }
    const draft = buildRunSkillRecordingDraft(run, events, artifacts);
    setRecordingDraft({ ...draft, duplicateHint: recordingEligibility.duplicateHint ?? draft.duplicateHint });
    setRecordingResult(undefined);
    setRecordingError("");
  }

  function updateRecordingDraft(patch: Partial<RunSkillRecordingDraft>): void {
    setRecordingDraft((current) => current ? { ...current, ...patch } : current);
  }

  async function submitRecordingDraft(): Promise<void> {
    if (!run || !recordingDraft || recordingSubmitting || splitLines(recordingDraft.validationStepsText).length === 0) {
      return;
    }
    setRecordingSubmitting(true);
    try {
      setRecordingError("");
      const request = buildSkillRecordingRequestFromDraft(recordingDraft, run);
      const response = await recordSkillRecording(recordingDraft.workspaceCwd, request);
      setRecordingResult(response);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecordingSubmitting(false);
    }
  }

  const recordingButtonDisabled = !run || !recordingEligibility.visible;
  return (
    <section className="inspector" aria-label="Run inspector">
      <div className="panel-title">
        <Search size={18} />
        <h2>{t("Run context")}</h2>
      </div>
      <div className="meta-list">
        <MetaRow label={t("Status")} value={run?.status ?? t("not loaded")} />
        <MetaRow label={t("Provider")} value={run ? `${run.providerName}/${run.providerModel}` : "-"} />
      </div>

      <div className="inspector-block run-recording-block">
        <div className="run-recording-head">
          <h3>{t("Skill recording")}</h3>
          <button className="primary-button compact-button" type="button" onClick={openRecordingDraft} disabled={recordingButtonDisabled}>
            <Save size={14} />
            {t("Save as Skill")}
          </button>
        </div>
        <p className="muted">
          {recordingEligibility.visible
            ? recordingEligibility.recommended
              ? t("This completed run has reusable evidence. Review it before creating a skill candidate.")
              : recordingEligibility.reasonCode === "duplicate_existing"
                ? t("This run already used a selected skill. Prefer appending evidence or improving the existing skill.")
                : t("Recording creates a reviewable candidate, not an active skill.")
            : recordingEligibility.reasonCode === "not_terminal"
              ? t("Run must finish before recording.")
              : recordingEligibility.reasonCode === "recording_disabled"
                ? t("Skill recording endpoint is disabled")
              : t("No bounded run evidence is available for recording.")}
        </p>
        {recordingPrecheckError ? (
          <p className="muted">{t("Using local recording precheck because daemon eligibility is unavailable.")}</p>
        ) : recordingPrecheck ? (
          <p className="muted">{t("Daemon duplicate precheck completed without using a model call.")}</p>
        ) : null}
        {recordingDraft ? (
          <SkillRecordingReviewSheet
            draft={recordingDraft}
            submitting={recordingSubmitting}
            error={recordingError}
            result={recordingResult}
            onChange={updateRecordingDraft}
            onClose={() => setRecordingDraft(undefined)}
            onSubmit={() => void submitRecordingDraft()}
          />
        ) : null}
      </div>

      <div className="inspector-block">
        <h3>{t("Tool calls")}</h3>
        {toolEvents.length === 0 ? (
          <p className="muted">{t("No tool activity yet.")}</p>
        ) : (
          toolEvents.map((event) => (
            <div className="tool-row" key={event.id}>
              <span>{event.type.replace("tool_", "")}</span>
              <code>{readDataString(event.data, "toolName") || "tool"}</code>
            </div>
          ))
        )}
      </div>

      <div className="inspector-block">
        <h3>{t("Persistence")}</h3>
        <div className="persistence-line">
          <CheckCircle2 size={16} />
          {t("Run record saved")}
        </div>
        <details className="json-details compact-json">
          <summary>{t("Debug details")}</summary>
          <div className="meta-list">
            <MetaRow label={t("Task")} value={run?.taskId ?? "-"} />
            <MetaRow label={t("Event log")} value={run?.eventLogPath ?? "-"} compact />
            <MetaRow label={t("Summary")} value={run?.summaryPath ?? "-"} compact />
          </div>
        </details>
      </div>
    </section>
  );
}
