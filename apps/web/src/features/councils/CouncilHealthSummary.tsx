import { useI18n } from "../../i18n.js";
import { InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { CouncilListHealthRowView } from "./council-list-health-view-model.js";

export function CouncilHealthSummary({ row }: { readonly row: CouncilListHealthRowView }): JSX.Element {
  const { locale, t } = useI18n();
  const detail = healthDetail(row, t);
  const reportTime = row.reportGeneratedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.reportGeneratedAt))
    : undefined;

  return (
    <div className="council-health-strip council-list-health-summary" data-health-state={row.state} aria-label={t("Council health")}>
      <div className="council-list-health-summary-primary">
        <StatusIndicator label={row.statusLabel} tone={row.tone} />
        <span>{detail}</span>
        {reportTime ? <time dateTime={row.reportGeneratedAt}>{t("Checked {time}", { time: reportTime })}</time> : null}
      </div>
      {row.findingLabels.length > 0 ? (
        <InspectorSection
          className="council-list-health-findings"
          summary={row.severityLabels.join(" / ")}
          title={t("Health findings")}
        >
          <ul>
            {row.findingLabels.map((finding, index) => <li key={`${index}:${finding}`}>{finding}</li>)}
          </ul>
        </InspectorSection>
      ) : null}
    </div>
  );
}

function healthDetail(row: CouncilListHealthRowView, t: ReturnType<typeof useI18n>["t"]): string {
  if (row.state === "paused") return t("This council is paused and will not be used for channel collaboration.");
  if (row.state === "partial") return row.partialReason ?? t("Health information is incomplete.");
  if (row.state === "pending") return t("Refresh to load member readiness.");
  if (row.state === "healthy") return t("No readiness issues were found in the latest complete health report.");
  return row.severityLabels.join(" / ") || t("Member readiness needs attention.");
}
