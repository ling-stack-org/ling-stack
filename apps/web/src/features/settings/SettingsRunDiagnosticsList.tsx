import { SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { DataRow, EmptyState, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { RunDiagnosticsRowViewModel } from "./run-diagnostics-view-models.js";

export function SettingsRunDiagnosticsList({
  isLoading,
  rows,
  selectedRunId,
  onSelect,
}: {
  readonly isLoading: boolean;
  readonly rows: readonly RunDiagnosticsRowViewModel[];
  readonly selectedRunId: string;
  readonly onSelect: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const initialLoading = isLoading && rows.length === 0;

  return (
    <div
      className="settings-run-diagnostics-list"
      data-ui2-run-diagnostics-list=""
      role="listbox"
      aria-busy={isLoading || undefined}
      aria-label={t("Recent runs")}
    >
      {initialLoading ? <RunListSkeleton /> : rows.length === 0 ? (
        <EmptyState compact icon={<SquareTerminal />} title={t("No runs yet")} />
      ) : rows.map((row) => (
        <DataRow
          key={row.id}
          className="settings-run-row"
          compact
          data-run-id={row.id}
          identity={(
            <span className="settings-run-row-copy">
              <strong>{row.title || t("Untitled run")}</strong>
              <small>{formatDateTime(row.updatedAt)}</small>
            </span>
          )}
          selected={row.id === selectedRunId}
          status={<StatusIndicator compact label={t(row.statusLabelKey)} tone={row.tone} />}
          onClick={() => onSelect(row.id)}
        />
      ))}
    </div>
  );
}

function RunListSkeleton(): React.JSX.Element {
  return (
    <div className="settings-run-diagnostics-skeletons" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <DataRow
          key={index}
          className="settings-run-row"
          compact
          identity={(
            <span className="settings-run-row-copy">
              <Skeleton width={`${70 - index * 7}%`} />
              <Skeleton width={96} />
            </span>
          )}
          status={<Skeleton width={72} />}
        />
      ))}
    </div>
  );
}
