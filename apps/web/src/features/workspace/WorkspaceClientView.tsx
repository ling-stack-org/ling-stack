import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Command,
  Database,
  Hash,
  History,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Send,
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
import { AvatarInitial, RunRepairHintBanner, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelFormState,
  ProviderPreset,
  ResourceLease,
  RunSession,
  Task,
  TaskFormState,
} from "../../types.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

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
  const latestRun = activeRunId ? runById.get(activeRunId) : runs[0];
  const activeLeaseCount = resourceLeases.filter((lease) => lease.status === "active").length;
  const selectedChannelRuntimePolicy = effectiveChannelRuntimePolicy(selectedChannel);
  const channelStatusText = selectedChannel
    ? `${selectedChannel.status} · ${selectedChannelRuntimePolicy.executionMode} · ${selectedChannelRuntimePolicy.writeLockScope} lock · ${selectedChannel.boundPath ?? cwd}`
    : t("No channel yet");

  return (
    <div className="client-window" aria-label={t("Workspace")}>
      <header className="channel-header">
        <div>
          <div className="channel-title-line">
            <Hash size={21} />
            <h1>{selectedChannel?.name ?? "engineering"}</h1>
          </div>
          <label className="channel-path-field">
            <span>{t("Workspace path")}</span>
            <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
          </label>
          <p>{channelStatusText}</p>
        </div>
        <div className="channel-header-actions">
          <span className={daemonHealthy ? "glass-chip ok" : "glass-chip attention"}>
            <Activity size={14} />
            {daemonHealthy === undefined ? t("Checking daemon") : daemonHealthy ? t("Daemon ready") : t("Daemon offline")}
          </span>
          <span className={providerBlocker ? "glass-chip attention" : "glass-chip ok"}>
            <Bot size={14} />
            {effectiveProvider?.displayName ?? providerLabel}
          </span>
          {selectedChannel ? (
            <span className={selectedChannel.status === "active" ? "glass-chip ok" : "glass-chip attention"}>
              <Workflow size={14} />
              {selectedChannel.status}
            </span>
          ) : null}
          {activeLeaseCount > 0 ? (
            <span className="glass-chip attention">
              <Clock3 size={14} />
              {t("{count} active leases", { count: activeLeaseCount })}
            </span>
          ) : null}
        </div>
      </header>

      <div className="client-main">
        <section className="conversation-panel" aria-label={t("Channel activity")}>
          {errorMessage ? (
            <div className="inline-error">
              <CircleAlert size={17} />
              {errorMessage}
            </div>
          ) : null}

          <div className="message-feed">
            <MessageBubble
              avatar={<AvatarInitial label="L" tone="orange" />}
              author="Ling Stack"
              time={t("Now")}
              body={selectedChannel ? t("Default workspace is ready. This channel is bound to {path}.", { path: selectedChannel.boundPath ?? cwd }) : t("Create a default channel to start the workspace loop.")}
            />
            <MessageBubble
              avatar={<AvatarInitial label="T" />}
              author="Tian"
              time={t("Just now")}
              body={selectedTask ? selectedTask.prompt : taskForm.prompt}
            />
            <MessageBubble
              avatar={<AvatarInitial label="A" tone="teal" />}
              author="Ada"
              tag="AI"
              time={t("Ready")}
              body={providerBlocker ? providerBlocker : t("I can run this task with {providerName}. Risky tools will wait for approval.", { providerName: effectiveProvider?.displayName ?? providerLabel })}
            />
            {latestRun ? (
              <MessageBubble
                avatar={<AvatarInitial label="H" tone="violet" />}
                author="Hopper"
                tag="AI"
                time={formatDateTime(latestRun.updatedAt)}
                body={t("Latest run {runId} is {status}.", { runId: latestRun.id, status: latestRun.status })}
                action={
                  <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(latestRun.id)}>
                    <History size={14} />
                    {t("Open run")}
                  </button>
                }
              />
            ) : null}
          </div>

          <section className="task-strip" aria-label={t("Tasks")}>
            <div className="task-strip-head">
              <span>
                <SquareTerminal size={16} />
                <strong>{t("Tasks")}</strong>
              </span>
              <button className="icon-button" type="button" onClick={onRefreshTasks} disabled={!selectedChannelId || tasksLoading} aria-label={t("Refresh")}>
                {tasksLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              </button>
            </div>
            <div className="client-task-list">
              {tasks.length === 0 ? (
                <div className="client-empty-state">
                  {tasksLoading ? <Loader2 className="spin" /> : <SquareTerminal />}
                  <span>{tasksLoading ? t("Loading tasks...") : t("No tasks in this channel")}</span>
                </div>
              ) : (
                tasks.map((task) => {
                  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
                  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
                  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus);
                  const taskChannel = channels.find((channel) => channel.id === task.channelId);
                  const taskChannelPaused = taskChannel?.status !== undefined && taskChannel.status !== "active";
                  const blockedByLease = activeLeaseCount > 0 && (!linkedRun || linkedRun.status !== "running");
                  return (
                    <article
                      key={task.id}
                      className={task.id === selectedTask?.id ? "client-task-card task-detail selected" : "client-task-card"}
                      aria-label={task.id === selectedTask?.id ? t("Task detail") : undefined}
                    >
                      {task.id === selectedTask?.id ? <span className="client-task-kicker">{t("Task detail")}</span> : null}
                      <button type="button" className="client-task-main" onClick={() => onSelectTask(task.id)}>
                        <span>
                          <strong>{task.title}</strong>
                          <small>{task.prompt}</small>
                        </span>
                        <span className={`task-status ${task.status}`}>{task.status}</span>
                      </button>
                      {task.currentRunId ? (
                        <div className="task-run-link compact">
                          <StatusBadge status={linkedRunStatus} />
                          <code>{task.currentRunId}</code>
                          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
                            <History size={14} />
                            {t("Open run")}
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
                      {taskChannelPaused || blockedByLease ? (
                        <div className="task-run-link compact">
                          <StatusBadge status={taskChannelPaused ? (taskChannel?.status ?? "blocked") : "blocked"} />
                          <span>{taskChannelPaused ? t("Channel is not active") : t("Active resource lock")}</span>
                        </div>
                      ) : null}
                      <div className="task-actions">
                        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={isRunning || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}>
                          {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                          {t("Check run")}
                        </button>
                        <button className="primary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={isRunning || Boolean(providerBlocker) || taskChannelPaused}>
                          {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                          {t("Run")}
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <section className="composer-panel" aria-label={t("New task")}>
            <div className="composer-head">
              <span>
                <MessageSquare size={16} />
                {t("New task")}
              </span>
              <label className="field run-provider-field">
                <span>{t("Run provider")}</span>
                <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading || providers.length === 0}>
                  <option value="">{t("Select provider preset")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </select>
              </label>
            </div>
            <input
              className="composer-title"
              value={taskForm.title}
              onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })}
              placeholder={t("Title")}
            />
            <textarea
              value={taskForm.prompt}
              rows={3}
              onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })}
              placeholder={t("Prompt")}
            />
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
              <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannelId || !taskForm.prompt.trim()}>
                <Send size={15} />
                {t("Create task")}
              </button>
            </div>
          </section>
        </section>

        <aside className="workspace-config-dock" aria-label={t("Workspace configuration")}>
          <div className="dock-card">
            <div className="dock-card-head">
              <Command size={16} />
              <strong>{t("Workspace")}</strong>
            </div>
            <label className="field wide">
              <span>{t("Workspace path")}</span>
              <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
            </label>
          </div>
          <div className="dock-card">
            <div className="dock-card-head">
              <Workflow size={16} />
              <strong>{t("Channels")}</strong>
              <button className="icon-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading} aria-label={t("Refresh")}>
                {channelsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              </button>
            </div>
            <div className="mini-channel-list">
              {channels.map((channel) => (
                <button key={channel.id} type="button" className={channel.id === selectedChannelId ? "mini-channel active" : "mini-channel"} onClick={() => onSelectChannel(channel.id)}>
                  <Hash size={13} />
                  <span>{channel.name}</span>
                  <small>{channel.status}</small>
                </button>
              ))}
              {channels.length === 0 ? (
                <button className="secondary-button compact-button full" type="button" onClick={onCreateDefaultChannel} disabled={channelsLoading || !readyProvider}>
                  <Plus size={14} />
                  {t("Create default")}
                </button>
              ) : null}
            </div>
            <details className="config-disclosure">
              <summary>{t("New channel")}</summary>
              <label className="field wide">
                <span>{t("Name")}</span>
                <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
              </label>
              <label className="field wide">
                <span>{t("Execution path")}</span>
                <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
              </label>
              <ChannelRuntimePolicyFields form={channelForm} onChange={onChannelFormChange} />
              <button className="secondary-button compact-button full" type="button" onClick={onCreateChannel}>
                <Plus size={14} />
                {t("Create channel")}
              </button>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MessageBubble({
  avatar,
  author,
  tag,
  time,
  body,
  action,
}: {
  readonly avatar: JSX.Element;
  readonly author: string;
  readonly tag?: string;
  readonly time: string;
  readonly body: string;
  readonly action?: JSX.Element;
}): JSX.Element {
  return (
    <article className="message-bubble">
      {avatar}
      <div className="message-content">
        <div className="message-meta">
          <strong>{author}</strong>
          {tag ? <small>{tag}</small> : null}
          <time>{time}</time>
        </div>
        <p>{body}</p>
        {action ? <div className="message-action">{action}</div> : null}
      </div>
    </article>
  );
}
