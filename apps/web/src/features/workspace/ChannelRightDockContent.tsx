import { useMemo, type ReactNode } from "react";
import type { Translate } from "../../i18n.js";
import type {
  ApprovalRequest,
  ChannelAttachment,
  ChannelMessage,
  RunArtifact,
  RunSession,
} from "../../types.js";
import {
  mergeDockFileItems,
  mergeEvidenceGroups,
  projectApprovalsToEvidenceGroup,
  projectApprovalsToReviewItems,
  projectArtifactsToFileItems,
  projectChannelAttachmentsToFileItems,
  projectFileRefsToFileItems,
  projectFilesToEvidenceGroup,
  projectFilesToReviewItems,
  projectMessagesToReviewItems,
  projectRunsToEvidenceGroup,
  projectRunsToReviewItems,
  projectWebEvidenceToEvidenceGroup,
  type RightDockMessageProjectionInput,
  type WorkspaceRightDockProps,
} from "./right-dock/index.js";
import type { AttentionProgressRow } from "./ChannelProgressPanels.js";

interface ChannelRightDockContentInput {
  readonly selectedChannelId: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly taskChannelById: ReadonlyMap<string, string>;
  readonly channelRuns: readonly RunSession[];
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelAttachments: readonly ChannelAttachment[];
  readonly channelArtifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly attentionProgressRows: readonly AttentionProgressRow[];
  readonly teamAttentionCount: number;
  readonly teamMetricsPanel: ReactNode;
  readonly contextDockContent: ReactNode;
  readonly t: Translate;
}

export interface ChannelRightDockContent {
  readonly reviewItems: WorkspaceRightDockProps["reviewItems"];
  readonly evidenceGroups: WorkspaceRightDockProps["evidenceGroups"];
  readonly fileItems: WorkspaceRightDockProps["fileItems"];
  readonly activityCount: number;
  readonly activityNode: ReactNode;
}

export function useChannelRightDockContent({
  selectedChannelId,
  approvals,
  runById,
  taskChannelById,
  channelRuns,
  channelMessages,
  channelAttachments,
  channelArtifactsByRun,
  attentionProgressRows,
  teamAttentionCount,
  teamMetricsPanel,
  contextDockContent,
  t,
}: ChannelRightDockContentInput): ChannelRightDockContent {
  const channelApprovals = useMemo(() => {
    return approvals.filter((approval) => {
      const approvalChannelId = approval.channelId
        ?? (approval.runId ? runById.get(approval.runId)?.channelId : undefined)
        ?? (approval.taskId ? taskChannelById.get(approval.taskId) : undefined);
      return approvalChannelId === selectedChannelId;
    });
  }, [approvals, runById, selectedChannelId, taskChannelById]);

  const messages = useMemo<readonly RightDockMessageProjectionInput[]>(
    () => channelMessages.map((message) => ({
      id: message.id,
      title: message.kind === "ai_reply" ? t("AI reply") : message.authorType === "local-user" ? t("User message") : t("Channel message"),
      body: message.body,
      status: message.status,
      errorMessage: message.errorMessage,
      runId: message.linkedRunId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      webEvidence: message.webEvidence,
      fileRefs: message.fileRefs,
    })),
    [channelMessages, t],
  );

  const fileItems = useMemo(
    () => mergeDockFileItems(
      projectChannelAttachmentsToFileItems(channelAttachments, t),
      projectFileRefsToFileItems(channelMessages.flatMap((message) => message.fileRefs ?? [])),
      projectArtifactsToFileItems(channelArtifactsByRun),
    ),
    [channelArtifactsByRun, channelAttachments, channelMessages, t],
  );

  const evidenceGroups = useMemo(
    () => mergeEvidenceGroups(
      projectRunsToEvidenceGroup(channelRuns, t),
      projectApprovalsToEvidenceGroup(channelApprovals, t),
      projectWebEvidenceToEvidenceGroup(messages, t),
      projectFilesToEvidenceGroup(fileItems, t),
    ),
    [channelApprovals, channelRuns, fileItems, messages, t],
  );

  const reviewItems = useMemo(
    () => [
      ...projectApprovalsToReviewItems(channelApprovals, t),
      ...projectRunsToReviewItems(channelRuns, t),
      ...projectMessagesToReviewItems(messages, t),
      ...projectFilesToReviewItems(fileItems, t),
    ],
    [channelApprovals, channelRuns, fileItems, messages, t],
  );

  const activityNode = (
    <div className="right-dock-activity-stack">
      {teamMetricsPanel}
      {contextDockContent}
    </div>
  );

  return {
    reviewItems,
    evidenceGroups,
    fileItems,
    activityCount: attentionProgressRows.length + teamAttentionCount,
    activityNode,
  };
}
