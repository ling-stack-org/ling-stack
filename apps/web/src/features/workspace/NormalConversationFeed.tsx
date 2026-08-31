import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ArrowDown, Copy, FileText, Pencil, ThumbsDown, ThumbsUp } from "lucide-react";
import { getConversationInteractionPolicy } from "@ling-stack/conversation-ui-core";
import { attachmentContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForWorkCell,
  type ComposerGateApprovalPresentation,
} from "../../lib/runtime-approval-presentation.js";
import {
  ConversationAttachmentStrip,
  ConversationGeneratedMediaBlock,
  ConversationFeed,
  ConversationTimeline,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  InlineMessageEditor,
  MessageActionBar,
  MessageRow,
} from "../../shared/conversation/index.js";
import { IconButton, InlineFeedback } from "../../shared/ui/index.js";
import type { ConversationGeneratedMedia, RunSession } from "../../types.js";
import type {
  WorkspaceRightDockFileTarget,
  WorkspaceRightDockReviewTarget,
} from "./right-dock/index.js";
import {
  projectNormalConversationFeedItems,
  type NormalConversationFeedItem,
} from "./normal-conversation-feed-view-models.js";
import type {
  ConversationHomeDetailContext,
  ConversationHomeMessage,
} from "./normal-conversation-types.js";

const latestThresholdPx = 56;

export interface NormalConversationFeedProps {
  readonly messages: readonly ConversationHomeMessage[];
  readonly visibleMessages: readonly ConversationHomeMessage[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly detailContext?: ConversationHomeDetailContext;
  readonly composerGateApprovals: readonly InlineApprovalView[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly projectPath?: string;
  readonly workspaceCwd: string;
  readonly searchActive: boolean;
  readonly editingMessageId?: string;
  readonly editSaving: boolean;
  readonly latestEditableUserMessageId?: string;
  readonly replacementRetryingMessageId?: string;
  readonly replacementRetryError: string;
  readonly onCancelMessageEdit: () => void;
  readonly onEditMessage: (messageId: string) => void;
  readonly onSaveMessage: (message: ConversationHomeMessage, body: string) => void | Promise<void>;
  readonly onRetryReplacement: (message: ConversationHomeMessage) => void | Promise<void>;
  readonly onOpenFiles: () => void;
  readonly onOpenReportFile: (target: WorkspaceRightDockFileTarget) => void;
  readonly onOpenReview: (target: WorkspaceRightDockReviewTarget) => void;
  readonly onOpenRun?: (runId: string) => void;
}

export function NormalConversationFeed({
  detailContext,
  composerGateApprovals,
  editSaving,
  editingMessageId,
  latestEditableUserMessageId,
  messages,
  generatedMedia,
  onCancelMessageEdit,
  onEditMessage,
  onOpenFiles,
  onOpenReportFile,
  onOpenReview,
  onOpenRun,
  onRetryReplacement,
  onSaveMessage,
  projectPath,
  replacementRetryError,
  replacementRetryingMessageId,
  runById,
  searchActive,
  visibleMessages,
  workspaceCwd,
}: NormalConversationFeedProps): React.JSX.Element {
  const { t } = useI18n();
  const feedRef = useRef<HTMLDivElement | null>(null);
  const tailReconciliationFrameRef = useRef<number | undefined>(undefined);
  const stickToLatestRef = useRef(true);
  const [latestButtonVisible, setLatestButtonVisible] = useState(false);
  const [feedbackById, setFeedbackById] = useState<Record<string, "up" | "down">>({});
  const composerGateApprovalByRunId = useMemo(
    () => buildComposerGateApprovalPresentationByRunId(composerGateApprovals, t),
    [composerGateApprovals, t],
  );
  const feedItems = useMemo(() => projectNormalConversationFeedItems({
    detailContext,
    messages,
    projectPath,
    runById,
    t,
    visibleMessages,
    workspaceCwd,
  }), [detailContext, messages, projectPath, runById, t, visibleMessages, workspaceCwd]);
  const generatedMediaByRunId = useMemo(() => groupGeneratedMediaByRunId(generatedMedia), [generatedMedia]);
  const itemIdentityKey = useMemo(
    () => feedItems.map((item) => item.message.id).join("|"),
    [feedItems],
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth"): void => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }
    feed.scrollTo({ top: feed.scrollHeight, behavior });
    stickToLatestRef.current = true;
    setLatestButtonVisible(false);
  }, []);

  const reconcileTail = useCallback((): void => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }
    if (stickToLatestRef.current) {
      feed.scrollTop = feed.scrollHeight;
      setLatestButtonVisible(false);
      return;
    }
    setLatestButtonVisible(distanceFromLatest(feed) > latestThresholdPx);
  }, []);

  const scheduleTailReconciliation = useCallback((): void => {
    if (tailReconciliationFrameRef.current !== undefined) {
      return;
    }
    tailReconciliationFrameRef.current = globalThis.requestAnimationFrame(() => {
      tailReconciliationFrameRef.current = undefined;
      reconcileTail();
    });
  }, [reconcileTail]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }
    scheduleTailReconciliation();
  }, [itemIdentityKey, scheduleTailReconciliation]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => scheduleTailReconciliation());
    Array.from(feed.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [itemIdentityKey, scheduleTailReconciliation]);

  useLayoutEffect(() => {
    return () => {
      if (tailReconciliationFrameRef.current !== undefined) {
        globalThis.cancelAnimationFrame(tailReconciliationFrameRef.current);
        tailReconciliationFrameRef.current = undefined;
      }
    };
  }, []);

  function handleFeedScroll(event: UIEvent<HTMLDivElement>): void {
    const atLatest = distanceFromLatest(event.currentTarget) <= latestThresholdPx;
    stickToLatestRef.current = atLatest;
    setLatestButtonVisible(!atLatest);
  }

  function toggleFeedback(messageId: string, feedback: "up" | "down"): void {
    setFeedbackById((current) => {
      if (current[messageId] === feedback) {
        const next = { ...current };
        delete next[messageId];
        return next;
      }
      return { ...current, [messageId]: feedback };
    });
  }

  return (
    <div className="normal-conversation-feed-frame">
      <ConversationFeed
        rootRef={feedRef}
        onScroll={handleFeedScroll}
        className="normal-conversation-feed"
        ariaLabel={t("Conversation messages")}
        items={feedItems}
        emptyLabel={searchActive ? t("No matching conversation messages") : t("No conversation messages yet")}
        getItemId={(item) => item.message.id}
        renderItem={(item) => (
          <NormalConversationMessageRow
            item={item}
            composerGateApproval={item.workCell
              ? composerGateApprovalPresentationForWorkCell(item.workCell, composerGateApprovalByRunId)
              : undefined}
            generatedMedia={item.message.runId ? generatedMediaByRunId.get(item.message.runId) ?? [] : []}
            feedback={feedbackById[item.message.id]}
            editing={editingMessageId === item.message.id}
            editSaving={editSaving}
            editable={item.message.id === latestEditableUserMessageId}
            replacementRetrying={replacementRetryingMessageId === item.message.id}
            replacementRetryError={replacementRetryError}
            projectPath={projectPath}
            workspaceCwd={workspaceCwd}
            onCancelEdit={onCancelMessageEdit}
            onEdit={() => onEditMessage(item.message.id)}
            onSave={(body) => onSaveMessage(item.message, body)}
            onRetryReplacement={() => onRetryReplacement(item.message)}
            onToggleFeedback={(feedback) => toggleFeedback(item.message.id, feedback)}
            onOpenFiles={onOpenFiles}
            onOpenReportFile={onOpenReportFile}
            onOpenReview={onOpenReview}
            onOpenRun={onOpenRun}
          />
        )}
      />
      {latestButtonVisible ? (
        <IconButton
          className="message-feed-latest-button normal-conversation-latest-button"
          icon={ArrowDown}
          label={t("Jump to latest message")}
          onClick={() => scrollToLatest()}
        />
      ) : null}
    </div>
  );
}

