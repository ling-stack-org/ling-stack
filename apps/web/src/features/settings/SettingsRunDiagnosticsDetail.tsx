import { SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  Button,
  DataRow,
  EmptyState,
  InlineFeedback,
  InspectorSection,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { RunArtifact, RunEventEnvelope, RunSession } from "../../types.js";
import {
  projectRecentRunActivity,
  runNextStepLabelKey,
  runStatusLabelKey,
  runStatusTone,
  runTitle,
} from "./run-diagnostics-view-models.js";

export function SettingsRunDiagnosticsDetail({
  artifacts,
  events,
  loading,
  run,
  selectedRunId,
  onOpenFullDiagnostics,
}: {
  readonly artifacts: readonly RunArtifact[];
  readonly events: readonly RunEventEnvelope[];
  readonly loading: boolean;
  readonly run: RunSession | undefined;
  readonly selectedRunId: string;
  readonly onOpenFullDiagnostics: (runId?: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const activity = projectRecentRunActivity(events);

  if (loading) {
    return (
      <div className="settings-run-diagnostics-detail" aria-label={t("Run diagnostics detail")}>
        <Skeleton shape="block" height={58} width="100%" />
        <Skeleton shape="block" height={132} width="100%" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="settings-run-diagnostics-detail" aria-label={t("Run diagnostics detail")}>
        <EmptyState
          compact
          icon={<SquareTerminal />}
          title={selectedRunId ? t("Run details are unavailable") : t("Select a run to inspect diagnostics.")}
          action={(
            <Button size="sm" variant="secondary" onClick={() => onOpenFullDiagnostics(selectedRunId || undefined)}>
              {t("Open full diagnostics in app")}
            </Button>
          )}
        />
      </div>
    );
  }

  const title = runTitle(run) || t("Untitled run");
  const attention = run.status === "failed" || run.status === "cancelled";

  return (
    <div className="settings-run-diagnostics-detail" data-run-detail-id={run.id} aria-label={t("Run diagnostics detail")}>
      <div className="settings-run-detail-header">
        <span>
          <strong>{title}</strong>
          <small>{t(runNextStepLabelKey(run))}</small>
        </span>
        <StatusIndicator label={t(runStatusLabelKey(run.status))} tone={runStatusTone(run.status)} />
      </div>

      {attention ? (
        <InlineFeedback title={t("Run needs attention")} tone="danger">
          {t("Raw failure detail is available in technical details.")}
        </InlineFeedback>
      ) : null}

      <dl className="settings-run-detail-metadata">
        <DetailValue label={t("Created")} value={formatDateTime(run.createdAt)} />
        <DetailValue label={t("Updated")} value={formatDateTime(run.updatedAt)} />
        <DetailValue label={t("Events")} value={String(events.length)} />
        <DetailValue label={t("Artifacts")} value={String(artifacts.length)} />
      </dl>

      <section className="settings-run-activity" aria-label={t("Recent activity")}>
        <h3>{t("Recent activity")}</h3>
        {activity.length > 0 ? (
          <div className="settings-run-activity-list">
            {activity.map((item) => (
              <DataRow
                key={item.id}
                className="settings-run-activity-row"
                compact
                identity={<StatusIndicator label={t(item.labelKey)} tone={item.tone} />}
                summary={<time dateTime={item.timestamp}>{formatDateTime(item.timestamp)}</time>}
              />
            ))}
          </div>
        ) : <EmptyState className="settings-run-activity-empty" compact title={t("No activity yet")} />}
      </section>

      <InspectorSection
        className="settings-run-technical-details"
        title={t("Raw run details")}
        summary={t("Technical details")}
      >
        <dl className="settings-run-raw-metadata">
          <DetailValue label={t("Run id")} value={run.id} />
          <DetailValue label={t("Provider")} value={run.providerName || t("Not available")} />
          <DetailValue label={t("Model")} value={run.providerModel || t("Not available")} />
          <DetailValue label={t("Failure detail")} value={run.errorMessage || t("Not available")} />
          <DetailValue label={t("Task")} value={run.taskId || t("Not available")} />
          <DetailValue label={t("Channel")} value={run.channelId ?? t("Not available")} />
          <DetailValue label={t("Work unit")} value={run.workUnitId ?? t("Not available")} />
          <DetailValue label={t("Event log")} value={run.eventLogPath || t("Not available")} />
        </dl>
      </InspectorSection>

      <div className="settings-run-detail-actions">
        <Button
          leadingIcon={<SquareTerminal aria-hidden="true" />}
          size="sm"
          variant="secondary"
          onClick={() => onOpenFullDiagnostics(run.id)}
        >
          {t("Open full diagnostics in app")}
        </Button>
      </div>
    </div>
  );
}

function DetailValue({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
