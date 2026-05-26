import {
  CheckCircle2,
  Search,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readDataString } from "../../lib/data.js";
import { MetaRow } from "../../shared/components/index.js";
import type {
  RunEventEnvelope,
  RunSession,
} from "../../types.js";

export function RunInspector({
  activeRunId,
  lookupRunId,
  run,
  events,
  onLookupRunIdChange,
  onLoadRun,
}: {
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  return (
    <section className="inspector" aria-label="Run inspector">
      <div className="panel-title">
        <Search size={18} />
        <h2>{t("Run context")}</h2>
      </div>
      <label className="field wide">
        <span>{t("Run id")}</span>
        <input value={lookupRunId || activeRunId} onChange={(event) => onLookupRunIdChange(event.target.value)} />
      </label>
      <button className="secondary-button full" type="button" onClick={onLoadRun}>
        {t("Load persisted run")}
      </button>

      <div className="meta-list">
        <MetaRow label={t("Status")} value={run?.status ?? t("not loaded")} />
        <MetaRow label={t("Task")} value={run?.taskId ?? "-"} />
        <MetaRow label={t("Provider")} value={run ? `${run.providerName}/${run.providerModel}` : "-"} />
        <MetaRow label={t("Event log")} value={run?.eventLogPath ?? "-"} compact />
        <MetaRow label={t("Summary")} value={run?.summaryPath ?? "-"} compact />
      </div>

      <div className="inspector-block">
        <h3>{t("Tool calls")}</h3>
        {toolEvents.length === 0 ? (
          <p className="muted">{t("No tool activity yet.")}</p>
        ) : (
          toolEvents.map((event) => (
            <div className="tool-row" key={event.id}>
              <span>{event.type.replace("tool_", "")}</span>
              <code>{readDataString(event.data, "toolName") || "tool"}</code>
            </div>
          ))
        )}
      </div>

      <div className="inspector-block">
        <h3>{t("Persistence")}</h3>
        <div className="persistence-line">
          <CheckCircle2 size={16} />
          SQLite index
        </div>
        <div className="persistence-line">
          <CheckCircle2 size={16} />
          JSONL audit log
        </div>
      </div>
    </section>
  );
}