function NormalConversationMessageRow({
  composerGateApproval,
  editSaving,
  editable,
  editing,
  feedback,
  item,
  generatedMedia,
  onCancelEdit,
  onEdit,
  onOpenFiles,
  onOpenReportFile,
  onOpenReview,
  onOpenRun,
  onRetryReplacement,
  onSave,
  onToggleFeedback,
  projectPath,
  replacementRetryError,
  replacementRetrying,
  workspaceCwd,
}: {
  readonly item: NormalConversationFeedItem;
  readonly composerGateApproval?: ComposerGateApprovalPresentation;
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly feedback?: "up" | "down";
  readonly editing: boolean;
  readonly editSaving: boolean;
  readonly editable: boolean;
  readonly replacementRetrying: boolean;
  readonly replacementRetryError: string;
  readonly projectPath?: string;
  readonly workspaceCwd: string;
  readonly onCancelEdit: () => void;
  readonly onEdit: () => void;
  readonly onSave: (body: string) => void | Promise<void>;
  readonly onRetryReplacement: () => void | Promise<void>;
  readonly onToggleFeedback: (feedback: "up" | "down") => void;
  readonly onOpenFiles: () => void;
  readonly onOpenReportFile: (target: WorkspaceRightDockFileTarget) => void;
  readonly onOpenReview: (target: WorkspaceRightDockReviewTarget) => void;
  readonly onOpenRun?: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { message } = item;
  const blockedAgentMessage = item.authorType === "ai-teammate"
    && (Boolean(composerGateApproval) || message.status === "blocked");
  return (
    <MessageRow
      surface="normal_conversation"
      className={item.className}
      authorType={item.authorType}
      tone={blockedAgentMessage ? "chat-blocked" : item.authorType === "system" ? "system" : "chat"}
      authorName={item.authorName}
      createdAtLabel={item.createdAtLabel}
      statusNode={message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
      body={item.body}
      bodyCwd={projectPath?.trim() || workspaceCwd.trim()}
      bodyNode={editing ? (
        <InlineMessageEditor
          initialValue={message.content}
          cwd={projectPath?.trim() || workspaceCwd.trim()}
          ariaLabel={t("Edit message")}
          saveLabel={t("Save and resend")}
          cancelLabel={t("Cancel")}
          saving={editSaving}
          warning={item.workspaceMayHaveChanged ? t("This turn changed the workspace. The edited prompt will continue from the current state.") : undefined}
          onCancel={onCancelEdit}
          onSave={onSave}
        />
      ) : (
        <ConversationTimeline
          items={item.timelineItems}
          policy={getConversationInteractionPolicy("normal_conversation")}
          timelineId={`message:${message.id}`}
          threadId={message.threadId}
          sourceKind="conversation"
          activityMode={item.bodyStreaming ? "active" : "completed"}
          cwd={projectPath?.trim() || workspaceCwd.trim()}
          onOpenSourceRef={(ref) => {
            if ((ref.kind === "file" || ref.kind === "path") && ref.path) {
              onOpenReportFile({
                cwd: projectPath?.trim() || workspaceCwd.trim(),
                path: ref.path,
                label: ref.label,
              });
            }
          }}
          ariaLabel={t("Conversation transcript")}
        />
      )}
      bodyCompact
      bodyStreaming={item.bodyStreaming}
      bodyOnOpenLocalFile={onOpenFiles}
      attachmentsNode={(message.attachments?.length ?? 0) > 0 || (message.fileRefs?.length ?? 0) > 0 ? (
        <>
          <ConversationAttachmentStrip
            attachments={(message.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: formatBytes(attachment.sizeBytes),
            icon: <FileText size={13} />,
            href: attachmentContentUrl(attachment, workspaceCwd.trim()),
            target: "_blank",
            rel: "noreferrer",
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd: workspaceCwd.trim(),
              attachmentId: attachment.id,
              scope: "conversation",
              threadId: message.threadId,
              maxBytes: 64_000,
            } : undefined,
            }))}
            loadPreview={loadPreviewContent}
          />
          <ConversationReferenceStrip
            ariaLabel={t("References")}
            references={(message.fileRefs ?? []).map((fileRef, index) => ({
              id: `file:${fileRef.path}:${fileRef.line ?? ""}:${index}`,
              kind: "workspace_file" as const,
              label: fileRef.label ?? fileRef.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? fileRef.path,
              meta: fileRef.line !== undefined ? `${fileRef.path}:${fileRef.line}` : fileRef.path,
              previewTitle: fileRef.label,
              previewText: fileRef.path,
              onOpen: () => onOpenReportFile({ cwd: workspaceCwd.trim(), path: fileRef.path, line: fileRef.line, label: fileRef.label }),
            }))}
          />
        </>
      ) : null}
      workCellNode={generatedMedia.length > 0 ? (
        <>
          {message.role === "assistant" ? (
            <ConversationGeneratedMediaBlock items={generatedMedia} cwd={workspaceCwd.trim()} />
          ) : null}
        </>
      ) : null}
      errorNode={(
        <>
          {item.errorText ? (
            <InlineFeedback
              className="normal-conversation-message-error"
              tone="danger"
              title={item.errorText}
            />
          ) : null}
          {message.pendingReplacement ? (
            <ConversationReplacementRetry
              failureReason={replacementRetryError || message.pendingReplacement.failureReason}
              retryLabel={t("Retry response")}
              retrying={replacementRetrying}
              onRetry={() => void onRetryReplacement()}
            />
          ) : null}
        </>
      )}
      actionsNode={message.content && !editing && !blockedAgentMessage ? (
        <MessageActionBar
          surface="normal_conversation"
          className="normal-conversation-message-actions"
          actions={message.role === "user" ? [
            {
              id: "copy",
              kind: "copy",
              label: t("Copy message"),
              icon: <Copy size={14} />,
              copyText: message.content,
            },
            ...(editable ? [{
              id: "edit",
              kind: "edit_latest" as const,
              label: t("Edit message"),
              icon: <Pencil size={14} />,
              onClick: onEdit,
            }] : []),
          ] : [
            {
              id: "copy",
              kind: "copy",
              label: t("Copy message"),
              icon: <Copy size={14} />,
              copyText: message.content,
            },
            {
              id: "like",
              kind: "like",
              label: t("Like response"),
              icon: <ThumbsUp size={14} />,
              selected: feedback === "up",
              onClick: () => onToggleFeedback("up"),
            },
            {
              id: "dislike",
              kind: "dislike",
              label: t("Dislike response"),
              icon: <ThumbsDown size={14} />,
              selected: feedback === "down",
              onClick: () => onToggleFeedback("down"),
            },
          ]}
        />
      ) : null}
    />
  );
}

function groupGeneratedMediaByRunId(
  items: readonly ConversationGeneratedMedia[],
): ReadonlyMap<string, readonly ConversationGeneratedMedia[]> {
  const grouped = new Map<string, ConversationGeneratedMedia[]>();
  for (const item of items) {
    grouped.set(item.runId, [...(grouped.get(item.runId) ?? []), item]);
  }
  return grouped;
}

function distanceFromLatest(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
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
