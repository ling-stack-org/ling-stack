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
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus, readTaskTitle } from "../../lib/run-evidence.js";
import { allTools, riskyTools, taskStatuses } from "../../lib/tools.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerCheckMessage,
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

import { SelectControl } from "../../shared/components/SelectControl.js";

export function ChannelTaskWorkspace({
  cwd,
  channels,
  selectedChannelId,
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
  onChannelEditFormChange,
  onTaskFormChange,
  onTaskEditFormChange,
  onProviderSelect,
  onSelectChannel,
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
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onTaskEditFormChange: (form: TaskEditFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onSelectChannel: (channelId: string) => void;
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
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedTaskRun = selectedTask?.currentRunId ? runById.get(selectedTask.currentRunId) : undefined;
  const selectedTaskRunStatus = selectedTask?.currentRunId
    ? displayLinkedRunStatus(selectedTask.currentRunId, selectedTaskRun, activeRunId, latestStatus)
    : "";
  const selectedTaskRunSucceeded = selectedTaskRunStatus === "succeeded";
  const selectedTaskRepairHint = buildRunRepairHint(selectedTaskRun, 0, selectedTaskRunStatus, "", t);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId) ?? "";
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const canRunWithEffectiveProvider = Boolean(effectiveProvider && canUseProviderForRun(effectiveProvider));
  const effectiveProviderPreflightBlocker = providerRunPreflightBlocker(effectiveProvider, t);
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
              return (
                <button
                  key={channel.id}
                  className={channel.id === selectedChannelId ? "channel-row selected" : "channel-row"}
                  type="button"
                  onClick={() => onSelectChannel(channel.id)}
                >
                  <span className="channel-row-main">
                    <strong>{channel.name}</strong>
                    <small>{t(channel.status)}</small>
                  </span>
                  <span className="channel-tools">{t("{count} tools", { count: channel.allowedTools.length })}</span>
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
              <span className="event-count">{t("{count} tools", { count: selectedChannel.allowedTools.length })}</span>
            </div>
            <div className="channel-detail-meta">
              <MetaRow label={t("Status")} value={t(selectedChannel.status)} compact />
              <MetaRow label={t("Default provider")} value={providers.find((provider) => provider.id === selectedChannel.defaultProviderPresetId)?.displayName ?? t("None")} compact />
	            </div>
	            <label className="field wide">
	              <span>{t("Name")}</span>
              <input value={channelEditForm.name} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, name: event.target.value })} />
            </label>
            <details className="advanced-settings">
              <summary>{t("Advanced settings")}</summary>
              <ChannelRuntimePolicyFields form={channelEditForm} onChange={onChannelEditFormChange} />
	              <label className="field wide">
	                <span>{t("Default provider")}</span>
                <SelectControl
                  value={channelEditForm.defaultProviderPresetId}
                  onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })}
                >
	                  <option value="">{t("None")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </SelectControl>
              </label>
              {mediaProviders.length > 0 ? (
                <div className="provider-run-notice neutral">
                  <Database size={16} />
                  <span>{t("Generation-only models cannot run coding tasks.")}</span>
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
            </details>
	            <button className="primary-button full" type="button" onClick={() => onSaveChannelEdit(selectedChannel.id)}>
	              <Save size={16} />
	              {t("Save channel")}
	            </button>
          </div>
        ) : null}

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
          <SelectControl value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providers.length === 0}>
	            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </SelectControl>
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
	                    ? (effectiveProviderPreflightBlocker ?? t("{providerName}: {reason}.", { providerName: effectiveProvider.displayName, reason: providerRunBlockerLabel(effectiveProvider, t) }))
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
            <span>{t("Generation-only models cannot run coding tasks.")}</span>
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
              <span className={`task-status ${selectedTask.status}`}>{t(selectedTask.status)}</span>
            </div>
            {selectedTask.currentRunId ? (
              <div className={selectedTaskRunSucceeded ? "task-run-link succeeded" : "task-run-link"}>
                <StatusBadge status={selectedTaskRunStatus} />
                <span className="task-run-summary">
                  {selectedTaskRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
                  <span>{t("Latest run")}</span>
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
            {selectedTask.requestedSkillId ? (
              <div className="task-run-link compact">
                <StatusBadge status="skill" />
                <span>{t("Requested skill")}: {selectedTask.requestedSkillId}</span>
              </div>
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
              <SelectControl value={taskEditForm.status} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, status: event.target.value as TaskStatus })}>
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {t(status)}
                  </option>
                ))}
              </SelectControl>
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
                {t("Check & run")}
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
              const repairHint = buildRunRepairHint(linkedRun, 0, linkedRunStatus, "", t);
              const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
              const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
              const taskActionsDisabled = isRunning || taskActionPending;
              return (
                <article key={task.id} className={task.id === selectedTaskId ? "task-row selected" : "task-row"}>
                  <div className="task-row-head">
                    <strong>{task.title}</strong>
                    <span className={`task-status ${task.status}`}>{t(task.status)}</span>
                  </div>
                  <p>{task.prompt}</p>
                  <div className="provider-meta-line">
                    <time>{formatDateTime(task.updatedAt)}</time>
                  </div>
                  {task.currentRunId ? (
                    <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
                      <StatusBadge status={linkedRunStatus} />
                      <span className="task-run-summary">
                        {linkedRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
                        <span>{t("Latest run")}</span>
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
	                      {t("Check & run")}
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
  const { t } = useI18n();
  const snapshotTitle = readTaskTitle(run.taskSnapshot) || run.taskId;
  const failedReason = run.errorMessage || t("This run failed before completing.");
  const taskActionPending = activeTaskRunAction !== undefined;
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";

  return (
    <div className="task-repair-handoff" aria-label="Task repair handoff">
      <div className="task-repair-handoff-head">
        <span>
          <SquareTerminal size={16} />
          <strong>{t("Run updated task")}</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          {t("Clear")}
        </button>
      </div>
      <div className="task-repair-handoff-copy">
        <span>{t("Edit this task to repair the failed run.")}</span>
        <small>{t("Failed snapshot: {title}. {reason}", { title: snapshotTitle, reason: failedReason })}</small>
        <small>{t("Save and run uses the current task editor values.")}</small>
      </div>
      <div className="task-repair-handoff-actions">
        <button className="primary-button compact-button" type="button" onClick={() => onRunUpdatedTask(task)} disabled={isRunning || taskActionPending || !canRun}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Save and run")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunUpdatedTask(task)} disabled={isRunning || taskActionPending || !canCheckRun}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Save and check")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          {t("Open failed run")}
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
  const blocker = providerRunPreflightBlocker(provider, t);
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
		            {provider ? providerLastCheckLabel(provider, t) : t("no provider")}
          </span>
        </div>
        <p>{taskProviderReadinessMessage(provider, blocker, t)}</p>
        <div className="task-provider-readiness-meta">
	          <MetaRow label={t("Provider")} value={provider ? provider.displayName : "-"} compact />
	          <MetaRow label={t("Model")} value={provider ? provider.model : "-"} compact />
	          <MetaRow label={t("Checked")} value={checkedAt} compact />
        </div>
        {lastCheck && !lastCheck.ok ? <small>{providerCheckMessage(lastCheck, t)}</small> : null}
        <small>{taskProviderReadinessGuidance(provider, t)}</small>
      </div>
      <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
	        {t("Model Workbench")}
      </button>
    </div>
  );
}
