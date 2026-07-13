import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefCallback, type RefObject, type UIEvent } from "react";
import type { ReactVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import { ArrowDown, Copy, FileText, Image, Link2, Loader2, MessageSquare, Pencil, Plus, Send, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { artifactContentUrl, attachmentContentUrl, editConversationMessage } from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildConversationWorkCellViewModel, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  AvatarInitial,
  ComposerFileReferenceToken,
  UsedMemorySummary,
  UsedMemorySummaryLabel,
  UserProfileAvatar,
  filterUsedMemoryEventsByResponse,
  pendingAssetLabel,
  type ComposerInputPart,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import {
  ComposerPermissionMenu,
  ConversationAttachmentStrip,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  ConversationComposerShell,
  ConversationGuidanceStrip,
  InlineMessageEditor,
  ConversationShell,
  ConversationWorkCell,
  ConversationVirtualFeed,
  ConversationViewProvider,
  MessageActionBar,
  MessageEvidencePanel,
  MessageRow,
  TokenizedComposerInput,
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  type ActiveSlashCommandPicker,
  type TokenizedComposerInputHandle,
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
  PermissionPreset,
  PermissionConfirmation,
  SessionPermissionMode,
  TerminalReportDto,
} from "../../types.js";
import { conversationPermissionPresetMenuOptions, inferPermissionPreset } from "../../lib/session-permissions.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import {
  directFileRefLabel,
  formatBytes,
  isHistoricalProviderPreflightMessage,
  teammateDirectInterventionModeLabel,
  teammateDirectInterventionStatusLabel,
} from "./teammate-workspace-utils.js";
import {
  ConversationSummaryPopover,
  WorkspaceRightDock,
  type ConversationSummaryRow,
  type WorkspaceRightDockPageRequest,
} from "../workspace/right-dock/index.js";
import { useWorkspaceBottomPanelResizeController } from "../workspace/useWorkspaceBottomPanelResizeController.js";
import { useWorkspaceRightDockController } from "../workspace/useWorkspaceRightDockController.js";
import { useWorkspaceTerminalSession, WorkspaceTerminalPanel } from "../workspace/WorkspaceTerminalPanel.js";
import { buildTeammatePrivateDockContent } from "./teammate-private-dock.js";

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
  terminalReports,
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
  slashCommands,
  composerInputParts,
  composerFileReferenceParts,
  composerFileReferenceTokens,
  composerDragActive,
  onPrivateFeedScroll,
  onCancelPrivateFeedAutoFollow,
  onScrollToLatest,
  onCopyMessageText,
  onOpenRun,
  onOpenFiles,
  onCreateTaskFromMessage,
  onPromoteDirectGuidance,
  onCancelDirectGuidance,
  onEditDirectGuidance,
  onRefreshMessages,
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
  defaultPermissionMode,
  defaultPermissionPreset,
  dockOpen,
  dockPageRequest,
  dockActions,
  terminalOpen,
  summaryRendered,
  summaryExpanded,
  summaryMotionClass,
  summaryPlacementRef,
  summaryRows,
  contextNode,
  contextCount,
  onSummaryClose,
  onDockPageRequestConsumed,
  onDockClose,
  onTerminalClose,
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
  readonly terminalReports: readonly TerminalReportDto[];
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
  readonly slashCommands: readonly { readonly id: string; readonly label: string }[];
  readonly composerInputParts: readonly ComposerInputPart[];
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
  readonly onOpenFiles: () => void;
  readonly onCreateTaskFromMessage: (message: TeammateDirectMessage) => void | Promise<void>;
  readonly onPromoteDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onCancelDirectGuidance: (interventionId: string) => void | Promise<void>;
  readonly onEditDirectGuidance: (intervention: TeammateDirectReplyIntervention) => void | Promise<void>;
  readonly onRefreshMessages: () => void | Promise<void>;
  readonly onMessageDraftChange: (value: string) => void;
  readonly onComposerSubmit: (authorization: {
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  }) => void;
  readonly onComposerKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    authorization: {
      readonly permissionPreset: PermissionPreset;
      readonly permissionConfirmation?: PermissionConfirmation;
    },
  ) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onUploadPrivateFiles: (files: readonly File[]) => void | Promise<void>;
  readonly onRemoveComposerFileReference: (raw: string, occurrenceIndex: number) => void;
  readonly onRemovePendingLinkPreview: (previewId: string) => void;
  readonly onRemovePendingAttachment: (localId: string) => void | Promise<void>;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly dockOpen: boolean;
  readonly dockPageRequest?: WorkspaceRightDockPageRequest;
  readonly dockActions?: ReactNode;
  readonly terminalOpen: boolean;
  readonly summaryRendered: boolean;
  readonly summaryExpanded: boolean;
  readonly summaryMotionClass: "is-popover-expanded" | "is-popover-collapsed";
  readonly summaryPlacementRef: RefCallback<HTMLElement>;
  readonly summaryRows: readonly ConversationSummaryRow[];
  readonly contextNode?: JSX.Element;
  readonly contextCount?: number;
  readonly onSummaryClose: () => void;
  readonly onDockPageRequestConsumed: (nonce: number) => void;
  readonly onDockClose: () => void;
  readonly onTerminalClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [messageFeedbackById, setMessageFeedbackById] = useState<Record<string, "up" | "down">>({});
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(() => defaultPermissionPreset ?? inferPermissionPreset(defaultPermissionMode));
  const [permissionConfirmation, setPermissionConfirmation] = useState<PermissionConfirmation | undefined>();
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | undefined>();
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [replacementRetryingMessageId, setReplacementRetryingMessageId] = useState<string>();
  const [replacementRetryError, setReplacementRetryError] = useState("");
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const privateDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: dockOpen,
    resizeObserverKey: `${teammate.id}:${cwd.trim()}`,
  });
  const privateBottomPanelResize = useWorkspaceBottomPanelResizeController({
    containerRef: privateDockController.containerRef,
    resizeObserverKey: `${teammate.id}:${cwd.trim()}`,
  });
  const workspaceTerminalSession = useWorkspaceTerminalSession(cwd.trim());
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const latestEditableMessageId = [...visibleMessages].reverse().find((message) => message.authorType === "local-user" && !message.pendingReplacement)?.id;
  const privateWorkCellByMessageId = buildPrivateWorkCellMap({
    messages: visibleMessages,
    teammateId: teammate.id,
    runs,
    terminalReports,
    t,
  });
  const privateDockContent = useMemo(
    () => buildTeammatePrivateDockContent({
      messages: visibleMessages,
      attachments: [...privateAttachmentById.values()],
      runs,
      teammateDisplayName: teammate.displayName,
      t,
    }),
    [privateAttachmentById, runs, teammate.displayName, t, visibleMessages],
  );
  const permissionLocked = privateComposerSending || hasDirectRuntimeActivity || Boolean(directGuidanceSubmitting);
  const slashCommandPickerOptions = filterSlashCommandPickerOptions(slashCommands, slashPicker);
  const privateComposerCurrentSendIcon = privateComposerSending
    ? <Loader2 className="spin" size={15} />
    : directReplyActive && !privateComposerHasGuidancePayload
      ? <Square size={15} />
      : <Send size={15} />;
  const summaryInMainLayout = summaryRendered && dockOpen;
  const summaryNode = (
    <ConversationSummaryPopover
      title={t("Environment")}
      subtitle={teammate.displayName}
      rows={summaryRows}
      onClose={onSummaryClose}
    />
  );

  useEffect(() => {
    setSelectedPermissionPreset(defaultPermissionPreset ?? inferPermissionPreset(defaultPermissionMode));
    setPermissionConfirmation(undefined);
  }, [defaultPermissionMode, defaultPermissionPreset]);

  function confirmPermissionChange(preset: PermissionPreset): boolean {
    if (preset !== "full_access") {
      return true;
    }
    const confirmed = typeof globalThis.confirm === "function"
      ? globalThis.confirm(t("Full access can allow broad local file, network, and tool access for the next run. Continue?"))
      : false;
    if (confirmed) {
      setPermissionConfirmation({
        mode: "full_access",
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        reason: "Confirmed from teammate private composer",
      });
    }
    return confirmed;
  }

  function submitComposer(): void {
    let confirmation = permissionConfirmation;
    if (selectedPermissionPreset === "full_access" && !confirmation) {
      if (!confirmPermissionChange("full_access")) {
        return;
      }
      confirmation = {
        mode: "full_access",
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        reason: "Confirmed from teammate private composer",
      };
      setPermissionConfirmation(confirmation);
    }
    onComposerSubmit({
      permissionPreset: selectedPermissionPreset,
      permissionConfirmation: confirmation,
    });
  }

  async function saveMessageEdit(message: TeammateDirectMessage, body: string): Promise<void> {
    if (editSaving) {
      return;
    }
    setEditSaving(true);
    setEditError("");
    setReplacementRetryError("");
    try {
      await editConversationMessage(cwd.trim(), {
        surface: "teammate_direct",
        ownerId: teammate.id,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: teammate.providerPresetId,
        permissionPreset: selectedPermissionPreset,
        permissionConfirmation,
        idempotencyKey: `teammate-message-edit:${message.id}:${crypto.randomUUID()}`,
      });
      setEditingMessageId(undefined);
      await onRefreshMessages();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function retryMessageReplacement(message: TeammateDirectMessage): Promise<void> {
    const pending = message.pendingReplacement;
    if (!pending || replacementRetryingMessageId) {
      return;
    }
    setReplacementRetryingMessageId(message.id);
    setReplacementRetryError("");
    try {
      const result = await editConversationMessage(cwd.trim(), {
        surface: "teammate_direct",
        ownerId: teammate.id,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body: message.body,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: teammate.providerPresetId,
        permissionPreset: selectedPermissionPreset,
        permissionConfirmation,
        idempotencyKey: pending.idempotencyKey,
      });
      if (result.status === "replacement_pending") {
        setReplacementRetryError(result.failureReason ?? pending.failureReason ?? "");
      }
      await onRefreshMessages();
    } catch (error) {
      setReplacementRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacementRetryingMessageId(undefined);
    }
  }

  useEffect(() => {
    if (!privateComposerSending) {
      return;
    }
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [privateComposerSending]);

  function updateSlashPicker(value: string, caret: number): void {
    setSlashPicker(findActiveSlashCommand(value, caret));
    setSlashActiveIndex(0);
  }

  function focusComposerAt(caret: number): void {
    const focus = (): void => {
      composerInputRef.current?.focusAt(caret);
    };
    focus();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focus);
      return;
    }
    globalThis.setTimeout(focus, 0);
  }

  function commitSlashCommand(option: { readonly id: string }): void {
    const composer = composerInputRef.current;
    const liveValue = messageDraft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
    const picker = slashPicker ?? findActiveSlashCommand(liveValue, liveCaret) ?? findActiveSlashCommand(liveValue, liveValue.length);
    const inserted = insertSlashCommandToken(liveValue, picker, option.id);
    onMessageDraftChange(inserted.value);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function handleComposerInputKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (slashPicker && slashCommandPickerOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashCommandPickerOptions.length) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commitSlashCommand(slashCommandPickerOptions[Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPicker(undefined);
        setSlashActiveIndex(0);
        return;
      }
    }
    let confirmation = permissionConfirmation;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedPermissionPreset === "full_access" && !confirmation) {
      if (!confirmPermissionChange("full_access")) {
        event.preventDefault();
        return;
      }
      confirmation = {
        mode: "full_access",
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        reason: "Confirmed from teammate private composer",
      };
      setPermissionConfirmation(confirmation);
    }
    onComposerKeyDown(event, {
      permissionPreset: selectedPermissionPreset,
      permissionConfirmation: confirmation,
    });
  }

  function toggleMessageFeedback(messageId: string, feedback: "up" | "down"): void {
    setMessageFeedbackById((current) => {
      if (current[messageId] === feedback) {
        const next = { ...current };
        delete next[messageId];
        return next;
      }
      return { ...current, [messageId]: feedback };
    });
  }

  return (
    <ConversationShell
      rootRef={privateDockController.containerRef}
      style={{
        ...privateDockController.containerStyle,
        ...privateBottomPanelResize.panelStyle,
      }}
      className={[
        "teammate-private-chat",
        privateDockController.visible ? "with-right-dock" : "",
        summaryInMainLayout ? "with-conversation-summary-panel" : "",
        summaryInMainLayout ? (summaryExpanded ? "summary-panel-expanded" : "summary-panel-collapsed") : "",
        privateDockController.visible && !privateDockController.expanded ? "workspace-right-dock-collapsed" : "",
        terminalOpen ? "with-bottom-terminal" : "",
        privateDockController.resizing ? "is-resizing-workspace-right-dock" : "",
        privateBottomPanelResize.resizing ? "is-resizing-workspace-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
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
              const workCell = privateWorkCellByMessageId.get(message.id);
              const hasStructuredTerminalReport = Boolean(workCell?.model.terminalReportRows.length);
              const messageBody = hasStructuredTerminalReport
                ? ""
                : pendingAiReply && !message.body.trim()
                ? t("AI teammate is replying...")
                : message.status === "cancelled" && !message.body.trim()
                  ? t("Reply stopped")
                  : recoveredHistoricalProviderFailure
                    ? t("Historical model check failed. The model is available now; resend or continue the chat.")
                    : message.body;
              const workCellRun = workCell ? runs.find((run) => run.id === workCell.model.anchorRunId) : undefined;
              const messageFeedback = messageFeedbackById[message.id];
              const editing = editingMessageId === message.id;
              const messageFileRefs = message.fileRefs ?? [];
              const messageLinkPreviews = (message.linkPreviewIds ?? [])
                .map((id) => directLinkPreviewById.get(id))
                .filter((preview): preview is TeammateDirectLinkPreview => preview?.status === "ready");
              const feedbackActions = message.authorType === "ai-teammate" ? [
                {
                  id: "like",
                  kind: "like" as const,
                  label: t("Like response"),
                  icon: <ThumbsUp size={14} />,
                  selected: messageFeedback === "up",
                  onClick: () => toggleMessageFeedback(message.id, "up"),
                },
                {
                  id: "dislike",
                  kind: "dislike" as const,
                  label: t("Dislike response"),
                  icon: <ThumbsDown size={14} />,
                  selected: messageFeedback === "down",
                  onClick: () => toggleMessageFeedback(message.id, "down"),
                },
              ] : [];
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
                  statusNode={message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
                  body={messageBody}
                  bodyNode={editing ? (
                    <div className="conversation-inline-message-editor-stack">
                      <InlineMessageEditor
                        initialValue={message.body}
                        cwd={cwd}
                        ariaLabel={t("Edit message")}
                        saveLabel={t("Save and resend")}
                        cancelLabel={t("Cancel")}
                        saving={editSaving}
                        onCancel={() => {
                          setEditError("");
                          setEditingMessageId(undefined);
                        }}
                        onSave={(value) => saveMessageEdit(message, value)}
                      />
                      {editError ? <div className="inline-error compact-inline-error" role="alert">{editError}</div> : null}
                    </div>
                  ) : undefined}
                  bodyCwd={cwd}
                  bodyCompact
                  bodyStreaming={pendingAiReply}
                  bodyOnOpenLocalFile={onOpenFiles}
                  attachmentsNode={(message.attachmentIds ?? []).length > 0 || messageFileRefs.length > 0 || messageLinkPreviews.length > 0 ? (
                    <>
                      <ConversationAttachmentStrip
                        className="teammate-message-attachments"
                        chipClassName="teammate-attachment-chip"
                        loadPreview={loadPreviewContent}
                        attachments={(message.attachmentIds ?? [])
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
                      <ConversationReferenceStrip
                        ariaLabel={t("References")}
                        references={[
                          ...messageFileRefs.map((fileRef, index) => ({
                            id: `file:${fileRef.path}:${fileRef.line ?? ""}:${index}`,
                            kind: "workspace_file" as const,
                            label: fileRef.label ?? fileNameFromReferencePath(fileRef.path),
                            meta: fileRef.line !== undefined ? `${fileRef.path}:${fileRef.line}` : fileRef.path,
                            previewTitle: fileRef.label ?? fileNameFromReferencePath(fileRef.path),
                            previewText: fileRef.path,
                            onOpen: onOpenFiles,
                          })),
                          ...messageLinkPreviews.map((preview) => ({
                            id: `web:${preview.id}`,
                            kind: "web" as const,
                            label: preview.title ?? preview.siteName ?? webReferenceHost(preview.normalizedUrl || preview.url),
                            meta: preview.siteName ?? webReferenceHost(preview.normalizedUrl || preview.url),
                            href: preview.normalizedUrl || preview.url,
                            previewTitle: preview.title,
                            previewText: preview.description,
                          })),
                        ]}
                      />
                    </>
                  ) : null}
                  workCellNode={workCell ? (
                    <ConversationWorkCell
                      model={workCell.model}
                      surface="teammate_direct"
                      cwd={workCellRun?.cwd ?? cwd.trim()}
                      detailsState={{ status: "loaded", groups: workCell.model.groups, evidenceLinks: workCell.model.evidenceLinks }}
                      onOpenRun={onOpenRun}
                      loadPreview={loadPreviewContent}
                    />
                  ) : null}
                  evidenceNode={(messageUsedMemoryEvents.length > 0 || message.webEvidence) ? (
                    <MessageEvidencePanel
                      memoryContent={messageUsedMemoryEvents.length > 0 ? (
                        <UsedMemorySummary variant="inline" events={messageUsedMemoryEvents} memoryById={memoryById} />
                      ) : undefined}
                      memorySummary={messageUsedMemoryEvents.length > 0 ? <UsedMemorySummaryLabel events={messageUsedMemoryEvents} /> : undefined}
                      webEvidence={message.webEvidence}
                    />
                  ) : null}
                  errorNode={(
                    <>
                      {message.errorMessage && message.status !== "cancelled" && !recoveredHistoricalProviderFailure ? <small className="teammate-message-error">{message.errorMessage}</small> : null}
                      {message.pendingReplacement ? (
                        <ConversationReplacementRetry
                          failureReason={replacementRetryError || message.pendingReplacement.failureReason}
                          retryLabel={t("Retry response")}
                          retrying={replacementRetryingMessageId === message.id}
                          onRetry={() => void retryMessageReplacement(message)}
                        />
                      ) : null}
                    </>
                  )}
                  actionsNode={!editing ? (
                    <MessageActionBar
                      surface="teammate_direct"
                      className="teammate-message-actions"
                      copiedLabel={t("Copied")}
                      actions={[
                        {
                          id: "copy",
                          kind: "copy",
                          label: t("Copy message"),
                          icon: <Copy size={14} />,
                          onClick: () => onCopyMessageText(message.body),
                        },
                        ...(message.authorType === "local-user" && message.id === latestEditableMessageId ? [{
                          id: "edit",
                          kind: "edit_latest" as const,
                          label: t("Edit message"),
                          icon: <Pencil size={14} />,
                          onClick: () => {
                            setEditError("");
                            setEditingMessageId(message.id);
                          },
                        }] : []),
                        ...feedbackActions,
                        {
                          id: "create-task",
                          kind: "create_task" as const,
                          label: t("Create task"),
                          icon: creatingTask ? <Loader2 className="spin" size={14} /> : <Plus size={14} />,
                          disabled: creatingTask || taskChannelOptions.length === 0,
                          onClick: () => void onCreateTaskFromMessage(message),
                        },
                      ]}
                    />
                  ) : null}
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
          <ConversationComposerShell
            surface="teammate_direct"
            density="docked"
            className="teammate-direct-composer"
            ariaLabel={t("Private chat composer")}
            dropZoneClassName={composerDragActive ? "active" : undefined}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
            previewNode={pendingAttachments.length > 0 || pendingDirectLinkPreviews.length > 0 || composerFileReferenceParts.length > 0 ? (
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
            inputNode={(
              <TokenizedComposerInput
                ref={composerInputRef}
                value={messageDraft}
                parts={composerInputParts}
                onChange={(value, caret) => {
                  onMessageDraftChange(value);
                  updateSlashPicker(value, caret);
                }}
                onKeyDown={handleComposerInputKeyDown}
                onPaste={onComposerPaste}
                onSelect={updateSlashPicker}
                placeholder={privateComposerPlaceholder}
                ariaLabel={privateComposerPlaceholder}
              />
            )}
            slashPickerNode={slashPicker ? (
              <div className="mention-picker-popover command-picker-popover conversation-composer-popover" role="listbox" aria-label={t("Slash command")}>
                {slashCommandPickerOptions.length > 0 ? slashCommandPickerOptions.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={index === Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)}
                    className={index === Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1) ? "mention-suggestion command active" : "mention-suggestion command"}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commitSlashCommand(option)}
                  >
                    <span>/{option.id}</span>
                    <small>{option.label}</small>
                  </button>
                )) : (
                  <span className="mention-suggestion empty">{t("No matching commands")}</span>
                )}
              </div>
            ) : null}
            dropHintNode={composerDragActive ? (
              <div className="composer-drop-hint">
                <FileText size={16} />
                <span>{t("Drop files to attach")}</span>
              </div>
            ) : null}
            leftToolsNode={(
              <>
                <label className="icon-button composer-tool-button composer-attach-button" aria-label={uploadingAttachments ? t("Uploading...") : t("Attach files")} title={uploadingAttachments ? t("Uploading...") : t("Attach files")}>
                  <Plus size={17} />
                  <input
                    type="file"
                    multiple
                    hidden
                    accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
                    onChange={(event) => {
                      const files = event.currentTarget.files;
                      if (files && files.length > 0) {
                        void onUploadPrivateFiles(Array.from(files));
                      }
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <ComposerPermissionMenu
                  preset={selectedPermissionPreset}
                  options={conversationPermissionPresetMenuOptions(t)}
                  disabled={permissionLocked}
                  disabledReason={t("Permission is locked while the private reply is running.")}
                  fullAccessConfirmationMessage={t("Full access can allow broad local file, network, and tool access for the next run. Continue?")}
                  confirmChange={confirmPermissionChange}
                  onPresetChange={(preset) => {
                    setSelectedPermissionPreset(preset);
                    if (preset !== "full_access") {
                      setPermissionConfirmation(undefined);
                    }
                  }}
                />
              </>
            )}
            rightToolsNode={(
              <button
                className="primary-button composer-send-button"
                type="button"
                onClick={submitComposer}
                disabled={privateComposerSendDisabled || privateComposerSending}
                aria-label={privateComposerSending ? privateComposerSendingLabel : privateComposerSendLabel}
                title={privateComposerSending ? privateComposerSendingLabel : privateComposerSendLabel}
              >
                {privateComposerCurrentSendIcon}
              </button>
            )}
          />
        </>
      )}
      sideNode={(
        <>
          {summaryInMainLayout ? (
            <aside
              ref={summaryPlacementRef}
              className={`channel-progress-popover channel-progress-panel conversation-summary-side-panel teammate-private-summary-panel ${summaryMotionClass}`}
              aria-label={t("Summary")}
            >
              {summaryNode}
            </aside>
          ) : null}
          {privateDockController.visible ? (
            <button
              className="workspace-right-dock-resize-handle"
              type="button"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("Resize workspace dock")}
              title={t("Drag to resize workspace dock")}
              onPointerDown={privateDockController.handleResizePointerDown}
              onPointerMove={privateDockController.handleResizePointerMove}
              onPointerUp={privateDockController.handleResizePointerEnd}
              onPointerCancel={privateDockController.handleResizePointerEnd}
              onLostPointerCapture={privateDockController.handleResizePointerEnd}
            />
          ) : null}
          {privateDockController.visible ? (
            <div className="workspace-right-dock-frame teammate-private-right-dock-frame">
              <WorkspaceRightDock
                surface="teammate_direct"
                open={dockOpen}
                ariaLabel={t("Private chat workspace dock")}
                className="teammate-private-right-dock"
                cwd={cwd.trim()}
                launcherTitle={t("Workspace tools")}
                launcherSubtitle={teammate.displayName}
                reviewItems={privateDockContent.reviewItems}
                evidenceGroups={privateDockContent.evidenceGroups}
                fileItems={privateDockContent.fileItems}
                terminalSession={workspaceTerminalSession}
                includeActivity
                activityNode={contextNode}
                activityCount={contextCount}
                actions={dockActions}
                pageRequest={dockPageRequest}
                onPageRequestConsumed={onDockPageRequestConsumed}
                onClose={onDockClose}
              />
            </div>
          ) : null}
          {terminalOpen ? (
            <WorkspaceTerminalPanel
              cwd={cwd.trim()}
              className="workspace-bottom-terminal teammate-private-bottom-terminal"
              session={workspaceTerminalSession}
              style={privateBottomPanelResize.panelStyle}
              resizeHandleNode={(
                <button
                  className="workspace-bottom-panel-resize-handle"
                  type="button"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={t("Resize terminal panel")}
                  title={t("Drag to resize terminal panel")}
                  onPointerDown={privateBottomPanelResize.handleResizePointerDown}
                  onPointerMove={privateBottomPanelResize.handleResizePointerMove}
                  onPointerUp={privateBottomPanelResize.handleResizePointerEnd}
                  onPointerCancel={privateBottomPanelResize.handleResizePointerEnd}
                  onLostPointerCapture={privateBottomPanelResize.handleResizePointerEnd}
                />
              )}
              onClose={onTerminalClose}
            />
          ) : null}
        </>
      )}
    />
  );
}

function buildPrivateWorkCellMap(input: {
  readonly messages: readonly TeammateDirectMessage[];
  readonly teammateId: string;
  readonly runs: readonly RunSession[];
  readonly terminalReports: readonly TerminalReportDto[];
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
      terminalReport: input.terminalReports.find((report) =>
        (report.source.kind === "run" && report.source.id === run.id) ||
        (Boolean(report.threadId) && report.threadId === run.threadId)
      ),
    });
    if (model) {
      cells.set(message.id, { model });
    }
  }
  return cells;
}

function fileNameFromReferencePath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function webReferenceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./iu, "");
  } catch {
    return value;
  }
}
