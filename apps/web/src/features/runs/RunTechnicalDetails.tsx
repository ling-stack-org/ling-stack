import { Clock3, Database, SquareTerminal, Workflow } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatEventData, formatEventPreview, readDataBoolean, readDataField, readDataString, readDeepDataPreview, readDeepDataScalarString, summarizeUnifiedExecResultFromData, truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { findRelatedToolStart } from "../../lib/run-evidence.js";
import { inferPermissionPreset, permissionPresetLabel, readEffectivePolicySnapshot, readPermissionPresetFromSnapshot, readSessionPermissionModeFromSnapshot, sessionPermissionModeLabel, summarizeEffectivePolicySnapshot } from "../../lib/session-permissions.js";
import { MetaRow } from "../../shared/components/index.js";
import { DataRow, EmptyState, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ResourceLease, RunEventEnvelope, RunSession, StateTransitionEvent, WorkUnitDetailResponse } from "../../types.js";
import { EventRow } from "./EventRow.js";

export function RunTechnicalDetails({ run, events, leases, transitions, workUnitDetail }: {
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly leases: readonly ResourceLease[];
  readonly transitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const permissionMode = readSessionPermissionModeFromSnapshot(run.requestSnapshot);
  const permissionPreset = readPermissionPresetFromSnapshot(run.requestSnapshot) ?? inferPermissionPreset(permissionMode);
  const policy = readEffectivePolicySnapshot(run.requestSnapshot);
  const runner = readRunnerResolution(run, workUnitDetail?.workUnit);
  const terminal = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  return (
    <InspectorSection className="debug-details" summary={t("{count} events", { count: events.length })} title={t("Debug details")}>
      <div className="runs-section-stack">
        <section className="runs-subsection runtime-audit-block">
          <h3><Workflow size={15} />{t("State machine")} <small>{t("{count} transitions", { count: transitions.length })}</small></h3>
          <div className="runs-summary-grid">
            <MetaRow label={t("Requested runner")} value={runner.requestedRunnerId} compact /><MetaRow label={t("Effective runner")} value={runner.effectiveRunnerId} compact /><MetaRow label={t("Runner source")} value={runner.requestSource} compact />
            <MetaRow label={t("Work unit")} value={workUnitDetail?.workUnit.id ?? run.workUnitId ?? "-"} compact /><MetaRow label={t("Status")} value={workUnitDetail?.workUnit.status ?? "-"} compact /><MetaRow label={t("Attempt")} value={workUnitDetail?.workUnit.activeAttemptId ?? "-"} compact />
          </div>
          <div className="runs-section-list">{transitions.length === 0 ? <EmptyState compact icon={<Clock3 />} title={t("No state transition events loaded")} /> : transitions.map((transition) => <DataRow identity={`${transition.event}: ${transition.fromStatus} -> ${transition.toStatus}`} key={transition.id} status={<span><StatusIndicator compact label={transition.entityType} /><small>{formatDateTime(transition.createdAt)}</small></span>} />)}</div>
          {leases.length ? <div className="runs-section-list">{leases.map((lease) => <DataRow identity={truncatePreview(lease.resourceKey, 72)} key={lease.id} status={<StatusIndicator compact label={lease.status} />} summary={lease.resourceType} />)}</div> : null}
        </section>
        <section className="runs-subsection">
          <h3>{t("Effective permissions")}</h3>
          <div className="runs-summary-grid"><MetaRow label={t("Permission preset")} value={permissionPresetLabel(permissionPreset, t)} compact /><MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(policy?.mode ?? permissionMode, t)} compact />{summarizeEffectivePolicySnapshot(policy, t).map((summary, index) => <MetaRow key={`${index}:${summary}`} label={index ? t("Rule") : t("Summary")} value={summary} compact />)}</div>
        </section>
        <section className="runs-subsection"><h3><SquareTerminal size={15} />{t("Tool activity")}</h3>{toolEvents.length === 0 ? <EmptyState compact title={t("No tool activity recorded.")} /> : <div className="tool-event-list">{toolEvents.map((event) => <ToolEventDetails event={event} events={events} key={event.id} />)}</div>}</section>
        <section className="runs-subsection"><h3><Database size={15} />{t("Event timeline")}</h3><div className="event-list run-detail-events">{events.length === 0 ? <EmptyState compact title={t("No events loaded.")} /> : events.map((event) => <EventRow event={event} key={event.id} />)}</div></section>
        <section className="runs-subsection"><h3>{t("Session files")}</h3><div className="runs-session-files"><span>{t("Event log")}</span><code>{run.eventLogPath}</code><span>{t("Summary")}</span><code>{run.summaryPath ?? "-"}</code></div></section>
        <section className="runs-subsection"><h3>{t("Debug snapshots")}</h3><InspectorSection title={t("Request snapshot")}><pre className="runs-code-scroll">{formatEventData(run.requestSnapshot)}</pre></InspectorSection><InspectorSection title={t("Provider snapshot")}><pre className="runs-code-scroll">{formatEventData(run.providerSnapshot)}</pre></InspectorSection>{terminal ? <InspectorSection title={t("Terminal event")}><pre className="runs-code-scroll">{formatEventData(terminal.data)}</pre></InspectorSection> : null}</section>
      </div>
    </InspectorSection>
  );
}

function readRunnerResolution(run: RunSession, workUnit?: WorkUnitDetailResponse["workUnit"]): { requestedRunnerId: string; effectiveRunnerId: string; requestSource: string } {
  const resolution = readDataField(run.requestSnapshot, "runnerResolution");
  return {
    requestedRunnerId: readDataString(resolution, "requestedRunnerId") || workUnit?.requestedRunnerId || readDataString(run.requestSnapshot, "runnerId") || "-",
    effectiveRunnerId: readDataString(resolution, "effectiveRunnerId") || workUnit?.effectiveRunnerId || workUnit?.runnerId || "-",
    requestSource: readDataString(resolution, "requestSource") || "-",
  };
}

function ToolEventDetails({ event, events }: { readonly event: RunEventEnvelope; readonly events: readonly RunEventEnvelope[] }): React.JSX.Element {
  const { t } = useI18n();
  const isError = readDataBoolean(event.data, "isError");
  const start = event.type === "tool_start" ? undefined : findRelatedToolStart(events, event);
  const toolName = readDataString(event.data, "toolName") || event.type.replace("tool_", "");
  const toolCallId = readDeepDataScalarString(event.data, ["toolCallId"]) || readDeepDataScalarString(start?.data, ["toolCallId"]);
  const command = readDeepDataScalarString(event.data, ["command", "cmd", "script"]) || readDeepDataScalarString(start?.data, ["command", "cmd", "script"]);
  const target = readDeepDataScalarString(event.data, ["path", "filePath", "targetPath", "target"]) || readDeepDataScalarString(start?.data, ["path", "filePath", "targetPath", "target"]);
  const preview = summarizeUnifiedExecResultFromData(event.data) || readDeepDataPreview(event.data, ["message", "error", "detail", "reason", "result", "output", "stdout", "stderr"]) || command || formatEventPreview(event.data);
  return <InspectorSection open={isError} summary={`#${event.seq} ${event.type}`} title={toolName}><p className="runs-readable-copy">{preview}</p><div className="runs-summary-grid"><MetaRow label={t("Tool call")} value={toolCallId || "-"} compact /><MetaRow label={t("Command")} value={command || "-"} compact /><MetaRow label={t("Target path")} value={target || "-"} compact /></div><pre className="runs-code-scroll">{formatEventData(event.data)}</pre></InspectorSection>;
}
