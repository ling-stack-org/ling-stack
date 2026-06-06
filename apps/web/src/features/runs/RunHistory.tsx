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
  Square,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { LingDaemonError } from "@ling-stack/api-client";
import { useEffect, useState } from "react";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { cancelRunIntervention, createRunIntervention, getLingThreadEvidence, listLingThreads, listRunInterventions, previewLingThreadResume, resumeLingThread } from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  formatEventData,
  formatEventPreview,
  readDataBoolean,
  readDataField,
  readDataString,
  readDeepDataPreview,
  readDeepDataScalarString,
  truncatePreview,
} from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  readEffectivePolicySnapshot,
  readSessionPermissionModeFromSnapshot,
  sessionPermissionModeLabel,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
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
  UsedMemorySummary,
  filterUsedMemoryEventsByResponse,
} from "../../shared/components/index.js";
import { ConversationEvidenceBundlePanel, ConversationSummaryRow, FileChangeEvidencePanel, MessageBodyRenderer } from "../../shared/conversation/index.js";
import { fileChangeStatusFromRun } from "../../lib/file-change-evidence.js";
import { EventRow } from "./EventRow.js";
import type {
  ApprovalRequest,
  LingThread,
  LingThreadEvidenceResponse,
  LingThreadResumePreviewResponse,
  MemoryObject,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunIntervention,
  RunSession,
  StateTransitionEvent,
  UsedMemoryEvent,
  WorkUnitDetailResponse,
} from "../../types.js";

