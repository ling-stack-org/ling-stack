import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Command,
  FileCheck2,
  FileText,
  Hash,
  History,
  Image as ImageIcon,
  Play,
  ShieldCheck,
  Square,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { formatDateTime } from "../../lib/formatting.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import { canUseProviderForRun } from "../../lib/providers.js";
import { buildRunRepairHint, displayLinkedRunStatus } from "../../lib/run-evidence.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  sessionPermissionModeDescription,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import { RunRepairHintBanner } from "../../shared/components/index.js";
import { ConversationAttachmentStrip } from "../../shared/conversation/index.js";
import {
  Badge,
  Button,
  DataRow,
  EmptyState,
  InlineFeedback,
  InspectorSection,
  SegmentedControl,
  SegmentedControlItem,
  StatusIndicator,
} from "../../shared/ui/index.js";
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
  TaskRunActionState,
} from "../../types.js";
import { deriveChannelTaskPrimaryState } from "./channel-task-view-models.js";

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
  operationError,
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
  readonly operationError?: string;
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
  const linkedRunStatus = task.currentRunId
    ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus)
    : "";
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
  const taskSummaries = contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === task.id);
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const sourceWorkflowStep = workflowSteps.find((step) => step.taskId === task.id);
  const sourceWorkflow = sourceWorkflowStep ? workflows.find((workflow) => workflow.id === sourceWorkflowStep.workflowId) : undefined;
  const timelineRunId = activeRunId || task.currentRunId || "";
  const pendingRunApprovals = approvals.filter((approval) => {
    if (effectiveApprovalStatus(approval) !== "pending") return false;
    return timelineRunId ? approval.runId === timelineRunId : approval.taskId === task.id;
  });
  const contextCount = taskAttachments.length + activeDecisions.length + taskSummaries.length + (sourceWorkflowStep ? 1 : 0);
  const primaryState = useMemo(() => deriveChannelTaskPrimaryState({
    blockedByLease,
    channelPaused: taskChannelPaused,
    linkedRunStatus,
    pendingApprovalCount,
    providerBlocked: Boolean(providerBlocker),
    taskStatus: task.status,
  }), [blockedByLease, linkedRunStatus, pendingApprovalCount, providerBlocker, task.status, taskChannelPaused]);
  const [handoffState, setHandoffState] = useState<{ readonly status: "idle" | "saving" | "failed"; readonly message: string }>({
    status: "idle",
    message: "",
  });

  useEffect(() => {
    setHandoffState({ status: "idle", message: "" });
  }, [task.id]);

  async function handleCreateHandoff(): Promise<void> {
    if (handoffState.status === "saving") return;
    setHandoffState({ status: "saving", message: "" });
    try {
      const handoff = await onCreateHandoffFromTask(task);
      if (!handoff) {
        setHandoffState({ status: "failed", message: t("Create handoff failed") });
        return;
      }
      setHandoffState({ status: "idle", message: "" });
      onOpenHandoffs();
    } catch (error) {
      setHandoffState({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <article
      className="channel-task-detail-surface task-detail"
      aria-label={t("Task detail")}
      data-ui2-channel-task="detail"
      data-task-state={primaryState.id}
    >
      <header className="channel-task-detail-header">
        <div className="channel-task-detail-identity">
          <h2>{task.title}</h2>
          <p>{task.prompt}</p>
        </div>
        <StatusIndicator label={t(primaryState.label)} tone={primaryState.tone} />
      </header>

      <div className="channel-task-meta" aria-label={t("Task context")}>
        <span><Hash size={13} />{taskChannel?.name ?? task.channelId}</span>
        <span><Command size={13} />{effectiveProvider?.displayName ?? t("No model selected")}</span>
        <span><Clock3 size={13} />{formatDateTime(task.updatedAt)}</span>
        {task.requestedSkillId ? <span><SquareTerminal size={13} />{task.requestedSkillId}</span> : null}
      </div>

      {operationError ? (
        <InlineFeedback tone="danger" role="alert">
          {operationError}
        </InlineFeedback>
      ) : null}

      {task.currentRunId ? (
        <DataRow
          compact
          className="channel-task-run-row"
          identity={linkedRunSucceeded ? t("Task complete") : t("Run linked")}
          summary={linkedRunSucceeded ? t("Latest run") : linkedRunStatus ? t(linkedRunStatus) : t("Latest run")}
          status={<StatusIndicator label={linkedRunStatus ? t(linkedRunStatus) : t("Saved")} tone={runStatusTone(linkedRunStatus)} />}
          actions={(
            <div className="channel-task-row-actions">
              <Button
                size="sm"
                variant={linkedRunSucceeded ? "primary" : "secondary"}
                leadingIcon={linkedRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
                onClick={() => onOpenRun(task.currentRunId ?? "")}
              >
                {linkedRunSucceeded ? t("View result") : t("Open run")}
              </Button>
              {linkedRunCancellable ? (
                <Button
                  size="sm"
                  variant="danger"
                  leadingIcon={<Square size={13} />}
                  loading={isCancellingRun}
                  loadingLabel={t("Stopping")}
                  onClick={() => linkedRun && onCancelActiveRun(linkedRun)}
                >
                  {isCancellingRun ? t("Stopping") : t("Stop")}
                </Button>
              ) : null}
            </div>
          )}
        />
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
      {providerBlocker ? <InlineFeedback tone="danger" title={t("Provider needs attention")}>{providerBlocker}</InlineFeedback> : null}
      {taskChannelPaused || blockedByLease ? (
        <InlineFeedback tone="warning" title={taskChannelPaused ? t("Channel is not active") : t("Active resource lock")}>
          {taskChannelPaused ? t("Task runs remain unavailable until the channel is active.") : t("Another run currently owns the workspace resource lock.")}
        </InlineFeedback>
      ) : null}
      {handoffState.status === "failed" ? (
        <InlineFeedback tone="danger" title={t("Create handoff failed")}>{handoffState.message}</InlineFeedback>
      ) : null}

      <InspectorSection title={t("Task context")} summary={contextCount > 0 ? String(contextCount) : t("No context summary for this task")}>
        {contextCount === 0 ? (
          <EmptyState compact icon={<FileText />} title={t("No context summary for this task")} />
        ) : (
          <div className="channel-task-context-content">
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
            {activeDecisions.length > 0 ? (
              <div className="channel-task-context-badges">
                {activeDecisions.slice(0, 3).map((decision) => (
                  <Badge key={decision.id} icon={<FileCheck2 size={12} />} tone="success" variant="outline">{decision.title}</Badge>
                ))}
              </div>
            ) : null}
            {taskSummaries.map((summary) => (
              <Button key={summary.id} size="sm" variant="secondary" leadingIcon={<FileText size={13} />} onClick={() => onCreateTaskFromContextSummary(summary)}>
                {t("Context summary")}
              </Button>
            ))}
            {sourceWorkflowStep ? (
              <DataRow
                compact
                identity={t("Source workflow")}
                summary={`${sourceWorkflow?.title ?? sourceWorkflowStep.workflowId} / ${sourceWorkflowStep.title}`}
                status={<StatusIndicator label={t(sourceWorkflowStep.status)} tone={runStatusTone(sourceWorkflowStep.status)} />}
              />
            ) : null}
          </div>
        )}
      </InspectorSection>

      <InspectorSection title={t("Permissions")} summary={permissionPresetLabel(resolvedPermissionPreset, t)}>
        <div className="channel-task-permission-content">
          <SegmentedControl
            aria-label={t("Permission preset")}
            value={resolvedPermissionPreset}
            onValueChange={(preset) => onPermissionModeChange(permissionModeForPreset(preset as PermissionPreset))}
            size="sm"
          >
            {permissionPresetOptions.map((preset) => (
              <SegmentedControlItem key={preset} value={preset} disabled={isRunning || taskActionPending}>
                {permissionPresetLabel(preset, t)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <p>{permissionPresetDescription(resolvedPermissionPreset, t)}</p>
          <details className="channel-task-permission-preview">
            <summary>{t("Preview permissions")}</summary>
            <div>
              {policyPreviewRows.map((row) => <span key={row}>{row}</span>)}
              <span>{sessionPermissionModeDescription(permissionMode, t)}</span>
            </div>
          </details>
        </div>
      </InspectorSection>

      <footer className="channel-task-actions">
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Workflow size={14} />}
          loading={handoffState.status === "saving"}
          loadingLabel={t("Creating")}
          onClick={() => void handleCreateHandoff()}
        >
          {handoffState.status === "saving" ? t("Creating") : t("Create handoff")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<CheckCircle2 size={14} />}
          loading={checkRunLoading}
          loadingLabel={t("Checking")}
          onClick={() => onCheckThenRunTask(task)}
          disabled={taskActionsDisabled || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}
        >
          {t("Check & run")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          leadingIcon={<Play size={14} />}
          loading={runLoading}
          loadingLabel={t("Running")}
          onClick={() => onRunTask(task)}
          disabled={taskActionsDisabled || Boolean(providerBlocker) || taskChannelPaused}
        >
          {t("Run")}
        </Button>
      </footer>

      {pendingRunApprovals.length > 0 ? (
        <section className="channel-task-approval-panel" aria-label={t("Pending approval")} aria-live="polite">
          <header>
            <span><ShieldCheck size={15} />{t("Pending approval")}</span>
            <Button size="sm" variant="ghost" loading={approvalsLoading} onClick={onRefreshRunApprovals}>
              {t("Refresh")}
            </Button>
          </header>
          <div className="channel-task-approval-list">
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
        </section>
      ) : null}
    </article>
  );
}

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function runStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "succeeded" || status === "done" || status === "completed") return "success";
  if (status === "waiting_for_approval" || status === "review") return "warning";
  if (status === "failed" || status === "cancelled" || status === "blocked") return "danger";
  if (status === "running" || status === "queued" || status === "in_progress") return "info";
  return "neutral";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
