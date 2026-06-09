import {
  Activity,
  Archive,
  ArchiveRestore,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  GitBranch,
  History,
  Loader2,
  Pencil,
  Pin,
  PinOff,
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
import { archiveLingThread, artifactContentUrl, cancelRunIntervention, createRunIntervention, forkLingThread, forkRunLingThread, getLingThreadEvidence, listLingThreads, listLingThreadTurns, listRunInterventions, listRunShellSnapshots, pinLingThread, previewLingThreadResume, resumeLingThread, unarchiveLingThread, unpinLingThread } from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  formatEventData,
  formatEventPreview,
  readDataBoolean,
  readDataField,
  readDataString,
  readDeepDataPreview,
  readDeepDataScalarString,
  summarizeUnifiedExecResultFromData,
  truncatePreview,
} from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  inferPermissionPreset,
  permissionPresetLabel,
  readEffectivePolicySnapshot,
  readPermissionPresetFromSnapshot,
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
  LingThreadArchivedFilter,
  LingThreadEvidenceResponse,
  LingThreadResumePreviewResponse,
  LingThreadSearchMatch,
  LingTurn,
  LingTurnRun,
  MemoryObject,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunIntervention,
  RunSession,
  ShellSnapshotListItem,
  StateTransitionEvent,
  UsedMemoryEvent,
  WorkUnitDetailResponse,
} from "../../types.js";

type WorkHistoryTurnLoadState =
  | { readonly status: "loading"; readonly signature: string }
  | {
      readonly status: "loaded";
      readonly turns: readonly LingTurn[];
      readonly runLinks: readonly LingTurnRun[];
      readonly signature: string;
    }
  | { readonly status: "failed"; readonly error: string; readonly signature: string };

interface WorkHistoryTurnAttempt {
  readonly run: RunSession;
  readonly attemptNumber: number;
  readonly role: LingTurnRun["role"] | "legacy";
  readonly linkedAt: string;
}

interface WorkHistoryTurnGroup {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly title: string;
  readonly status: string;
  readonly runIds: readonly string[];
  readonly latestRunId: string;
  readonly attemptCount: number;
  readonly updatedAt: string;
  readonly source: "durable_turn" | "legacy_thread";
  readonly attempts: readonly WorkHistoryTurnAttempt[];
  readonly thread: LingThread | undefined;
}

