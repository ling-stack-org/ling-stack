import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Command,
  Database,
  Hash,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { effectiveChannelRuntimePolicy } from "../../lib/channels.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus } from "../../lib/run-evidence.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { RunRepairHintBanner, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelFormState,
  ProviderPreset,
  ResourceLease,
  RunSession,
  Task,
  TaskFormState,
  TaskRunActionState,
} from "../../types.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

type TaskFilter = "all" | "queued" | "running" | "review" | "done";

const taskFilters: readonly TaskFilter[] = ["all", "queued", "running", "review", "done"];

export function WorkspaceClientView({
  cwd,
  daemonHealthy,
  providerLabel,
  channels,
  selectedChannelId,
  channelForm,
  tasks,
  taskForm,
  selectedTaskId,
  providers,
  taskRunProviderId,
  fallbackProviderId,
  channelsLoading,
  tasksLoading,
  providersLoading,
  approvals,
  resourceLeases,
  runs,
  runById,
  activeRunId,
  latestStatus,
  isRunning,
  activeTaskRunAction,
  errorMessage,
  onCwdChange,
  onChannelFormChange,
  onTaskFormChange,
  onProviderSelect,
  onSelectChannel,
  onRefreshChannels,
  onCreateDefaultChannel,
  onCreateChannel,
  onCreateTask,
  onRefreshTasks,
  onSelectTask,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly daemonHealthy: boolean | undefined;
  readonly providerLabel: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly selectedTaskId: string;
  readonly providers: readonly ProviderPreset[];
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly providersLoading: boolean;
  readonly approvals: readonly ApprovalRequest[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly runs: readonly RunSession[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateDefaultChannel: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const readyProvider = providers.find(providerPreflightReady);
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id) ?? "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const providerBlocker = providerRunPreflightBlocker(effectiveProvider);
  const activeLeaseCount = resourceLeases.filter((lease) => lease.status === "active").length;
  const taskActionPending = activeTaskRunAction !== undefined;
  const selectedChannelRuntimePolicy = effectiveChannelRuntimePolicy(selectedChannel);
  const channelStatusText = selectedChannel
    ? `${selectedChannel.status} · ${selectedChannelRuntimePolicy.executionMode} · ${selectedChannelRuntimePolicy.writeLockScope} lock`
    : t("No channel yet");
  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
        const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
        return taskMatchesFilter(taskFilter, task, linkedRunStatus);
      }),
    [activeRunId, latestStatus, runById, taskFilter, tasks],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        taskFilters.map((filter) => [
          filter,
          tasks.filter((task) => {
            const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
            const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
            return taskMatchesFilter(filter, task, linkedRunStatus);
          }).length,
        ]),
      ) as Record<TaskFilter, number>,
    [activeRunId, latestStatus, runById, tasks],
  );

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    onSelectTask(taskId);
  }

  function createTask(): void {
    onCreateTask();
    setCreateTaskOpen(false);
  }

  return (
    <div className="client-window task-workbench-window" aria-label={t("Workspace")}>
      <header className="channel-header task-workbench-header">
        <div>
          <div className="channel-title-line">
            <Hash size={21} />
            <h1>{selectedChannel?.name ?? "Engineering"}</h1>
          </div>
          <p>{channelStatusText}{selectedChannel?.boundPath ? ` · ${selectedChannel.boundPath}` : ""}</p>
        </div>
        <div className="channel-header-actions">
          <span className={daemonHealthy ? "glass-chip ok" : "glass-chip attention"}>
            <Activity size={14} />
            {daemonHealthy === undefined ? t("Checking daemon") : daemonHealthy ? t("Daemon ready") : t("Daemon offline")}
          </span>
          <span className={providerBlocker ? "glass-chip attention" : "glass-chip ok"}>
            <Command size={14} />
            {effectiveProvider?.displayName ?? providerLabel}
          </span>
          {activeLeaseCount > 0 ? (
            <span className="glass-chip attention">
              <Clock3 size={14} />
              {t("{count} active leases", { count: activeLeaseCount })}
            </span>
          ) : null}
        </div>
      </header>

      <section className="task-workbench-toolbar" aria-label={t("Workspace task toolbar")}>
        <label className="field toolbar-path-field">
          <span>{t("Workspace path")}</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>
        <label className="field toolbar-channel-field">
          <span>{t("Channel")}</span>
          <select value={selectedChannelId} onChange={(event) => onSelectChannel(event.target.value)} disabled={channelsLoading || channels.length === 0}>
            {channels.length === 0 ? <option value="">{t("No channel yet")}</option> : null}
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name} / {channel.status}
              </option>
            ))}
          </select>
        </label>
        <label className="field run-provider-field">
          <span>{t("Run provider")}</span>
          <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading || providers.length === 0}>
            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </select>
        </label>
        <button className="primary-button task-toolbar-create" type="button" onClick={() => setCreateTaskOpen(true)} disabled={!selectedChannelId}>
          <Plus size={15} />
          {t("New task")}
        </button>
      </section>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="task-workbench-main">
        <section className="panel task-list-panel" aria-label={t("Tasks")}>
          <div className="panel-title split">
            <span>
              <SquareTerminal size={16} />
              <h2>{t("Tasks")}</h2>
            </span>
            <button className="icon-button" type="button" onClick={onRefreshTasks} disabled={!selectedChannelId || tasksLoading} aria-label={t("Refresh")}>
              {tasksLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>
          <div className="task-filter-tabs" aria-label={t("Task filters")}>
            {taskFilters.map((filter) => (
              <button key={filter} className={taskFilter === filter ? "active" : ""} type="button" onClick={() => setTaskFilter(filter)}>
                {t(taskFilterLabel(filter))}
                <small>{filterCounts[filter]}</small>
              </button>
            ))}
          </div>
          <div className="workbench-task-list">
            {filteredTasks.length === 0 ? (
              <div className="client-empty-state">
                {tasksLoading ? <Loader2 className="spin" /> : <SquareTerminal />}
                <span>{tasksLoading ? t("Loading tasks...") : t("No tasks match this filter")}</span>
              </div>
            ) : (
              filteredTasks.map((task) => {
                const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
                const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={task.id === selectedTask?.id && !createTaskOpen ? "client-task-card selected" : "client-task-card"}
                    onClick={() => selectTask(task.id)}
                  >
                    <span className="client-task-main">
                      <span>
                        <strong>{task.title}</strong>
                        <small>{task.prompt}</small>
                      </span>
                      <span className={`task-status ${task.status}`}>{task.status}</span>
                    </span>
                    <span className="task-card-meta">
                      {task.currentRunId ? <StatusBadge status={linkedRunStatus} /> : <span className="status-badge queued">{t("Not run")}</span>}
                      <small>{task.currentRunId ?? formatDateTime(task.updatedAt)}</small>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="panel task-detail-panel" aria-label={createTaskOpen ? t("New task") : t("Task detail")}>
          {createTaskOpen ? (
            <NewTaskPanel
              taskForm={taskForm}
              selectedChannel={selectedChannel}
              effectiveProviderId={effectiveProviderId}
              taskReadyProviders={taskReadyProviders}
              setupChatProviders={setupChatProviders}
              mediaProviders={mediaProviders}
              providersLoading={providersLoading}
              onProviderSelect={onProviderSelect}
              onTaskFormChange={onTaskFormChange}
              onCreateTask={createTask}
              onCancel={() => setCreateTaskOpen(false)}
            />
          ) : selectedTask ? (
            <TaskDetailPanel
              task={selectedTask}
              channels={channels}
              runById={runById}
              activeRunId={activeRunId}
              latestStatus={latestStatus}
              pendingApprovalCount={pendingApprovalCount}
              effectiveProvider={effectiveProvider}
              providerBlocker={providerBlocker}
              isRunning={isRunning}
              activeTaskRunAction={activeTaskRunAction}
              taskActionPending={taskActionPending}
              activeLeaseCount={activeLeaseCount}
              onCheckThenRunTask={onCheckThenRunTask}
              onRunTask={onRunTask}
              onOpenRun={onOpenRun}
              onOpenApprovals={onOpenApprovals}
              onOpenProviders={onOpenProviders}
            />
          ) : (
            <div className="client-empty-state">
              <SquareTerminal />
              <span>{t("Select a task or create a new one")}</span>
            </div>
          )}
        </section>
      </div>

      <details className="config-disclosure channel-options">
        <summary>
          <SlidersHorizontal size={14} />
          {t("Advanced channel settings")}
        </summary>
        <div className="channel-options-grid">
          <label className="field wide">
            <span>{t("Name")}</span>
            <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Execution path")}</span>
            <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
          </label>
          <ChannelRuntimePolicyFields form={channelForm} onChange={onChannelFormChange} />
          <div className="channel-option-actions">
            {channels.length === 0 ? (
              <button className="secondary-button compact-button" type="button" onClick={onCreateDefaultChannel} disabled={channelsLoading || !readyProvider}>
                <Plus size={14} />
                {t("Create default")}
              </button>
            ) : null}
            <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
              {channelsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh channels")}
            </button>
            <button className="primary-button compact-button" type="button" onClick={onCreateChannel}>
              <Plus size={14} />
              {t("Create channel")}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function NewTaskPanel({
  taskForm,
  selectedChannel,
  effectiveProviderId,
  taskReadyProviders,
  setupChatProviders,
  mediaProviders,
  providersLoading,
  onProviderSelect,
  onTaskFormChange,
  onCreateTask,
  onCancel,
}: {
  readonly taskForm: TaskFormState;
  readonly selectedChannel: Channel | undefined;
  readonly effectiveProviderId: string;
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly mediaProviders: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onCreateTask: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="task-create-panel">
      <div className="panel-title split">
        <span>
          <Plus size={17} />
          <h2>{t("New task")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
      <label className="field wide">
        <span>{t("Run provider")}</span>
        <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading}>
          <option value="">{t("Select provider preset")}</option>
          <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
        </select>
      </label>
      <label className="field wide">
        <span>{t("Title")}</span>
        <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
      </label>
      <label className="field wide">
        <span>{t("Prompt")}</span>
        <textarea value={taskForm.prompt} rows={7} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
      </label>
      {mediaProviders.length > 0 ? (
        <div className="provider-run-notice neutral client-provider-notice">
          <Database size={16} />
          <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
        </div>
      ) : null}
      <div className="composer-footer">
        <div className="tool-token-list" aria-label={t("Tool calls")}>
          {(selectedChannel?.allowedTools ?? defaultTools).map((tool) => (
            <span key={tool} className={riskyTools.includes(tool) ? "tool-token risky" : "tool-token"}>{tool}</span>
          ))}
        </div>
        <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannel || !taskForm.prompt.trim()}>
          <Send size={15} />
          {t("Create task")}
        </button>
      </div>
    </div>
  );
}

function TaskDetailPanel({
  task,
  channels,
  runById,
  activeRunId,
  latestStatus,
  pendingApprovalCount,
  effectiveProvider,
  providerBlocker,
  isRunning,
  activeTaskRunAction,
  taskActionPending,
  activeLeaseCount,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly pendingApprovalCount: number;
  readonly effectiveProvider: ProviderPreset | undefined;
  readonly providerBlocker: string | undefined;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly taskActionPending: boolean;
  readonly activeLeaseCount: number;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
  const linkedRunSucceeded = linkedRunStatus === "succeeded";
  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus);
  const taskChannel = channels.find((channel) => channel.id === task.channelId);
  const taskChannelPaused = taskChannel?.status !== undefined && taskChannel.status !== "active";
  const blockedByLease = activeLeaseCount > 0 && (!linkedRun || linkedRun.status !== "running");
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const taskActionsDisabled = isRunning || taskActionPending;

  return (
    <article className="client-task-card task-detail selected" aria-label={t("Task detail")}>
      <div className="task-detail-head">
        <span className="client-task-kicker">{t("Task detail")}</span>
        <span className={`task-status ${task.status}`}>{task.status}</span>
      </div>
      <div className="task-detail-copy">
        <h2>{task.title}</h2>
        <p>{task.prompt}</p>
      </div>
      <div className="task-detail-meta">
        <span>
          <Hash size={13} />
          {taskChannel?.name ?? task.channelId}
        </span>
        <span>
          <Command size={13} />
          {effectiveProvider?.displayName ?? t("No model selected")}
        </span>
        <span>
          <Clock3 size={13} />
          {formatDateTime(task.updatedAt)}
        </span>
      </div>
      {task.currentRunId ? (
        <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
          <StatusBadge status={linkedRunStatus} />
          <span className="task-run-summary">
            {linkedRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
            <code>{task.currentRunId}</code>
          </span>
          <button className={linkedRunSucceeded ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
            {linkedRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
            {linkedRunSucceeded ? t("View result") : t("Open run")}
          </button>
        </div>
      ) : null}
      {task.currentRunId && repairHint ? (
        <RunRepairHintBanner
          hint={repairHint}
          runId={task.currentRunId}
          compact
          onOpenProviders={() => onOpenProviders(linkedRun)}
          onOpenApprovals={onOpenApprovals}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {providerBlocker ? (
        <div className="provider-run-notice">
          <CircleAlert size={16} />
          <span>{providerBlocker}</span>
        </div>
      ) : null}
      {taskChannelPaused || blockedByLease ? (
        <div className="task-run-link compact">
          <StatusBadge status={taskChannelPaused ? (taskChannel?.status ?? "blocked") : "blocked"} />
          <span>{taskChannelPaused ? t("Channel is not active") : t("Active resource lock")}</span>
        </div>
      ) : null}
      <div className="task-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={taskActionsDisabled || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Check run")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={taskActionsDisabled || Boolean(providerBlocker) || taskChannelPaused}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Run")}
        </button>
      </div>
    </article>
  );
}

function taskFilterLabel(filter: TaskFilter): string {
  if (filter === "queued") {
    return "Queued";
  }
  if (filter === "running") {
    return "Running";
  }
  if (filter === "review") {
    return "Needs review";
  }
  if (filter === "done") {
    return "Done";
  }
  return "All";
}

function taskMatchesFilter(filter: TaskFilter, task: Task, linkedRunStatus: string): boolean {
  if (filter === "queued") {
    return task.status === "todo";
  }
  if (filter === "running") {
    return task.status === "running" || task.status === "claimed" || linkedRunStatus === "running" || linkedRunStatus === "queued";
  }
  if (filter === "review") {
    return task.status === "failed" || task.status === "blocked" || task.status === "review" || linkedRunStatus === "failed" || linkedRunStatus === "waiting_for_approval";
  }
  if (filter === "done") {
    return task.status === "done" || linkedRunStatus === "succeeded";
  }
  return true;
}
