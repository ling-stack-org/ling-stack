import { Activity, RotateCcw, Square } from "lucide-react";
import { canRerunSnapshot } from "../../api/run-request-builders.js";
import { useI18n } from "../../i18n.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { Button, StatusIndicator } from "../../shared/ui/index.js";
import type { ApprovalRequest, RunSession } from "../../types.js";
import { deriveRunPrimaryState } from "./run-detail-view-models.js";
import { runCanBeStopped } from "./runs-thread-view-models.js";

export function RunDetailHeader({ run, approvals, isRunning, cancellingRunId, onRerun, onCancelRun }: {
  readonly run: RunSession | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly isRunning: boolean;
  readonly cancellingRunId: string;
  readonly onRerun: (run: RunSession) => void;
  readonly onCancelRun: (run: RunSession) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const primaryState = deriveRunPrimaryState(run, approvals);
  const stopping = Boolean(run && cancellingRunId === run.id);
  return (
    <header className="runs-detail-header">
      <div className="runs-detail-heading">
        <Activity aria-hidden="true" size={18} />
        <span><h2 id="run-detail-title">{t("Run detail")}</h2><small>{run ? readTaskTitle(run.taskSnapshot) || run.taskId : t("not loaded")}</small></span>
        <StatusIndicator label={t(primaryState.label)} tone={primaryState.tone} />
      </div>
      <div className="runs-detail-actions">
        {run && (runCanBeStopped(run) || stopping) ? <Button aria-label={stopping ? t("Stopping") : t("Stop")} leadingIcon={<Square size={14} />} loading={stopping} onClick={() => onCancelRun(run)} size="sm" variant="danger">{stopping ? t("Stopping") : t("Stop")}</Button> : null}
        <Button disabled={isRunning || !canRerunSnapshot(run)} leadingIcon={<RotateCcw size={15} />} loading={isRunning} onClick={() => run && canRerunSnapshot(run) && onRerun(run)} size="sm" variant="primary">{t("Rerun snapshot")}</Button>
      </div>
    </header>
  );
}
