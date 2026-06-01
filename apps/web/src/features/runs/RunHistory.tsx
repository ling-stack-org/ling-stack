import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { ApprovalCard, type ApprovalResolution } from "../approvals/index.js";
import { useI18n } from "../../i18n.js";
import {
  formatEventData,
  formatEventPreview,
  readDataBoolean,
  readDataString,
  readDeepDataPreview,
  readDeepDataScalarString,
  truncatePreview,
} from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  buildAssistantOutputPreview,
  buildRunRepairHint,
  buildRuntimeFailureSummary,
  findRelatedToolStart,
  readRunEventIssueText,
  readRunEvidenceMessage,
  readRunProviderPresetId,
  readRunWorkspaceCwd,
  readTaskPrompt,
  readTaskTitle,
  summarizeToolEvents,
} from "../../lib/run-evidence.js";
import {
  ArtifactRow,
  MetaRow,
  RunRepairHintBanner,
  StatusBadge,
} from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  StateTransitionEvent,
} from "../../types.js";

export function RunHistory({
  cwd,
  runs,
  selectedRunId,
  selectedRun,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isLoading,
  isRunning,
  errorMessage,
  onRefresh,
  onRefreshSelected,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
  onSelect,
}: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onRefreshSelected: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="run-history-layout">
      <section className="panel runs-panel" aria-labelledby="run-history-title">
        <div className="panel-title split">
          <span>
            <History size={18} />
            <h2 id="run-history-title">{t("Recent runs")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="runs-list">
          {runs.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <Clock3 />}
              <span>{isLoading ? t("Loading runs...") : t("No persisted runs for this workspace")}</span>
            </div>
          ) : (
            runs.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedRunId ? "run-list-row selected" : "run-list-row"}
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <span className={`status-dot ${item.status}`} />
                <span className="run-list-main">
                  <strong>{readTaskTitle(item.taskSnapshot) || item.taskId}</strong>
                  <small>{`${item.providerName}/${item.providerModel}`}</small>
                </span>
                <span className="run-list-meta">
                  <StatusBadge status={item.status} />
                  <time>{formatDateTime(item.createdAt)}</time>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <RunDetailPanel
        run={selectedRun}
        events={events}
        artifacts={artifacts}
        resourceLeases={resourceLeases}
        stateTransitions={stateTransitions}
        assistantText={assistantText}
        approvals={approvals}
        approvalsLoading={approvalsLoading}
        resolvingApprovals={resolvingApprovals}
        isRunning={isRunning}
        onRefresh={onRefreshSelected}
        onRefreshApprovals={onRefreshApprovals}
        onRerun={onRerun}
        onResolveApproval={onResolveApproval}
        onOpenProviders={onOpenProviders}
        onOpenApprovals={onOpenApprovals}
        onEditTask={onEditTask}
      />
    </div>
  );
}

