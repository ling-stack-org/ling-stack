import { useEffect, useMemo, useRef, useState } from "react";
import { getSkillRecordingEligibility, recordSkillRecording } from "../../api.js";
import {
  buildArtifactSkillRecordingDraft,
  buildRunSkillRecordingEligibility,
  buildSkillRecordingRequestFromDraft,
  mergeRunSkillRecordingEligibility,
  splitLines,
  type RunSkillRecordingDraft,
} from "../../lib/skill-recording.js";
import type {
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  SkillRecordingEligibilityResponse,
  SkillRecordingObservationResponse,
} from "../../types.js";

export function useRunSkillRecording(input: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
}) {
  const localEligibility = useMemo(() => buildRunSkillRecordingEligibility(input.run, input.events), [input.events, input.run]);
  const [draft, setDraft] = useState<RunSkillRecordingDraft>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SkillRecordingObservationResponse>();
  const [precheck, setPrecheck] = useState<SkillRecordingEligibilityResponse>();
  const [precheckError, setPrecheckError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const requestRevisionRef = useRef(0);
  const identityRef = useRef("");
  identityRef.current = `${input.cwd.trim()}::${input.run.id}`;
  const eligibility = mergeRunSkillRecordingEligibility(localEligibility, precheck);

  useEffect(() => {
    requestRevisionRef.current += 1;
    setDraft(undefined);
    setSubmitting(false);
    setResult(undefined);
    setPrecheck(undefined);
    setPrecheckError("");
    setSubmitError("");
  }, [input.cwd, input.run.id]);

  function openArtifact(artifact: RunArtifact): void {
    if (!localEligibility.visible) return;
    const nextDraft = buildArtifactSkillRecordingDraft(input.run, input.events, artifact);
    setDraft({ ...nextDraft, duplicateHint: eligibility.duplicateHint ?? nextDraft.duplicateHint });
    setResult(undefined);
    setSubmitError("");
    setPrecheckError("");
    void runPrecheck();
  }

  async function runPrecheck(): Promise<void> {
    const identity = identityRef.current;
    const revision = ++requestRevisionRef.current;
    try {
      const response = await getSkillRecordingEligibility(input.cwd.trim(), input.run.id);
      if (identityRef.current !== identity || requestRevisionRef.current !== revision) return;
      const merged = mergeRunSkillRecordingEligibility(localEligibility, response);
      setPrecheck(response);
      setPrecheckError("");
      setDraft((current) => current?.runId === input.run.id ? { ...current, duplicateHint: merged.duplicateHint ?? current.duplicateHint } : current);
    } catch (error) {
      if (identityRef.current !== identity || requestRevisionRef.current !== revision) return;
      setPrecheck(undefined);
      setPrecheckError(error instanceof Error ? error.message : String(error));
    }
  }

  function updateDraft(patch: Partial<RunSkillRecordingDraft>): void {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setSubmitError("");
  }

  async function submit(): Promise<void> {
    if (!draft || submitting || !draft.title.trim() || !draft.normalizedGoal.trim() || splitLines(draft.validationStepsText).length === 0) return;
    const identity = identityRef.current;
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await recordSkillRecording(draft.workspaceCwd, buildSkillRecordingRequestFromDraft(draft, input.run));
      if (identityRef.current === identity) setResult(response);
    } catch (error) {
      if (identityRef.current === identity) setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      if (identityRef.current === identity) setSubmitting(false);
    }
  }

  return {
    state: { draft, submitting, result, precheck, precheckError, submitError, eligibility, visible: localEligibility.visible },
    actions: {
      openArtifact,
      updateDraft,
      submit,
      close: () => { if (!submitting) setDraft(undefined); },
    },
  };
}
