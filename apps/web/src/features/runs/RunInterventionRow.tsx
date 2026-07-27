import { ChevronDown, ChevronUp, CircleStop, Clock3, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, InlineFeedback, Spinner, StatusIndicator } from "../../shared/ui/index.js";
import type { RunIntervention } from "../../types.js";
import { runInterventionStatusTone } from "./run-intervention-view-models.js";

const collapsedInstructionThreshold = 260;

export function RunInterventionRow({
  cancelBusy,
  cancelError,
  intervention,
  loading = false,
  onCancel,
  onPromote,
  promoteBusy,
  promoteError,
}: {
  readonly cancelBusy?: boolean;
  readonly cancelError?: string;
  readonly intervention: RunIntervention;
  readonly loading?: boolean;
  readonly onCancel?: () => void;
  readonly onPromote?: () => void;
  readonly promoteBusy?: boolean;
  readonly promoteError?: string;
}): JSX.Element {
  const { t } = useI18n();
  const instructionId = useId();
  const [expanded, setExpanded] = useState(false);
  const canCollapse = intervention.instruction.length > collapsedInstructionThreshold;
  const isActionable = intervention.status === "queued" && onCancel && onPromote;
  const isRedirect = intervention.mode === "interrupt_redirect";

  return (
    <article aria-busy={loading || undefined} className="runs-intervention-row" data-status={intervention.status}>
      <header className="runs-intervention-row-header">
        <span className="runs-intervention-row-identity">
          {isRedirect ? <CircleStop aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
          <strong>{isRedirect ? t("Stop and redirect") : t("Queue guidance")}</strong>
        </span>
        <span className="runs-intervention-row-state">
          {loading ? <Spinner label={t("Loading")} size="sm" /> : null}
          <StatusIndicator
            label={interventionStatusLabel(intervention.status, t)}
            tone={runInterventionStatusTone(intervention.status)}
          />
        </span>
      </header>

      <p
        className="runs-intervention-row-instruction"
        data-collapsed={canCollapse && !expanded ? "true" : undefined}
        data-long={canCollapse ? "true" : undefined}
        id={instructionId}
      >
        {intervention.instruction}
      </p>

      <Button
        aria-controls={instructionId}
        aria-expanded={expanded}
        className="runs-intervention-row-disclosure"
        leadingIcon={expanded ? <ChevronUp /> : <ChevronDown />}
        onClick={() => setExpanded((current) => !current)}
        size="sm"
        variant="ghost"
      >
        {t(expanded ? "Hide details" : "Show details")}
      </Button>

      {expanded ? (
        <dl className="runs-intervention-row-details">
          <div><dt>{t("Created by")}</dt><dd>{t(intervention.requestedBy === "local-user" ? "Local user" : "System")}</dd></div>
          <div><dt>{t("Created")}</dt><dd>{formatDateTime(intervention.createdAt)}</dd></div>
          <div><dt>{t("Updated")}</dt><dd>{formatDateTime(intervention.updatedAt)}</dd></div>
          {intervention.continuationRunId ? (
            <div><dt>{t("Continuation")}</dt><dd><code title={intervention.continuationRunId}>{intervention.continuationRunId}</code></dd></div>
          ) : null}
          {intervention.failureReason ? <div><dt>{t("Failure reason")}</dt><dd>{intervention.failureReason}</dd></div> : null}
        </dl>
      ) : null}

      {isActionable ? (
        <footer className="runs-intervention-row-footer">
          <span className="runs-intervention-row-actions">
            <Button loading={cancelBusy} onClick={onCancel} size="sm" variant="ghost">{t("Cancel")}</Button>
            <Button leadingIcon={<RotateCcw />} loading={promoteBusy} onClick={onPromote} size="sm" variant="primary">
              {t("Start handling")}
            </Button>
          </span>
        </footer>
      ) : null}

      {cancelError ? <InlineFeedback tone="danger">{cancelError}</InlineFeedback> : null}
      {promoteError ? <InlineFeedback tone="danger">{promoteError}</InlineFeedback> : null}
    </article>
  );
}

function interventionStatusLabel(status: RunIntervention["status"], t: (key: string) => string): string {
  const labels: Record<RunIntervention["status"], string> = {
    queued: "Queued",
    cancelling_source: "Stopping source",
    starting_continuation: "Starting continuation",
    started: "Started",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return t(labels[status]);
}
