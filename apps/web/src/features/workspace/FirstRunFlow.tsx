import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  History,
  Loader2,
  Play,
  PlugZap,
  Plus,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { canUseProviderForRun, providerPreflightReady, providerRunPreflightBlocker } from "../../lib/providers.js";
import { buildRunRepairHint, displayLinkedRunStatus, readTaskTitle } from "../../lib/run-evidence.js";
import type { Channel, ProviderPreset, RunSession, Task } from "../../types.js";

interface FirstRunStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: "ready" | "attention" | "pending";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly secondaryActionLabel?: string;
  readonly onSecondaryAction?: () => void;
  readonly disabled?: boolean;
}

export function FirstRunFlow({
  providers,
  channels,
  selectedChannelId,
  tasks,
  selectedTaskId,
  taskRunProviderId,
  fallbackProviderId,
  providersLoading,
  channelsLoading,
  tasksLoading,
  isRunning,
  activeRunId,
  latestStatus,
  currentRun,
  runById,
  pendingApprovalCount,
  onOpenProviders,
  onOpenApprovals,
  onOpenRun,
  onCreateDefaultChannel,
  onSetChannelProvider,
  onCreateTask,
  onCheckThenRunTask,
  onRunTask,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
  readonly selectedTaskId: string;
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly providersLoading: boolean;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly isRunning: boolean;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly currentRun: RunSession | undefined;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly pendingApprovalCount: number;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onCreateDefaultChannel: () => void;
  readonly onSetChannelProvider: (channelId: string, providerId: string) => void;
  readonly onCreateTask: () => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const readyProvider = providers.find(providerPreflightReady);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const channelDefaultProvider = selectedChannel?.defaultProviderPresetId
    ? providers.find((provider) => provider.id === selectedChannel.defaultProviderPresetId)
    : undefined;
  const channelHasReadyDefault = Boolean(channelDefaultProvider && providerPreflightReady(channelDefaultProvider));
  const effectiveProviderId = taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id || "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const runReady = Boolean(selectedTask && effectiveProvider && providerRunPreflightBlocker(effectiveProvider) === undefined);
  const firstRunComplete = Boolean(readyProvider && selectedChannel && channelHasReadyDefault && selectedTask && runReady);
  const activeRun = activeRunId ? (currentRun?.id === activeRunId ? currentRun : runById.get(activeRunId)) : undefined;
  const selectedTaskRunId = selectedTask?.currentRunId ?? "";
  const selectedTaskRun = selectedTaskRunId ? runById.get(selectedTaskRunId) : undefined;
  const selectedTaskRunStatus = selectedTaskRunId ? displayLinkedRunStatus(selectedTaskRunId, selectedTaskRun, activeRunId, latestStatus) : "";

  if (activeRunId && isRunning) {
    return (
      <section className="first-run-flow panel active" aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            <Loader2 className="spin" size={17} />
	            <strong id="first-run-flow-title">{t("Run in progress")}</strong>
	          </span>
	          <small>
	            {activeRun ? readTaskTitle(activeRun.taskSnapshot) || activeRun.taskId : t("Active task")} is {latestStatus}. {activeRunId}
	          </small>
	        </div>
	        <div className="first-run-actions">
	          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(activeRunId)}>
	            <History size={14} />
	            {t("Open run")}
	          </button>
        </div>
      </section>
    );
  }

  if (selectedTask && selectedTaskRunId) {
    const repairHint = buildRunRepairHint(selectedTaskRun, pendingApprovalCount, selectedTaskRunStatus);
    const needsRepair = selectedTaskRunStatus === "failed" || selectedTaskRunStatus === "waiting_for_approval";
	    const runStatusClass = selectedTaskRunStatus === "succeeded" ? "ready" : needsRepair ? "attention" : "active";
	    const title = selectedTaskRunStatus === "succeeded"
	      ? t("Run loop complete")
	      : needsRepair
	        ? t("Run needs attention")
	        : t("Current run linked");
    const detail = repairHint
      ? `${selectedTask.title} latest run is ${selectedTaskRunStatus}. ${repairHint.detail}`
      : `${selectedTask.title} latest run is ${selectedTaskRunStatus}.${selectedTaskRun?.errorMessage ? ` ${selectedTaskRun.errorMessage}` : ""}`;
    const primaryAction = repairHint?.target ?? "run";

    return (
      <section className={`first-run-flow panel ${runStatusClass}`} aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            {selectedTaskRunStatus === "succeeded" ? <CheckCircle2 size={17} /> : needsRepair ? <CircleAlert size={17} /> : <History size={17} />}
            <strong id="first-run-flow-title">{title}</strong>
          </span>
          <small>{detail}</small>
        </div>
        <div className="first-run-actions">
          {primaryAction === "providers" ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenProviders(selectedTaskRun)}>
	              <PlugZap size={14} />
	              {repairHint?.actionLabel ?? t("Model Workbench")}
	            </button>
          ) : null}
          {primaryAction === "approvals" ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenApprovals(selectedTaskRunId)}>
	              <ShieldCheck size={14} />
	              {repairHint?.actionLabel ?? t("Approvals")}
	            </button>
          ) : null}
          <button className={primaryAction === "run" ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(selectedTaskRunId)}>
	            <History size={14} />
	            {primaryAction === "run" ? (repairHint?.actionLabel ?? t("Open run")) : t("Open run")}
	          </button>
          {selectedTaskRunStatus === "succeeded" ? (
            <button className="primary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning || !runReady}>
	              <Play size={14} />
	              {t("Run again")}
	            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (firstRunComplete && selectedTask && effectiveProvider) {
    return (
      <section className="first-run-flow panel ready" aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            <CheckCircle2 size={17} />
	            <strong id="first-run-flow-title">{t("First run ready")}</strong>
	          </span>
	          <small>
	            {t("{taskTitle} can run with {providerName}.", { taskTitle: selectedTask.title, providerName: effectiveProvider.displayName })}
	          </small>
        </div>
        <div className="first-run-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(selectedTask)} disabled={isRunning}>
	            {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
	            {t("Check run")}
	          </button>
          <button className="primary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning}>
	            {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
	            {t("Run")}
	          </button>
        </div>
      </section>
    );
  }

  const steps: readonly FirstRunStep[] = [
	    buildFirstRunProviderStep(readyProvider, providersLoading, () => onOpenProviders(), t),
	    buildFirstRunChannelStep(Boolean(selectedChannel), Boolean(readyProvider), channelsLoading, onCreateDefaultChannel, t),
	    buildFirstRunChannelProviderStep(selectedChannel, readyProvider, channelHasReadyDefault, onSetChannelProvider, t),
	    buildFirstRunTaskStep(Boolean(selectedChannel), tasks.length, tasksLoading, onCreateTask, t),
	    buildFirstRunRunStep(selectedTask, effectiveProvider, runReady, isRunning, onCheckThenRunTask, onRunTask, t),
	  ];

  return (
    <section className="first-run-flow panel" aria-labelledby="first-run-flow-title">
      <div className="panel-title split first-run-title">
        <span>
          <Play size={18} />
	          <h2 id="first-run-flow-title">{t("First run")}</h2>
	        </span>
	        <span className="event-count">{t("setup loop")}</span>
      </div>
      <div className="first-run-steps">
        {steps.map((step) => (
          <article key={step.id} className={`first-run-step ${step.status}`}>
            {firstRunStepIcon(step.status)}
            <span className="first-run-step-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="first-run-step-actions">
              {step.actionLabel && step.onAction ? (
                <button className="secondary-button compact-button" type="button" onClick={step.onAction} disabled={step.disabled}>
	                  {step.status === "pending" ? <Loader2 className="spin" size={14} /> : firstRunActionIcon(step)}
                  {step.actionLabel}
                </button>
              ) : null}
              {step.secondaryActionLabel && step.onSecondaryAction ? (
                <button className="primary-button compact-button" type="button" onClick={step.onSecondaryAction} disabled={step.disabled}>
                  {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  {step.secondaryActionLabel}
                </button>
              ) : null}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildFirstRunProviderStep(
  readyProvider: ProviderPreset | undefined,
  loading: boolean,
  onOpenProviders: () => void,
  t: Translate,
): FirstRunStep {
  if (loading) {
    return {
      id: "provider",
      label: t("Model Workbench"),
      detail: t("Loading model presets"),
      status: "pending",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
      disabled: true,
    };
  }
  if (!readyProvider) {
    return {
      id: "provider",
      label: t("Model Workbench"),
      detail: t("Create or repair a preflight-ready chat provider first."),
      status: "attention",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
    };
  }
  return {
    id: "provider",
    label: t("Model Workbench"),
    detail: t("{providerName} is preflight-ready.", { providerName: readyProvider.displayName }),
    status: "ready",
  };
}

function buildFirstRunChannelStep(
  hasChannel: boolean,
  hasReadyProvider: boolean,
  loading: boolean,
  onCreateDefaultChannel: () => void,
  t: Translate,
): FirstRunStep {
  if (loading) {
    return {
      id: "channel",
      label: t("Channel"),
      detail: t("Loading channels"),
      status: "pending",
      disabled: true,
    };
  }
  if (!hasChannel) {
    return {
      id: "channel",
      label: t("Channel"),
      detail: hasReadyProvider ? t("Create an Engineering channel with the ready provider as default.") : t("Create a channel after provider setup."),
      status: "attention",
      actionLabel: t("Create default"),
      onAction: onCreateDefaultChannel,
      disabled: !hasReadyProvider,
    };
  }
  return {
    id: "channel",
    label: t("Channel"),
    detail: t("A channel is selected."),
    status: "ready",
  };
}

function buildFirstRunChannelProviderStep(
  channel: Channel | undefined,
  readyProvider: ProviderPreset | undefined,
  channelHasReadyDefault: boolean,
  onSetChannelProvider: (channelId: string, providerId: string) => void,
  t: Translate,
): FirstRunStep {
  if (!channel) {
    return {
      id: "channel-provider",
      label: t("Channel provider"),
      detail: t("Create or select a channel first."),
      status: "pending",
    };
  }
  if (channelHasReadyDefault) {
    return {
      id: "channel-provider",
      label: t("Channel provider"),
      detail: t("Selected channel has a preflight-ready default provider."),
      status: "ready",
    };
  }
  return {
    id: "channel-provider",
    label: t("Channel provider"),
    detail: readyProvider ? t("Set {providerName} as the channel default.", { providerName: readyProvider.displayName }) : t("Repair a provider before setting the channel default."),
    status: "attention",
    actionLabel: t("Set provider"),
    onAction: readyProvider ? () => onSetChannelProvider(channel.id, readyProvider.id) : undefined,
    disabled: !readyProvider,
  };
}

function buildFirstRunTaskStep(
  hasChannel: boolean,
  taskCount: number,
  loading: boolean,
  onCreateTask: () => void,
  t: Translate,
): FirstRunStep {
  if (loading) {
    return {
      id: "task",
      label: t("Task"),
      detail: t("Loading selected channel tasks"),
      status: "pending",
    };
  }
  if (taskCount === 0) {
    return {
      id: "task",
      label: t("Task"),
      detail: hasChannel ? t("Create the first task from the default prompt.") : t("Create a channel first."),
      status: "attention",
      actionLabel: t("Create first task"),
      onAction: hasChannel ? onCreateTask : undefined,
      disabled: !hasChannel,
    };
  }
  return {
    id: "task",
    label: t("Task"),
    detail: t(taskCount === 1 ? "{count} task available." : "{count} tasks available.", { count: taskCount }),
    status: "ready",
  };
}

function buildFirstRunRunStep(
  task: Task | undefined,
  provider: ProviderPreset | undefined,
  runReady: boolean,
  isRunning: boolean,
  onCheckThenRunTask: (task: Task) => void,
  onRunTask: (task: Task) => void,
  t: Translate,
): FirstRunStep {
  if (!task) {
    return {
      id: "run",
      label: t("Run"),
      detail: t("Create a task first."),
      status: "pending",
    };
  }
  if (!provider) {
    return {
      id: "run",
      label: t("Run"),
      detail: t("Select or set a provider before running."),
      status: "attention",
    };
  }
  if (!runReady) {
    return {
      id: "run",
      label: t("Run"),
      detail: providerRunPreflightBlocker(provider) ?? t("Provider is not ready."),
      status: "attention",
      actionLabel: t("Check run"),
      onAction: () => onCheckThenRunTask(task),
      disabled: isRunning || !canUseProviderForRun(provider),
    };
  }
  return {
    id: "run",
    label: t("Run"),
    detail: t("Task and provider are ready."),
    status: "ready",
    actionLabel: t("Check run"),
    onAction: () => onCheckThenRunTask(task),
    secondaryActionLabel: t("Run"),
    onSecondaryAction: () => onRunTask(task),
    disabled: isRunning,
  };
}

function firstRunStepIcon(status: FirstRunStep["status"]): JSX.Element {
  if (status === "ready") {
    return <CheckCircle2 size={17} />;
  }
  if (status === "pending") {
    return <Clock3 size={17} />;
  }
  return <CircleAlert size={17} />;
}

function firstRunActionIcon(step: FirstRunStep): JSX.Element {
  if (step.id === "provider" || step.id === "channel-provider") {
    return <PlugZap size={14} />;
  }
  if (step.id === "channel" || step.id === "task") {
    return <Plus size={14} />;
  }
  if (step.id === "run") {
    return <CheckCircle2 size={14} />;
  }
  return <Save size={14} />;
}
