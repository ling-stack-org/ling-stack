import { RotateCcw, Search } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { MetaRow } from "../../shared/components/index.js";
import { Button, Field, InlineFeedback, InspectorSection, Textarea } from "../../shared/ui/index.js";
import type { RunSession } from "../../types.js";
import type { WorkHistoryTurnContext, WorkHistoryTurnLoadState } from "./runs-thread-types.js";
import { useThreadDetailController } from "./useThreadDetailController.js";

export function RunThreadContinuationSection({ cwd, run, turnContext, isRunning, onRefresh }: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly turnContext: WorkHistoryTurnContext | undefined;
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const turnState = useMemo<WorkHistoryTurnLoadState | undefined>(() => turnContext ? {
    status: "loaded",
    turns: [turnContext.turn],
    runLinks: turnContext.group.attempts.map((attempt) => ({
      turnId: turnContext.turn.id,
      runId: attempt.run.id,
      attemptNumber: attempt.attemptNumber,
      role: attempt.role === "legacy" ? "primary" : attempt.role,
      createdAt: attempt.linkedAt,
    })),
    signature: `${turnContext.turn.id}:${turnContext.turn.updatedAt}`,
  } : undefined, [turnContext]);
  const controller = useThreadDetailController({
    cwd,
    thread: undefined,
    threadId: run.threadId ?? "",
    turnState,
    visibleThreads: [],
    isRunning,
    onRefresh,
    onSelectThreadId: () => undefined,
  });
  const { state, actions } = controller;
  if (!run.threadId) return null;
  return (
    <InspectorSection open summary={state.sourceRunId || run.id} title={t("Resume context preview")}>
      <div className="runs-form-grid">
        <Field className="runs-form-wide" label={t("Resume instruction")}>
          <Textarea rows={3} value={state.resumeInstruction} onChange={(event) => actions.setResumeInstruction(event.target.value)} disabled={!state.canPreview || state.busyActions.has("resume")} />
        </Field>
        {state.errors.preview ? <InlineFeedback className="runs-form-wide" tone="danger">{state.errors.preview}</InlineFeedback> : null}
        {state.errors.resume ? <InlineFeedback className="runs-form-wide" tone="danger">{state.errors.resume}</InlineFeedback> : null}
        <div className="runs-form-actions runs-form-wide">
          <Button disabled={!state.canPreview} leadingIcon={<Search size={14} />} loading={state.busyActions.has("preview")} onClick={() => void actions.previewResume()} size="sm">{t("Preview resume")}</Button>
          <Button disabled={!state.canResume} leadingIcon={<RotateCcw size={14} />} loading={state.busyActions.has("resume")} onClick={() => void actions.resume()} size="sm">{t("Resume thread")}</Button>
        </div>
        {state.resumedRunId ? <p className="runs-readable-copy runs-form-wide"><strong>{t("Resume run")}</strong>{state.resumedRunId}</p> : null}
        {state.resumePreview ? (
          <InspectorSection className="compact-json runs-form-wide" open title={t("Resume context preview")}>
            <div className="runs-summary-grid">
              {state.resumePreview.context.sourceTurnId ? <MetaRow label={t("Source turn")} value={state.resumePreview.context.sourceTurnId} compact /> : null}
              <MetaRow label={t("Source run")} value={state.resumePreview.context.sourceRunId} compact />
              <MetaRow label={t("Prior turns")} value={String(state.resumePreview.context.priorTurnIds?.length ?? 0)} compact />
              <MetaRow label={t("Prior runs")} value={String(state.resumePreview.context.priorRunIds.length)} compact />
              <MetaRow label={t("Artifacts")} value={String(state.resumePreview.context.includedArtifactIds.length)} compact />
            </div>
            {state.resumePreview.context.warnings.length ? <InlineFeedback tone="warning">{state.resumePreview.context.warnings.join(" ")}</InlineFeedback> : null}
            <pre className="runs-code-scroll">{state.resumePreview.context.contextText}</pre>
          </InspectorSection>
        ) : null}
      </div>
    </InspectorSection>
  );
}