function RunDetailPanel({
  run,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isRunning,
  onRefresh,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
}: {
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const workspaceCwd = run ? readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd : "-";
  const providerPresetId = run ? readRunProviderPresetId(run) : "";
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const repairHint = run ? buildRunRepairHint(run, pendingApprovals.length, run.status, readRunEventIssueText(terminalEvent), t) : undefined;
  const runtimeRepairRun = run && run.status === "failed" && repairHint?.target === "run" ? run : undefined;
  const runLeases = run ? resourceLeases.filter((lease) => lease.ownerId === run.id) : [];
  const relevantTransitions = run
    ? stateTransitions.filter((transition) =>
        (transition.entityType === "run" && transition.entityId === run.id) ||
        (transition.entityType === "task" && transition.entityId === run.taskId)
      )
    : [];

  return (
    <section className="panel run-detail-panel" aria-labelledby="run-detail-title">
      <div className="panel-title split">
        <span>
          <Activity size={18} />
          <h2 id="run-detail-title">{t("Run detail")}</h2>
        </span>
        <span className="run-detail-actions">
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={!run || isRunning}>
            <RefreshCw size={15} />
            {t("Reload")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => run && onRerun(run)} disabled={!run || isRunning || !providerPresetId}>
            {isRunning ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />}
            {t("Rerun snapshot")}
          </button>
        </span>
      </div>

      {!run ? (
        <div className="empty-state">
          <Search />
          <span>{t("Select a run to inspect execution details")}</span>
        </div>
      ) : (
        <div className="run-detail-content">
          <div className="run-detail-summary">
            <MetaRow label={t("Status")} value={run.status} compact />
            <MetaRow label={t("Provider")} value={`${run.providerName}/${run.providerModel}`} compact />
            <MetaRow label={t("Created")} value={formatDateTime(run.createdAt)} compact />
            <MetaRow label={t("Ended")} value={run.endedAt ? formatDateTime(run.endedAt) : "-"} compact />
          </div>

          {repairHint ? (
            <RunRepairHintBanner
              hint={repairHint}
              runId={run.id}
              onOpenProviders={() => onOpenProviders(run)}
              onOpenApprovals={onOpenApprovals}
              onReload={onRefresh}
            />
          ) : null}

          {run.errorMessage ? (
            <div className="inline-error">
              <CircleAlert size={17} />
              {run.errorMessage}
            </div>
          ) : null}

          {runtimeRepairRun ? (
            <RuntimeRunRepairPanel
              run={runtimeRepairRun}
              events={events}
              workspaceCwd={workspaceCwd}
              isRunning={isRunning}
              onEditTask={onEditTask}
              onRerun={onRerun}
              onReload={onRefresh}
            />
          ) : null}

          <div className="run-detail-section approval-state-section">
            <div className="panel-title tight split">
              <span>
                <ShieldCheck size={16} />
                <h3>{t("Approval state")}</h3>
              </span>
              <span className="approval-section-actions">
                <span className="event-count">{t("{count} approval events", { count: approvals.length })}</span>
                <button className="secondary-button compact-button" type="button" onClick={onRefreshApprovals} disabled={approvalsLoading}>
                  {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Refresh")}
                </button>
              </span>
            </div>
            {pendingApprovals.length > 0 ? (
              <div className="approval-waiting-banner" role="status">
                <Clock3 size={16} />
                <span>
                  {t(pendingApprovals.length === 1 ? "Waiting for {count} approval: {actions}" : "Waiting for {count} approvals: {actions}", {
                    count: pendingApprovals.length,
                    actions: pendingApprovals.map((approval) => approval.actionType).join(", "),
                  })}
                </span>
              </div>
            ) : null}
            {approvals.length === 0 ? (
              <p className="muted">{t("No approval gates recorded for this run.")}</p>
            ) : (
              <div className="run-approval-list">
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    compact
                    resolvingDecision={resolvingApprovals[approval.id]}
                    onResolve={onResolveApproval}
                  />
                ))}
              </div>
            )}
          </div>

          {assistantText ? (
            <div className="assistant-output">
              <span>{t("Assistant output")}</span>
              <p>{assistantText}</p>
            </div>
          ) : null}

          <RunEvidencePanel
            run={run}
            terminalEvent={terminalEvent}
            toolEvents={toolEvents}
            assistantText={assistantText}
            approvals={approvals}
            artifacts={artifacts}
          />

          <details className="run-detail-section json-details debug-details">
            <summary>
              <Database size={16} />
              <span>{t("Debug details")}</span>
            </summary>
            <div className="run-detail-section">
              <div className="panel-title tight">
                <Bot size={16} />
                <h3>{t("Task snapshot")}</h3>
              </div>
              <strong>{readTaskTitle(run.taskSnapshot) || run.taskId}</strong>
              <p>{readTaskPrompt(run.taskSnapshot) || t("No prompt snapshot.")}</p>
            </div>
            <RuntimeAuditBlock leases={runLeases} transitions={relevantTransitions} />
            <div className="run-detail-section">
              <div className="panel-title tight split">
                <span>
                  <SquareTerminal size={16} />
                  <h3>{t("Tool activity")}</h3>
                </span>
                <span className="event-count">{t("{count} tool events", { count: toolEvents.length })}</span>
              </div>
              {toolEvents.length === 0 ? (
                <p className="muted">{t("No tool activity recorded.")}</p>
              ) : (
                <div className="tool-event-list">
                  {toolEvents.map((event) => (
                    <ToolEventDetails key={event.id} event={event} events={events} />
                  ))}
                </div>
              )}
            </div>
            <div className="run-detail-section">
              <div className="panel-title tight split">
                <span>
                  <Database size={16} />
                  <h3>{t("Event timeline")}</h3>
                </span>
                <span className="event-count">{t("{count} events", { count: events.length })}</span>
              </div>
              {events.length === 0 ? (
                <p className="muted">{t("No events loaded.")}</p>
              ) : (
                <div className="event-list run-detail-events">
                  {events.map((event) => <EventRow key={event.id} event={event} />)}
                </div>
              )}
            </div>
            <div className="run-detail-section">
              <div className="panel-title tight">
                <Database size={16} />
                <h3>{t("Session files")}</h3>
              </div>
              <div className="session-file-list">
                <span>{t("Event log")}</span>
                <code>{run.eventLogPath}</code>
                <span>{t("Summary")}</span>
                <code>{run.summaryPath ?? "-"}</code>
              </div>
            </div>
            <div className="run-detail-section">
              <div className="panel-title tight">
                <Database size={16} />
                <h3>{t("Debug snapshots")}</h3>
              </div>
              <div className="run-evidence-grid">
                <MetaRow label={t("Provider preset")} value={providerPresetId || "-"} compact />
                <MetaRow label={t("Task")} value={run.taskId} compact />
                <MetaRow label={t("Channel")} value={run.channelId ?? "-"} compact />
              </div>
              <details className="json-details">
                <summary>{t("Request snapshot")}</summary>
                <pre>{formatEventData(run.requestSnapshot)}</pre>
              </details>
              <details className="json-details">
                <summary>{t("Provider snapshot")}</summary>
                <pre>{formatEventData(run.providerSnapshot)}</pre>
              </details>
              {terminalEvent ? (
                <details className="json-details">
                  <summary>{t("Terminal event")}</summary>
                  <pre>{formatEventData(terminalEvent.data)}</pre>
                </details>
              ) : null}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function RuntimeAuditBlock({
  leases,
  transitions,
}: {
  readonly leases: readonly ResourceLease[];
  readonly transitions: readonly StateTransitionEvent[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="run-detail-section runtime-audit-block">
      <div className="panel-title tight split">
        <span>
          <Workflow size={16} />
          <h3>{t("State machine")}</h3>
        </span>
        <span className="event-count">{t("{count} transitions", { count: transitions.length })}</span>
      </div>
      {leases.length > 0 ? (
        <div className="runtime-list">
          {leases.map((lease) => (
            <div key={lease.id} className="runtime-list-row">
              <StatusBadge status={lease.resourceType} />
              <span>{truncatePreview(lease.resourceKey, 48)}</span>
              <small>{lease.status}</small>
            </div>
          ))}
        </div>
      ) : null}
      <div className="runtime-list transition-list">
        {transitions.length === 0 ? (
          <div className="empty-state compact-empty">
            <Clock3 />
            <span>{t("No state transition events loaded")}</span>
          </div>
        ) : (
          transitions.slice(0, 8).map((transition) => (
            <div key={transition.id} className="runtime-list-row">
              <StatusBadge status={transition.entityType} />
              <span>{transition.event}: {transition.fromStatus} -&gt; {transition.toStatus}</span>
              <small>{formatDateTime(transition.createdAt)}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RunEvidencePanel({
  run,
  terminalEvent,
  toolEvents,
  assistantText,
  approvals,
  artifacts,
}: {
  readonly run: RunSession;
  readonly terminalEvent: RunEventEnvelope | undefined;
  readonly toolEvents: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
}): JSX.Element {
  const { t } = useI18n();
  const taskLabel = readTaskTitle(run.taskSnapshot) || run.taskId;
  const providerLabel = `${run.providerName}/${run.providerModel}`;
  const terminalLabel = terminalEvent ? `#${terminalEvent.seq} ${terminalEvent.type}` : "-";
  const evidenceMessage = readRunEvidenceMessage(run, terminalEvent, t);
  const assistantPreview = buildAssistantOutputPreview(assistantText, t);
  const toolSummary = summarizeToolEvents(toolEvents);
  const artifactCwd = readRunWorkspaceCwd(run, run.cwd);

  return (
    <div className="run-detail-section run-evidence">
      <div className="panel-title tight split">
        <span>
          <CheckCircle2 size={16} />
          <h3>{t("Evidence")}</h3>
        </span>
        <span className="event-count">{t("audit preview")}</span>
      </div>

      <div className="run-evidence-block">
        <strong>{t("Run summary preview")}</strong>
        <div className="run-evidence-grid">
          <MetaRow label={t("Status")} value={run.status} compact />
          <MetaRow label={t("Task")} value={taskLabel} compact />
          <MetaRow label={t("Provider")} value={providerLabel} compact />
          <MetaRow label={t("Terminal event")} value={terminalLabel} compact />
          <MetaRow label={t("Tool events")} value={String(toolSummary.total)} compact />
          <MetaRow label={t("Errored tools")} value={String(toolSummary.errorCount)} compact />
          <MetaRow label={t("Approvals")} value={String(approvals.length)} compact />
        </div>
        <p className={`run-evidence-copy${run.status === "failed" ? " error" : ""}`}>{evidenceMessage}</p>
        <p className="run-evidence-copy">
          <strong>{t("Assistant output")}</strong>
          {assistantPreview}
        </p>
      </div>

      <div className="run-evidence-block">
        <strong>{t("Artifacts")}</strong>
        {artifacts.length === 0 ? (
          <div className="artifact-empty-state">
            <span>{t("No artifacts recorded for this run")}</span>
            <small>{t("Artifacts will appear here once the daemon records files under .ling-stack/artifacts.")}</small>
          </div>
        ) : (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <ArtifactRow artifact={artifact} cwd={artifactCwd} key={artifact.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RuntimeRunRepairPanel({
  run,
  events,
  workspaceCwd,
  isRunning,
  onEditTask,
  onRerun,
  onReload,
}: {
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly workspaceCwd: string;
  readonly isRunning: boolean;
  readonly onEditTask: (run: RunSession) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onReload: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const summary = buildRuntimeFailureSummary(run, events, workspaceCwd, t);
  const canEditTask = Boolean(run.channelId && run.taskId);
  const canRerun = Boolean(readRunProviderPresetId(run));

  return (
    <div className="runtime-run-repair" aria-label={t("Runtime run repair")}>
      <div className="runtime-run-repair-head">
        <span>
          <SquareTerminal size={16} />
          <strong>{t("Repair runtime/tool failure")}</strong>
        </span>
        <StatusBadge status={run.status} />
      </div>
      <div className="runtime-run-repair-copy">
        <span>
          {t("Run {runId} failed at {eventLabel}.", { runId: run.id, eventLabel: summary.eventLabel })}
        </span>
        <small>{summary.issueText}</small>
        <small>{summary.suggestion}</small>
      </div>
      <div className="runtime-run-repair-meta">
        <MetaRow label={t("Tool")} value={summary.toolName || "-"} compact />
        <MetaRow label={t("Event")} value={summary.eventLabel} compact />
        <MetaRow label={t("Exit code")} value={summary.exitCode || "-"} compact />
        {summary.command ? <MetaRow label={t("Command")} value={summary.command} compact /> : null}
        {summary.targetPath ? <MetaRow label={t("Target path")} value={summary.targetPath} compact /> : null}
      </div>
      <div className="runtime-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onEditTask(run)} disabled={!canEditTask}>
          <Pencil size={14} />
          {t("Edit task")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRerun(run)} disabled={isRunning || !canRerun}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
          {t("Rerun snapshot")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={onReload} disabled={isRunning}>
          <RefreshCw size={14} />
          {t("Reload")}
        </button>
      </div>
    </div>
  );
}

function ToolEventDetails({
  event,
  events,
}: {
  readonly event: RunEventEnvelope;
  readonly events: readonly RunEventEnvelope[];
}): JSX.Element {
  const { t } = useI18n();
  const isError = readDataBoolean(event.data, "isError");
  const toolName = readDataString(event.data, "toolName") || event.type.replace("tool_", "");
  const relatedToolStart = event.type === "tool_start" ? undefined : findRelatedToolStart(events, event);
  const toolCallId = readDeepDataScalarString(event.data, ["toolCallId"]) || readDeepDataScalarString(relatedToolStart?.data, ["toolCallId"]);
  const command = readDeepDataScalarString(event.data, ["command", "cmd", "script"]) || readDeepDataScalarString(relatedToolStart?.data, ["command", "cmd", "script"]);
  const targetPath = readDeepDataScalarString(event.data, ["path", "filePath", "targetPath", "target"])
    || readDeepDataScalarString(relatedToolStart?.data, ["path", "filePath", "targetPath", "target"]);
  const outputPreview = readDeepDataPreview(event.data, ["message", "error", "detail", "reason", "result", "partialResult", "output", "stdout", "stderr"]);
  const summaryPreview = outputPreview || command || formatEventPreview(event.data);

  return (
    <details className={`tool-event-row${isError ? " error" : ""}`} open={isError}>
      <summary className="tool-event-summary">
        <span>#{event.seq}</span>
        <strong>{toolName}</strong>
        <code>{event.type}</code>
        <small>{isError ? t("error") : formatDateTime(event.ts)}</small>
      </summary>
      <div className="tool-event-details">
        {summaryPreview ? <p className="tool-event-preview">{summaryPreview}</p> : null}
        <div className="tool-event-meta">
          <MetaRow label={t("Tool call")} value={toolCallId || "-"} compact />
          <MetaRow label={t("Command")} value={command || "-"} compact />
          <MetaRow label={t("Target path")} value={targetPath || "-"} compact />
        </div>
        <details className="json-details compact-json">
          <summary>{t("Raw tool payload")}</summary>
          <pre>{formatEventData(event.data)}</pre>
        </details>
      </div>
    </details>
  );
}

export function EventRow({ event }: { readonly event: RunEventEnvelope }): JSX.Element {
  const { t } = useI18n();
  const preview = formatEventPreview(event.data);
  const payloadOpen = event.type === "run_error" || event.type === "result" || (event.type === "tool_end" && readDataBoolean(event.data, "isError"));

  return (
    <article className={`event-row ${event.type}`}>
      <div className="event-seq">#{event.seq}</div>
      <div className="event-body">
        <div className="event-head">
          <span>{event.type}</span>
          <time>{new Date(event.ts).toLocaleTimeString()}</time>
        </div>
        <details className="event-payload" open={payloadOpen}>
          <summary>
            <span>{preview || t("Payload")}</span>
          </summary>
          <pre>{formatEventData(event.data)}</pre>
        </details>
      </div>
    </article>
  );
}
