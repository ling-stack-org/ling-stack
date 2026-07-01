import { useMemo } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";
import type { Translate } from "../../i18n.js";
import {
  buildCollaborationProgressProjection,
  type CollaborationProgressProjectionIcon,
  type CollaborationProgressProjectionItem,
  type CollaborationProgressProjectionTone,
} from "../../lib/collaboration-progress-projection.js";
import type { CollaborationTaskCardModel } from "../../lib/collaboration-task-card.js";
import type { ConversationContextSourceSummary } from "../../lib/conversation-context-sources.js";
import type {
  ApprovalRequest,
  ChannelContextSummary,
  ChannelWorkflowStep,
  RunSession,
  Task,
} from "../../types.js";
import {
  buildActiveProgressSourceSummary,
  runIsActiveProgressPopoverRun,
  taskIsActiveProgressPopoverTask,
  type AttentionProgressRow,
  type AttentionProgressTone,
} from "./ChannelProgressPanels.js";

interface ChannelProgressSummaryInput {
  readonly collaborationCards: readonly CollaborationTaskCardModel[];
  readonly selectedTask?: Task;
  readonly latestRun?: RunSession;
  readonly pendingApprovalCount: number;
  readonly selectedApproval?: ApprovalRequest;
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runningWorkflowStepId: string;
  readonly t: Translate;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approval?: ApprovalRequest) => void;
}

export interface ChannelProgressSummary {
  readonly attentionRows: readonly AttentionProgressRow[];
  readonly activeSourceSummary?: ConversationContextSourceSummary;
}

export function useChannelProgressSummary({
  collaborationCards,
  selectedTask,
  latestRun,
  pendingApprovalCount,
  selectedApproval,
  contextSummaries,
  workflowSteps,
  runningWorkflowStepId,
  t,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
}: ChannelProgressSummaryInput): ChannelProgressSummary {
  const attentionRows = useMemo<readonly AttentionProgressRow[]>(() => {
    const workflowRows = buildWorkflowAttentionProgressRows({
      items: buildCollaborationProgressProjection({
        cards: collaborationCards,
        t,
        limit: 6,
        scope: "active",
      }),
    });
    const rowCandidates: readonly (AttentionProgressRow | undefined)[] = [
      ...workflowRows,
      selectedTask && taskIsActiveProgressPopoverTask(selectedTask) ? {
        id: "current-task",
        icon: <SquareTerminal size={18} />,
        tone: selectedTask.status === "blocked" ? "blocked" : selectedTask.status === "failed" ? "failed" : selectedTask.status === "done" ? "success" : selectedTask.status === "running" ? "running" : "neutral",
        primary: selectedTask.title,
        secondary: `${t("Current task")} · ${t(selectedTask.status)}`,
        onOpen: () => onOpenTask(selectedTask.id),
      } : undefined,
      latestRun && runIsActiveProgressPopoverRun(latestRun) ? {
        id: "latest-run",
        icon: runProgressIcon(latestRun.status),
        tone: runProgressTone(latestRun.status),
        primary: `${t("Latest run")} · ${t(latestRun.status)}`,
        secondary: readRunTitle(latestRun),
        onOpen: () => onOpenRun(latestRun.id),
      } : undefined,
      pendingApprovalCount > 0 ? {
        id: "pending-approval",
        icon: <ShieldCheck size={18} />,
        tone: "waiting",
        primary: t("Approval needed"),
        secondary: t("{count} pending approvals", { count: pendingApprovalCount }),
        onOpen: () => onOpenApproval(selectedApproval),
      } : undefined,
    ];
    return rowCandidates.filter((row): row is AttentionProgressRow => row !== undefined);
  }, [collaborationCards, latestRun, onOpenApproval, onOpenRun, onOpenTask, pendingApprovalCount, selectedApproval, selectedTask, t]);

  const activeSourceSummary = useMemo(
    () => buildActiveProgressSourceSummary({
      contextSummaries,
      workflowSteps,
      selectedTask,
      runningWorkflowStepId,
      t,
    }),
    [contextSummaries, workflowSteps, runningWorkflowStepId, selectedTask, t],
  );

  return {
    attentionRows,
    activeSourceSummary,
  };
}

function readRunTitle(run: RunSession): string {
  if (typeof run.taskSnapshot === "object" && run.taskSnapshot !== null && "title" in run.taskSnapshot) {
    const title = (run.taskSnapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) {
      return title;
    }
  }
  return run.taskId;
}

function runProgressTone(status: RunSession["status"]): AttentionProgressTone {
  if (status === "succeeded") {
    return "success";
  }
  if (status === "running" || status === "queued") {
    return "running";
  }
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "failed") {
    return "failed";
  }
  return "neutral";
}

function runProgressIcon(status: RunSession["status"]): JSX.Element {
  if (status === "succeeded") {
    return <CheckCircle2 size={18} />;
  }
  if (status === "running") {
    return <Loader2 className="spin" size={18} />;
  }
  if (status === "waiting_for_approval") {
    return <ShieldCheck size={18} />;
  }
  if (status === "failed") {
    return <CircleAlert size={18} />;
  }
  if (status === "cancelled") {
    return <X size={18} />;
  }
  return <Clock3 size={18} />;
}

function buildWorkflowAttentionProgressRows(input: {
  readonly items: readonly CollaborationProgressProjectionItem[];
  readonly onOpen?: () => void;
}): readonly AttentionProgressRow[] {
  return input.items.map((item) => ({
    id: item.id,
    icon: collaborationProgressIcon(item.icon),
    tone: collaborationProgressTone(item.tone),
    primary: item.primary,
    secondary: item.secondary,
    onOpen: input.onOpen,
  }));
}

function collaborationProgressTone(tone: CollaborationProgressProjectionTone): AttentionProgressTone {
  return tone;
}

function collaborationProgressIcon(icon: CollaborationProgressProjectionIcon): JSX.Element {
  if (icon === "blocked" || icon === "failed") {
    return <CircleAlert size={18} />;
  }
  if (icon === "waiting") {
    return <ShieldCheck size={18} />;
  }
  if (icon === "success") {
    return <CheckCircle2 size={18} />;
  }
  if (icon === "running") {
    return <Loader2 className="spin" size={18} />;
  }
  return <Workflow size={18} />;
}
