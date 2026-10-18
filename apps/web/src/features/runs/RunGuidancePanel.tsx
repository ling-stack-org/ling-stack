import { Clock3, Pencil, RotateCcw, Square, Workflow } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState, InlineFeedback, InspectorSection, Textarea } from "../../shared/ui/index.js";
import type { RunSession } from "../../types.js";
import { RunInterventionRow } from "./RunInterventionRow.js";
import { useRunInterventionController } from "./useRunInterventionController.js";

export function RunGuidancePanel({ cwd, run, canRedirect, onRefreshRun }: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly canRedirect: boolean;
  readonly onRefreshRun: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { state, actions } = useRunInterventionController({ cwd, run, onRefreshRun });
  const queueKey = "create:queue_followup";
  const redirectKey = "create:interrupt_redirect";
  const creating = state.busyKeys.has(queueKey) || state.busyKeys.has(redirectKey);
  const errorLabel = (error: string) => error === "missing_instruction" ? t("Please enter guidance first.")
    : error === "Pending confirmation" ? t("Pending confirmation") : error;
  return (
    <InspectorSection
      className="run-guidance-panel"
      summary={t("{count} interventions", { count: state.interventions.length })}
      title={t("Run guidance")}
      open
    >
      <div className="runs-intervention-panel">
        <h3 className="runs-section-heading">{t("Run guidance")}</h3>
        {run.parentRunId ? <p className="runs-lineage-note"><Workflow size={15} />{t("Continuing from previous run")} <code>{run.parentRunId}</code></p> : null}
        <p className="runs-readable-copy"><Pencil size={15} />{t("Add guidance while the run is active. Ling Stack records it and starts continuation runs in order.")}</p>
        <Textarea
          aria-label={t("Run guidance")}
          onChange={(event) => actions.setInstruction(event.target.value)}
          placeholder={t("Tell this run what to do next...")}
          rows={3}
          value={state.instruction}
        />
        {state.errors[queueKey] ? <InlineFeedback tone="danger">{errorLabel(state.errors[queueKey])}</InlineFeedback> : null}
        {state.errors[redirectKey] ? <InlineFeedback tone="danger">{errorLabel(state.errors[redirectKey])}</InlineFeedback> : null}
        {state.pendingConfirmation && !state.errors[queueKey] && !state.errors[redirectKey]
          ? <InlineFeedback tone="warning">{t("Pending confirmation")}</InlineFeedback> : null}
        {state.errors.refresh ? (
          <InlineFeedback tone={state.loadState === "stale" ? "warning" : "danger"}>
            <span>{state.errors.refresh}</span>
            <Button size="sm" variant="secondary" onClick={() => void actions.loadInterventions()}>{t("Retry")}</Button>
          </InlineFeedback>
        ) : null}
        <div className="runs-form-actions">
          <Button disabled={!state.pendingConfirmation && !state.instruction.trim()} leadingIcon={state.pendingConfirmation ? <RotateCcw size={14} /> : <Clock3 size={14} />} loading={creating} onClick={() => void actions.create("queue_followup")} size="sm">{state.pendingConfirmation ? t("Retry") : t("Queue guidance")}</Button>
          <Button aria-label={t("Redirect current run")} disabled={creating || state.pendingConfirmation || !state.instruction.trim() || !canRedirect} leadingIcon={<Square size={14} />} loading={state.busyKeys.has(redirectKey)} onClick={() => void actions.create("interrupt_redirect")} size="sm" variant="danger">{t("Stop and redirect")}</Button>
        </div>
        {state.interventions.length === 0 && state.loadState !== "loading" ? <EmptyState compact icon={<Clock3 />} title={t("No guidance queued for this run")} /> : (
          <div className="runs-section-list">
            {state.interventions.map((item) => (
              <RunInterventionRow
                cancelBusy={state.busyKeys.has(`cancel:${item.id}`)}
                cancelError={state.errors[`cancel:${item.id}`]}
                intervention={item}
                key={item.id}
                onCancel={() => void actions.cancel(item.id)}
                onPromote={() => void actions.promote(item.id)}
                promoteBusy={state.busyKeys.has(`promote:${item.id}`)}
                promoteError={state.errors[`promote:${item.id}`]}
              />
            ))}
          </div>
        )}
      </div>
    </InspectorSection>
  );
}