interface WorkHistoryTurnContext {
  readonly group: WorkHistoryTurnGroup;
  readonly turn: LingTurn;
}

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
  const [threadsFallbackFromRuns, setThreadsFallbackFromRuns] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [threadArchivedFilter, setThreadArchivedFilter] = useState<LingThreadArchivedFilter>("exclude");
  const [threadSearch, setThreadSearch] = useState("");
  const [threadSearchMatches, setThreadSearchMatches] = useState<readonly LingThreadSearchMatch[]>([]);
  const [turnStateByThreadKey, setTurnStateByThreadKey] = useState<Readonly<Record<string, WorkHistoryTurnLoadState>>>({});

  async function refreshThreads(): Promise<void> {
    if (!cwd.trim()) {
      setThreads([]);
      setThreadsFallbackFromRuns(false);
      setThreadSearchMatches([]);
      setThreadError("");
      return;
    }
    setThreadsLoading(true);
    setThreadError("");
    try {
      const q = normalizeWorkHistorySearchQuery(threadSearch);
      const response = await listLingThreads(cwd, { ...(q ? { q } : {}), archived: threadArchivedFilter, limit: 50 });
      setThreads(response.threads);
      setThreadSearchMatches(response.matches ?? []);
      setThreadsFallbackFromRuns(false);
    } catch (error) {
      if (error instanceof LingDaemonError && error.status === 404) {
        setThreads([]);
        setThreadsFallbackFromRuns(true);
        setThreadSearchMatches([]);
        setThreadError("");
        return;
      }
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadsLoading(false);
    }
  }

  const visibleThreads = threadsFallbackFromRuns && threadArchivedFilter === "exclude" ? deriveThreadsFromRuns(runs) : threads;
  const selectedThread = selectedThreadId ? visibleThreads.find((thread) => thread.id === selectedThreadId) : undefined;
  const visibleThreadIds = new Set(visibleThreads.map((thread) => thread.id));
  const workHistoryRuns = visibleThreads.length > 0 || threadsFallbackFromRuns
    ? runs.filter((run) => !run.threadId || visibleThreadIds.has(run.threadId))
    : runs.filter((run) => !run.threadId);
  const selectedRunForWorkHistory = selectedRun?.threadId && !visibleThreadIds.has(selectedRun.threadId) && !threadsFallbackFromRuns ? undefined : selectedRun;
  const turnLoadRequests = buildWorkHistoryTurnLoadRequests(cwd, visibleThreads, workHistoryRuns, selectedRunForWorkHistory);
  const turnLoadSignature = turnLoadRequests.map((request) => `${request.threadId}:${request.signature}`).join("|");
  const workHistoryGroups = buildWorkHistoryTurnGroups({
    cwd,
    runs: workHistoryRuns,
    visibleThreads,
    turnStateByThreadKey,
  });
  const searchMatchByThreadId = buildThreadSearchMatchMap(threadSearchMatches);
  const workHistoryTreeRows = buildWorkHistoryGroupTree(workHistoryGroups);
  const standaloneRuns = runs.filter((run) => !run.threadId);
  const selectedTurnContext = buildTurnContextByRunId(selectedRunId, workHistoryGroups, turnStateByThreadKey, cwd);

  useEffect(() => {
    setTurnStateByThreadKey({});
  }, [cwd]);

  useEffect(() => {
    void refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, threadArchivedFilter, threadSearch]);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || turnLoadRequests.length === 0) {
      return;
    }
    const requests = turnLoadRequests.filter((request) => {
      const current = turnStateByThreadKey[turnStateKey(workspaceCwd, request.threadId)];
      return !current || current.signature !== request.signature;
    });
    if (requests.length === 0) {
      return;
    }
    setTurnStateByThreadKey((current) => {
      const next = { ...current };
      for (const request of requests) {
        next[turnStateKey(workspaceCwd, request.threadId)] = {
          status: "loading",
          signature: request.signature,
        };
      }
      return next;
    });
    void Promise.allSettled(
      requests.map(async (request) => ({
        request,
        response: await listLingThreadTurns(workspaceCwd, request.threadId, { limit: 100 }),
      })),
    ).then((results) => {
      setTurnStateByThreadKey((current) => {
        const next = { ...current };
        for (const [index, result] of results.entries()) {
          const request = requests[index];
          if (!request) {
            continue;
          }
          const key = turnStateKey(workspaceCwd, request.threadId);
          if (current[key]?.signature !== request.signature) {
            continue;
          }
          if (result.status === "fulfilled") {
            const { response } = result.value;
            next[key] = {
              status: "loaded",
              turns: response.turns,
              runLinks: response.runLinks,
              signature: request.signature,
            };
          } else {
            next[key] = {
              status: "failed",
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              signature: request.signature,
            };
          }
        }
        return next;
      });
    });
  }, [cwd, turnLoadSignature, turnStateByThreadKey, turnLoadRequests]);

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

  function handleSelectWorkHistoryGroup(group: WorkHistoryTurnGroup): void {
    if (group.source === "durable_turn") {
      setSelectedThreadId("");
      if (group.latestRunId !== selectedRunId) {
        onSelect(group.latestRunId);
      }
      return;
    }
    if (group.thread) {
      handleSelectThread(group.thread);
      return;
    }
    setSelectedThreadId(group.threadId);
    if (group.latestRunId && group.latestRunId !== selectedRunId) {
      onSelect(group.latestRunId);
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
              <h3>{t("Work threads")}</h3>
            </span>
            <button className="secondary-button compact-button" type="button" onClick={() => void refreshThreads()} disabled={threadsLoading}>
              {threadsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          </div>
          <div className="segmented-control work-history-filter" aria-label={t("Work thread visibility")}>
            {([
              ["exclude", t("Active")],
              ["include", t("All")],
              ["only", t("Archived")],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={threadArchivedFilter === value ? "active" : ""}
                type="button"
                onClick={() => setThreadArchivedFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="activity-search-field work-history-search-field">
            <Search size={14} />
            <input
              type="search"
              value={threadSearch}
              onChange={(event) => setThreadSearch(event.target.value)}
              placeholder={t("Search work threads")}
              aria-label={t("Search work threads")}
            />
          </label>
          {threadError ? (
            <div className="inline-error compact">
              <CircleAlert size={15} />
              {threadError}
            </div>
          ) : null}
          <div className="runs-list thread-list">
            {workHistoryGroups.length === 0 ? (
              <div className="empty-state compact-empty">
                {threadsLoading ? <Loader2 className="spin" /> : <Workflow />}
                <span>{threadsLoading ? t("Loading work history...") : t("No work threads yet")}</span>
              </div>
            ) : (
              workHistoryTreeRows.map(({ group, depth, parentHidden }) => {
                const selected = group.source === "durable_turn"
                  ? !selectedThreadId && group.runIds.includes(selectedRunId)
                  : group.threadId === selectedThreadId || (!selectedThreadId && group.latestRunId === selectedRunId);
                const metadataHint = formatWorkHistoryMetadataHint(group.thread, t);
                const searchMatch = searchMatchByThreadId.get(group.threadId);
                return (
                  <div key={group.id} className="work-history-turn-group">
                    <button
                      className={selected ? "run-list-row work-history-branch-row selected" : "run-list-row work-history-branch-row"}
                      style={{ paddingLeft: `${12 + depth * 18}px` }}
                      type="button"
                      onClick={() => handleSelectWorkHistoryGroup(group)}
                    >
                      <span className={`status-dot ${group.status}`} />
                      <span className="run-list-main">
                        <strong>{group.title}</strong>
                        <small>
                          {group.thread?.parentThreadId ? `${t("Fork branch")} · ` : ""}
                          {parentHidden ? `${t("Parent hidden")} · ` : ""}
                          {group.thread?.pinnedAt ? `${t("Pinned")} · ` : ""}
                          {group.thread?.archivedAt || group.thread?.status === "archived" ? `${t("Archived")} · ` : ""}
                          {group.source === "durable_turn" ? t("Durable turn") : group.thread?.kind ?? t("Work thread")}
                          {" · "}
                          {t("{count} attempts", { count: group.attemptCount })}
                          {metadataHint ? ` · ${metadataHint}` : ""}
                        </small>
                        {searchMatch ? (
                          <small>
                            {formatLingThreadSearchMatch(searchMatch, t)}: {searchMatch.snippet}
                          </small>
                        ) : null}
                      </span>
                      <span className="run-list-meta">
                        <StatusBadge status={group.status} />
                        <time>{formatDateTime(group.updatedAt)}</time>
                      </span>
                    </button>
                    {group.source === "durable_turn" && group.attempts.length > 1 ? (
                      <div className="work-history-attempt-list" aria-label={t("Attempts")}>
                        {group.attempts.map((attempt) => (
                          <button
                            key={attempt.run.id}
                            className={attempt.run.id === selectedRunId && !selectedThreadId ? "run-list-row work-history-attempt-row selected" : "run-list-row work-history-attempt-row"}
                            type="button"
                            onClick={() => handleSelectRun(attempt.run.id)}
                          >
                            <span className={`status-dot ${attempt.run.status}`} />
                            <span className="run-list-main">
                              <strong>{t("Attempt {number}", { number: attempt.attemptNumber })}</strong>
                              <small>{readTaskTitle(attempt.run.taskSnapshot) || attempt.run.taskId}</small>
                            </span>
                            <span className="run-list-meta">
                              <StatusBadge status={attempt.run.status} />
                              <time>{formatDateTime(attempt.run.updatedAt || attempt.run.createdAt)}</time>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="panel-title tight">
          <span>
            <History size={16} />
            <h3>{t("Run-only records")}</h3>
          </span>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="runs-list">
          {standaloneRuns.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <Clock3 />}
              <span>{isLoading ? t("Loading runs...") : t("No run-only records for this workspace")}</span>
            </div>
          ) : (
            standaloneRuns.map((item) => (
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
          turnState={turnStateByThreadKey[turnStateKey(cwd, selectedThreadId)]}
          visibleThreads={visibleThreads}
          isRunning={isRunning}
          onRefresh={refreshThreadAndRuns}
          onSelectRun={handleSelectRun}
          onSelectThreadId={setSelectedThreadId}
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
          turnContext={selectedTurnContext}
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
          onSelectRun={handleSelectRun}
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
  turnState,
  visibleThreads,
  isRunning,
  onRefresh,
  onSelectRun,
  onSelectThreadId,
}: {
  readonly cwd: string;
  readonly thread: LingThread | undefined;
  readonly threadId: string;
  readonly turnState?: WorkHistoryTurnLoadState;
  readonly visibleThreads: readonly LingThread[];
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onSelectThreadId: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [threadEvidence, setThreadEvidence] = useState<LingThreadEvidenceResponse | undefined>(undefined);
  const [threadEvidenceLoading, setThreadEvidenceLoading] = useState(false);
  const [threadActionLoading, setThreadActionLoading] = useState(false);
  const [threadVisibilityLoading, setThreadVisibilityLoading] = useState(false);
  const [threadPreviewLoading, setThreadPreviewLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [threadInterventions, setThreadInterventions] = useState<readonly RunIntervention[]>([]);
  const [threadInterventionsLoading, setThreadInterventionsLoading] = useState(false);
  const [threadInterventionError, setThreadInterventionError] = useState("");
  const [threadForkLoading, setThreadForkLoading] = useState(false);
  const [forkedThreadId, setForkedThreadId] = useState("");
  const [forkRunInstruction, setForkRunInstruction] = useState("");
  const [forkRunRunId, setForkRunRunId] = useState("");
  const [selectedSourceTurnId, setSelectedSourceTurnId] = useState("");
  const [selectedSourceRunId, setSelectedSourceRunId] = useState("");
  const [resumedRunId, setResumedRunId] = useState("");
  const [resumePreview, setResumePreview] = useState<LingThreadResumePreviewResponse | undefined>(undefined);
  const [resumeInstruction, setResumeInstruction] = useState("");
  const displayThread = threadEvidence?.thread ?? thread;
  const parentThread = displayThread?.parentThreadId
    ? visibleThreads.find((candidate) => candidate.id === displayThread.parentThreadId)
    : undefined;
  const childThreads = displayThread
    ? visibleThreads
        .filter((candidate) => candidate.parentThreadId === displayThread.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    : [];
  const evidenceRuns = threadEvidence?.runs ?? [];
  const threadArtifactById = buildThreadArtifactMap(threadEvidence);
  const loadedTurns = turnState?.status === "loaded" ? turnState.turns : [];
  const loadedTurnRunLinks = turnState?.status === "loaded" ? turnState.runLinks : [];
  const selectedSourceTurn = selectedSourceTurnId ? loadedTurns.find((turn) => turn.id === selectedSourceTurnId) : undefined;
  const selectedSourceTurnRunIds = selectedSourceTurn ? resolveTurnRunIds(selectedSourceTurn, loadedTurnRunLinks) : undefined;
  const selectedSourceTurnRunId = selectedSourceTurn
    ? resolveDefaultRunIdForTurn(selectedSourceTurn, loadedTurnRunLinks, evidenceRuns)
    : "";
  const sourceRun = resolveThreadSourceRun(displayThread, evidenceRuns, selectedSourceRunId || selectedSourceTurnRunId);
  const sourceRunId = selectedSourceRunId || selectedSourceTurnRunId || sourceRun?.id || displayThread?.lastRunId || "";
  const sourceRunOptions = selectedSourceTurnRunIds && selectedSourceTurnRunIds.size > 0
    ? evidenceRuns.filter((item) => selectedSourceTurnRunIds.has(item.run.id))
    : evidenceRuns;
  const activeRun = displayThread?.activeRunId
    ? evidenceRuns.find((item) => item.run.id === displayThread.activeRunId)?.run
    : undefined;
  const hasActiveNonTerminalRun = Boolean(displayThread?.activeRunId && (!activeRun || runCanBeStopped(activeRun)));
  const hasActiveSelectedTurn = Boolean(selectedSourceTurn && !isResumeSourceTurnTerminal(selectedSourceTurn));
  const isThreadArchived = Boolean(displayThread?.archivedAt || displayThread?.status === "archived");
  const isThreadPinned = Boolean(displayThread?.pinnedAt);
  const canPreviewThreadResume = Boolean(displayThread && sourceRunId);
  const canResumeThread = Boolean(canPreviewThreadResume && !hasActiveNonTerminalRun && !hasActiveSelectedTurn && !isRunning);
  const canForkThread = Boolean(displayThread && !isThreadArchived && !threadForkLoading);
  const canForkRunThread = Boolean(canForkThread && sourceRunId && forkRunInstruction.trim() && !threadActionLoading);
  const resumeDisabledReason = buildThreadResumeDisabledReason({
    hasThread: Boolean(displayThread),
    hasSourceRun: Boolean(sourceRunId),
    hasActiveNonTerminalRun,
    hasActiveSelectedTurn,
    isRunning,
    t,
  });
  const loadedTurnSignature = loadedTurns.map((turn) => `${turn.id}:${turn.status}:${turn.updatedAt}`).join("|");

  useEffect(() => {
    if (loadedTurns.length === 0) {
      if (selectedSourceTurnId) {
        setSelectedSourceTurnId("");
      }
      return;
    }
    if (selectedSourceTurnId && loadedTurns.some((turn) => turn.id === selectedSourceTurnId)) {
      return;
    }
    const defaultTurnId = resolveDefaultResumeSourceTurn(loadedTurns)?.id ?? "";
    setSelectedSourceTurnId(defaultTurnId);
    if (defaultTurnId) {
      setSelectedSourceRunId("");
    }
  }, [loadedTurnSignature, loadedTurns, selectedSourceTurnId]);

  useEffect(() => {
    setThreadEvidence(undefined);
    setThreadError("");
    setThreadInterventions([]);
    setThreadInterventionError("");
    setForkedThreadId("");
    setForkRunInstruction("");
    setForkRunRunId("");
    setSelectedSourceTurnId("");
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
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
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
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
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

  async function handleForkThread(): Promise<void> {
    if (!canForkThread) {
      return;
    }
    setThreadForkLoading(true);
    setThreadError("");
    try {
      const response = await forkLingThread(cwd, threadId, {
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        idempotencyKey: `work-history-fork:${threadId}:${selectedSourceTurn?.id ?? ""}:${sourceRunId}`,
      });
      setForkedThreadId(response.childThread.id);
      onRefresh();
      onSelectThreadId(response.childThread.id);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadForkLoading(false);
    }
  }

  async function handleForkRunThread(): Promise<void> {
    if (!displayThread || !canForkRunThread || !sourceRunId) {
      return;
    }
    const instruction = forkRunInstruction.trim();
    const idempotencyKey = `work-history-fork-run:${stableBrowserHash(`${threadId}:${selectedSourceTurn?.id ?? ""}:${sourceRunId}:${instruction}`)}`;
    setThreadActionLoading(true);
    setThreadError("");
    setForkRunRunId("");
    try {
      const response = await forkRunLingThread(cwd, threadId, {
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        sourceRunId,
        instruction,
        idempotencyKey,
      });
      setForkedThreadId(response.childThread.id);
      setForkRunRunId(response.runId ?? response.childRun?.id ?? "");
      setForkRunInstruction("");
      onRefresh();
      onSelectThreadId(response.childThread.id);
      void loadThreadEvidence(response.childThread.id);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadActionLoading(false);
    }
  }

  async function handleThreadVisibilityAction(action: "archive" | "unarchive" | "pin" | "unpin"): Promise<void> {
    if (!displayThread || threadVisibilityLoading) {
      return;
    }
    setThreadVisibilityLoading(true);
    setThreadError("");
    try {
      const idempotencyKey = `work-history-${action}:${displayThread.id}`;
      const response = action === "archive"
        ? await archiveLingThread(cwd, displayThread.id, { idempotencyKey })
        : action === "unarchive"
          ? await unarchiveLingThread(cwd, displayThread.id, { idempotencyKey })
          : action === "pin"
            ? await pinLingThread(cwd, displayThread.id, { idempotencyKey })
            : await unpinLingThread(cwd, displayThread.id, { idempotencyKey });
      setThreadEvidence((current) => current ? { ...current, thread: response.thread } : current);
      onRefresh();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadVisibilityLoading(false);
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
          <button className="secondary-button compact-button" type="button" onClick={() => void handleForkThread()} disabled={!canForkThread}>
            {threadForkLoading ? <Loader2 className="spin" size={15} /> : <GitBranch size={15} />}
            {t("Fork")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => void handleThreadVisibilityAction(isThreadPinned ? "unpin" : "pin")}
            disabled={!displayThread || threadVisibilityLoading}
          >
            {threadVisibilityLoading ? <Loader2 className="spin" size={15} /> : isThreadPinned ? <PinOff size={15} /> : <Pin size={15} />}
            {isThreadPinned ? t("Unpin") : t("Pin")}
          </button>
          <button
            className={isThreadArchived ? "secondary-button compact-button" : "secondary-button danger compact-button"}
            type="button"
            onClick={() => void handleThreadVisibilityAction(isThreadArchived ? "unarchive" : "archive")}
            disabled={!displayThread || threadVisibilityLoading}
          >
            {threadVisibilityLoading ? <Loader2 className="spin" size={15} /> : isThreadArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {isThreadArchived ? t("Unarchive") : t("Archive")}
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
          <MetaRow label={t("Parent thread")} value={displayThread?.parentThreadId ?? "-"} compact />
          <MetaRow label={t("Parent turn")} value={displayThread?.parentTurnId ?? "-"} compact />
          <MetaRow label={t("Fork source run")} value={displayThread?.forkedFromRunId ?? "-"} compact />
          <MetaRow label={t("Workflow step")} value={displayThread?.workflowStepId ?? "-"} compact />
          <MetaRow label={t("Pinned")} value={displayThread?.pinnedAt ? formatDateTime(displayThread.pinnedAt) : "-"} compact />
          <MetaRow label={t("Archived")} value={displayThread?.archivedAt ? formatDateTime(displayThread.archivedAt) : displayThread?.status === "archived" ? t("Legacy archived") : "-"} compact />
          <MetaRow label={t("Archive reason")} value={displayThread?.archivedReason ?? "-"} compact />
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

        <div className="run-detail-section thread-resume-panel thread-fork-run-panel">
          <div className="panel-title tight split">
            <span>
              <GitBranch size={16} />
              <h3>{t("Fork and run")}</h3>
            </span>
            <span className="event-count">{sourceRunId || "-"}</span>
          </div>
          <label className="approval-reason-field thread-resume-composer">
            <span>{t("Child instruction")}</span>
            <textarea
              value={forkRunInstruction}
              rows={3}
              placeholder={t("Start the child branch with this instruction...")}
              onChange={(event) => setForkRunInstruction(event.target.value)}
              disabled={!canForkThread || threadActionLoading}
            />
          </label>
          {!sourceRunId ? (
            <p className="run-evidence-copy">
              <strong>{t("Fork guard")}</strong>
              {t("Select a source run before starting a child branch.")}
            </p>
          ) : null}
          <div className="button-row compact">
            <button className="primary-button compact-button" type="button" onClick={() => void handleForkRunThread()} disabled={!canForkRunThread}>
              {threadActionLoading ? <Loader2 className="spin" size={14} /> : <Activity size={14} />}
              {t("Start child branch")}
            </button>
          </div>
          {forkRunRunId ? (
            <p className="run-evidence-copy">
              <strong>{t("Run started")}</strong>
              {forkRunRunId}
            </p>
          ) : null}
        </div>

        <div className="run-detail-section thread-branch-lineage">
          <div className="panel-title tight split">
            <span>
              <GitBranch size={16} />
              <h3>{t("Fork lineage")}</h3>
            </span>
            <span className="event-count">{t("{count} child branches", { count: childThreads.length })}</span>
          </div>
          {displayThread?.parentThreadId ? (
            <div className="runtime-list-row lineage-row">
              <StatusBadge status={parentThread?.status ?? "unavailable"} />
              <span>
                {t("Forked from")} {parentThread?.title ?? displayThread.parentThreadId}
                <small>
                  {displayThread.parentTurnId ? `${t("Source turn")}: ${displayThread.parentTurnId}` : t("Thread-level fork")}
                  {displayThread.forkedFromRunId ? ` · ${t("Source run")}: ${displayThread.forkedFromRunId}` : ""}
                </small>
              </span>
              <button className="secondary-button compact-button" type="button" onClick={() => onSelectThreadId(displayThread.parentThreadId ?? "")}>
                {t("Open source")}
              </button>
            </div>
          ) : (
            <p className="muted">{t("This thread is a source branch.")}</p>
          )}
          {childThreads.length > 0 ? (
            <div className="runtime-list thread-child-branch-list">
              {childThreads.map((child) => (
                <button
                  key={child.id}
                  className="runtime-list-row thread-child-branch-row"
                  type="button"
                  onClick={() => onSelectThreadId(child.id)}
                >
                  <StatusBadge status={child.status} />
                  <span>
                    {child.title}
                    <small>{child.id}</small>
                  </span>
                  <small>{formatDateTime(child.updatedAt)}</small>
                </button>
              ))}
            </div>
          ) : null}
          {forkedThreadId ? (
            <p className="run-evidence-copy">
              <strong>{t("Fork created")}</strong>
              {forkedThreadId}
            </p>
          ) : null}
        </div>

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
            <span>{t("Resume source turn")}</span>
            <select
              value={selectedSourceTurn?.id ?? ""}
              onChange={(event) => {
                setSelectedSourceTurnId(event.target.value);
                setSelectedSourceRunId("");
                setResumePreview(undefined);
              }}
              disabled={loadedTurns.length === 0 || threadActionLoading}
            >
              <option value="">{loadedTurns.length === 0 ? t("No source turn") : t("Source run fallback")}</option>
              {loadedTurns.map((turn) => (
                <option key={turn.id} value={turn.id}>
                  {turn.title} · {turn.status} · {turn.id}
                </option>
              ))}
            </select>
          </label>
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
              {sourceRunId && !sourceRunOptions.some((item) => item.run.id === sourceRunId) ? (
                <option value={sourceRunId}>{sourceRunId}</option>
              ) : null}
              {sourceRunOptions.map((item) => (
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
                {resumePreview.context.sourceTurnId ? <MetaRow label={t("Source turn")} value={resumePreview.context.sourceTurnId} compact /> : null}
                <MetaRow label={t("Source run")} value={resumePreview.context.sourceRunId} compact />
                {resumePreview.context.priorTurnIds ? <MetaRow label={t("Prior turns")} value={String(resumePreview.context.priorTurnIds.length)} compact /> : null}
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
  turnContext,
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
  onSelectRun,
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
  readonly turnContext: WorkHistoryTurnContext | undefined;
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
  readonly onSelectRun: (runId: string) => void;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const workspaceCwd = run ? readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd : "-";
  const providerPresetId = run ? readRunProviderPresetId(run) : "";
  const permissionMode = run ? readSessionPermissionModeFromSnapshot(run.requestSnapshot) : undefined;
  const permissionPreset = run
    ? readPermissionPresetFromSnapshot(run.requestSnapshot) ?? inferPermissionPreset(permissionMode)
    : undefined;
  const permissionConfirmation = run ? readDataField(run.requestSnapshot, "permissionConfirmation") : undefined;
  const permissionConfirmationAt = readDataString(permissionConfirmation, "confirmedAt");
  const permissionConfirmationReason = readDataString(permissionConfirmation, "reason");
  const permissionConfirmationSummary = permissionConfirmationAt || permissionConfirmationReason
    ? t("Confirmed at {time}: {reason}", {
        time: permissionConfirmationAt ? formatDateTime(permissionConfirmationAt) : "-",
        reason: permissionConfirmationReason || "-",
      })
    : "";
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
            <MetaRow label={t("Permission preset")} value={permissionPresetLabel(permissionPreset, t)} compact />
            <MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(permissionMode, t)} compact />
            {permissionConfirmationSummary ? (
              <MetaRow label={t("Full access confirmation")} value={permissionConfirmationSummary} compact />
            ) : null}
            <MetaRow label={t("Work unit")} value={run.workUnitId ?? "-"} compact />
            <MetaRow label={t("Selected skill")} value={run.selectedSkillId ?? "-"} compact />
            <MetaRow label={t("Created")} value={formatDateTime(run.createdAt)} compact />
            <MetaRow label={t("Ended")} value={run.endedAt ? formatDateTime(run.endedAt) : "-"} compact />
          </div>

          {turnContext ? (
            <div className="run-detail-section work-history-turn-context">
              <div className="panel-title tight split">
                <span>
                  <Workflow size={16} />
                  <h3>{t("Turn")}</h3>
                </span>
                <span className="event-count">{t("{count} attempts", { count: turnContext.group.attemptCount })}</span>
              </div>
              <div className="run-detail-summary">
                <MetaRow label={t("Title")} value={turnContext.turn.title} compact />
                <MetaRow label={t("Status")} value={turnContext.turn.status} compact />
                <MetaRow label={t("Kind")} value={turnContext.turn.kind} compact />
                <MetaRow label={t("Created")} value={formatDateTime(turnContext.turn.createdAt)} compact />
                <MetaRow label={t("Updated")} value={formatDateTime(turnContext.turn.updatedAt)} compact />
              </div>
              <div className="runtime-list">
                {turnContext.group.attempts.map((attempt) => (
                  <div key={attempt.run.id} className="runtime-list-row">
                    <StatusBadge status={attempt.run.status} />
                    <span>
                      {t("Attempt {number}", { number: attempt.attemptNumber })}
                      <small>{readTaskTitle(attempt.run.taskSnapshot) || attempt.run.taskId}</small>
                    </span>
                    <small>{attempt.role}</small>
                    <button className="secondary-button compact-button" type="button" onClick={() => onSelectRun(attempt.run.id)} disabled={attempt.run.id === run.id}>
                      {attempt.run.id === run.id ? t("Current run") : t("Open attempt")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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
            turnContext={turnContext}
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
                <MetaRow label={t("Permission preset")} value={permissionPresetLabel(permissionPreset, t)} compact />
                <MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(effectivePolicySnapshot?.mode ?? permissionMode, t)} compact />
                {permissionConfirmationSummary ? (
                  <MetaRow label={t("Full access confirmation")} value={permissionConfirmationSummary} compact />
                ) : null}
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

function resolveDefaultResumeSourceTurn(turns: readonly LingTurn[]): LingTurn | undefined {
  const sorted = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  return sorted.find(isResumeSourceTurnTerminal) ?? sorted[0];
}

function isResumeSourceTurnTerminal(turn: LingTurn): boolean {
  return turn.status === "succeeded" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "superseded";
}

function resolveTurnRunIds(turn: LingTurn, links: readonly LingTurnRun[]): ReadonlySet<string> {
  return new Set([
    turn.activeRunId,
    turn.lastRunId,
    ...links.filter((link) => link.turnId === turn.id).map((link) => link.runId),
  ].filter((runId): runId is string => Boolean(runId)));
}

function resolveDefaultRunIdForTurn(
  turn: LingTurn,
  links: readonly LingTurnRun[],
  evidenceRuns: readonly LingThreadEvidenceResponse["runs"][number][],
): string {
  if (turn.lastRunId && evidenceRuns.some((item) => item.run.id === turn.lastRunId)) {
    return turn.lastRunId;
  }
  const latestLink = links
    .filter((link) => link.turnId === turn.id && evidenceRuns.some((item) => item.run.id === link.runId))
    .sort((left, right) => right.attemptNumber - left.attemptNumber || right.createdAt.localeCompare(left.createdAt))[0];
  return latestLink?.runId ?? "";
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
  readonly hasActiveSelectedTurn: boolean;
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
  if (input.hasActiveSelectedTurn) {
    return input.t("The selected turn is still active; wait for it to finish before resuming from it.");
  }
  if (input.isRunning) {
    return input.t("Another run is currently active; wait before starting a continuation.");
  }
  return "";
}

function turnStateKey(cwd: string, threadId: string): string {
  return `${cwd.trim()}::${threadId}`;
}

function buildWorkHistoryTurnLoadRequests(
  cwd: string,
  visibleThreads: readonly LingThread[],
  runs: readonly RunSession[],
  selectedRun: RunSession | undefined,
): ReadonlyArray<{ readonly threadId: string; readonly signature: string }> {
  if (!cwd.trim()) {
    return [];
  }
  const threadById = new Map(visibleThreads.map((thread) => [thread.id, thread]));
  const threadIds = new Set<string>();
  for (const thread of visibleThreads) {
    threadIds.add(thread.id);
  }
  for (const run of runs) {
    if (run.threadId) {
      threadIds.add(run.threadId);
    }
  }
  if (selectedRun?.threadId) {
    threadIds.add(selectedRun.threadId);
  }
  return [...threadIds].slice(0, 100).map((threadId) => ({
    threadId,
    signature: buildWorkHistoryThreadSignature(threadById.get(threadId), runs.filter((run) => run.threadId === threadId)),
  }));
}

function buildWorkHistoryThreadSignature(thread: LingThread | undefined, runs: readonly RunSession[]): string {
  const runSignature = [...runs]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((run) => `${run.id}:${run.status}:${run.updatedAt || ""}:${run.endedAt || ""}`)
    .join(",");
  const metadata = thread?.metadata;
  return [
    thread?.updatedAt ?? "",
    thread?.activeRunId ?? "",
    thread?.lastRunId ?? "",
    metadata?.lastActivityAt ?? "",
    metadata?.pendingApprovalCount ?? "",
    metadata?.blockedCount ?? "",
    metadata?.failedAttemptCount ?? "",
    metadata?.artifactCount ?? "",
    metadata?.rebuiltAt ?? "",
    runSignature,
  ].join("|");
}

function buildWorkHistoryTurnGroups(input: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly visibleThreads: readonly LingThread[];
  readonly turnStateByThreadKey: Readonly<Record<string, WorkHistoryTurnLoadState>>;
}): readonly WorkHistoryTurnGroup[] {
  const workspaceCwd = input.cwd.trim();
  const threadById = new Map(input.visibleThreads.map((thread) => [thread.id, thread]));
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const threadIds = new Set<string>(input.visibleThreads.map((thread) => thread.id));
  for (const run of input.runs) {
    if (run.threadId) {
      threadIds.add(run.threadId);
    }
  }

  const groups: WorkHistoryTurnGroup[] = [];
  for (const threadId of threadIds) {
    const thread = threadById.get(threadId) ?? deriveThreadFromThreadRuns(threadId, input.runs.filter((run) => run.threadId === threadId));
    if (!thread) {
      continue;
    }
    const threadRuns = input.runs.filter((run) => run.threadId === threadId);
    const consumedRunIds = new Set<string>();
    const turnState = workspaceCwd ? input.turnStateByThreadKey[turnStateKey(workspaceCwd, threadId)] : undefined;
    if (turnState?.status === "loaded") {
      const linksByTurnId = groupVisibleTurnRunLinks(turnState.runLinks, runById, threadId);
      for (const turn of turnState.turns) {
        const attempts = buildDurableTurnAttempts(linksByTurnId.get(turn.id) ?? [], runById);
        if (attempts.length === 0) {
          continue;
        }
        for (const attempt of attempts) {
          consumedRunIds.add(attempt.run.id);
        }
        const latestRunId = resolveLatestTurnRunId(turn, attempts);
        groups.push({
          id: `turn:${turn.id}`,
          threadId,
          turnId: turn.id,
          title: turn.title || thread.title,
          status: turn.status,
          runIds: attempts.map((attempt) => attempt.run.id),
          latestRunId,
          attemptCount: attempts.length,
          updatedAt: turn.updatedAt || attempts.find((attempt) => attempt.run.id === latestRunId)?.run.updatedAt || thread.updatedAt,
          source: "durable_turn",
          attempts,
          thread,
        });
      }
    }

    const ungroupedRuns = threadRuns.filter((run) => !consumedRunIds.has(run.id));
    if (ungroupedRuns.length > 0 || !groups.some((group) => group.threadId === threadId)) {
      groups.push(buildLegacyThreadGroup(thread, ungroupedRuns.length > 0 ? ungroupedRuns : threadRuns));
    }
  }

  return groups.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

function buildWorkHistoryGroupTree(groups: readonly WorkHistoryTurnGroup[]): ReadonlyArray<{
  readonly group: WorkHistoryTurnGroup;
  readonly depth: number;
  readonly parentHidden: boolean;
}> {
  const groupsByThreadId = new Map<string, WorkHistoryTurnGroup[]>();
  const threadById = new Map<string, LingThread>();
  for (const group of groups) {
    groupsByThreadId.set(group.threadId, [...(groupsByThreadId.get(group.threadId) ?? []), group]);
    if (group.thread) {
      threadById.set(group.thread.id, group.thread);
    }
  }
  const childThreadIdsByParentId = new Map<string, string[]>();
  for (const thread of threadById.values()) {
    if (!thread.parentThreadId) {
      continue;
    }
    childThreadIdsByParentId.set(thread.parentThreadId, [...(childThreadIdsByParentId.get(thread.parentThreadId) ?? []), thread.id]);
  }
  const rootThreadIds = [...threadById.values()]
    .filter((thread) => !thread.parentThreadId || !threadById.has(thread.parentThreadId))
    .map((thread) => thread.id);
  const visited = new Set<string>();
  const rows: Array<{ readonly group: WorkHistoryTurnGroup; readonly depth: number; readonly parentHidden: boolean }> = [];

  const sortThreadIds = (threadIds: readonly string[]): string[] =>
    [...new Set(threadIds)].sort((leftId, rightId) =>
      Number(Boolean(threadById.get(rightId)?.pinnedAt)) - Number(Boolean(threadById.get(leftId)?.pinnedAt)) ||
      (threadById.get(rightId)?.pinnedAt ?? "").localeCompare(threadById.get(leftId)?.pinnedAt ?? "") ||
      latestThreadGroupUpdatedAt(groupsByThreadId.get(rightId) ?? []).localeCompare(latestThreadGroupUpdatedAt(groupsByThreadId.get(leftId) ?? [])) ||
      leftId.localeCompare(rightId));

  const visitThread = (threadId: string, depth: number, parentHidden: boolean): void => {
    if (visited.has(threadId)) {
      return;
    }
    visited.add(threadId);
    for (const group of sortGroupsForThread(groupsByThreadId.get(threadId) ?? [])) {
      rows.push({ group, depth, parentHidden });
    }
    for (const childThreadId of sortThreadIds(childThreadIdsByParentId.get(threadId) ?? [])) {
      visitThread(childThreadId, Math.min(depth + 1, 6), false);
    }
  };

  for (const threadId of sortThreadIds(rootThreadIds)) {
    const thread = threadById.get(threadId);
    visitThread(threadId, 0, Boolean(thread?.parentThreadId && !threadById.has(thread.parentThreadId)));
  }
  for (const group of groups) {
    if (!visited.has(group.threadId)) {
      rows.push({ group, depth: 0, parentHidden: Boolean(group.thread?.parentThreadId) });
    }
  }
  return rows;
}

function sortGroupsForThread(groups: readonly WorkHistoryTurnGroup[]): readonly WorkHistoryTurnGroup[] {
  return [...groups].sort((left, right) =>
    Number(left.source === "legacy_thread") - Number(right.source === "legacy_thread") ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id));
}

function latestThreadGroupUpdatedAt(groups: readonly WorkHistoryTurnGroup[]): string {
  return groups.reduce((latest, group) => group.updatedAt > latest ? group.updatedAt : latest, "");
}

function groupVisibleTurnRunLinks(
  links: readonly LingTurnRun[],
  runById: ReadonlyMap<string, RunSession>,
  threadId: string,
): ReadonlyMap<string, readonly LingTurnRun[]> {
  const linksByTurnId = new Map<string, LingTurnRun[]>();
  const seenRunIds = new Set<string>();
  for (const link of [...links].sort((left, right) => left.attemptNumber - right.attemptNumber || left.createdAt.localeCompare(right.createdAt))) {
    const run = runById.get(link.runId);
    if (!run || run.threadId !== threadId || seenRunIds.has(link.runId)) {
      continue;
    }
    seenRunIds.add(link.runId);
    linksByTurnId.set(link.turnId, [...(linksByTurnId.get(link.turnId) ?? []), link]);
  }
  return linksByTurnId;
}

function buildDurableTurnAttempts(
  links: readonly LingTurnRun[],
  runById: ReadonlyMap<string, RunSession>,
): readonly WorkHistoryTurnAttempt[] {
  const attempts: WorkHistoryTurnAttempt[] = [];
  for (const link of links) {
    const run = runById.get(link.runId);
    if (!run) {
      continue;
    }
    attempts.push({
      run,
      attemptNumber: link.attemptNumber,
      role: link.role,
      linkedAt: link.createdAt,
    });
  }
  return attempts.sort((left, right) => left.attemptNumber - right.attemptNumber || left.linkedAt.localeCompare(right.linkedAt));
}

function resolveLatestTurnRunId(turn: LingTurn, attempts: readonly WorkHistoryTurnAttempt[]): string {
  const activeAttempt = turn.activeRunId ? attempts.find((attempt) => attempt.run.id === turn.activeRunId) : undefined;
  if (activeAttempt) {
    return activeAttempt.run.id;
  }
  const lastAttempt = turn.lastRunId ? attempts.find((attempt) => attempt.run.id === turn.lastRunId) : undefined;
  if (lastAttempt) {
    return lastAttempt.run.id;
  }
  return [...attempts].sort((left, right) =>
    compareRunRecency(right.run, left.run) || right.attemptNumber - left.attemptNumber
  )[0]?.run.id ?? attempts[attempts.length - 1]?.run.id ?? "";
}

function buildLegacyThreadGroup(thread: LingThread, runs: readonly RunSession[]): WorkHistoryTurnGroup {
  const orderedRuns = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestRun = [...runs].sort((left, right) => compareRunRecency(right, left))[0];
  const latestRunId = thread.activeRunId ?? thread.lastRunId ?? latestRun?.id ?? "";
  const metadata = thread.metadata;
  return {
    id: `thread:${thread.id}`,
    threadId: thread.id,
    title: metadata?.summary || thread.title,
    status: thread.status,
    runIds: orderedRuns.map((run) => run.id),
    latestRunId,
    attemptCount: Math.max(orderedRuns.length, latestRunId ? 1 : 0),
    updatedAt: metadata?.lastActivityAt || thread.updatedAt || latestRun?.updatedAt || latestRun?.createdAt || "",
    source: "legacy_thread",
    attempts: orderedRuns.map((run, index) => ({
      run,
      attemptNumber: index + 1,
      role: "legacy",
      linkedAt: run.createdAt,
    })),
    thread,
  };
}

function buildTurnContextByRunId(
  runId: string,
  groups: readonly WorkHistoryTurnGroup[],
  turnStateByThreadKey: Readonly<Record<string, WorkHistoryTurnLoadState>>,
  cwd: string,
): WorkHistoryTurnContext | undefined {
  if (!runId || !cwd.trim()) {
    return undefined;
  }
  const group = groups.find((item) => item.source === "durable_turn" && item.turnId && item.runIds.includes(runId));
  if (!group?.turnId) {
    return undefined;
  }
  const turnState = turnStateByThreadKey[turnStateKey(cwd, group.threadId)];
  if (turnState?.status !== "loaded") {
    return undefined;
  }
  const turn = turnState.turns.find((item) => item.id === group.turnId);
  return turn ? { group, turn } : undefined;
}

function deriveThreadFromThreadRuns(threadId: string, runs: readonly RunSession[]): LingThread | undefined {
  return deriveThreadsFromRuns(runs).find((thread) => thread.id === threadId);
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

function formatWorkHistoryMetadataHint(thread: LingThread | undefined, t: Translate): string {
  const metadata = thread?.metadata;
  if (!metadata) {
    return "";
  }
  const items: string[] = [];
  if (metadata.pendingApprovalCount > 0) {
    items.push(t("{count} pending approvals", { count: metadata.pendingApprovalCount }));
  }
  if (metadata.failedAttemptCount > 0) {
    items.push(t("{count} failed attempts", { count: metadata.failedAttemptCount }));
  }
  if (metadata.artifactCount > 0) {
    items.push(t("{count} artifacts", { count: metadata.artifactCount }));
  }
  return items.slice(0, 2).join(" · ");
}

function normalizeWorkHistorySearchQuery(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 ? normalized : undefined;
}

function buildThreadSearchMatchMap(matches: readonly LingThreadSearchMatch[]): ReadonlyMap<string, LingThreadSearchMatch> {
  const result = new Map<string, LingThreadSearchMatch>();
  for (const match of matches) {
    if (!result.has(match.threadId)) {
      result.set(match.threadId, match);
    }
  }
  return result;
}

function formatLingThreadSearchMatch(match: LingThreadSearchMatch, t: Translate): string {
  if (match.field === "thread_title") {
    return t("Thread title");
  }
  if (match.field === "thread_objective") {
    return t("Thread objective");
  }
  if (match.field === "turn_title") {
    return t("Turn title");
  }
  if (match.field === "turn_instruction") {
    return t("Turn instruction");
  }
  if (match.field === "task_title") {
    return t("Task title");
  }
  if (match.field === "task_prompt") {
    return t("Task prompt");
  }
  if (match.field === "metadata_summary") {
    return t("Thread summary");
  }
  return t("Task id");
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
  turnContext,
  terminalEvent,
  toolEvents,
  assistantText,
  approvals,
  artifacts,
  onRefresh,
}: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly turnContext: WorkHistoryTurnContext | undefined;
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
  const resumeTurnId = turnContext?.turn.id;
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
        ...(resumeTurnId ? { turnId: resumeTurnId } : {}),
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
        ...(resumeTurnId ? { turnId: resumeTurnId } : {}),
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

      <ShellSnapshotPanel cwd={cwd} run={run} artifacts={artifacts} />

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
            <MetaRow label={t("Source turn")} value={resumeTurnId ?? "-"} compact />
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
                {resumePreview.context.sourceTurnId ? <MetaRow label={t("Source turn")} value={resumePreview.context.sourceTurnId} compact /> : null}
                <MetaRow label={t("Source run")} value={resumePreview.context.sourceRunId} compact />
                {resumePreview.context.priorTurnIds ? <MetaRow label={t("Prior turns")} value={String(resumePreview.context.priorTurnIds.length)} compact /> : null}
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

function ShellSnapshotPanel({
  cwd,
  run,
  artifacts,
}: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly artifacts: readonly RunArtifact[];
}): JSX.Element {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<readonly ShellSnapshotListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  async function loadSnapshots(): Promise<void> {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const response = await listRunShellSnapshots(run.id, cwd);
      setSnapshots(response.snapshots);
    } catch (error) {
      setSnapshots([]);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    setSnapshots([]);
    setErrorMessage("");
    void loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, run.id]);

  return (
    <div className="run-evidence-block shell-snapshot-panel">
      <div className="panel-title tight split">
        <span>
          <SquareTerminal size={16} />
          <h3>{t("Shell snapshots")}</h3>
        </span>
        <span className="button-row compact">
          <span className="event-count">{t("{count} snapshots", { count: snapshots.length })}</span>
          <button className="secondary-button compact-button" type="button" onClick={() => void loadSnapshots()} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {t("Refresh")}
          </button>
        </span>
      </div>
      {errorMessage ? (
        <p className="run-evidence-copy error">
          <strong>{t("Shell snapshot diagnostics unavailable")}</strong>
          {errorMessage}
        </p>
      ) : null}
      {isLoading && snapshots.length === 0 ? (
        <div className="empty-state compact-empty">
          <Loader2 className="spin" />
          <span>{t("Loading shell snapshots...")}</span>
        </div>
      ) : snapshots.length === 0 && !errorMessage ? (
        <div className="artifact-empty-state">
          <span>{t("No shell snapshots recorded for this run")}</span>
          <small>{t("Approved bash commands will record redacted start and terminal snapshots when the daemon feature is enabled.")}</small>
        </div>
      ) : snapshots.length > 0 ? (
        <div className="shell-snapshot-list">
          {snapshots.map((snapshot) => (
            <div key={snapshot.id} className="shell-snapshot-row">
              <div className="shell-snapshot-head">
                <StatusBadge status={snapshot.status} />
                <code>#{snapshot.sequence}</code>
                <span>{snapshot.source}</span>
                <small>{formatDateTime(snapshot.createdAt)}</small>
              </div>
              <div className="shell-snapshot-command">
                <strong>{truncatePreview(snapshot.commandPreview, 180)}</strong>
                <small>{t("Tool call")}: {snapshot.toolCallId}</small>
              </div>
              <div className="shell-snapshot-meta">
                <MetaRow label={t("Exit code")} value={snapshot.exitCode === undefined ? "-" : String(snapshot.exitCode)} compact />
                <MetaRow label={t("Duration")} value={snapshot.durationMs === undefined ? "-" : `${snapshot.durationMs}ms`} compact />
              </div>
              <div className="shell-snapshot-artifacts">
                <ShellSnapshotArtifactLink
                  cwd={cwd}
                  label={t("JSON")}
                  artifactId={snapshot.artifactId}
                  artifact={artifactsById.get(snapshot.artifactId)}
                />
                {snapshot.textArtifactId ? (
                  <ShellSnapshotArtifactLink
                    cwd={cwd}
                    label={t("Text")}
                    artifactId={snapshot.textArtifactId}
                    artifact={artifactsById.get(snapshot.textArtifactId)}
                  />
                ) : (
                  <code title={t("No text summary artifact")}>{t("No text summary")}</code>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ShellSnapshotArtifactLink({
  cwd,
  label,
  artifactId,
  artifact,
}: {
  readonly cwd: string;
  readonly label: string;
  readonly artifactId: string;
  readonly artifact: RunArtifact | undefined;
}): JSX.Element {
  const title = artifact?.title ?? artifactId;
  return (
    <a className="artifact-action-link" href={artifactContentUrl(artifactId, cwd)} target="_blank" rel="noreferrer" title={title}>
      {label}: {truncatePreview(title, 42)}
    </a>
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

function stableBrowserHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
  const unifiedExecPreview = summarizeUnifiedExecResultFromData(event.data);
  const summaryPreview = unifiedExecPreview || outputPreview || command || formatEventPreview(event.data);

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
