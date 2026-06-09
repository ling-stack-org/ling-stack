import type { ReactNode } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  History,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { truncatePreview } from "../../lib/data.js";
import { canUseProviderForRun, providerRunPreflightBlocker } from "../../lib/providers.js";
import { StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ProviderPreset,
  ResourceLease,
  RunSession,
  StateTransitionEvent,
  Task,
} from "../../types.js";

interface WorkspaceReadinessItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: "ready" | "attention" | "loading" | "info";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly disabled?: boolean;
}

export function WorkspaceContextPanel({
  daemonHealthy,
  providers,
  channels,
  tasks,
  providersLoading,
  channelsLoading,
  tasksLoading,
  runsLoading,
  succeededRunCount,
  runs,
  approvals,
  resourceLeases,
  stateTransitions,
  onRefreshDaemon,
  onOpenProviders,
  onOpenRuns,
  onOpenApprovals,
  onCreateChannel,
  onCreateTask,
  children,
}: {
  readonly daemonHealthy: boolean | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly providersLoading: boolean;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly runsLoading: boolean;
  readonly succeededRunCount: number;
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly onRefreshDaemon: () => void;
  readonly onOpenProviders: () => void;
  readonly onOpenRuns: () => void;
  readonly onOpenApprovals: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="workspace-context-stack">
      <section className="context-panel-card" aria-label={t("Run context")}>
        <div className="panel-title tight">
          <Users size={16} />
          <h2>{t("Context")}</h2>
        </div>
        <WorkspaceReadiness
          daemonHealthy={daemonHealthy}
          providers={providers}
          channels={channels}
          tasks={tasks}
          providersLoading={providersLoading}
          channelsLoading={channelsLoading}
          tasksLoading={tasksLoading}
          runsLoading={runsLoading}
          succeededRunCount={succeededRunCount}
          runs={runs}
          approvals={approvals}
          onRefreshDaemon={onRefreshDaemon}
          onOpenProviders={onOpenProviders}
          onOpenRuns={onOpenRuns}
          onOpenApprovals={onOpenApprovals}
          onCreateChannel={onCreateChannel}
          onCreateTask={onCreateTask}
        />
      </section>
      {children}
    </div>
  );
}

