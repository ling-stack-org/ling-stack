import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  SquareTerminal,
  Trash2,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveChannelRuntimePolicy } from "../../lib/channels.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus, readTaskTitle } from "../../lib/run-evidence.js";
import { allTools, riskyTools, taskStatuses } from "../../lib/tools.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  taskProviderReadinessGuidance,
  taskProviderReadinessMessage,
} from "../../lib/providers.js";
import { MetaRow, RunRepairHintBanner, StatusBadge } from "../../shared/components/index.js";
import type {
  Channel,
  ChannelFormState,
  ProviderPreset,
  RunSession,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskRunActionState,
  TaskStatus,
} from "../../types.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

export function ChannelTaskWorkspace({
  cwd,
  channels,
  selectedChannelId,
  channelForm,
  channelEditForm,
  tasks,
  taskForm,
  selectedTaskId,
  taskEditForm,
  providers,
  taskRunProviderId,
  fallbackProviderId,
  channelsLoading,
  tasksLoading,
  isRunning,
  activeTaskRunAction,
  activeRunId,
  latestStatus,
  runById,
  repairRun,
  errorMessage,
  onCwdChange,
  onChannelFormChange,
  onChannelEditFormChange,
  onTaskFormChange,
  onTaskEditFormChange,
  onProviderSelect,
  onSelectChannel,
  onCreateChannel,
  onSaveChannelEdit,
  onDeleteChannel,
  onRefreshChannels,
  onCreateTask,
  onRefreshTasks,
  onSelectTask,
  onSaveTaskEdit,
  onRunTask,
  onCheckThenRunTask,
  onRunUpdatedTask,
  onCheckThenRunUpdatedTask,
  onReviewTask,
  onDeleteTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly channelEditForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly selectedTaskId: string;
  readonly taskEditForm: TaskEditFormState;
  readonly providers: readonly ProviderPreset[];
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly repairRun: RunSession | undefined;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onTaskEditFormChange: (form: TaskEditFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onCreateChannel: () => void;
  readonly onSaveChannelEdit: (channelId: string) => void;
  readonly onDeleteChannel: (channelId: string) => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateTask: () => void;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onSaveTaskEdit: (taskId: string) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunUpdatedTask: (task: Task) => void;
  readonly onCheckThenRunUpdatedTask: (task: Task) => void;
  readonly onReviewTask: (taskId: string) => void;
  readonly onDeleteTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedChannelRuntimePolicy = effectiveChannelRuntimePolicy(selectedChannel);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedTaskRun = selectedTask?.currentRunId ? runById.get(selectedTask.currentRunId) : undefined;
  const selectedTaskRunStatus = selectedTask?.currentRunId
    ? displayLinkedRunStatus(selectedTask.currentRunId, selectedTaskRun, activeRunId, latestStatus)
    : "";
  const selectedTaskRunSucceeded = selectedTaskRunStatus === "succeeded";
  const selectedTaskRepairHint = buildRunRepairHint(selectedTaskRun, 0, selectedTaskRunStatus);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId) ?? "";
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const canRunWithEffectiveProvider = Boolean(effectiveProvider && canUseProviderForRun(effectiveProvider));
  const effectiveProviderPreflightBlocker = providerRunPreflightBlocker(effectiveProvider);
  const canPreflightRunWithEffectiveProvider = Boolean(effectiveProvider && canRunWithEffectiveProvider && effectiveProviderPreflightBlocker === undefined);
  const selectedTaskRepairRun = selectedTask && repairRun?.taskId === selectedTask.id && repairRun.channelId === selectedTask.channelId
    ? repairRun
    : undefined;
  const taskActionPending = activeTaskRunAction !== undefined;
  const selectedCheckLoading = selectedTask ? activeTaskRunAction?.taskId === selectedTask.id && activeTaskRunAction.action === "check" : false;
  const selectedRunLoading = selectedTask ? activeTaskRunAction?.taskId === selectedTask.id && activeTaskRunAction.action === "run" : false;

  return (
    <div className="task-workspace">
      <section className="panel channel-panel" aria-labelledby="channels-title">
        <div className="panel-title split">
          <span>
            <Workflow size={18} />
            <h2 id="channels-title">{t("Channels")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
            {channelsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        <label className="field wide">
          <span>{t("Workspace path")}</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="channel-list">
          {channels.length === 0 ? (
            <div className="empty-state compact-empty">
              {channelsLoading ? <Loader2 className="spin" /> : <Workflow />}
              <span>{channelsLoading ? t("Loading channels...") : t("No channels yet")}</span>
            </div>
          ) : (
            channels.map((channel) => {
              const runtimePolicy = effectiveChannelRuntimePolicy(channel);
              return (
                <button
                  key={channel.id}
                  className={channel.id === selectedChannelId ? "channel-row selected" : "channel-row"}
                  type="button"
                  onClick={() => onSelectChannel(channel.id)}
                >
                  <span className="channel-row-main">
                    <strong>{channel.name}</strong>
                    <small>{channel.status} · {runtimePolicy.executionMode} · {t("Execution")}: {channel.boundPath ?? cwd}</small>
                  </span>
                  <span className="channel-tools">{channel.allowedTools.join(", ")}</span>
                </button>
              );
            })
          )}
        </div>

        {selectedChannel ? (
          <div className="channel-detail" aria-label={t("Channel detail")}>
            <div className="panel-title tight split">
              <span>
                <Pencil size={16} />
                <h3>{t("Channel detail")}</h3>
              </span>
              <span className="event-count">{selectedChannel.allowedTools.length} tools</span>
            </div>
            <div className="channel-detail-meta">
              <MetaRow label={t("Channel id")} value={selectedChannel.id} compact />
              <MetaRow label={t("Status")} value={selectedChannel.status} compact />
              <MetaRow label={t("Runtime policy")} value={`${selectedChannelRuntimePolicy.executionMode} · ${selectedChannelRuntimePolicy.writeLockScope}`} compact />
	              <MetaRow label={t("Workspace path")} value={cwd} compact />
	              <MetaRow label={t("Execution path")} value={selectedChannel.boundPath ?? cwd} compact />
	            </div>
	            <label className="field wide">
	              <span>{t("Name")}</span>
              <input value={channelEditForm.name} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, name: event.target.value })} />
            </label>
	            <label className="field wide">
	              <span>{t("Execution path")}</span>
              <input
                value={channelEditForm.boundPath}
                onChange={(event) => onChannelEditFormChange({ ...channelEditForm, boundPath: event.target.value })}
              />
            </label>
            <ChannelRuntimePolicyFields form={channelEditForm} onChange={onChannelEditFormChange} />
	            <label className="field wide">
	              <span>{t("Default provider")}</span>
              <select
                value={channelEditForm.defaultProviderPresetId}
                onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })}
              >
	                <option value="">{t("None")}</option>
                <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
              </select>
            </label>
            {mediaProviders.length > 0 ? (
              <div className="provider-run-notice neutral">
                <Database size={16} />
                <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
              </div>
            ) : null}
            <div className="tool-grid compact-tools" aria-label="Channel detail allowed tools">
              {allTools.map((tool) => (
                <label
                  key={tool}
                  className={`${channelEditForm.allowedTools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}${riskyTools.includes(tool) ? " requires-approval" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={channelEditForm.allowedTools.includes(tool)}
                    onChange={(event) => {
                      const allowedTools = event.target.checked
                        ? [...channelEditForm.allowedTools, tool]
                        : channelEditForm.allowedTools.filter((item) => item !== tool);
                      onChannelEditFormChange({ ...channelEditForm, allowedTools });
                    }}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
	            <button className="primary-button full" type="button" onClick={() => onSaveChannelEdit(selectedChannel.id)}>
	              <Save size={16} />
	              {t("Save channel")}
	            </button>
          </div>
        ) : null}

        <div className="channel-create">
          <div className="panel-title tight">
            <Plus size={16} />
	            <h3>{t("New channel")}</h3>
          </div>
          <label className="field wide">
	            <span>{t("Name")}</span>
            <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
          </label>
          <label className="field wide">
	            <span>{t("Execution path")}</span>
            <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
          </label>
          <ChannelRuntimePolicyFields form={channelForm} onChange={onChannelFormChange} />
          <label className="field wide">
	            <span>{t("Default provider")}</span>
            <select
              value={channelForm.defaultProviderPresetId}
              onChange={(event) => onChannelFormChange({ ...channelForm, defaultProviderPresetId: event.target.value })}
            >
	              <option value="">{t("None")}</option>
              <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
            </select>
          </label>
          {mediaProviders.length > 0 ? (
            <div className="provider-run-notice neutral">
              <Database size={16} />
              <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
            </div>
          ) : null}
          <div className="tool-grid compact-tools" aria-label="Channel allowed tools">
            {allTools.map((tool) => (
              <label
                key={tool}
                className={`${channelForm.allowedTools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}${riskyTools.includes(tool) ? " requires-approval" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={channelForm.allowedTools.includes(tool)}
                  onChange={(event) => {
                    const allowedTools = event.target.checked
                      ? [...channelForm.allowedTools, tool]
                      : channelForm.allowedTools.filter((item) => item !== tool);
                    onChannelFormChange({ ...channelForm, allowedTools });
                  }}
                />
                <span>{tool}</span>
              </label>
            ))}
          </div>
	          <button className="primary-button full" type="button" onClick={onCreateChannel}>
	            <Plus size={16} />
	            {t("Create channel")}
	          </button>
        </div>
      </section>

      <section className="panel task-panel" aria-labelledby="tasks-title">
        <div className="panel-title split">
          <span>
            <SquareTerminal size={18} />
	            <h2 id="tasks-title">{t("Tasks")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshTasks} disabled={!selectedChannelId || tasksLoading}>
            {tasksLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
	            {t("Refresh")}
          </button>
        </div>

        <div className="selected-channel-strip">
          <div>
	            <span>{t("Channel")}</span>
	            <strong>{selectedChannel?.name ?? t("None selected")}</strong>
          </div>
          {selectedChannel ? (
            <button className="secondary-button compact-button danger" type="button" onClick={() => onDeleteChannel(selectedChannel.id)}>
	              <Trash2 size={14} />
	              {t("Delete")}
	            </button>
          ) : null}
        </div>

        <label className="field wide">
	          <span>{t("Run provider")}</span>
          <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providers.length === 0}>
	            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </select>
        </label>
        {providers.length === 0 || taskReadyProviders.length === 0 || !effectiveProvider || effectiveProviderPreflightBlocker ? (
          <div className={canPreflightRunWithEffectiveProvider ? "provider-run-notice ok" : "provider-run-notice"}>
            {canPreflightRunWithEffectiveProvider ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span>
              {providers.length === 0
	                ? t("No saved provider presets. Create one from GPT, Claude, relay, or domestic templates.")
	                : taskReadyProviders.length === 0
	                  ? t("No ready coding provider. Open Model Workbench, repair secret/base URL/model, then run Check.")
	                  : effectiveProvider
	                    ? (effectiveProviderPreflightBlocker ?? `${effectiveProvider.displayName}: ${providerRunBlockerLabel(effectiveProvider)}.`)
	                    : t("Select a provider preset before running tasks.")}
	            </span>
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenProviders()}>
	              {t("Model Workbench")}
            </button>
          </div>
        ) : null}
        {mediaProviders.length > 0 ? (
          <div className="provider-run-notice neutral">
            <Database size={16} />
            <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
          </div>
        ) : null}

        <div className="task-create">
          <label className="field wide">
	            <span>{t("Title")}</span>
            <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
          </label>
          <label className="field wide">
	            <span>{t("Prompt")}</span>
            <textarea value={taskForm.prompt} rows={5} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
          </label>
          <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannelId}>
	            <Plus size={16} />
	            {t("Create task")}
          </button>
        </div>

        {selectedTask ? (
	          <div className="task-detail" aria-label={t("Task detail")}>
            <div className="panel-title tight split">
              <span>
                <Pencil size={16} />
	                <h3>{t("Task detail")}</h3>
              </span>
              <span className={`task-status ${selectedTask.status}`}>{selectedTask.status}</span>
            </div>
            <div className="task-detail-meta">
	              <MetaRow label={t("Task id")} value={selectedTask.id} compact />
	              <MetaRow label={t("Channel")} value={selectedTask.channelId} compact />
	              <MetaRow label={t("Current run")} value={selectedTask.currentRunId ?? "-"} compact />
            </div>
            {selectedTask.currentRunId ? (
              <div className={selectedTaskRunSucceeded ? "task-run-link succeeded" : "task-run-link"}>
                <StatusBadge status={selectedTaskRunStatus} />
                <span className="task-run-summary">
                  {selectedTaskRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
                  <code>{selectedTask.currentRunId}</code>
                </span>
                <button className={selectedTaskRunSucceeded ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(selectedTask.currentRunId ?? "")}>
	                  {selectedTaskRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
	                  {selectedTaskRunSucceeded ? t("View result") : t("Open run")}
                </button>
              </div>
            ) : null}
            {selectedTask.currentRunId && selectedTaskRepairHint ? (
              <RunRepairHintBanner
                hint={selectedTaskRepairHint}
                runId={selectedTask.currentRunId}
                compact
                onOpenProviders={() => onOpenProviders(selectedTaskRun)}
                onOpenApprovals={onOpenApprovals}
                onOpenRun={onOpenRun}
              />
            ) : null}
            {selectedTaskRepairRun ? (
              <TaskRepairHandoffPanel
                task={selectedTask}
                run={selectedTaskRepairRun}
                isRunning={isRunning}
                activeTaskRunAction={activeTaskRunAction}
                canRun={canPreflightRunWithEffectiveProvider}
                canCheckRun={canRunWithEffectiveProvider}
                onRunUpdatedTask={onRunUpdatedTask}
                onCheckThenRunUpdatedTask={onCheckThenRunUpdatedTask}
                onOpenRun={onOpenRun}
                onClear={onClearRepair}
              />
            ) : null}
            <label className="field wide">
              <span>{t("Title")}</span>
              <input value={taskEditForm.title} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, title: event.target.value })} />
            </label>
            <label className="field wide">
              <span>{t("Status")}</span>
              <select value={taskEditForm.status} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, status: event.target.value as TaskStatus })}>
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="field wide">
              <span>{t("Prompt")}</span>
              <textarea value={taskEditForm.prompt} rows={7} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, prompt: event.target.value })} />
            </label>
            <TaskProviderReadiness provider={effectiveProvider} onOpenProviders={() => onOpenProviders()} />
            <div className="task-actions">
              <button className="primary-button" type="button" onClick={() => onSaveTaskEdit(selectedTask.id)}>
                <Save size={16} />
                {t("Save task")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(selectedTask)} disabled={isRunning || taskActionPending || !canRunWithEffectiveProvider}>
                {selectedCheckLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                {t("Check run")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning || taskActionPending || !canPreflightRunWithEffectiveProvider}>
                {selectedRunLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                {t("Run")}
              </button>
            </div>
          </div>
        ) : null}

        <div className="task-list">
          {tasks.length === 0 ? (
            <div className="empty-state compact-empty">
              {tasksLoading ? <Loader2 className="spin" /> : <Clock3 />}
              <span>{tasksLoading ? t("Loading tasks...") : t("No tasks in this channel")}</span>
            </div>
          ) : (
            tasks.map((task) => {
              const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
              const linkedRunStatus = task.currentRunId
                ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus)
                : "";
              const linkedRunSucceeded = linkedRunStatus === "succeeded";
              const repairHint = buildRunRepairHint(linkedRun, 0, linkedRunStatus);
              const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
              const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
              const taskActionsDisabled = isRunning || taskActionPending;
              return (
                <article key={task.id} className={task.id === selectedTaskId ? "task-row selected" : "task-row"}>
                  <div className="task-row-head">
                    <strong>{task.title}</strong>
                    <span className={`task-status ${task.status}`}>{task.status}</span>
                  </div>
                  <p>{task.prompt}</p>
                  <div className="provider-meta-line mono">
                    <span>{task.id}</span>
                    <time>{formatDateTime(task.updatedAt)}</time>
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
                  <div className="task-actions">
                    <button className="secondary-button compact-button" type="button" onClick={() => onSelectTask(task.id)}>
	                      <Pencil size={14} />
	                      {t("Edit")}
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={taskActionsDisabled || !canRunWithEffectiveProvider}>
                      {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
	                      {t("Check run")}
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={taskActionsDisabled || !canPreflightRunWithEffectiveProvider}>
                      {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
	                      {t("Run")}
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onReviewTask(task.id)} disabled={task.status === "review"}>
	                      <CheckCircle2 size={14} />
	                      {t("Review")}
                    </button>
                    <button className="secondary-button compact-button danger" type="button" onClick={() => onDeleteTask(task.id)}>
	                      <Trash2 size={14} />
	                      {t("Delete")}
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function TaskRepairHandoffPanel({
  task,
  run,
  isRunning,
  activeTaskRunAction,
  canRun,
  canCheckRun,
  onRunUpdatedTask,
  onCheckThenRunUpdatedTask,
  onOpenRun,
  onClear,
}: {
  readonly task: Task;
  readonly run: RunSession;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly canRun: boolean;
  readonly canCheckRun: boolean;
  readonly onRunUpdatedTask: (task: Task) => void;
  readonly onCheckThenRunUpdatedTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const snapshotTitle = readTaskTitle(run.taskSnapshot) || run.taskId;
  const failedReason = run.errorMessage || "This run failed before completing.";
  const taskActionPending = activeTaskRunAction !== undefined;
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";

  return (
    <div className="task-repair-handoff" aria-label="Task repair handoff">
      <div className="task-repair-handoff-head">
        <span>
          <SquareTerminal size={16} />
          <strong>Run updated task</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="task-repair-handoff-copy">
        <span>
          Editing <code>{task.id}</code> to repair failed run <code>{run.id}</code>.
        </span>
        <small>Failed snapshot: {snapshotTitle}. {failedReason}</small>
        <small>Rerun snapshot replays the old request. Save + run updated task uses the current task editor values.</small>
      </div>
      <div className="task-repair-handoff-actions">
        <button className="primary-button compact-button" type="button" onClick={() => onRunUpdatedTask(task)} disabled={isRunning || taskActionPending || !canRun}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          Save + run updated task
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunUpdatedTask(task)} disabled={isRunning || taskActionPending || !canCheckRun}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          Save + check run
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          Open failed run
        </button>
      </div>
    </div>
  );
}

function TaskProviderReadiness({
  provider,
  onOpenProviders,
}: {
  readonly provider: ProviderPreset | undefined;
  readonly onOpenProviders: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const blocker = providerRunPreflightBlocker(provider);
  const ready = Boolean(provider && !blocker);
  const lastCheck = provider?.lastCheck;
  const checkedAt = lastCheck ? formatDateTime(lastCheck.checkedAt) : t("not checked");

  return (
    <div className={ready ? "task-provider-readiness ok" : "task-provider-readiness"}>
      {ready ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
      <div className="task-provider-readiness-copy">
        <div className="task-provider-readiness-head">
	          <strong>{ready ? t("Provider ready") : t("Provider needs attention")}</strong>
          <span className={provider ? providerLastCheckClass(provider) : "provider-state check-unknown"}>
	            {provider ? providerLastCheckLabel(provider) : t("no provider")}
          </span>
        </div>
        <p>{taskProviderReadinessMessage(provider, blocker)}</p>
        <div className="task-provider-readiness-meta">
	          <MetaRow label={t("Provider")} value={provider ? provider.displayName : "-"} compact />
	          <MetaRow label={t("Model")} value={provider ? provider.model : "-"} compact />
	          <MetaRow label={t("Checked")} value={checkedAt} compact />
        </div>
        {lastCheck && !lastCheck.ok ? <small>{lastCheck.message}</small> : null}
        <small>{taskProviderReadinessGuidance(provider)}</small>
      </div>
      <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
	        {t("Model Workbench")}
      </button>
    </div>
  );
}
