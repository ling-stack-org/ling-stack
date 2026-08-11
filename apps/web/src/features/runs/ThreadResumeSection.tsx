import { RotateCcw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { MetaRow } from "../../shared/components/index.js";
import { Button, Field, InlineFeedback, InspectorSection, Select, Textarea } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";
import { buildThreadResumeDisabledReason } from "./thread-detail-view-models.js";

export function ThreadResumeSection({ controller }: { readonly controller: ThreadDetailController }): React.JSX.Element {
  const { t } = useI18n();
  const { state, actions } = controller;
  const disabledReason = buildThreadResumeDisabledReason({
    hasThread: Boolean(state.displayThread),
    hasSourceRun: Boolean(state.sourceRunId),
    hasActiveNonTerminalRun: state.hasActiveNonTerminalRun,
    hasActiveSelectedTurn: state.hasActiveSelectedTurn,
    isRunning: !state.canResume && !state.hasActiveNonTerminalRun && !state.hasActiveSelectedTurn && !state.isArchived,
    isArchived: state.isArchived,
    t,
  });
  return (
    <InspectorSection open summary={state.sourceRunId || "-"} title={t("Resume context preview")}>
      <div className="runs-form-grid">
        <Field label={t("Resume source turn")}>
          <Select value={state.selectedSourceTurn?.id ?? ""} onChange={(event) => actions.setSelectedSourceTurnId(event.target.value)} disabled={state.loadedTurns.length === 0 || state.busyActions.has("resume")}>
            <option value="">{state.loadedTurns.length === 0 ? t("No source turn") : t("Source run fallback")}</option>
            {state.loadedTurns.map((turn) => <option key={turn.id} value={turn.id}>{turn.title} · {t(turn.status)}</option>)}
          </Select>
        </Field>
        <Field label={t("Resume source run")}>
          <Select value={state.sourceRunId} onChange={(event) => actions.setSelectedSourceRunId(event.target.value)} disabled={state.sourceRunOptions.length === 0 || state.busyActions.has("resume")}>
            {!state.sourceRunId ? <option value="">{t("No source run")}</option> : null}
            {state.sourceRunOptions.map((item) => <option key={item.run.id} value={item.run.id}>{readTaskTitle(item.run.taskSnapshot) || item.run.taskId}</option>)}
          </Select>
        </Field>
        <Field className="runs-form-wide" label={t("Resume instruction")}>
          <Textarea rows={3} value={state.resumeInstruction} onChange={(event) => actions.setResumeInstruction(event.target.value)} disabled={!state.canPreview || state.busyActions.has("resume")} />
        </Field>
        {disabledReason ? <InlineFeedback className="runs-form-wide" tone="warning" title={t("Resume guard")}>{disabledReason}</InlineFeedback> : null}
        {state.errors.preview ? <InlineFeedback className="runs-form-wide" tone="danger">{state.errors.preview}</InlineFeedback> : null}
        {state.errors.resume ? <InlineFeedback className="runs-form-wide" tone="danger">{state.errors.resume}</InlineFeedback> : null}
        <div className="runs-form-actions runs-form-wide">
          <Button disabled={!state.canPreview} leadingIcon={<Search size={14} />} loading={state.busyActions.has("preview")} onClick={() => void actions.previewResume()} size="sm">{t("Preview resume")}</Button>
          <Button disabled={!state.canResume} leadingIcon={<RotateCcw size={14} />} loading={state.busyActions.has("resume")} onClick={() => void actions.resume()} size="sm" variant="primary">{t("Resume thread")}</Button>
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
