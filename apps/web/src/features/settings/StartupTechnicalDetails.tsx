import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { DataRow, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { StartupDiagnostic, StartupStatusResponse } from "../../types.js";
import {
  projectStartupPhases,
  startupDiagnosticKey,
} from "./startup-readiness-view-models.js";

export function StartupTechnicalDetails({ status }: { readonly status: StartupStatusResponse }): JSX.Element {
  const { t } = useI18n();
  const phases = projectStartupPhases(status);
  const issueCount = status.diagnostics.filter((diagnostic) => diagnostic.level !== "info").length;

  return (
    <InspectorSection
      className="settings-startup-technical"
      title={t("Technical details")}
      summary={t("{phaseCount} phases · {issueCount} issues", { phaseCount: phases.length, issueCount })}
    >
      <dl className="settings-startup-metadata">
        <TechnicalValue label={t("Workspace")} value={status.cwd} />
        <TechnicalValue label={t("Attempt")} value={status.startupAttemptId} />
        <TechnicalValue label={t("Started")} value={formatDateTime(status.startedAt)} />
        <TechnicalValue label={t("Updated")} value={formatDateTime(status.updatedAt)} />
        <TechnicalValue
          label={t("Effective config")}
          value={status.effectiveConfigLoadedAt ? formatDateTime(status.effectiveConfigLoadedAt) : t("Not available")}
        />
      </dl>

      <section className="settings-startup-technical-section" aria-label={t("Startup phases")}>
        <h3>{t("Startup phases")}</h3>
        <div className="settings-startup-phase-list">
          {phases.map((phase) => (
            <DataRow
              key={phase.id}
              className="settings-startup-phase-row"
              compact
              identity={(
                <span className="settings-startup-phase-copy">
                  <strong>{t(phase.labelKey)}</strong>
                  <small>{t(phase.kindLabelKey)}</small>
                </span>
              )}
              status={<StatusIndicator compact label={t(phase.statusLabelKey)} tone={phase.tone} />}
            />
          ))}
        </div>
      </section>

      {status.diagnostics.length > 0 ? (
        <section className="settings-startup-technical-section" aria-label={t("Startup diagnostics")}>
          <h3>{t("Startup diagnostics")}</h3>
          <div className="settings-startup-diagnostic-list">
            {status.diagnostics.map((diagnostic) => (
              <StartupDiagnosticDetail key={startupDiagnosticKey(diagnostic)} diagnostic={diagnostic} />
            ))}
          </div>
        </section>
      ) : null}
    </InspectorSection>
  );
}

function TechnicalValue({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StartupDiagnosticDetail({ diagnostic }: { readonly diagnostic: StartupDiagnostic }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-startup-diagnostic-detail">
      <strong>{diagnostic.message}</strong>
      <dl>
        <TechnicalValue label={t("Phase")} value={diagnostic.phase} />
        <TechnicalValue label={t("Code")} value={diagnostic.code} />
        {diagnostic.path ? <TechnicalValue label={t("Path")} value={diagnostic.path} /> : null}
        {diagnostic.count && diagnostic.count > 1
          ? <TechnicalValue label={t("Occurrences")} value={String(diagnostic.count)} />
          : null}
        {diagnostic.nextAction ? <TechnicalValue label={t("Suggested next step")} value={diagnostic.nextAction} /> : null}
      </dl>
    </div>
  );
}
