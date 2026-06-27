import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject, UIEvent } from "react";
import type { ReactVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import { ArrowDown, Copy, FileText, Image, Link2, Loader2, MessageSquare, Plus, Square, X } from "lucide-react";
import { artifactContentUrl, attachmentContentUrl } from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildConversationWorkCellViewModel, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  AvatarInitial,
  ComposerFileReferenceToken,
  MessageComposer,
  UsedMemorySummary,
  UserProfileAvatar,
  filterUsedMemoryEventsByResponse,
  pendingAssetLabel,
  type ComposerInputPart,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import {
  ConversationAttachmentStrip,
  ConversationGuidanceStrip,
  ConversationShell,
  ConversationWorkCell,
  ConversationVirtualFeed,
  ConversationViewProvider,
  MessageActionBar,
  MessageEvidencePanel,
  MessageRow,
} from "../../shared/conversation/index.js";
import type {
  AiTeammate,
  Channel,
  MemoryObject,
  RunSession,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammatePrivateAttachment,
  UsedMemoryEvent,
  UserProfile,
} from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import {
  directFileRefLabel,
  formatBytes,
  isHistoricalProviderPreflightMessage,
  teammateDirectInterventionModeLabel,
  teammateDirectInterventionStatusLabel,
} from "./teammate-workspace-utils.js";

type ComposerFileReferencePart = Extract<ComposerInputPart, { readonly type: "workspace_file" }>;

export function TeammatePrivateChatSurface({
  cwd,
  teammate,
  userProfile,
  loading,
  visibleMessages,
  normalizedMessageSearchQuery,
  privateFeedRef,
  privateMessageFeedVirtualizer,
  privateMessageFeedVirtualRows,
  usedMemoryEvents,
  memoryById,
  runs,
  providerRecovered,
  privateAttachmentById,
  creatingTask,
  taskChannelOptions,
  latestButtonVisible,
  hasDirectRuntimeActivity,
  directReplyActive,
  directGuidanceSubmitting,
  directGuidanceCancelingId,
  directGuidancePromotingId,
  openDirectInterventions,
  directLinkPreviewById,
  messageDraft,
  privateComposerSending,
  privateComposerSendDisabled,
  privateComposerSendLabel,
  privateComposerSendingLabel,
  privateComposerHasGuidancePayload,
  privateComposerPlaceholder,
  uploadingAttachments,
  pendingAttachments,
  pendingDirectLinkPreviews,
  composerFileReferenceParts,
  composerFileReferenceTokens,
  composerDragActive,
  onPrivateFeedScroll,
  onCancelPrivateFeedAutoFollow,
  onScrollToLatest,
  onCopyMessageText,
  onOpenRun,
  onCreateTaskFromMessage,
  onPromoteDirectGuidance,
  onCancelDirectGuidance,
  onEditDirectGuidance,
  onMessageDraftChange,
  onComposerSubmit,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDragOver,
  onComposerDragLeave,
  onComposerDrop,
  onUploadPrivateFiles,
  onRemoveComposerFileReference,
  onRemovePendingLinkPreview,
  onRemovePendingAttachment,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly userProfile?: UserProfile;
  readonly loading: boolean;
  readonly visibleMessages: readonly TeammateDirectMessage[];
  readonly normalizedMessageSearchQuery: string;
  readonly privateFeedRef: RefObject<HTMLDivElement>;
  readonly privateMessageFeedVirtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  readonly privateMessageFeedVirtualRows: readonly VirtualItem[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly runs: readonly RunSession[];
  readonly providerRecovered: boolean;
  readonly privateAttachmentById: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly creatingTask: boolean;
  readonly taskChannelOptions: readonly Channel[];
  readonly latestButtonVisible: boolean;
  readonly hasDirectRuntimeActivity: boolean;
  readonly directReplyActive: boolean;
  readonly directGuidanceSubmitting: "queue_followup" | "interrupt_redirect" | "stop" | "";
  readonly directGuidanceCancelingId: string;
  readonly directGuidancePromotingId: string;
  readonly openDirectInterventions: readonly TeammateDirectReplyIntervention[];
  readonly directLinkPreviewById: ReadonlyMap<string, TeammateDirectLinkPreview>;
  readonly messageDraft: string;
  readonly privateComposerSending: boolean;
  readonly privateComposerSendDisabled: boolean;
  readonly privateComposerSendLabel: string;
  readonly privateComposerSendingLabel: string;
  readonly privateComposerHasGuidancePayload: boolean;
  readonly privateComposerPlaceholder: string;
  readonly uploadingAttachments: boolean;
  readonly pendingAttachments: readonly PendingAttachmentItem<TeammatePrivateAttachment>[];
  readonly pendingDirectLinkPreviews: readonly TeammateDirectLinkPreview[];
  readonly composerFileReferenceParts: readonly ComposerFileReferencePart[];
  readonly composerFileReferenceTokens: readonly {
    readonly part: ComposerFileReferencePart;
    readonly occurrenceIndex: number;
  }[];
  readonly composerDragActive: boolean;
  readonly onPrivateFeedScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onCancelPrivateFeedAutoFollow: () => void;
  readonly onScrollToLatest: () => void;
  readonly onCopyMessageText: (text: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onCreateTaskFromMessage: (message: TeammateDirectMessage) => void | Promise<void>;
  readonly onPromoteDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onCancelDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onEditDirectGuidance: (intervention: TeammateDirectReplyIntervention) => void | Promise<void>;
  readonly onMessageDraftChange: (value: string) => void;
  readonly onComposerSubmit: () => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onUploadPrivateFiles: (files: readonly File[]) => void | Promise<void>;
  readonly onRemoveComposerFileReference: (raw: string, occurrenceIndex: number) => void;
  readonly onRemovePendingLinkPreview: (previewId: string) => void;
  readonly onRemovePendingAttachment: (localId: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const privateWorkCellByMessageId = buildPrivateWorkCellMap({
    messages: visibleMessages,
    teammateId: teammate.id,
    runs,
    t,
  });
  return (
    <ConversationShell
      className="teammate-private-chat"
      ariaLabel={t("Private chat")}
      feedNode={(
        <ConversationViewProvider surfaceId={`teammate:${teammate.id}`}>
          <ConversationVirtualFeed
            scrollRef={privateFeedRef}
            ariaLabel={t("Private message feed")}
            feedClassName="message-feed teammate-message-list"
            emptyFeedClassName="message-feed teammate-message-list message-feed-empty"
            loading={loading}
            empty={!loading && visibleMessages.length === 0}
            loadingLabel={t("Loading teammate workspace...")}
            emptyIcon={<MessageSquare size={18} />}
            emptyLabel={normalizedMessageSearchQuery ? t("No private messages match search") : t("No private messages yet")}
            totalSize={privateMessageFeedVirtualizer.getTotalSize()}
            virtualRows={privateMessageFeedVirtualRows}
            items={visibleMessages}
            getItemId={(message) => message.id}
            getItemKind={(message) => message.authorType}
            measureElement={privateMessageFeedVirtualizer.measureElement}
            onScroll={onPrivateFeedScroll}
            onUserScrollIntent={onCancelPrivateFeedAutoFollow}
            renderItem={(message) => {
              const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
              const pendingAiReply = message.authorType === "ai-teammate" && message.status === "pending";
              const blockedMessage = message.status === "blocked" || message.status === "failed" || message.status === "cancelled";
              const recoveredHistoricalProviderFailure = providerRecovered && isHistoricalProviderPreflightMessage(message);
              const authorName = message.authorType === "ai-teammate" ? teammate.displayName : message.authorType === "system" ? t("System") : localUserDisplayName;
              const messageBody = pendingAiReply && !message.body.trim()
                ? t("AI teammate is replying...")
                : message.status === "cancelled" && !message.body.trim()
                  ? t("Reply stopped")
                  : recoveredHistoricalProviderFailure
                    ? t("Historical model check failed. The model is available now; resend or continue the chat.")
                    : message.body;
              const workCell = privateWorkCellByMessageId.get(message.id);
              const workCellRun = workCell ? runs.find((run) => run.id === workCell.model.anchorRunId) : undefined;
              return (
                <MessageRow
                  className={`teammate-message-row ${message.authorType}${blockedMessage ? " blocked" : ""}`}
                  authorType={message.authorType}
                  tone={blockedMessage ? "chat-blocked" : undefined}
                  avatar={
                    message.authorType === "ai-teammate"
                      ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                      : message.authorType === "system"
                        ? <AvatarInitial label="S" tone="violet" />
                        : <UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />
                  }
                  authorName={authorName}
                  createdAtLabel={formatDateTime(message.createdAt)}
                  body={messageBody}
                  bodyCwd={cwd}
                  bodyCompact
                  bodyStreaming={pendingAiReply}
                  attachmentsNode={message.attachmentIds.length > 0 ? (
                    <ConversationAttachmentStrip
                      className="teammate-message-attachments"
                      chipClassName="teammate-attachment-chip"
                      loadPreview={loadPreviewContent}
                      attachments={message.attachmentIds
                        .map((id) => privateAttachmentById.get(id))
                        .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
                        .map((attachment) => ({
                          id: attachment.id,
                          label: attachment.fileName,
                          meta: formatBytes(attachment.sizeBytes),
                          href: attachmentContentUrl(attachment, cwd.trim()),
                          target: "_blank",
                          rel: "noreferrer",
                          icon: attachment.kind === "image" ? <Image size={13} /> : <FileText size={13} />,
                          previewRequest: attachmentCanPreview(attachment) ? {
                            source: "attachment",
                            cwd: cwd.trim(),
                            attachmentId: attachment.id,
                            scope: "teammate_private",
                            teammateId: teammate.id,
                          } : undefined,
                        }))}
                    />
                  ) : null}
                  workCellNode={workCell ? (
                    <ConversationWorkCell
                      model={workCell.model}
                      cwd={workCellRun?.cwd ?? cwd.trim()}
                      detailsState={{ status: "loaded", groups: workCell.model.groups, evidenceLinks: workCell.model.evidenceLinks }}
                      onOpenRun={onOpenRun}
                      loadPreview={loadPreviewContent}
                    />
                  ) : null}
                  evidenceNode={(messageUsedMemoryEvents.length > 0 || message.webEvidence) ? (
                    <MessageEvidencePanel
                      memoryContent={messageUsedMemoryEvents.length > 0 ? (
                        <UsedMemorySummary compact events={messageUsedMemoryEvents} memoryById={memoryById} />
                      ) : undefined}
                      memorySummary={messageUsedMemoryEvents.length > 0 ? t("Used memory") : undefined}
                      webEvidence={message.webEvidence}
                    />
                  ) : null}
                  errorNode={message.errorMessage && message.status !== "cancelled" && !recoveredHistoricalProviderFailure ? <small className="teammate-message-error">{message.errorMessage}</small> : null}
                  actionsNode={(
                    <MessageActionBar
                      surface="teammate_direct"
                      className="teammate-message-actions"
                      actions={[
                        {
                          id: "copy",
                          kind: "copy",
                          label: t("Copy message"),
                          icon: <Copy size={14} />,
                          onClick: () => onCopyMessageText(message.body),
                        },
                        {
                          id: "create-task",
                          kind: "create_task",
                          label: t("Create task"),
                          icon: creatingTask ? <Loader2 className="spin" size={14} /> : <Plus size={14} />,
                          className: "secondary-button compact-button",
                          disabled: creatingTask || taskChannelOptions.length === 0,
                          onClick: () => void onCreateTaskFromMessage(message),
                        },
                      ]}
                    />
                  )}
                />
              );
            }}
            latestButtonNode={
              latestButtonVisible ? (
                <button className="message-feed-latest-button" type="button" onClick={onScrollToLatest} aria-label={t("Jump to latest message")}>
                  <ArrowDown size={22} />
                </button>
              ) : null
            }
          />
        </ConversationViewProvider>
      )}
      composerNode={(
        <>
          {hasDirectRuntimeActivity ? (
            <ConversationGuidanceStrip
              title={directReplyActive ? t("Replying") : t("Private guidance")}
              description={directReplyActive ? t("Stop the current reply or queue new guidance.") : t("Guidance is queued.")}
              submitting={directGuidanceSubmitting}
              stopDisabled={!directReplyActive}
              items={openDirectInterventions.map((intervention) => {
                const isQueued = intervention.status === "queued";
                const rowBusy = directGuidanceCancelingId === intervention.id || directGuidancePromotingId === intervention.id;

                return {
                  id: intervention.id,
                  instruction: intervention.messagePayload?.body || intervention.instruction,
                  attachments: (intervention.messagePayload?.attachmentIds ?? [])
                    .map((attachmentId) => privateAttachmentById.get(attachmentId))
                    .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
                    .map((attachment) => ({ id: attachment.id, label: attachment.fileName })),
                  linkPreviews: (intervention.messagePayload?.linkPreviewIds ?? [])
                    .map((previewId) => directLinkPreviewById.get(previewId))
                    .filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview))
                    .map((preview) => ({ id: preview.id, label: preview.title || preview.siteName || preview.url })),
                  fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((fileRef, index) => ({
                    id: `${intervention.id}:file:${index}`,
                    label: directFileRefLabel(fileRef),
                  })),
                  statusLabel: teammateDirectInterventionStatusLabel(intervention.status, t),
                  meta: teammateDirectInterventionModeLabel(intervention.mode, t),
                  promoteLabel: t("Run this guidance now"),
                  promoteDisabled: rowBusy || Boolean(directGuidanceSubmitting),
                  promoteLoading: directGuidancePromotingId === intervention.id,
                  onPromote: isQueued ? () => void onPromoteDirectGuidance(intervention.id) : undefined,
                  deleteLabel: t("Delete queued guidance"),
                  deleteDisabled: rowBusy,
                  deleteLoading: directGuidanceCancelingId === intervention.id,
                  onDelete: isQueued ? () => void onCancelDirectGuidance(intervention.id) : undefined,
                  moreLabel: t("More guidance actions"),
                  editLabel: t("Edit message"),
                  editDisabled: rowBusy,
                  onEdit: isQueued ? () => void onEditDirectGuidance(intervention) : undefined,
                  closeQueueLabel: t("Close queue"),
                  closeQueueDisabled: rowBusy,
                  closeQueueLoading: directGuidanceCancelingId === intervention.id,
                  onCloseQueue: isQueued ? () => void onCancelDirectGuidance(intervention.id) : undefined,
                };
              })}
            />
          ) : null}
          <MessageComposer
            className="teammate-direct-composer"
            label={t("Private chat composer")}
            value={messageDraft}
            rows={3}
            sending={privateComposerSending}
            sendDisabled={privateComposerSendDisabled}
            sendLabel={privateComposerSendLabel}
            sendingLabel={privateComposerSendingLabel}
            sendIcon={directReplyActive ? (privateComposerHasGuidancePayload ? undefined : <Square size={15} />) : undefined}
            attachLabel={uploadingAttachments ? t("Uploading...") : t("Attach files")}
            accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
            placeholder={privateComposerPlaceholder}
            onChange={onMessageDraftChange}
            onSend={onComposerSubmit}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
            onAttachFiles={(files) => void onUploadPrivateFiles(Array.from(files))}
            dropZoneClassName={composerDragActive ? "active" : undefined}
            previewContent={pendingAttachments.length > 0 || pendingDirectLinkPreviews.length > 0 || composerFileReferenceParts.length > 0 ? (
              <div className="pending-assets composer-preview-strip" aria-label={t("Pending message assets")}>
                {composerFileReferenceTokens.map(({ occurrenceIndex, part }, index) => (
                  <ComposerFileReferenceToken
                    key={`${part.raw}-${index}`}
                    path={part.path}
                    line={part.line}
                    removeLabel={t("Remove file reference")}
                    onRemove={() => onRemoveComposerFileReference(part.raw, occurrenceIndex)}
                  />
                ))}
                {pendingDirectLinkPreviews.map((preview) => (
                  <div key={preview.id} className="composer-preview-card link ready">
                    <span className="composer-preview-file-icon" aria-hidden="true">
                      <Link2 size={16} />
                    </span>
                    <span className="composer-preview-body">
                      <strong title={preview.url}>{preview.title || preview.siteName || preview.url}</strong>
                      <small>{preview.normalizedUrl}</small>
                    </span>
                    <button className="composer-preview-remove" type="button" onClick={() => onRemovePendingLinkPreview(preview.id)} aria-label={t("Remove link preview")}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {pendingAttachments.map((item) => (
                  <div key={item.localId} className={`composer-preview-card ${item.previewUrl ? "image" : "file"} ${item.state}`}>
                    {item.previewUrl ? (
                      <img className="composer-preview-thumbnail" src={item.previewUrl} alt={item.fileName} />
                    ) : (
                      <span className="composer-preview-file-icon" aria-hidden="true">
                        <FileText size={17} />
                      </span>
                    )}
                    <span className="composer-preview-body">
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <small>{item.error ?? `${t(pendingAssetLabel(item.state))} · ${formatBytes(item.attachment?.sizeBytes ?? item.sizeBytes)}`}</small>
                    </span>
                    {item.state === "uploading" ? <Loader2 className="composer-preview-state-icon spin" size={13} /> : null}
                    <button className="composer-preview-remove" type="button" onClick={() => void onRemovePendingAttachment(item.localId)} aria-label={t("Remove pending attachment")}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            overlayContent={composerDragActive ? (
              <div className="composer-drop-hint">
                <FileText size={16} />
                <span>{t("Drop files to attach")}</span>
              </div>
            ) : null}
          />
        </>
      )}
    />
  );
}

function buildPrivateWorkCellMap(input: {
  readonly messages: readonly TeammateDirectMessage[];
  readonly teammateId: string;
  readonly runs: readonly RunSession[];
  readonly t: Translate;
}): ReadonlyMap<string, { readonly model: ConversationWorkCellViewModel }> {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const cells = new Map<string, { readonly model: ConversationWorkCellViewModel }>();
  for (const message of input.messages) {
    if (message.authorType !== "ai-teammate" || !message.linkedRunId) {
      continue;
    }
    const run = runById.get(message.linkedRunId);
    if (!run?.threadId) {
      continue;
    }
    if (run.teammateId && run.teammateId !== input.teammateId) {
      continue;
    }
    const model = buildConversationWorkCellViewModel({
      threadId: run.threadId,
      runs: [run],
      allowRunThreadFallback: true,
      approvals: [],
      artifactsByRun: {},
      t: input.t,
      artifactHref: (artifact) => artifactContentUrl(artifact.id, run.cwd),
    });
    if (model) {
      cells.set(message.id, { model });
    }
  }
  return cells;
}
