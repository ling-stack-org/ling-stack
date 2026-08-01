import { Info } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, IconButton, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { MemoryHealthReport } from "../../types.js";
import { memoryHealthFindingTitle, type MemoryStatusTone, type TeammateMemoryDetail } from "./teammate-memory-view-models.js";

export function TeammateMemoryHealthSection({
  health,
  healthLabel,
  healthTone,
  onOpenDetail,
}: {
  readonly health: MemoryHealthReport;
  readonly healthLabel: string;
  readonly healthTone: MemoryStatusTone;
  readonly onOpenDetail: (detail: TeammateMemoryDetail) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <InspectorSection
      className="teammate-memory-health"
      title={t("Memory health")}
      summary={t("{critical} critical · {warnings} warnings · {backlog} to review", {
        critical: health.summary.findings.critical,
        warnings: health.summary.findings.warning,
        backlog: health.summary.reviewBacklog,
      })}
      action={<StatusIndicator compact label={healthLabel} tone={healthTone} />}
    >
      <div className="teammate-memory-health-metrics" aria-label={t("Memory health summary")}>
        <span><strong>{health.summary.findings.critical}</strong><small>{t("Critical")}</small></span>
        <span><strong>{health.summary.findings.warning}</strong><small>{t("Warnings")}</small></span>
        <span><strong>{health.summary.reviewBacklog}</strong><small>{t("Review backlog")}</small></span>
        <span><strong>{health.summary.verifyBeforeUse}</strong><small>{t("Verify before use")}</small></span>
      </div>
      {health.findings.length > 0 ? (
        <div className="teammate-memory-finding-list" role="list">
          {health.findings.map((finding) => (
            <DataRow
              key={finding.id}
              className="teammate-memory-finding-row"
              compact
              role="listitem"
              identity={<strong>{t(memoryHealthFindingTitle(finding.kind))}</strong>}
              status={<StatusIndicator compact label={t(finding.severity === "critical" ? "Critical" : finding.severity === "warning" ? "Warning" : "Info")} tone={finding.severity === "critical" ? "danger" : finding.severity === "warning" ? "warning" : "info"} />}
              actions={<IconButton icon={Info} label={t("View health finding")} onClick={() => onOpenDetail({ kind: "health", finding })} />}
            />
          ))}
        </div>
      ) : null}
    </InspectorSection>
  );
}
