import { AlertCircle, CheckCircle2, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readDataString } from "../../lib/data.js";
import { MetaRow } from "../../shared/components/index.js";
import { Button, Input, InspectorSection } from "../../shared/ui/index.js";
import type { RunArtifact, RunEventEnvelope, RunSession } from "../../types.js";

export function RunInspector({
  activeRunId,
  lookupRunId,
  run,
  events,
  artifacts = [],
  isLoading,
  errorMessage,
  onLookupRunIdChange,
  onLoadRun,
}: {
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts?: readonly RunArtifact[];
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  return (
    <section className="inspector" aria-label={t("Run inspector")}>
      <div className="panel-title">
        <Search size={18} />
        <h2>{t("Run context")}</h2>
      </div>
      <div className="run-inspector-lookup">
        <label htmlFor="run-inspector-id">{t("Run id")}</label>
        <div className="run-inspector-lookup-controls">
          <Input
            id="run-inspector-id"
            value={lookupRunId}
            placeholder={t("Run id")}
            disabled={isLoading}
            onChange={(event) => onLookupRunIdChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void Promise.resolve(onLoadRun()).catch(() => undefined);
              }
            }}
          />
          <Button size="sm" variant="secondary" loading={isLoading} loadingLabel={t("Loading")} onClick={() => void Promise.resolve(onLoadRun()).catch(() => undefined)}>
            {t("Load persisted run")}
          </Button>
        </div>
        {errorMessage ? <p className="run-inspector-error" role="alert"><AlertCircle size={14} />{errorMessage}</p> : null}
        {!run && !isLoading && !errorMessage ? <p className="muted">{t("No run loaded yet")}</p> : null}
        {activeRunId ? <span className="run-inspector-active-id">{activeRunId}</span> : null}
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
          <MetaRow label={t("Artifacts")} value={String(artifacts.length)} compact />
        </div>
      </InspectorSection>
    </section>
  );
}
