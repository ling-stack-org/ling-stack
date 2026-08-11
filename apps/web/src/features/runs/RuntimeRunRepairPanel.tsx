import { Pencil, RefreshCw, RotateCcw, SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { buildRuntimeFailureSummary, readRunProviderPresetId } from "../../lib/run-evidence.js";
import { MetaRow } from "../../shared/components/index.js";
import { Button, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { RunEventEnvelope, RunSession } from "../../types.js";
import { runStatusTone } from "./run-list-view-models.js";

export function RuntimeRunRepairPanel({ run, events, workspaceCwd, isRunning, onEditTask, onRerun, onReload }: {
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly workspaceCwd: string;
  readonly isRunning: boolean;
  readonly onEditTask: (run: RunSession) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onReload: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const summary = buildRuntimeFailureSummary(run, events, workspaceCwd, t);
  return (
    <InlineFeedback className="runtime-run-repair" title={t("Repair runtime/tool failure")} tone="danger">
      <div className="runs-repair-heading"><SquareTerminal size={16} /><StatusIndicator compact label={t(run.status)} tone={runStatusTone(run.status)} /></div>
      <p>{t("Run {runId} failed at {eventLabel}.", { runId: run.id, eventLabel: summary.eventLabel })}</p>
      <p>{summary.issueText}</p><p>{summary.suggestion}</p>
      <div className="runs-summary-grid">
        <MetaRow label={t("Tool")} value={summary.toolName || "-"} compact /><MetaRow label={t("Event")} value={summary.eventLabel} compact /><MetaRow label={t("Exit code")} value={summary.exitCode || "-"} compact />
        {summary.command ? <MetaRow label={t("Command")} value={summary.command} compact /> : null}{summary.targetPath ? <MetaRow label={t("Target path")} value={summary.targetPath} compact /> : null}
      </div>
      <div className="runs-form-actions">
        <Button disabled={!run.channelId || !run.taskId} leadingIcon={<Pencil size={14} />} onClick={() => onEditTask(run)} size="sm">{t("Edit task")}</Button>
        <Button disabled={isRunning || !readRunProviderPresetId(run)} leadingIcon={<RotateCcw size={14} />} loading={isRunning} onClick={() => onRerun(run)} size="sm" variant="primary">{t("Rerun snapshot")}</Button>
        <Button disabled={isRunning} leadingIcon={<RefreshCw size={14} />} onClick={onReload} size="sm">{t("Reload")}</Button>
      </div>
    </InlineFeedback>
  );
}