export function RuntimeStatePanel({
  runs,
  approvals,
  resourceLeases,
  stateTransitions,
}: {
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
}): JSX.Element {
  const { t } = useI18n();
  const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval");
  const recentTransitions = stateTransitions.slice(0, 5);

  return (
    <section className="context-panel-card runtime-state-panel" aria-label={t("Runtime state")}>
      <div className="panel-title tight split">
        <span>
          <Activity size={16} />
          <h2>{t("Runtime state")}</h2>
        </span>
        <span className={resourceLeases.length > 0 ? "readiness-summary attention" : "readiness-summary ok"}>
          {resourceLeases.length > 0 ? t("{count} leases", { count: resourceLeases.length }) : t("No active locks")}
        </span>
      </div>
      <div className="runtime-kpi-grid">
        <div>
          <span>{t("Active runs")}</span>
          <strong>{activeRuns.length}</strong>
        </div>
        <div>
          <span>{t("Pending approvals")}</span>
          <strong>{approvals.length}</strong>
        </div>
      </div>
      {resourceLeases.length > 0 ? (
        <div className="runtime-list">
          {resourceLeases.slice(0, 4).map((lease) => (
            <div key={lease.id} className="runtime-list-row">
              <StatusBadge status={lease.resourceType} />
              <span>{truncatePreview(lease.resourceKey, 34)}</span>
              <small>{lease.ownerId}</small>
            </div>
          ))}
        </div>
      ) : null}
      {recentTransitions.length > 0 ? (
        <div className="runtime-list transition-list">
          {recentTransitions.map((transition) => (
            <div key={transition.id} className="runtime-list-row">
              <StatusBadge status={transition.entityType} />
              <span>{transition.event}: {transition.fromStatus} -&gt; {transition.toStatus}</span>
              <small>{transition.actor}</small>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceReadiness({
  daemonHealthy,
  providers,
  channels,
  tasks,
  providersLoading,
  channelsLoading,
  tasksLoading,
  runsLoading,
  succeededRunCount,
  runs,
  approvals,
  onRefreshDaemon,
  onOpenProviders,
  onOpenRuns,
  onOpenApprovals,
  onCreateChannel,
  onCreateTask,
}: {
  readonly daemonHealthy: boolean | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly providersLoading: boolean;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly runsLoading: boolean;
  readonly succeededRunCount: number;
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly onRefreshDaemon: () => void;
  readonly onOpenProviders: () => void;
  readonly onOpenRuns: () => void;
  readonly onOpenApprovals: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const runnableProviderCount = providers.filter(canUseProviderForRun).length;
  const readyProviderCount = providers.filter((provider) => providerRunPreflightBlocker(provider) === undefined).length;
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const expiredApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "expired").length;
  const latestFailedRun = runs.find((item) => item.status === "failed");
  const providerItem = buildProviderReadinessItem(providers.length, runnableProviderCount, readyProviderCount, providersLoading, onOpenProviders, t);
  const channelItem = buildChannelReadinessItem(channels.length, channelsLoading, onCreateChannel, t);
  const taskItem = buildTaskReadinessItem(tasks.length, tasksLoading, channels.length > 0, onCreateTask, t);
  const approvalItem = buildApprovalReadinessItem(pendingApprovalCount, expiredApprovalCount, onOpenApprovals, t);
  const runLoopItem = buildRunLoopReadinessItem(succeededRunCount, latestFailedRun, runsLoading, onOpenRuns, t);
  const items: readonly WorkspaceReadinessItem[] = [
    buildDaemonReadinessItem(daemonHealthy, onRefreshDaemon, t),
    providerItem,
    channelItem,
    taskItem,
    approvalItem,
    runLoopItem,
  ];
  const blockingItems = items.filter((item) => !["tasks", "run-loop"].includes(item.id) && item.status !== "ready");
  const ready = blockingItems.length === 0;

  return (
    <section className="workspace-readiness panel" aria-labelledby="workspace-readiness-title">
      <div className="panel-title split readiness-title">
        <span>
          <ShieldCheck size={18} />
          <h2 id="workspace-readiness-title">{t("Workspace readiness")}</h2>
        </span>
        <span className={ready ? "readiness-summary ok" : "readiness-summary attention"}>
          {ready ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          {ready ? t("Ready") : t("{count} blocked", { count: blockingItems.length })}
        </span>
      </div>
      <div className="readiness-grid">
        {items.map((item) => (
          <div key={item.id} className={`readiness-item ${item.status}`}>
            <span className="readiness-icon">{readinessIcon(item.status)}</span>
            <span className="readiness-copy">
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
            {item.actionLabel && item.onAction ? (
              <button className="secondary-button compact-button" type="button" onClick={item.onAction} disabled={item.disabled}>
                {item.status === "loading" ? <Loader2 className="spin" size={14} /> : readinessActionIcon(item)}
                {item.actionLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function buildDaemonReadinessItem(daemonHealthy: boolean | undefined, onRefreshDaemon: () => void, t: Translate): WorkspaceReadinessItem {
  if (daemonHealthy === undefined) {
    return {
      id: "daemon",
      label: t("Daemon"),
      detail: t("Checking local daemon"),
      status: "loading",
      actionLabel: t("Retry"),
      onAction: onRefreshDaemon,
    };
  }
  if (!daemonHealthy) {
    return {
      id: "daemon",
      label: t("Daemon"),
      detail: t("Daemon is offline"),
      status: "attention",
      actionLabel: t("Retry"),
      onAction: onRefreshDaemon,
    };
  }
  return {
    id: "daemon",
    label: t("Daemon"),
    detail: t("Local daemon is reachable"),
    status: "ready",
  };
}

function buildProviderReadinessItem(
  total: number,
  runnable: number,
  ready: number,
  loading: boolean,
  onOpenProviders: () => void,
  t: Translate,
): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "providers",
      label: t("Model Workbench"),
      detail: t("Loading model presets"),
      status: "loading",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
      disabled: true,
    };
  }
  if (total === 0) {
    return {
      id: "providers",
      label: t("Model Workbench"),
      detail: t("No model presets"),
      status: "attention",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
    };
  }
  if (runnable === 0) {
    return {
      id: "providers",
      label: t("Model Workbench"),
      detail: t("{total} configured, none runnable", { total }),
      status: "attention",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
    };
  }
  if (ready === 0) {
    return {
      id: "providers",
      label: t("Model Workbench"),
      detail: t("{runnable} runnable, check required", { runnable }),
      status: "attention",
      actionLabel: t("Model Workbench"),
      onAction: onOpenProviders,
    };
  }
  return {
    id: "providers",
    label: t("Model Workbench"),
    detail: t("{ready}/{total} preflight ready", { ready, total }),
    status: "ready",
    actionLabel: t("Model Workbench"),
    onAction: onOpenProviders,
  };
}

function buildChannelReadinessItem(total: number, loading: boolean, onCreateChannel: () => void, t: Translate): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "channels",
      label: t("Channel"),
      detail: t("Loading channels"),
      status: "loading",
      actionLabel: t("Create"),
      onAction: onCreateChannel,
      disabled: true,
    };
  }
  if (total === 0) {
    return {
      id: "channels",
      label: t("Channel"),
      detail: t("No channel yet"),
      status: "attention",
      actionLabel: t("Create"),
      onAction: onCreateChannel,
    };
  }
  return {
    id: "channels",
    label: t("Channel"),
    detail: t(total === 1 ? "{total} channel available" : "{total} channels available", { total }),
    status: "ready",
  };
}

function buildTaskReadinessItem(total: number, loading: boolean, hasChannel: boolean, onCreateTask: () => void, t: Translate): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "tasks",
      label: t("Tasks"),
      detail: t("Loading selected channel tasks"),
      status: "loading",
    };
  }
  if (total === 0) {
    return {
      id: "tasks",
      label: t("Tasks"),
      detail: hasChannel ? t("No task in selected channel") : t("Create a channel first"),
      status: hasChannel ? "info" : "attention",
      actionLabel: hasChannel ? t("Create") : undefined,
      onAction: hasChannel ? onCreateTask : undefined,
    };
  }
  return {
    id: "tasks",
    label: t("Tasks"),
    detail: t(total === 1 ? "{total} task in selected channel" : "{total} tasks in selected channel", { total }),
    status: "ready",
  };
}

function buildApprovalReadinessItem(pendingCount: number, expiredCount: number, onOpenApprovals: () => void, t: Translate): WorkspaceReadinessItem {
  if (pendingCount > 0) {
    return {
      id: "approvals",
      label: t("Approvals"),
      detail: t(pendingCount === 1 ? "{count} approval waiting for a local decision" : "{count} approvals waiting for a local decision", { count: pendingCount }),
      status: "attention",
      actionLabel: t("Approvals"),
      onAction: onOpenApprovals,
    };
  }
  if (expiredCount > 0) {
    return {
      id: "approvals",
      label: t("Approvals"),
      detail: t(expiredCount === 1 ? "{count} expired approval need review" : "{count} expired approvals need review", { count: expiredCount }),
      status: "attention",
      actionLabel: t("Approvals"),
      onAction: onOpenApprovals,
    };
  }
  return {
    id: "approvals",
    label: t("Approvals"),
    detail: t("No pending or expired approvals"),
    status: "ready",
  };
}

function buildRunLoopReadinessItem(
  succeededRunCount: number,
  latestFailedRun: RunSession | undefined,
  loading: boolean,
  onOpenRuns: () => void,
  t: Translate,
): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "run-loop",
      label: t("Run loop"),
      detail: t("Loading run diagnostics"),
      status: "loading",
      actionLabel: t("Diagnostics"),
      onAction: onOpenRuns,
      disabled: true,
    };
  }
  if (latestFailedRun) {
    return {
      id: "run-loop",
      label: t("Run loop"),
      detail: t("Latest failed run needs review: {runId}", { runId: latestFailedRun.id }),
      status: "info",
      actionLabel: t("Diagnostics"),
      onAction: onOpenRuns,
    };
  }
  if (succeededRunCount === 0) {
    return {
      id: "run-loop",
      label: t("Run loop"),
      detail: t("No successful run yet"),
      status: "info",
      actionLabel: t("Diagnostics"),
      onAction: onOpenRuns,
    };
  }
  return {
    id: "run-loop",
    label: t("Run loop"),
    detail: t(succeededRunCount === 1 ? "{count} successful run" : "{count} successful runs", { count: succeededRunCount }),
    status: "ready",
    actionLabel: t("Diagnostics"),
    onAction: onOpenRuns,
  };
}

function readinessIcon(status: WorkspaceReadinessItem["status"]): JSX.Element {
  if (status === "ready") {
    return <CheckCircle2 size={17} />;
  }
  if (status === "loading") {
    return <Loader2 className="spin" size={17} />;
  }
  if (status === "info") {
    return <Clock3 size={17} />;
  }
  return <CircleAlert size={17} />;
}

function readinessActionIcon(item: WorkspaceReadinessItem): JSX.Element {
  if (item.id === "providers") {
    return <PlugZap size={14} />;
  }
  if (item.id === "run-loop") {
    return <History size={14} />;
  }
  if (item.id === "channels" || item.id === "tasks") {
    return <Plus size={14} />;
  }
  return <RefreshCw size={14} />;
}
