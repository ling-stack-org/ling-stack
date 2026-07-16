import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Command,
  Database,
  FileCheck2,
  FileText,
  Hash,
  History,
  Image as ImageIcon,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import { canUseProviderForRun } from "../../lib/providers.js";
import {
  buildRunRepairHint,
  displayLinkedRunStatus,
} from "../../lib/run-evidence.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  sessionPermissionModeDescription,
  sessionPermissionModeLabel,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  RunRepairHintBanner,
  StatusBadge,
} from "../../shared/components/index.js";
import {
  ConversationAttachmentStrip,
} from "../../shared/conversation/index.js";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import type {
  ApprovalPolicy,
  ApprovalRequest,
  Channel,
  ChannelAttachment,
  ChannelContextSummary,
  ChannelDecision,
  ChannelHandoff,
  ChannelWorkflow,
  ChannelWorkflowStep,
  PermissionPreset,
  ProviderPreset,
  RunSession,
  SessionPermissionMode,
  Task,
  TaskFormState,
  TaskRunActionState,
} from "../../types.js";
import { ProviderPresetOptions } from "./WorkspaceControls.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

export function NewTaskPanel({
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
        <SelectControl value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading}>
          <option value="">{t("Select provider preset")}</option>
          <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
        </SelectControl>
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
          <span>{t("Generation-only models cannot run coding tasks.")}</span>
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

export function TaskDetailPanel({
  cwd,
  task,
  channels,
  attachments,
  runById,
  activeRunId,
  latestStatus,
  pendingApprovalCount,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  effectiveProvider,
  providerBlocker,
  isRunning,
  activeTaskRunAction,
  taskActionPending,
  activeLeaseCount,
  isCancellingRun,
  approvalPolicy,
  permissionMode,
  permissionPreset,
  decisions,
  contextSummaries,
  workflows,
  workflowSteps,
  onCreateHandoffFromTask,
  onOpenHandoffs,
  onCreateTaskFromContextSummary,
  onCheckThenRunTask,
  onRunTask,
  onPermissionModeChange,
  onCancelActiveRun,
  onOpenRun,
  onOpenApprovals,
  onRefreshRunApprovals,
  onResolveApproval,
  onOpenProviders,
  attachmentContentUrl,
}: {
  readonly cwd: string;
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly attachments: readonly ChannelAttachment[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly pendingApprovalCount: number;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly effectiveProvider: ProviderPreset | undefined;
  readonly providerBlocker: string | undefined;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly taskActionPending: boolean;
  readonly activeLeaseCount: number;
  readonly isCancellingRun: boolean;
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly decisions: readonly ChannelDecision[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly onCreateHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly onOpenHandoffs: () => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onCancelActiveRun: (run?: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onRefreshRunApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
}): JSX.Element {
  const { t } = useI18n();
  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
  const linkedRunSucceeded = linkedRunStatus === "succeeded";
  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus, "", t);
  const taskChannel = channels.find((channel) => channel.id === task.channelId);
  const taskAttachments = (task.attachmentIds ?? [])
    .map((attachmentId) => attachments.find((attachment) => attachment.id === attachmentId))
    .filter((attachment): attachment is ChannelAttachment => Boolean(attachment));
  const resolvedPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);
  const effectivePolicyPreview = buildLocalEffectivePolicyPreview({
    policy: approvalPolicy,
    mode: permissionMode,
    channelBoundPath: taskChannel?.boundPath,
  });
  const policyPreviewRows = [
    ...summarizeEffectivePolicySnapshot(effectivePolicyPreview, t),
    ...formatToolDecisionGroups(effectivePolicyPreview, t),
  ];
  const taskChannelPaused = taskChannel?.status !== undefined && taskChannel.status !== "active";
  const blockedByLease = activeLeaseCount > 0 && (!linkedRun || linkedRun.status !== "running");
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const taskActionsDisabled = isRunning || taskActionPending;
  const linkedRunCancellable = Boolean(linkedRun && runCanBeStopped(linkedRun));
  const stopLinkedRun = (): void => {
    if (linkedRun) {
      onCancelActiveRun(linkedRun);
    }
  };
  const taskSummaries = contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === task.id);
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const sourceWorkflowStep = workflowSteps.find((step) => step.taskId === task.id);
  const sourceWorkflow = sourceWorkflowStep ? workflows.find((workflow) => workflow.id === sourceWorkflowStep.workflowId) : undefined;
  const timelineRunId = activeRunId || task.currentRunId || "";
  const pendingRunApprovals = approvals.filter((approval) => {
    if (effectiveApprovalStatus(approval) !== "pending") {
      return false;
    }
    return timelineRunId ? approval.runId === timelineRunId : approval.taskId === task.id;
  });
  const [handoffState, setHandoffState] = useState<{ readonly status: "idle" | "saving" | "saved" | "failed"; readonly message: string }>({
    status: "idle",
    message: "",
  });

  useEffect(() => {
    setHandoffState({ status: "idle", message: "" });
  }, [task.id]);

  async function handleCreateHandoff(): Promise<void> {
    if (handoffState.status === "saving") {
      return;
    }
    setHandoffState({ status: "saving", message: "" });
    try {
      const handoff = await onCreateHandoffFromTask(task);
      if (!handoff) {
        setHandoffState({ status: "failed", message: t("Create handoff failed") });
        return;
      }
      setHandoffState({ status: "saved", message: t("Handoff created") });
      onOpenHandoffs();
    } catch (error) {
      setHandoffState({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <article className="client-task-card task-detail selected" aria-label={t("Task detail")}>
      <div className="task-detail-head">
        <span className={`task-status ${task.status}`}>{t(task.status)}</span>
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
        {task.requestedSkillId ? (
          <span>
            <SquareTerminal size={13} />
            {t("Requested skill")}: {task.requestedSkillId}
          </span>
        ) : null}
      </div>
      {taskAttachments.length > 0 ? (
        <ConversationAttachmentStrip
          loadPreview={loadPreviewContent}
          attachments={taskAttachments.map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: formatBytes(attachment.sizeBytes),
            href: attachmentContentUrl(attachment),
            target: "_blank",
            rel: "noreferrer",
            icon: attachment.kind === "image" ? <ImageIcon size={13} /> : <FileText size={13} />,
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd,
              attachmentId: attachment.id,
              scope: "channel",
              channelId: task.channelId,
            } : undefined,
          }))}
        />
      ) : null}
      {task.currentRunId ? (
        <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
          <StatusBadge status={linkedRunStatus} />
          <span className="task-run-summary">
            {linkedRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
            <span>{t("Run linked")}</span>
          </span>
          <button className={linkedRunSucceeded ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
            {linkedRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
            {linkedRunSucceeded ? t("View result") : t("Open run")}
          </button>
          {linkedRunCancellable ? (
            <button className="secondary-button danger compact-button" type="button" onClick={stopLinkedRun} disabled={isCancellingRun}>
              {isCancellingRun ? <Loader2 className="spin" size={14} /> : <Square size={13} />}
              {isCancellingRun ? t("Stopping") : t("Stop")}
            </button>
          ) : null}
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
      {activeDecisions.length > 0 || taskSummaries.length > 0 ? (
        <div className="task-context-strip">
          {activeDecisions.slice(0, 3).map((decision) => (
            <span key={decision.id} className="glass-chip ok">
              <FileCheck2 size={13} />
              {decision.title}
            </span>
          ))}
          {taskSummaries.map((summary) => (
            <button key={summary.id} className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromContextSummary(summary)}>
              <FileText size={13} />
              {t("Context summary")}
            </button>
          ))}
        </div>
      ) : null}
      {sourceWorkflowStep ? (
        <div className="task-run-link compact">
          <StatusBadge status={sourceWorkflowStep.status} />
          <span>
            {t("Source workflow")}: {sourceWorkflow?.title ?? sourceWorkflowStep.workflowId} / {sourceWorkflowStep.title}
          </span>
        </div>
      ) : null}
      <div className="session-permission-control" aria-label={t("Permission mode")}>
        <div className="session-permission-head">
          <span>
            <ShieldCheck size={14} />
            {t("Permission preset")}
          </span>
          <strong>{sessionPermissionModeLabel(permissionMode, t)}</strong>
        </div>
        <div className="permission-preset-segment" role="group" aria-label={t("Permission preset")}>
          {permissionPresetOptions.map((preset) => (
            <button
              key={preset}
              className={resolvedPermissionPreset === preset ? "permission-preset-option active" : "permission-preset-option"}
              type="button"
              onClick={() => onPermissionModeChange(permissionModeForPreset(preset))}
              disabled={isRunning || taskActionPending}
              aria-pressed={resolvedPermissionPreset === preset}
            >
              <span>{permissionPresetLabel(preset, t)}</span>
            </button>
          ))}
        </div>
        <small>{permissionPresetDescription(resolvedPermissionPreset, t)}</small>
        <details className="permission-preview-disclosure">
          <summary>{t("Preview permissions")}</summary>
          <div className="permission-preview-list">
            {policyPreviewRows.map((row) => (
              <span key={row}>{row}</span>
            ))}
            <span>{sessionPermissionModeDescription(permissionMode, t)}</span>
          </div>
        </details>
      </div>
      <div className="task-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => void handleCreateHandoff()} disabled={handoffState.status === "saving"}>
          {handoffState.status === "saving" ? <Loader2 className="spin" size={14} /> : <Workflow size={14} />}
          {handoffState.status === "saving" ? t("Creating") : t("Create handoff")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={taskActionsDisabled || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Check & run")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={taskActionsDisabled || Boolean(providerBlocker) || taskChannelPaused}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Run")}
        </button>
      </div>
      {handoffState.status === "saved" || handoffState.status === "failed" ? (
        <div className={handoffState.status === "saved" ? "provider-run-notice ok" : "provider-run-notice"}>
          {handoffState.status === "saved" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          <span>{handoffState.message}</span>
        </div>
      ) : null}
      {pendingRunApprovals.length > 0 ? (
        <div className="inline-approval-panel task-approval-panel" aria-live="polite">
          <div className="inline-approval-head">
            <span>
              <ShieldCheck size={16} />
              {t("Pending approval")}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshRunApprovals} disabled={approvalsLoading}>
              {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          </div>
          <div className="inline-approval-list">
            {pendingRunApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                compact
                resolvingDecision={resolvingApprovals[approval.id]}
                onResolve={onResolveApproval}
              />
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