export function RunHistory({
  cwd,
  runs,
  selectedRunId,
  selectedRun,
  memoryById,
  usedMemoryEvents,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  workUnitDetail,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isLoading,
  isRunning,
  cancellingRunId,
  errorMessage,
  onRefresh,
  onRefreshSelected,
  onRefreshApprovals,
  onRerun,
  onCancelRun,
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
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly cancellingRunId: string;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onRefreshSelected: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onCancelRun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");

  async function refreshThreads(): Promise<void> {
    if (!cwd.trim()) {
      setThreads([]);
      setThreadError("");
      return;
    }
    setThreadsLoading(true);
    setThreadError("");
    try {
      const response = await listLingThreads(cwd, { limit: 50 });
      setThreads(response.threads);
    } catch (error) {
      if (error instanceof LingDaemonError && error.status === 404) {
        setThreads([]);
        setThreadError("");
        return;
      }
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadsLoading(false);
    }
  }

  const visibleThreads = threads.length > 0 ? threads : deriveThreadsFromRuns(runs);
  const selectedThread = selectedThreadId ? visibleThreads.find((thread) => thread.id === selectedThreadId) : undefined;

  function handleSelectRun(runId: string): void {
    setSelectedThreadId("");
    onSelect(runId);
  }

  function handleSelectThread(thread: LingThread): void {
    setSelectedThreadId(thread.id);
    const targetRunId = thread.activeRunId ?? thread.lastRunId;
    if (targetRunId && targetRunId !== selectedRunId) {
      onSelect(targetRunId);
    }
  }

  function refreshThreadAndRuns(): void {
    onRefresh();
    void refreshThreads();
  }

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

        <div className="thread-list-section">
          <div className="panel-title tight split">
            <span>
              <Workflow size={16} />
              <h3>{t("Threads")}</h3>
            </span>
            <button className="secondary-button compact-button" type="button" onClick={() => void refreshThreads()} disabled={threadsLoading}>
              {threadsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          </div>
          {threadError ? (
            <div className="inline-error compact">
              <CircleAlert size={15} />
              {threadError}
            </div>
          ) : null}
          <div className="runs-list thread-list">
            {visibleThreads.length === 0 ? (
              <div className="empty-state compact-empty">
                {threadsLoading ? <Loader2 className="spin" /> : <Workflow />}
                <span>{threadsLoading ? t("Loading threads...") : t("No threads yet")}</span>
              </div>
            ) : (
              visibleThreads.map((thread) => {
                const targetRunId = thread.activeRunId ?? thread.lastRunId;
                const selected = thread.id === selectedThreadId || (!selectedThreadId && targetRunId === selectedRunId);
                return (
                  <button
                    key={thread.id}
                    className={selected ? "run-list-row selected" : "run-list-row"}
                    type="button"
                    onClick={() => handleSelectThread(thread)}
                  >
                    <span className={`status-dot ${thread.status}`} />
                    <span className="run-list-main">
                      <strong>{thread.title}</strong>
                      <small>{thread.kind} · {thread.objective}</small>
                    </span>
                    <span className="run-list-meta">
                      <StatusBadge status={thread.status} />
                      <time>{formatDateTime(thread.updatedAt)}</time>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="panel-title tight">
          <span>
            <History size={16} />
            <h3>{t("Runs")}</h3>
          </span>
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
                onClick={() => handleSelectRun(item.id)}
              >
                <span className={`status-dot ${item.status}`} />
                <span className="run-list-main">
                  <strong>{readTaskTitle(item.taskSnapshot) || item.taskId}</strong>
                  <small>{`${item.providerName}/${item.providerModel} · ${runnerListLabel(item)}`}</small>
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

      {selectedThreadId ? (
        <ThreadDetailPanel
          cwd={cwd}
          thread={selectedThread}
          threadId={selectedThreadId}
          isRunning={isRunning}
          onRefresh={refreshThreadAndRuns}
          onSelectRun={handleSelectRun}
        />
      ) : (
        <RunDetailPanel
          run={selectedRun}
          memoryById={memoryById}
          usedMemoryEvents={usedMemoryEvents}
          events={events}
          artifacts={artifacts}
          resourceLeases={resourceLeases}
          stateTransitions={stateTransitions}
          workUnitDetail={workUnitDetail}
          assistantText={assistantText}
          approvals={approvals}
          approvalsLoading={approvalsLoading}
          resolvingApprovals={resolvingApprovals}
          isRunning={isRunning}
          cancellingRunId={cancellingRunId}
          onRefresh={onRefreshSelected}
          onRefreshApprovals={onRefreshApprovals}
          onRerun={onRerun}
          onCancelRun={onCancelRun}
          onResolveApproval={onResolveApproval}
          onOpenProviders={onOpenProviders}
          onOpenApprovals={onOpenApprovals}
          onEditTask={onEditTask}
          cwd={cwd}
        />
      )}
    </div>
  );
}

export function ThreadDetailPanel({
  cwd,
  thread,
  threadId,
  isRunning,
  onRefresh,
  onSelectRun,
}: {
  readonly cwd: string;
  readonly thread: LingThread | undefined;
  readonly threadId: string;
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [threadEvidence, setThreadEvidence] = useState<LingThreadEvidenceResponse | undefined>(undefined);
  const [threadEvidenceLoading, setThreadEvidenceLoading] = useState(false);
  const [threadActionLoading, setThreadActionLoading] = useState(false);
  const [threadPreviewLoading, setThreadPreviewLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [threadInterventions, setThreadInterventions] = useState<readonly RunIntervention[]>([]);
  const [threadInterventionsLoading, setThreadInterventionsLoading] = useState(false);
  const [threadInterventionError, setThreadInterventionError] = useState("");
  const [selectedSourceRunId, setSelectedSourceRunId] = useState("");
  const [resumedRunId, setResumedRunId] = useState("");
  const [resumePreview, setResumePreview] = useState<LingThreadResumePreviewResponse | undefined>(undefined);
  const [resumeInstruction, setResumeInstruction] = useState("");
  const displayThread = threadEvidence?.thread ?? thread;
  const evidenceRuns = threadEvidence?.runs ?? [];
  const threadArtifactById = buildThreadArtifactMap(threadEvidence);
  const sourceRun = resolveThreadSourceRun(displayThread, evidenceRuns, selectedSourceRunId);
  const sourceRunId = selectedSourceRunId || sourceRun?.id || displayThread?.lastRunId || "";
  const activeRun = displayThread?.activeRunId
    ? evidenceRuns.find((item) => item.run.id === displayThread.activeRunId)?.run
    : undefined;
  const hasActiveNonTerminalRun = Boolean(displayThread?.activeRunId && (!activeRun || runCanBeStopped(activeRun)));
  const canPreviewThreadResume = Boolean(displayThread && sourceRunId);
  const canResumeThread = Boolean(canPreviewThreadResume && !hasActiveNonTerminalRun && !isRunning);
  const resumeDisabledReason = buildThreadResumeDisabledReason({
    hasThread: Boolean(displayThread),
    hasSourceRun: Boolean(sourceRunId),
    hasActiveNonTerminalRun,
    isRunning,
    t,
  });

  useEffect(() => {
    setThreadEvidence(undefined);
    setThreadError("");
    setThreadInterventions([]);
    setThreadInterventionError("");
    setSelectedSourceRunId(thread?.lastRunId ?? "");
    setResumedRunId("");
    setResumePreview(undefined);
    setResumeInstruction("");
    void loadThreadEvidence(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, threadId]);

  async function loadThreadEvidence(nextThreadId = threadId): Promise<void> {
    if (!nextThreadId) {
      return;
    }
    setThreadEvidenceLoading(true);
    setThreadError("");
    try {
      const response = await getLingThreadEvidence(cwd, nextThreadId);
      setThreadEvidence(response);
      const latestRun = response.runs.length > 0 ? response.runs[response.runs.length - 1]?.run : undefined;
      const nextSourceRunId = response.thread.lastRunId ?? latestRun?.id ?? "";
      setSelectedSourceRunId((current) =>
        current && response.runs.some((item) => item.run.id === current) ? current : nextSourceRunId
      );
      await loadThreadInterventions(response.runs.map((item) => item.run.id));
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadEvidenceLoading(false);
    }
  }

  async function loadThreadInterventions(runIds: readonly string[]): Promise<void> {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length === 0) {
      setThreadInterventions([]);
      setThreadInterventionError("");
      return;
    }
    setThreadInterventionsLoading(true);
    setThreadInterventionError("");
    try {
      const settled = await Promise.allSettled(uniqueRunIds.map((runId) => listRunInterventions(cwd, runId, 100)));
      const interventions: RunIntervention[] = [];
      let failedCount = 0;
      for (const result of settled) {
        if (result.status === "fulfilled") {
          interventions.push(...result.value.interventions);
        } else {
          failedCount += 1;
        }
      }
      setThreadInterventions(uniqueInterventions(interventions));
      if (failedCount > 0) {
        setThreadInterventionError(t("{count} intervention audit request failed", { count: failedCount }));
      }
    } finally {
      setThreadInterventionsLoading(false);
    }
  }

  async function previewResumeThread(): Promise<void> {
    if (!canPreviewThreadResume || !sourceRunId) {
      return;
    }
    setThreadPreviewLoading(true);
    setThreadError("");
    try {
      setResumePreview(await previewLingThreadResume(cwd, threadId, {
        sourceRunId,
        instruction: resumeInstruction.trim() || "Resume this Ling thread from the thread detail.",
        includeArtifacts: true,
      }));
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadPreviewLoading(false);
    }
  }

  async function handleResumeThread(): Promise<void> {
    if (!canResumeThread || !sourceRunId) {
      return;
    }
    setThreadActionLoading(true);
    setThreadError("");
    try {
      const response = await resumeLingThread(cwd, threadId, {
        sourceRunId,
        instruction: resumeInstruction.trim() || "Resume this Ling thread from the thread detail.",
      });
      setResumedRunId(response.runId ?? "");
      setResumeInstruction("");
      setResumePreview(undefined);
      onRefresh();
      void loadThreadEvidence(threadId);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadActionLoading(false);
    }
  }

  return (
    <section className="panel run-detail-panel thread-detail-panel" aria-labelledby="thread-detail-title" aria-label={t("Thread detail")}>
      <div className="panel-title split">
        <span>
          <Workflow size={18} />
          <h2 id="thread-detail-title">{t("Thread detail")}</h2>
        </span>
        <span className="run-detail-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => void loadThreadEvidence()} disabled={threadEvidenceLoading}>
            {threadEvidenceLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Reload")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => sourceRunId && onSelectRun(sourceRunId)} disabled={!sourceRunId}>
            <Activity size={15} />
            {t("Open source run")}
          </button>
        </span>
      </div>

      <div className="run-detail-content">
        <div className="run-detail-summary">
          <MetaRow label={t("Thread")} value={threadId} compact />
          <MetaRow label={t("Title")} value={displayThread?.title ?? "-"} compact />
          <MetaRow label={t("Status")} value={displayThread?.status ?? "-"} compact />
          <MetaRow label={t("Kind")} value={displayThread?.kind ?? "-"} compact />
          <MetaRow label={t("Active run")} value={displayThread?.activeRunId ?? "-"} compact />
          <MetaRow label={t("Last run")} value={displayThread?.lastRunId ?? "-"} compact />
          <MetaRow label={t("Workflow step")} value={displayThread?.workflowStepId ?? "-"} compact />
          <MetaRow label={t("Updated")} value={displayThread ? formatDateTime(displayThread.updatedAt) : "-"} compact />
        </div>

        {displayThread?.objective ? (
          <p className="run-evidence-copy">
            <strong>{t("Objective")}</strong>
            {displayThread.objective}
          </p>
        ) : null}

        {hasActiveNonTerminalRun ? (
          <div className="inline-warning">
            <Clock3 size={16} />
            {t("Thread has an active run; resume is disabled until it reaches a terminal state.")}
          </div>
        ) : null}

        {threadError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {threadError}
          </div>
        ) : null}

        <div className="run-detail-section">
          <div className="panel-title tight split">
            <span>
              <History size={16} />
              <h3>{t("Thread lineage")}</h3>
            </span>
            <span className="event-count">{t("{count} runs", { count: evidenceRuns.length })}</span>
          </div>
          {threadEvidenceLoading && evidenceRuns.length === 0 ? (
            <div className="empty-state compact-empty">
              <Loader2 className="spin" />
              <span>{t("Loading thread evidence...")}</span>
            </div>
          ) : evidenceRuns.length === 0 ? (
            <div className="empty-state compact-empty">
              <History />
              <span>{t("No thread runs recorded")}</span>
            </div>
          ) : (
            <div className="runtime-list thread-lineage-list">
              {evidenceRuns.map((item) => (
                <div key={item.run.id} className="runtime-list-row">
                  <StatusBadge status={item.run.status} />
                  <span>
                    {readTaskTitle(item.run.taskSnapshot) || item.run.taskId}
                    <small>{item.run.id}</small>
                  </span>
                  <small>
                    {item.run.providerName}/{item.run.providerModel}
                    {" · "}
                    {t("{count} events", { count: item.events.length })}
                    {" · "}
                    {t("{count} approval events", { count: item.approvals.length })}
                    {" · "}
                    {t("{count} artifacts", { count: item.artifacts.length })}
                  </small>
                  <button className="secondary-button compact-button" type="button" onClick={() => onSelectRun(item.run.id)}>
                    {t("Open run")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="run-detail-section">
          <div className="panel-title tight split">
            <span>
              <ShieldCheck size={16} />
              <h3>{t("Execution actions")}</h3>
            </span>
            <span className="event-count">{t("{count} actions", { count: threadEvidence?.actions.length ?? 0 })}</span>
          </div>
          {!threadEvidence || threadEvidence.actions.length === 0 ? (
            <div className="empty-state compact-empty">
              <ShieldCheck />
              <span>{t("No execution actions recorded")}</span>
            </div>
          ) : (
            <div className="runtime-list">
              {threadEvidence.actions.map((action) => (
                <div key={action.id} className="runtime-list-row">
                  <StatusBadge status={action.status} />
                  <span>
                    {action.actionType}: {action.title}
                    <ActionArtifactChips label={t("Preview")} artifactIds={action.previewArtifactIds} artifactsById={threadArtifactById} />
                    <ActionArtifactChips label={t("Result")} artifactIds={action.resultArtifactIds} artifactsById={threadArtifactById} />
                  </span>
                  <small>{formatActionTargets(action.targetRefs)}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="run-detail-section">
          <div className="panel-title tight split">
            <span>
              <RotateCcw size={16} />
              <h3>{t("Queued follow-ups and redirects")}</h3>
            </span>
            <span className="event-count">{t("{count} interventions", { count: threadInterventions.length })}</span>
          </div>
          {threadInterventionError ? (
            <p className="run-evidence-copy error">{threadInterventionError}</p>
          ) : null}
          {threadInterventionsLoading && threadInterventions.length === 0 ? (
            <div className="empty-state compact-empty">
              <Loader2 className="spin" />
              <span>{t("Loading interventions...")}</span>
            </div>
          ) : threadInterventions.length === 0 ? (
            <div className="empty-state compact-empty">
              <RotateCcw />
              <span>{t("No queued follow-ups or redirects")}</span>
            </div>
          ) : (
            <div className="runtime-list">
              {threadInterventions.map((intervention) => (
                <div key={intervention.id} className="runtime-list-row">
                  <StatusBadge status={intervention.status} />
                  <span>
                    {intervention.mode}: {intervention.instruction}
                    {intervention.continuationRunId ? <small>{t("Continuation run")}: {intervention.continuationRunId}</small> : null}
                  </span>
                  <small>{formatDateTime(intervention.updatedAt)}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="run-detail-section thread-resume-panel">
          <div className="panel-title tight split">
            <span>
              <RotateCcw size={16} />
              <h3>{t("Resume context preview")}</h3>
            </span>
            <span className="event-count">{sourceRunId || "-"}</span>
          </div>
          <label className="approval-reason-field thread-resume-composer">
            <span>{t("Resume source run")}</span>
            <select
              value={sourceRunId}
              onChange={(event) => {
                setSelectedSourceRunId(event.target.value);
                setResumePreview(undefined);
              }}
              disabled={evidenceRuns.length === 0 || threadActionLoading}
            >
              {!sourceRunId ? <option value="">{t("No source run")}</option> : null}
              {sourceRunId && !evidenceRuns.some((item) => item.run.id === sourceRunId) ? (
                <option value={sourceRunId}>{sourceRunId}</option>
              ) : null}
              {evidenceRuns.map((item) => (
                <option key={item.run.id} value={item.run.id}>
                  {readTaskTitle(item.run.taskSnapshot) || item.run.taskId} · {item.run.id}
                </option>
              ))}
            </select>
          </label>
          <label className="approval-reason-field thread-resume-composer">
            <span>{t("Resume instruction")}</span>
            <textarea
              value={resumeInstruction}
              rows={3}
              placeholder={t("Tell the next continuation what changed or what to do next...")}
              onChange={(event) => setResumeInstruction(event.target.value)}
              disabled={!canPreviewThreadResume || threadActionLoading}
            />
          </label>
          {resumeDisabledReason ? (
            <p className="run-evidence-copy">
              <strong>{t("Resume guard")}</strong>
              {resumeDisabledReason}
            </p>
          ) : null}
          <div className="button-row compact">
            <button className="secondary-button compact-button" type="button" onClick={() => void previewResumeThread()} disabled={!canPreviewThreadResume || threadPreviewLoading}>
              {threadPreviewLoading ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
              {t("Preview resume")}
            </button>
            <button className="primary-button compact-button" type="button" onClick={() => void handleResumeThread()} disabled={!canResumeThread || threadActionLoading}>
              {threadActionLoading ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
              {t("Resume thread")}
            </button>
          </div>
          {resumedRunId ? (
            <p className="run-evidence-copy">
              <strong>{t("Resume run")}</strong>
              {resumedRunId}
            </p>
          ) : null}
          {resumePreview ? (
            <details className="json-details compact-json" open>
              <summary>{t("Resume context preview")}</summary>
              <div className="run-evidence-grid">
                <MetaRow label={t("Source run")} value={resumePreview.context.sourceRunId} compact />
                <MetaRow label={t("Prior runs")} value={String(resumePreview.context.priorRunIds.length)} compact />
                <MetaRow label={t("Events")} value={String(resumePreview.context.includedEventCount)} compact />
                <MetaRow label={t("Approvals")} value={String(resumePreview.context.includedApprovalCount)} compact />
                <MetaRow label={t("Artifacts")} value={String(resumePreview.context.includedArtifactIds.length)} compact />
                <MetaRow label={t("Pending actions")} value={String(resumePreview.context.pendingActionIds.length)} compact />
              </div>
              {resumePreview.context.warnings.length > 0 ? (
                <div className="inline-warning">
                  <CircleAlert size={16} />
                  {resumePreview.context.warnings.join(" ")}
                </div>
              ) : null}
              <pre>{resumePreview.context.contextText}</pre>
            </details>
          ) : null}
        </div>

        <div className="run-detail-section">
          <div className="panel-title tight split">
            <span>
              <Database size={16} />
              <h3>{t("State transitions")}</h3>
            </span>
            <span className="event-count">{t("{count} transitions", { count: threadEvidence?.transitions.length ?? 0 })}</span>
          </div>
          {!threadEvidence || threadEvidence.transitions.length === 0 ? (
            <p className="muted">{t("No state transitions recorded.")}</p>
          ) : (
            <div className="runtime-list">
              {threadEvidence.transitions.slice(0, 12).map((transition) => (
                <div key={transition.id} className="runtime-list-row">
                  <StatusBadge status={transition.entityType} />
                  <span>{transition.event}: {transition.fromStatus} -&gt; {transition.toStatus}</span>
                  <small>{formatDateTime(transition.createdAt)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RunDetailPanel({
  run,
  memoryById,
  usedMemoryEvents,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  workUnitDetail,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isRunning,
  cancellingRunId,
  onRefresh,
  onRefreshApprovals,
  onRerun,
  onCancelRun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
  cwd,
}: {
  readonly run: RunSession | undefined;
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isRunning: boolean;
  readonly cancellingRunId: string;
  readonly onRefresh: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onCancelRun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const workspaceCwd = run ? readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd : "-";
  const providerPresetId = run ? readRunProviderPresetId(run) : "";
  const permissionMode = run ? readSessionPermissionModeFromSnapshot(run.requestSnapshot) : undefined;
  const effectivePolicySnapshot = run ? readEffectivePolicySnapshot(run.requestSnapshot) : undefined;
  const effectivePolicySummary = summarizeEffectivePolicySnapshot(effectivePolicySnapshot, t);
  const runCancellable = Boolean(run && runCanBeStopped(run));
  const runStopping = Boolean(run && cancellingRunId === run.id);
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const repairHint = run ? buildRunRepairHint(run, pendingApprovals.length, run.status, readRunEventIssueText(terminalEvent), t) : undefined;
  const runtimeRepairRun = run && run.status === "failed" && repairHint?.target === "run" ? run : undefined;
  const runLeases = run ? resourceLeases.filter((lease) => lease.ownerId === run.id || lease.workUnitId === run.workUnitId) : [];
  const runUsedMemoryEvents = run ? filterUsedMemoryEventsByResponse(usedMemoryEvents, run.id) : [];
  const relevantTransitions = run
    ? stateTransitions.filter((transition) =>
        (transition.entityType === "run" && transition.entityId === run.id) ||
        (transition.entityType === "task" && transition.entityId === run.taskId) ||
        (transition.entityType === "work_unit" && transition.entityId === run.workUnitId)
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
          {runCancellable ? (
            <button className="secondary-button danger compact-button" type="button" onClick={() => run && onCancelRun(run)} disabled={!run || runStopping}>
              {runStopping ? <Loader2 className="spin" size={15} /> : <Square size={14} />}
              {runStopping ? t("Stopping") : t("Stop")}
            </button>
          ) : null}
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
            <MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(permissionMode, t)} compact />
            <MetaRow label={t("Work unit")} value={run.workUnitId ?? "-"} compact />
            <MetaRow label={t("Selected skill")} value={run.selectedSkillId ?? "-"} compact />
            <MetaRow label={t("Created")} value={formatDateTime(run.createdAt)} compact />
            <MetaRow label={t("Ended")} value={run.endedAt ? formatDateTime(run.endedAt) : "-"} compact />
          </div>

          {runUsedMemoryEvents.length > 0 ? (
            <ConversationEvidenceBundlePanel
              label={t("Evidence")}
              bundle={{
                summary: t("Used memory"),
                sections: [
                  {
                    id: "memory",
                    label: t("Memory"),
                    summary: t("Used memory"),
                    content: <UsedMemorySummary events={runUsedMemoryEvents} memoryById={memoryById} />,
                  },
                ],
              }}
            />
          ) : null}

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

          <RunGuidancePanel
            cwd={cwd}
            run={run}
            canRedirect={runCancellable}
            onRefreshRun={onRefresh}
          />

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
            cwd={cwd}
            run={run}
            terminalEvent={terminalEvent}
            toolEvents={toolEvents}
            assistantText={assistantText}
            approvals={approvals}
            artifacts={artifacts}
            onRefresh={onRefresh}
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
            <RuntimeAuditBlock run={run} leases={runLeases} transitions={relevantTransitions} workUnitDetail={workUnitDetail} />
            <div className="run-detail-section">
              <div className="panel-title tight">
                <ShieldCheck size={16} />
                <h3>{t("Effective permissions")}</h3>
              </div>
              <div className="run-evidence-grid">
                <MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(effectivePolicySnapshot?.mode ?? permissionMode, t)} compact />
                {effectivePolicySummary.map((summary, index) => (
                  <MetaRow key={`${index}:${summary}`} label={index === 0 ? t("Summary") : t("Rule")} value={summary} compact />
                ))}
              </div>
            </div>
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

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function resolveThreadSourceRun(
  thread: LingThread | undefined,
  evidenceRuns: readonly LingThreadEvidenceResponse["runs"][number][],
  selectedSourceRunId: string,
): RunSession | undefined {
  const selectedRun = selectedSourceRunId ? evidenceRuns.find((item) => item.run.id === selectedSourceRunId)?.run : undefined;
  if (selectedRun) {
    return selectedRun;
  }
  if (thread?.lastRunId) {
    return evidenceRuns.find((item) => item.run.id === thread.lastRunId)?.run;
  }
  return evidenceRuns.length > 0 ? evidenceRuns[evidenceRuns.length - 1]?.run : undefined;
}

function uniqueInterventions(interventions: readonly RunIntervention[]): readonly RunIntervention[] {
  const byId = new Map<string, RunIntervention>();
  for (const intervention of interventions) {
    byId.set(intervention.id, intervention);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

function buildThreadResumeDisabledReason(input: {
  readonly hasThread: boolean;
  readonly hasSourceRun: boolean;
  readonly hasActiveNonTerminalRun: boolean;
  readonly isRunning: boolean;
  readonly t: Translate;
}): string {
  if (!input.hasThread) {
    return input.t("Thread metadata is still loading.");
  }
  if (!input.hasSourceRun) {
    return input.t("Thread has no source run to resume.");
  }
  if (input.hasActiveNonTerminalRun) {
    return input.t("Thread has an active run; resume is disabled until it reaches a terminal state.");
  }
  if (input.isRunning) {
    return input.t("Another run is currently active; wait before starting a continuation.");
  }
  return "";
}

function deriveThreadsFromRuns(runs: readonly RunSession[]): readonly LingThread[] {
  const groups = new Map<string, RunSession[]>();
  for (const run of runs) {
    if (!run.threadId) {
      continue;
    }
    groups.set(run.threadId, [...(groups.get(run.threadId) ?? []), run]);
  }

  return [...groups.entries()]
    .map(([threadId, threadRuns]) => {
      const orderedRuns = [...threadRuns].sort((left, right) => compareRunRecency(right, left));
      const latestRun = orderedRuns[0];
      const oldestRun = [...threadRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      return {
        id: threadId,
        workspaceId: "workspace_default",
        kind: "task",
        channelId: latestRun.channelId,
        taskId: latestRun.taskId,
        teammateId: latestRun.teammateId,
        title: readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
        objective: readTaskPrompt(latestRun.taskSnapshot) || readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
        status: threadStatusFromRun(latestRun),
        activeRunId: runCanBeStopped(latestRun) ? latestRun.id : undefined,
        lastRunId: latestRun.id,
        createdAt: oldestRun.createdAt,
        updatedAt: latestRun.updatedAt || latestRun.createdAt,
      } satisfies LingThread;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function compareRunRecency(left: RunSession, right: RunSession): number {
  const leftTime = left.updatedAt || left.endedAt || left.startedAt || left.createdAt;
  const rightTime = right.updatedAt || right.endedAt || right.startedAt || right.createdAt;
  return leftTime.localeCompare(rightTime);
}

function threadStatusFromRun(run: RunSession): LingThread["status"] {
  if (run.status === "queued") {
    return "open";
  }
  return run.status;
}

function RunGuidancePanel({
  cwd,
  run,
  canRedirect,
  onRefreshRun,
}: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly canRedirect: boolean;
  readonly onRefreshRun: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [interventions, setInterventions] = useState<readonly RunIntervention[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [submittingMode, setSubmittingMode] = useState<RunIntervention["mode"] | "">("");
  const [cancellingId, setCancellingId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const loadInterventions = async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const response = await listRunInterventions(cwd, run.parentRunId ?? run.id, 100);
      setInterventions(response.interventions);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInterventions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, run.id, run.parentRunId]);

  const submitGuidance = async (mode: RunIntervention["mode"]): Promise<void> => {
    const trimmed = instruction.trim();
    if (!trimmed) {
      setErrorMessage(t("Please enter guidance first."));
      return;
    }
    setSubmittingMode(mode);
    setErrorMessage("");
    try {
      const response = await createRunIntervention(cwd, run.parentRunId ?? run.id, {
        mode,
        instruction: trimmed,
        idempotencyKey: `web:${run.id}:${mode}:${Date.now()}`,
      });
      setInterventions((current) => {
        const next = current.filter((item) => item.id !== response.intervention.id);
        return [...next, response.intervention].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });
      setInstruction("");
      onRefreshRun();
      if (mode === "interrupt_redirect") {
        window.setTimeout(() => {
          void loadInterventions();
          onRefreshRun();
        }, 800);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmittingMode("");
    }
  };

  const cancelGuidance = async (interventionId: string): Promise<void> => {
    setCancellingId(interventionId);
    setErrorMessage("");
    try {
      const response = await cancelRunIntervention(cwd, interventionId);
      setInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellingId("");
    }
  };

  const sourceRunId = run.parentRunId ?? run.id;
  const visibleInterventions = interventions.filter((item) => item.sourceRunId === sourceRunId);

  return (
    <div className="run-detail-section run-guidance-panel">
      <div className="panel-title tight split">
        <span>
          <Pencil size={16} />
          <h3>{t("Run guidance")}</h3>
        </span>
        <span className="run-guidance-actions">
          {isLoading ? <Loader2 className="spin" size={14} /> : null}
          <button className="secondary-button compact-button" type="button" onClick={() => void loadInterventions()} disabled={isLoading}>
            <RefreshCw size={14} />
            {t("Refresh")}
          </button>
        </span>
      </div>
      {run.parentRunId ? (
        <div className="run-lineage-banner">
          <Workflow size={15} />
          <span>{t("Continuing from previous run")} <code>{run.parentRunId}</code></span>
        </div>
      ) : null}
      <p className="muted">{t("Add guidance while the run is active. Ling Stack records it and starts continuation runs in order.")}</p>
      <textarea
        className="run-guidance-input"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t("Tell this run what to do next...")}
        rows={3}
      />
      <div className="run-guidance-submit-row">
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => void submitGuidance("queue_followup")}
          disabled={submittingMode !== "" || !instruction.trim()}
        >
          {submittingMode === "queue_followup" ? <Loader2 className="spin" size={14} /> : <Clock3 size={14} />}
          {t("Queue guidance")}
        </button>
        <button
          className="secondary-button danger compact-button"
          type="button"
          aria-label={t("Redirect current run")}
          onClick={() => void submitGuidance("interrupt_redirect")}
          disabled={submittingMode !== "" || !instruction.trim() || !canRedirect}
        >
          {submittingMode === "interrupt_redirect" ? <Loader2 className="spin" size={14} /> : <Square size={14} />}
          {t("Stop and redirect")}
        </button>
      </div>
      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={16} />
          {errorMessage}
        </div>
      ) : null}
      <div className="run-guidance-list">
        {visibleInterventions.length === 0 ? (
          <div className="empty-state compact-empty">
            <Clock3 />
            <span>{t("No guidance queued for this run")}</span>
          </div>
        ) : (
          visibleInterventions.map((item) => (
            <div key={item.id} className="run-guidance-row">
              <StatusBadge status={runInterventionStatusLabel(item.status, t)} />
              <span className="run-guidance-row-main">
                <strong>{item.mode === "interrupt_redirect" ? t("Stop and redirect") : t("Queue guidance")}</strong>
                <small>{item.instruction}</small>
              </span>
              <span className="run-guidance-row-meta">
                {item.continuationRunId ? <code>{t("Continuation")} {item.continuationRunId}</code> : null}
                {item.status === "queued" ? (
                  <button className="secondary-button compact-button" type="button" onClick={() => void cancelGuidance(item.id)} disabled={cancellingId === item.id}>
                    {cancellingId === item.id ? <Loader2 className="spin" size={13} /> : null}
                    {t("Cancel")}
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function runInterventionStatusLabel(status: RunIntervention["status"], t: (key: string, values?: Record<string, string | number>) => string): string {
  if (status === "cancelling_source") {
    return t("Stopping source");
  }
  if (status === "starting_continuation") {
    return t("Starting continuation");
  }
  if (status === "started") {
    return t("Started");
  }
  if (status === "cancelled") {
    return t("Cancelled");
  }
  if (status === "failed") {
    return t("Failed");
  }
  return t("Queued");
}

interface RunnerResolutionAuditView {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource: string;
  readonly fallbackAllowed: boolean;
  readonly fallbackReasonCode: string;
  readonly fallbackReasonMessage: string;
}

function runnerListLabel(run: RunSession): string {
  const audit = readRunnerResolutionAudit(run);
  if (audit.fallbackReasonCode) {
    return `${audit.effectiveRunnerId} fallback`;
  }
  return audit.effectiveRunnerId;
}

function readRunnerResolutionAudit(
  run: RunSession,
  workUnit?: WorkUnitDetailResponse["workUnit"],
): RunnerResolutionAuditView {
  const resolution = readDataField(run.requestSnapshot, "runnerResolution");
  const fallbackReason = readDataField(resolution, "fallbackReason") ?? workUnit?.fallbackReason;
  const requestedRunnerId =
    readDataString(resolution, "requestedRunnerId") ||
    workUnit?.requestedRunnerId ||
    readDataString(run.requestSnapshot, "runnerId") ||
    "-";
  const effectiveRunnerId =
    readDataString(resolution, "effectiveRunnerId") ||
    workUnit?.effectiveRunnerId ||
    workUnit?.runnerId ||
    "-";

  return {
    requestedRunnerId,
    effectiveRunnerId,
    requestSource: readDataString(resolution, "requestSource") || "-",
    fallbackAllowed: readDataBoolean(resolution, "fallbackAllowed"),
    fallbackReasonCode: readDataString(fallbackReason, "code"),
    fallbackReasonMessage: readDataString(fallbackReason, "message"),
  };
}

function RuntimeAuditBlock({
  run,
  leases,
  transitions,
  workUnitDetail,
}: {
  readonly run: RunSession;
  readonly leases: readonly ResourceLease[];
  readonly transitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
}): JSX.Element {
  const { t } = useI18n();
  const workUnit = workUnitDetail?.workUnit;
  const runnerAudit = readRunnerResolutionAudit(run, workUnit);
  return (
    <div className="run-detail-section runtime-audit-block">
      <div className="panel-title tight split">
        <span>
          <Workflow size={16} />
          <h3>{t("State machine")}</h3>
        </span>
        <span className="event-count">{t("{count} transitions", { count: transitions.length })}</span>
      </div>
      <div className="run-evidence-grid">
        <MetaRow label={t("Requested runner")} value={runnerAudit.requestedRunnerId} compact />
        <MetaRow label={t("Effective runner")} value={runnerAudit.effectiveRunnerId} compact />
        <MetaRow label={t("Runner source")} value={runnerAudit.requestSource} compact />
        <MetaRow label={t("Fallback allowed")} value={runnerAudit.fallbackAllowed ? t("Yes") : t("No")} compact />
        <MetaRow label={t("Fallback reason")} value={runnerAudit.fallbackReasonCode ? `${runnerAudit.fallbackReasonCode}: ${runnerAudit.fallbackReasonMessage}` : "-"} compact />
      </div>
      {workUnit ? (
        <div className="run-evidence-grid">
          <MetaRow label={t("Work unit")} value={workUnit.id} compact />
          <MetaRow label={t("Kind")} value={workUnit.kind} compact />
          <MetaRow label={t("Status")} value={workUnit.status} compact />
          <MetaRow label={t("Attempt")} value={workUnit.activeAttemptId ?? "-"} compact />
          <MetaRow label={t("Last event")} value={workUnit.lastEventAt ? formatDateTime(workUnit.lastEventAt) : "-"} compact />
          <MetaRow label={t("Last heartbeat")} value={workUnit.lastHeartbeatAt ? formatDateTime(workUnit.lastHeartbeatAt) : "-"} compact />
        </div>
      ) : null}
      {workUnitDetail?.attempts.length ? (
        <div className="runtime-list">
          {workUnitDetail.attempts.map((attempt) => (
            <div key={attempt.id} className="runtime-list-row">
              <StatusBadge status={attempt.status} />
              <span>{attempt.runnerId}</span>
              <small>{attempt.lastHeartbeatAt ? formatDateTime(attempt.lastHeartbeatAt) : attempt.runtimeInstanceId}</small>
            </div>
          ))}
        </div>
      ) : null}
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
      {workUnitDetail?.semaphoreSlots.length ? (
        <div className="runtime-list">
          {workUnitDetail.semaphoreSlots.map((slot) => (
            <div key={slot.id} className="runtime-list-row">
              <StatusBadge status={slot.resourceType} />
              <span>{truncatePreview(slot.resourceKey, 48)}</span>
              <small>{slot.status}</small>
            </div>
          ))}
        </div>
      ) : null}
      {workUnitDetail?.events.length ? (
        <div className="runtime-list transition-list">
          {workUnitDetail.events.slice(0, 8).map((event) => (
            <div key={event.id} className="runtime-list-row">
              <StatusBadge status={event.type} />
              <span>#{event.seq} {event.type}</span>
              <small>{formatDateTime(event.ts)}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunEvidencePanel({
  cwd,
  run,
  terminalEvent,
  toolEvents,
  assistantText,
  approvals,
  artifacts,
  onRefresh,
}: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly terminalEvent: RunEventEnvelope | undefined;
  readonly toolEvents: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly onRefresh: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [threadEvidence, setThreadEvidence] = useState<LingThreadEvidenceResponse | undefined>(undefined);
  const [threadEvidenceLoading, setThreadEvidenceLoading] = useState(false);
  const [threadActionLoading, setThreadActionLoading] = useState(false);
  const [threadPreviewLoading, setThreadPreviewLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [resumedRunId, setResumedRunId] = useState("");
  const [resumePreview, setResumePreview] = useState<LingThreadResumePreviewResponse | undefined>(undefined);
  const [resumeInstruction, setResumeInstruction] = useState("");
  const taskLabel = readTaskTitle(run.taskSnapshot) || run.taskId;
  const providerLabel = `${run.providerName}/${run.providerModel}`;
  const terminalLabel = terminalEvent ? `#${terminalEvent.seq} ${terminalEvent.type}` : "-";
  const evidenceMessage = readRunEvidenceMessage(run, terminalEvent, t);
  const assistantPreview = buildAssistantOutputPreview(assistantText, t);
  const toolSummary = summarizeToolEvents(toolEvents);
  const artifactCwd = readRunWorkspaceCwd(run, run.cwd);
  const canResumeThread = Boolean(run.threadId && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"));
  const threadArtifactById = buildThreadArtifactMap(threadEvidence);

  useEffect(() => {
    setThreadEvidence(undefined);
    setThreadError("");
    setResumedRunId("");
    setResumePreview(undefined);
    setResumeInstruction("");
  }, [run.id, run.threadId]);

  useEffect(() => {
    if (run.threadId) {
      void loadThreadEvidence();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, run.threadId]);

  async function loadThreadEvidence(): Promise<void> {
    if (!run.threadId) {
      return;
    }
    setThreadEvidenceLoading(true);
    setThreadError("");
    try {
      setThreadEvidence(await getLingThreadEvidence(cwd, run.threadId));
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadEvidenceLoading(false);
    }
  }

  async function handleResumeThread(): Promise<void> {
    if (!run.threadId || !canResumeThread) {
      return;
    }
    setThreadActionLoading(true);
    setThreadError("");
    try {
      const response = await resumeLingThread(cwd, run.threadId, {
        sourceRunId: run.id,
        instruction: resumeInstruction.trim() || "Resume this thread from the selected run detail.",
      });
      setResumedRunId(response.runId ?? "");
      setResumeInstruction("");
      onRefresh();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadActionLoading(false);
    }
  }

  async function previewResumeThread(): Promise<void> {
    if (!run.threadId || !canResumeThread) {
      return;
    }
    setThreadPreviewLoading(true);
    setThreadError("");
    try {
      setResumePreview(await previewLingThreadResume(cwd, run.threadId, {
        sourceRunId: run.id,
        instruction: resumeInstruction.trim() || "Resume this thread from the selected run detail.",
        includeArtifacts: true,
      }));
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadPreviewLoading(false);
    }
  }

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
        <ConversationSummaryRow
          className="run-conversation-summary"
          icon={<CheckCircle2 size={16} />}
          title={taskLabel}
          statusNode={<StatusBadge status={run.status} />}
          body={<MessageBodyRenderer className={`run-evidence-copy${run.status === "failed" ? " error" : ""}`} text={evidenceMessage} cwd={cwd} compact />}
          metaItems={[
            { id: "provider", label: t("Provider"), value: providerLabel },
            { id: "tools", label: t("Tool events"), value: String(toolSummary.total) },
            { id: "approvals", label: t("Approvals"), value: String(approvals.length) },
            { id: "artifacts", label: t("Artifacts"), value: String(artifacts.length) },
          ]}
          evidenceNode={(
            <ConversationEvidenceBundlePanel
              label={t("Evidence")}
              bundle={{
                summary: t("Run summary preview"),
                sections: [
                  {
                    id: "runtime",
                    label: t("Runtime"),
                    summary: `${t("Tool events")}: ${toolSummary.total}`,
                    content: (
                      <div className="run-evidence-grid">
                        <MetaRow label={t("Status")} value={run.status} compact />
                        <MetaRow label={t("Task")} value={taskLabel} compact />
                        <MetaRow label={t("Provider")} value={providerLabel} compact />
                        <MetaRow label={t("Terminal event")} value={terminalLabel} compact />
                        <MetaRow label={t("Tool events")} value={String(toolSummary.total)} compact />
                        <MetaRow label={t("Errored tools")} value={String(toolSummary.errorCount)} compact />
                        <MetaRow label={t("Approvals")} value={String(approvals.length)} compact />
                      </div>
                    ),
                  },
                  {
                    id: "assistant-output",
                    label: t("Assistant output"),
                    content: (
                      <p className="run-evidence-copy">
                        {assistantPreview}
                      </p>
                    ),
                  },
                ],
              }}
            />
          )}
        />
      </div>

      {run.threadId ? (
        <div className="run-evidence-block">
          <div className="panel-title tight split">
            <span>
              <Workflow size={16} />
              <h3>{t("Thread evidence")}</h3>
            </span>
            <span className="button-row compact">
              <button className="secondary-button compact-button" type="button" onClick={() => void loadThreadEvidence()} disabled={threadEvidenceLoading}>
                {threadEvidenceLoading ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
                {t("Load")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => void previewResumeThread()} disabled={!canResumeThread || threadPreviewLoading}>
                {threadPreviewLoading ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
                {t("Preview")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => void handleResumeThread()} disabled={!canResumeThread || threadActionLoading}>
                {threadActionLoading ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
                {t("Resume")}
              </button>
            </span>
          </div>
          <div className="run-evidence-grid">
            <MetaRow label={t("Thread")} value={run.threadId} compact />
            <MetaRow label={t("Thread status")} value={threadEvidence?.thread.status ?? "-"} compact />
            <MetaRow label={t("Parent run")} value={run.parentRunId ?? "-"} compact />
            <MetaRow label={t("Continuation")} value={run.continuationReason ?? "-"} compact />
            <MetaRow label={t("Thread runs")} value={threadEvidence ? String(threadEvidence.runs.length) : "-"} compact />
            <MetaRow label={t("Actions")} value={threadEvidence ? String(threadEvidence.actions.length) : "-"} compact />
            <MetaRow label={t("Transitions")} value={threadEvidence ? String(threadEvidence.transitions.length) : "-"} compact />
          </div>
          <label className="approval-reason-field thread-resume-composer">
            <span>{t("Resume instruction")}</span>
            <textarea
              value={resumeInstruction}
              rows={3}
              placeholder={t("Tell the next continuation what changed or what to do next...")}
              onChange={(event) => setResumeInstruction(event.target.value)}
              disabled={!canResumeThread || threadActionLoading}
            />
          </label>
          <div className="button-row compact">
            <button className="secondary-button compact-button" type="button" onClick={() => void previewResumeThread()} disabled={!canResumeThread || threadPreviewLoading}>
              {threadPreviewLoading ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
              {t("Preview resume")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => void handleResumeThread()} disabled={!canResumeThread || threadActionLoading}>
              {threadActionLoading ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
              {t("Resume thread")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => void loadThreadEvidence()} disabled={threadEvidenceLoading}>
              {threadEvidenceLoading ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
              {t("Reload evidence")}
            </button>
          </div>
          {resumedRunId ? (
            <p className="run-evidence-copy">
              <strong>{t("Resume run")}</strong>
              {resumedRunId}
            </p>
          ) : null}
          {threadError ? <p className="run-evidence-copy error">{threadError}</p> : null}
          {resumePreview ? (
            <details className="json-details compact-json" open>
              <summary>{t("Resume context preview")}</summary>
              <div className="run-evidence-grid">
                <MetaRow label={t("Source run")} value={resumePreview.context.sourceRunId} compact />
                <MetaRow label={t("Prior runs")} value={String(resumePreview.context.priorRunIds.length)} compact />
                <MetaRow label={t("Events")} value={String(resumePreview.context.includedEventCount)} compact />
                <MetaRow label={t("Approvals")} value={String(resumePreview.context.includedApprovalCount)} compact />
                <MetaRow label={t("Artifacts")} value={String(resumePreview.context.includedArtifactIds.length)} compact />
                <MetaRow label={t("Pending actions")} value={String(resumePreview.context.pendingActionIds.length)} compact />
              </div>
              {resumePreview.context.warnings.length > 0 ? (
                <div className="inline-warning">
                  <CircleAlert size={16} />
                  {resumePreview.context.warnings.join(" ")}
                </div>
              ) : null}
              <pre>{resumePreview.context.contextText}</pre>
            </details>
          ) : null}
          {threadEvidence ? (
            <div className="thread-evidence-trail">
              <strong>{t("Thread runs")}</strong>
              <div className="runtime-list">
                {threadEvidence.runs.map((item) => (
                  <div key={item.run.id} className="runtime-list-row">
                    <StatusBadge status={item.run.status} />
                    <span>{readTaskTitle(item.run.taskSnapshot) || item.run.taskId}</span>
                    <small>
                      {t("{count} events", { count: item.events.length })}
                      {" · "}
                      {t("{count} approval events", { count: item.approvals.length })}
                      {" · "}
                      {t("{count} artifacts", { count: item.artifacts.length })}
                    </small>
                  </div>
                ))}
              </div>
              <strong>{t("Execution actions")}</strong>
              <div className="runtime-list">
                {threadEvidence.actions.length === 0 ? (
                  <div className="empty-state compact-empty">
                    <ShieldCheck />
                    <span>{t("No execution actions recorded")}</span>
                  </div>
                ) : (
                  threadEvidence.actions.map((action) => (
                    <div key={action.id} className="runtime-list-row">
                      <StatusBadge status={action.status} />
                      <span>
                        {action.actionType}: {action.title}
                        <ActionArtifactChips label={t("Preview")} artifactIds={action.previewArtifactIds} artifactsById={threadArtifactById} />
                        <ActionArtifactChips label={t("Result")} artifactIds={action.resultArtifactIds} artifactsById={threadArtifactById} />
                      </span>
                      <small>{formatActionTargets(action.targetRefs)}</small>
                    </div>
                  ))
                )}
              </div>
              <strong>{t("State transitions")}</strong>
              <div className="runtime-list">
                {threadEvidence.transitions.slice(0, 10).map((transition) => (
                  <div key={transition.id} className="runtime-list-row">
                    <StatusBadge status={transition.entityType} />
                    <span>{transition.event}: {transition.fromStatus} -&gt; {transition.toStatus}</span>
                    <small>{formatDateTime(transition.createdAt)}</small>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="run-evidence-block">
        <strong>{t("Artifacts")}</strong>
        <FileChangeEvidencePanel
          cwd={artifactCwd}
          artifacts={artifacts}
          status={fileChangeStatusFromRun(run)}
          sourceRunId={run.id}
        />
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

function ActionArtifactChips({
  label,
  artifactIds,
  artifactsById,
}: {
  readonly label: string;
  readonly artifactIds: readonly string[];
  readonly artifactsById: ReadonlyMap<string, RunArtifact>;
}): JSX.Element | null {
  if (artifactIds.length === 0) {
    return null;
  }
  return (
    <span className="button-row compact">
      {artifactIds.map((artifactId) => {
        const artifact = artifactsById.get(artifactId);
        return (
          <code key={artifactId} title={artifact?.title ?? artifactId}>
            {label}: {truncatePreview(artifact?.title ?? artifactId, 40)}
          </code>
        );
      })}
    </span>
  );
}

function buildThreadArtifactMap(threadEvidence: LingThreadEvidenceResponse | undefined): ReadonlyMap<string, RunArtifact> {
  const artifacts = threadEvidence?.runs.flatMap((item) => item.artifacts) ?? [];
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
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

function formatActionTargets(targetRefs: LingThreadEvidenceResponse["actions"][number]["targetRefs"]): string {
  if (targetRefs.length === 0) {
    return "-";
  }
  return targetRefs
    .map((ref) => {
      const value = ref.path ?? ref.label ?? ref.id;
      return value ? `${ref.type}:${value}` : ref.type;
    })
    .join(" · ");
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
