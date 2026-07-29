import { History } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { Button, DataRow, EmptyState, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";
import { runStatusTone } from "./run-list-view-models.js";

export function ThreadAttemptsSection({ controller, onSelectRun }: {
  readonly controller: ThreadDetailController;
  readonly onSelectRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const runs = controller.state.evidenceRuns;
  return (
    <InspectorSection summary={`${t("Attempts")} · ${t("{count} runs", { count: runs.length })}`} title={t("Thread lineage")}>
      {runs.length === 0 ? <EmptyState compact icon={<History />} title={t("No thread runs recorded")} /> : (
        <div className="runs-section-list">
          {runs.map((item) => (
            <DataRow
              actions={<Button onClick={() => onSelectRun(item.run.id)} size="sm">{t("Open run")}</Button>}
              identity={<span><strong>{readTaskTitle(item.run.taskSnapshot) || item.run.taskId}</strong><small>{item.run.providerName}/{item.run.providerModel}</small></span>}
              key={item.run.id}
              role="button"
              status={<span><StatusIndicator compact label={t(item.run.status)} tone={runStatusTone(item.run.status)} /><small>{t("{count} events", { count: item.events.length })} · {t("{count} artifacts", { count: item.artifacts.length })}</small></span>}
            />
          ))}
        </div>
      )}
    </InspectorSection>
  );
}
