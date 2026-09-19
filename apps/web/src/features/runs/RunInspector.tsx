import { CheckCircle2, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readDataString } from "../../lib/data.js";
import { MetaRow } from "../../shared/components/index.js";
import { InspectorSection } from "../../shared/ui/index.js";
import type { RunArtifact, RunEventEnvelope, RunSession } from "../../types.js";

export function RunInspector({
  activeRunId,
  lookupRunId,
  run,
  events,
  artifacts = [],
  onLookupRunIdChange,
  onLoadRun,
}: {
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts?: readonly RunArtifact[];
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  void activeRunId;
  void lookupRunId;
  void artifacts;
  void onLookupRunIdChange;
  void onLoadRun;
  return (
    <section className="inspector" aria-label="Run inspector">
      <div className="panel-title">
        <Search size={18} />
        <h2>{t("Run context")}</h2>
      </div>
      <div className="meta-list">
        <MetaRow label={t("Status")} value={run?.status ?? t("not loaded")} />
        <MetaRow label={t("Provider")} value={run ? `${run.providerName}/${run.providerModel}` : "-"} />
      </div>
      <InspectorSection summary={String(toolEvents.length)} title={t("Tool calls")}>
        {toolEvents.length === 0 ? <p className="muted">{t("No tool activity yet.")}</p> : toolEvents.map((event) => (
          <div className="tool-row" key={event.id}>
            <span>{event.type.replace("tool_", "")}</span>
            <code>{readDataString(event.data, "toolName") || "tool"}</code>
          </div>
        ))}
      </InspectorSection>
      <InspectorSection title={t("Persistence")}>
        <div className="persistence-line"><CheckCircle2 size={16} />{t("Run record saved")}</div>
        <div className="meta-list">
          <MetaRow label={t("Task")} value={run?.taskId ?? "-"} />
          <MetaRow label={t("Event log")} value={run?.eventLogPath ?? "-"} compact />
          <MetaRow label={t("Summary")} value={run?.summaryPath ?? "-"} compact />
        </div>
      </InspectorSection>
    </section>
  );
}
