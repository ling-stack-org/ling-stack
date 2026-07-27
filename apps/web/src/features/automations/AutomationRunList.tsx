import { ExternalLink } from "lucide-react";
import { DataRow, IconButton, StatusIndicator } from "../../shared/ui/index.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { AutomationRunViewModel, AutomationTranslate } from "./automation-view-models.js";

export function AutomationRunList({
  runs,
  t,
  onOpenRun,
}: {
  readonly runs: readonly AutomationRunViewModel[];
  readonly t: AutomationTranslate;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  return (
    <div className="automation-ui2-run-list" role="list" aria-label={t("Recent history")}>
      {runs.map((item) => (
        <DataRow
          key={item.run.id}
          className="automation-ui2-run-row"
          identity={<strong>{item.automationTitle}</strong>}
          status={<StatusIndicator compact label={item.statusLabel} tone={item.statusTone} />}
          summary={<span>{item.triggerLabel} · {formatDateTime(item.run.firedAt)}</span>}
          actions={item.run.runId ? (
            <IconButton
              icon={ExternalLink}
              label={t("Open run")}
              onClick={() => onOpenRun(item.run.runId as string)}
            />
          ) : undefined}
        />
      ))}
    </div>
  );
}
