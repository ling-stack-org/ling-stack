import { CheckCircle2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { buildAssistantOutputPreview, readRunEvidenceMessage, readTaskTitle, summarizeToolEvents } from "../../lib/run-evidence.js";
import { filterUsedMemoryEventsByResponse, UsedMemorySummary } from "../../shared/components/index.js";
import { ConversationEvidenceBundlePanel, ConversationSummaryRow, MessageBodyRenderer } from "../../shared/conversation/index.js";
import { InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ApprovalRequest, MemoryObject, RunArtifact, RunEventEnvelope, RunSession, UsedMemoryEvent } from "../../types.js";
import { runStatusTone } from "./run-list-view-models.js";
import { ShellSnapshotPanel } from "./ShellSnapshotPanel.js";
import { terminalRunEvent } from "./run-detail-view-models.js";

export function RunEvidenceSection({ cwd, run, events, assistantText, approvals, artifacts, memoryById, usedMemoryEvents }: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
}): JSX.Element {
  const { t } = useI18n();
  const terminalEvent = terminalRunEvent(events);
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const toolSummary = summarizeToolEvents(toolEvents);
  const runMemory = filterUsedMemoryEventsByResponse(usedMemoryEvents, run.id);
  const summary = readRunEvidenceMessage(run, terminalEvent, t);
  return (
    <InspectorSection open summary={t("audit preview")} title={t("Evidence")}>
      <div className="runs-section-stack">
        <h3 className="runs-section-heading">{t("Evidence")}</h3>
        <ConversationSummaryRow
          body={<MessageBodyRenderer className="runs-readable-copy" compact cwd={cwd} text={summary} />}
          icon={<CheckCircle2 size={16} />}
          metaItems={[
            { id: "provider", label: t("Provider"), value: `${run.providerName}/${run.providerModel}` },
            { id: "tools", label: t("Tool events"), value: String(toolSummary.total) },
            { id: "approvals", label: t("Approvals"), value: String(approvals.length) },
            { id: "artifacts", label: t("Artifacts"), value: String(artifacts.length) },
          ]}
          statusNode={<StatusIndicator compact label={t(run.status)} tone={runStatusTone(run.status)} />}
          title={readTaskTitle(run.taskSnapshot) || run.taskId}
        />
        <ConversationEvidenceBundlePanel
          label={t("Evidence")}
          bundle={{
            summary: runMemory.length ? t("Used memory") : t("Run summary preview"),
            sections: [
              { id: "assistant", label: t("Assistant output"), content: <p className="runs-readable-copy">{buildAssistantOutputPreview(assistantText, t)}</p> },
              ...(runMemory.length ? [{ id: "memory", label: t("Memory"), content: <UsedMemorySummary events={runMemory} memoryById={memoryById} /> }] : []),
            ],
          }}
        />
        <ShellSnapshotPanel artifacts={artifacts} cwd={cwd} run={run} />
      </div>
    </InspectorSection>
  );
}
