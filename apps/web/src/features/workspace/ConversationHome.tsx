import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  FileText,
  Folder,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { deleteAttachment, editConversationMessage, uploadConversationAttachment } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type { ConversationAttachment, PermissionConfirmation, PermissionPreset, ProviderThinkingMode } from "../../types.js";
import {
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  parseComposerInputParts,
  revokePendingAttachmentPreviews,
  type ActiveSlashCommandPicker,
  type PendingAttachmentItem,
  type TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import { permissionPresetForWorkspaceAccessMode, workspaceAccessModeForPermissionPreset } from "../../lib/session-permissions.js";
import { authorizationAndAccessToLegacyPermission, resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import type {
  WorkspaceRightDockFileTarget,
  WorkspaceRightDockReviewTarget,
} from "./right-dock/index.js";
import { useWorkspaceBottomPanelResizeController } from "./useWorkspaceBottomPanelResizeController.js";
import { useWorkspaceRightDockController } from "./useWorkspaceRightDockController.js";
import { useConversationPanelPresence } from "./useConversationPanelPresence.js";
import { NormalConversationComposer } from "./NormalConversationComposer.js";
import { NormalConversationEmptyState } from "./NormalConversationEmptyState.js";
import { NormalConversationPage } from "./NormalConversationPage.js";
import {
  buildNormalConversationDockViewModel,
  runTaskSnapshotTitle,
} from "./normal-conversation-dock-projections.js";
import { normalConversationThinkingOptions } from "./normal-conversation-composer-options.js";
import type {
  ConversationHomeMessage,
  ConversationHomeModelOption,
  ConversationHomeProjectSelection,
  ConversationHomeProps,
} from "./normal-conversation-types.js";
import { useNormalConversationHeaderController } from "./useNormalConversationHeaderController.js";
import { useChannelPlanHistory } from "./useChannelPlanHistory.js";
import { useWorkspaceTerminalSession } from "./WorkspaceTerminalPanel.js";

export type {
  ConversationHomeDetailContext,
  ConversationHomeMessage,
  ConversationHomeModelOption,
  ConversationHomeModelSelection,
  ConversationHomeProjectSelection,
  ConversationHomeProps,
  ConversationHomeSendInput,
} from "./normal-conversation-types.js";
export function ConversationHome({
  conversationTitle = "",
  initialDraft = "",
  initialMessages = [],
  initialProjectPath = "",
  initialProjectLabel = "",
  initialProviderPresetId = "",
  initialThinkingLevel = "off",
  initialAuthorizationMode,
  initialWorkspaceAccessMode,
  initialPermissionMode,
  initialPermissionPreset,
  detailContext,
  defaultProviderLabel,
  defaultProviderPresetId,
  modelOptions,
  slashCommands,
  workspaceCwd,
  sending = false,
  activeRun,
  stopping = false,
  onOpenRun,
  onConfirmFullAccess,
  onRefreshConversation,
  onStopConversation,
  onSendConversation,
}: ConversationHomeProps): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [messages, setMessages] = useState<readonly ConversationHomeMessage[]>(initialMessages);
  const [localSending, setLocalSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [selectedProviderPresetId, setSelectedProviderPresetId] = useState(initialProviderPresetId.trim());
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<ProviderThinkingMode>(initialThinkingLevel);
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(() => permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
    initialWorkspaceAccessMode,
    initialPermissionMode,
    initialPermissionPreset,
  )));
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [conversationDockOpen, setConversationDockOpen] = useState(false);
  const [conversationSummaryOpen, setConversationSummaryOpen] = useState(false);
  const [conversationTerminalOpen, setConversationTerminalOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | undefined>();
  const [editSaving, setEditSaving] = useState(false);
  const [replacementRetryingMessageId, setReplacementRetryingMessageId] = useState<string>();
  const [replacementRetryError, setReplacementRetryError] = useState("");
  const [project, setProject] = useState<ConversationHomeProjectSelection>(() => ({
    projectPath: initialProjectPath.trim() || undefined,
    projectLabel: initialProjectLabel.trim() || undefined,
  }));
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const pendingAttachmentsRef = useRef<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
  const conversationDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: conversationDockOpen,
    resizeObserverKey: detailContext?.threadId ?? workspaceCwd.trim(),
  });
  const conversationBottomPanelResize = useWorkspaceBottomPanelResizeController({
    containerRef: conversationDockController.containerRef,
    resizeObserverKey: detailContext?.threadId ?? workspaceCwd.trim(),
  });
  const conversationTerminalPresence = useConversationPanelPresence(conversationTerminalOpen, false);
  const workspaceTerminalSession = useWorkspaceTerminalSession(workspaceCwd.trim());
  const {
    proposedPlanArtifacts,
    proposedPlanHistoryLoading,
    proposedPlanHistoryError,
    refreshProposedPlanHistory,
  } = useChannelPlanHistory({
    cwd: workspaceCwd,
    threadId: detailContext?.threadId,
  });
  const canRefreshConversation = Boolean(onRefreshConversation || (workspaceCwd.trim() && detailContext?.threadId));
  const refreshConversationSurface = useCallback(async (): Promise<void> => {
    refreshProposedPlanHistory();
    await onRefreshConversation?.();
  }, [onRefreshConversation, refreshProposedPlanHistory]);
  const normalConversationHeader = useNormalConversationHeaderController({
    identityKey: detailContext?.threadId ?? "",
    onRefresh: canRefreshConversation ? refreshConversationSurface : undefined,
    onSearchChange: setMessageSearchQuery,
  });
  const readyAttachmentIds = useMemo(
    () => pendingAttachments
      .filter((item) => item.state === "ready" && item.attachment)
      .map((item) => item.attachment?.id)
      .filter((id): id is string => Boolean(id)),
    [pendingAttachments],
  );
  const slashCommandPickerOptions = useMemo(
    () => filterSlashCommandPickerOptions(slashCommands, slashPicker),
    [slashCommands, slashPicker],
  );
  const activeProviderPresetId = selectedProviderPresetId || defaultProviderPresetId;
  const activeModelOption = modelOptions.find((option) => option.id === activeProviderPresetId);
  const thinkingMenuOptions = useMemo(
    () => normalConversationThinkingOptions(activeModelOption?.thinkingModes ?? []),
    [activeModelOption?.thinkingModes],
  );
  const thinkingEnabled = thinkingMenuOptions.some((mode) => mode !== "off");
  const runById = useMemo(
    () => new Map((detailContext?.runs ?? []).map((run) => [run.id, run])),
    [detailContext?.runs],
  );
  const latestEditableUserMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "user" && !message.pendingReplacement)?.id,
    [messages],
  );
  const normalizedMessageSearchQuery = messageSearchQuery.trim().toLowerCase();
  const resolvedConversationTitle = useMemo(() => {
    const explicitTitle = conversationTitle.trim();
    if (explicitTitle) return explicitTitle;
    const firstUserMessage = messages.find((message) => message.role === "user")?.content.replace(/\s+/gu, " ").trim();
    return firstUserMessage || t("Conversation");
  }, [conversationTitle, messages, t]);
  const visibleMessages = useMemo(() => {
    if (!normalizedMessageSearchQuery) {
      return messages;
    }
    return messages.filter((message) => {
      const attachmentText = (message.attachments ?? []).map((attachment) => attachment.fileName).join(" ");
      const linkedRun = message.runId ? runById.get(message.runId) : undefined;
          const runText = linkedRun
            ? [
                linkedRun.status,
                runTaskSnapshotTitle(linkedRun),
                linkedRun.providerName,
                linkedRun.providerModel,
              ].filter(Boolean).join(" ")
        : "";
      return `${message.content} ${attachmentText} ${runText}`.toLowerCase().includes(normalizedMessageSearchQuery);
    });
  }, [messages, normalizedMessageSearchQuery, runById]);
  const conversationDockViewModel = useMemo(
    () => buildNormalConversationDockViewModel({
      conversationTitle: resolvedConversationTitle,
      messages,
      project,
      workspaceCwd,
      threadId: detailContext?.threadId,
      turns: detailContext?.turns ?? [],
      runs: detailContext?.runs ?? [],
      executionActions: detailContext?.executionActions ?? [],
      terminalReports: detailContext?.terminalReports ?? [],
      t,
    }),
    [detailContext, messages, project, resolvedConversationTitle, t, workspaceCwd],
  );
  const conversationSummaryRows = useMemo(() => [
    {
      id: "workspace",
      icon: <Folder size={18} />,
      primary: t("Workspace"),
      secondary: conversationDockViewModel.summary.workspaceLabel,
    },
    {
      id: "messages",
      icon: <MessageSquare size={18} />,
      primary: t("Thread"),
      secondary: conversationDockViewModel.summary.messageCount === 1
        ? t("1 item")
        : t("{count} items", { count: conversationDockViewModel.summary.messageCount }),
    },
    ...(conversationDockViewModel.summary.latestRun ? [{
      id: "latest-run",
      icon: <SquareTerminal size={18} />,
      tone: conversationDockViewModel.summary.latestRun.summaryTone,
      primary: t("Latest run"),
      secondary: conversationDockViewModel.summary.latestRun.label,
    }] : []),
    {
      id: "files",
      icon: <FileText size={18} />,
      primary: t("Files"),
      secondary: t("{count} files", { count: conversationDockViewModel.summary.fileCount }),
    },
  ], [conversationDockViewModel.summary, t]);
  const conversationSummaryDockMotion = conversationDockOpen
    ? "header->main"
    : conversationDockController.visible
      ? "main->header"
      : undefined;

  function openConversationFiles(): void {
    setConversationSummaryOpen(false);
    setConversationDockOpen(true);
    conversationDockController.requestPage("files");
  }

  function openConversationReportFile(target: WorkspaceRightDockFileTarget): void {
    setConversationSummaryOpen(false);
    setConversationDockOpen(true);
    conversationDockController.requestPage("files", target);
  }

  function openConversationReview(target: WorkspaceRightDockReviewTarget): void {
    const executionCwd = detailContext?.runs.find((run) => run.id === target.runId)?.cwd ?? target.cwd;
    setConversationSummaryOpen(false);
    setConversationDockOpen(true);
    conversationDockController.requestPage("review", undefined, { ...target, cwd: executionCwd });
  }
  async function saveEditedMessage(message: ConversationHomeMessage, body: string): Promise<void> {
    const threadId = message.threadId ?? detailContext?.threadId;
    if (!threadId || editSaving) {
      return;
    }
    setEditSaving(true);
    setNotice("");
    setReplacementRetryError("");
    const idempotencyKey = `conversation-edit:${message.id}:${crypto.randomUUID()}`;
    try {
      const result = await editConversationMessage(workspaceCwd.trim(), {
        surface: "normal_conversation",
        ownerId: threadId,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body,
        attachmentIds: (message.attachments ?? []).map((attachment) => attachment.id),
        providerPresetId: activeProviderPresetId,
        permissionPreset: selectedPermissionPreset,
        idempotencyKey,
      });
      setMessages((current) => current.map((item) => item.id === message.id ? {
        ...item,
        content: result.message.body,
        revision: result.message.revision,
        editedAt: result.message.createdAt,
        updatedAt: result.message.createdAt,
        pendingReplacement: result.status === "replacement_pending" ? {
          supersessionId: result.supersessionId,
          idempotencyKey,
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        } : undefined,
      } : item));
      setEditingMessageId(undefined);
      await normalConversationHeader.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function retryEditedMessageReplacement(message: ConversationHomeMessage): Promise<void> {
    const pending = message.pendingReplacement;
    const threadId = message.threadId ?? detailContext?.threadId;
    if (!pending || !threadId || replacementRetryingMessageId) {
      return;
    }
    setReplacementRetryingMessageId(message.id);
    setReplacementRetryError("");
    try {
      const result = await editConversationMessage(workspaceCwd.trim(), {
        surface: "normal_conversation",
        ownerId: threadId,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body: message.content,
        attachmentIds: (message.attachments ?? []).map((attachment) => attachment.id),
        providerPresetId: activeProviderPresetId,
        permissionPreset: selectedPermissionPreset,
        idempotencyKey: pending.idempotencyKey,
      });
      if (result.status === "replacement_pending") {
        setReplacementRetryError(result.failureReason ?? pending.failureReason ?? "");
      }
      await normalConversationHeader.refresh();
    } catch (error) {
      setReplacementRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacementRetryingMessageId(undefined);
    }
  }
  const composerInputParts = useMemo(
    () => parseComposerInputParts(draft, {
      cwd: project.projectPath,
      slashCommands,
    }),
    [draft, project.projectPath, slashCommands],
  );

  const sendBusy = sending || localSending;
  const composerBusy = sendBusy || Boolean(activeRun);

  useEffect(() => {
    setDraft(initialDraft);
    setNotice("");
  }, [initialDraft]);

  useEffect(() => {
    setMessages(initialMessages);
    if (initialMessages.length === 0) {
      setConversationDockOpen(false);
    }
  }, [initialMessages]);

  useEffect(() => {
    setProject({
      projectPath: initialProjectPath.trim() || undefined,
      projectLabel: initialProjectLabel.trim() || undefined,
    });
  }, [initialProjectLabel, initialProjectPath]);

  useEffect(() => {
    setSelectedProviderPresetId(initialProviderPresetId.trim());
    setSelectedThinkingLevel(initialThinkingLevel);
  }, [initialProviderPresetId, initialThinkingLevel]);

  useEffect(() => {
    setSelectedPermissionPreset(permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
      initialWorkspaceAccessMode,
      initialPermissionMode,
      initialPermissionPreset,
    )));
  }, [initialPermissionMode, initialPermissionPreset, initialWorkspaceAccessMode]);

  useEffect(() => {
    if (!thinkingEnabled) {
      setSelectedThinkingLevel("off");
      return;
    }
    if (!thinkingMenuOptions.includes(selectedThinkingLevel)) {
      setSelectedThinkingLevel("off");
    }
  }, [selectedThinkingLevel, thinkingEnabled, thinkingMenuOptions]);

  useEffect(() => {
    if (!composerBusy) {
      return;
    }
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [composerBusy]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => () => {
    revokePendingAttachmentPreviews(pendingAttachmentsRef.current);
  }, []);

  async function submitDraft(): Promise<void> {
    const trimmedDraft = draft.trim();
    if (!trimmedDraft && readyAttachmentIds.length === 0) {
      setNotice(t("Type a message before sending."));
      return;
    }
    if (pendingAttachments.some((item) => item.state === "uploading")) {
      setNotice(t("Wait for attachments to finish uploading."));
      return;
    }
    if (composerBusy) {
      return;
    }
    const providerPresetId = activeProviderPresetId.trim();
    if (!providerPresetId) {
      setNotice(t("Please configure a chat model before sending."));
      return;
    }
    const authorizationMode = resolveAuthorizationMode(initialAuthorizationMode, initialPermissionMode, initialPermissionPreset);
    const workspaceAccessMode = workspaceAccessModeForPermissionPreset(selectedPermissionPreset);
    let permissionConfirmation: PermissionConfirmation | undefined;
    if (workspaceAccessMode === "full_access") {
      permissionConfirmation = await onConfirmFullAccess?.();
      if (!permissionConfirmation) {
        return;
      }
    }
    const legacyPermission = authorizationAndAccessToLegacyPermission(authorizationMode, workspaceAccessMode);
    const now = new Date().toISOString();
    const pendingUserMessage: ConversationHomeMessage = {
      id: createConversationHomeMessageId(),
      role: "user",
      content: trimmedDraft || t("User attached files."),
      attachments: pendingAttachments
        .map((item) => item.attachment)
        .filter((attachment): attachment is ConversationAttachment => Boolean(attachment)),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const pendingAttachmentsSnapshot = pendingAttachments;
    const readyAttachmentIdsSnapshot = readyAttachmentIds;
    setMessages((current) => [
      ...current,
      pendingUserMessage,
    ]);
    setDraft("");
    setPendingAttachments([]);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    setNotice("");
    setLocalSending(true);
    try {
      await onSendConversation({
        message: trimmedDraft,
        attachmentIds: readyAttachmentIdsSnapshot,
        project: project.projectPath ? project : {},
        model: {
          providerPresetId,
          ...(thinkingEnabled && selectedThinkingLevel !== "off" ? { thinkingLevel: selectedThinkingLevel } : {}),
        },
        authorization: {
          authorizationMode,
          workspaceAccessMode,
          permissionMode: legacyPermission.permissionMode,
          permissionPreset: legacyPermission.permissionPreset,
          permissionConfirmation,
        },
        replaceMessages: (nextMessages) => setMessages(nextMessages),
        upsertMessage: (message) => setMessages((current) => upsertConversationHomeMessage(current, message)),
        failMessage: (message) => {
          setNotice(message);
          setMessages((current) => upsertConversationHomeMessage(current, {
            id: `conversation-error:${pendingUserMessage.id}`,
            role: "assistant",
            authorLabel: "Ling Agent",
            content: message,
            status: "failed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        },
      });
      revokePendingAttachmentPreviews(pendingAttachmentsSnapshot);
    } catch (error) {
      setDraft(trimmedDraft);
      setPendingAttachments(pendingAttachmentsSnapshot);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitDraft();
    }
  }

  function handleComposerPaste(_event: ClipboardEvent<HTMLDivElement>): void {
    setNotice("");
  }

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

  function commitSlashCommand(option: ComposerSlashCommandOption): void {
    const composer = composerInputRef.current;
    const liveValue = draft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
    const picker = slashPicker ?? findActiveSlashCommand(liveValue, liveCaret) ?? findActiveSlashCommand(liveValue, liveValue.length);
    const inserted = insertSlashCommandToken(liveValue, picker, option.id);
    setDraft(inserted.value);
    setNotice("");
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function applyShortcut(prompt: string): void {
    setDraft(prompt);
    setNotice("");
  }

  async function attachConversationFiles(files: FileList | readonly File[]): Promise<void> {
    const fileList = Array.from(files);
    if (fileList.length === 0 || composerBusy) {
      return;
    }
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      setNotice(t("Local workspace is not ready."));
      return;
    }
    if (pendingAttachments.length + fileList.length > 10) {
      setNotice(t("A conversation message can attach at most 10 files."));
      return;
    }
    setNotice("");
    await Promise.all(fileList.map(async (file) => {
      const localId = createLocalComposerAssetId("conversation-attachment");
      const previewUrl = createAttachmentPreviewUrl(file);
      setPendingAttachments((current) => [
        ...current,
        {
          localId,
          fileName: file.name,
          sizeBytes: file.size,
          state: "uploading",
          previewUrl,
        },
      ]);
      try {
        const response = await uploadConversationAttachment(cwd, file, detailContext?.threadId);
        setPendingAttachments((current) => current.map((item) => item.localId === localId
          ? { ...item, state: "ready", attachment: response.attachment, deleteOnRemove: true }
          : item));
      } catch (error) {
        setPendingAttachments((current) => current.map((item) => item.localId === localId
          ? { ...item, state: "failed", error: error instanceof Error ? error.message : String(error) }
          : item));
      }
    }));
  }

  function removePendingAttachment(localId: string): void {
    const item = pendingAttachments.find((candidate) => candidate.localId === localId);
    setPendingAttachments((current) => current.filter((candidate) => candidate.localId !== localId));
    revokePendingAttachmentPreviews(item ? [item] : []);
    const cwd = workspaceCwd.trim();
    if (cwd && item?.attachment && item.deleteOnRemove) {
      void deleteAttachment(cwd, item.attachment.id).catch(() => undefined);
    }
  }

  function selectModel(option: ConversationHomeModelOption): void {
    if (composerBusy) {
      return;
    }
    setSelectedProviderPresetId(option.id);
    setSelectedThinkingLevel("off");
    setNotice("");
  }

  function selectThinkingLevel(level: ProviderThinkingMode): void {
    if (composerBusy) {
      return;
    }
    setSelectedThinkingLevel(level);
    setNotice("");
  }

  const composerNode = (
    <NormalConversationComposer
      draft={draft}
      inputRef={composerInputRef}
      inputParts={composerInputParts}
      slashPicker={slashPicker}
      slashOptions={slashCommandPickerOptions}
      slashActiveIndex={slashActiveIndex}
      pendingAttachments={pendingAttachments}
      permissionPreset={selectedPermissionPreset}
      modelOptions={modelOptions}
      selectedProviderPresetId={selectedProviderPresetId}
      defaultProviderPresetId={defaultProviderPresetId}
      defaultProviderLabel={defaultProviderLabel}
      selectedThinkingLevel={selectedThinkingLevel}
      sendBusy={sendBusy}
      activeRun={Boolean(activeRun)}
      stopping={stopping}
      canSend={Boolean(draft.trim() || readyAttachmentIds.length > 0)}
      notice={notice}
      onDraftChange={(value, caret) => {
        setDraft(value);
        setNotice("");
        updateSlashPicker(value, caret);
      }}
      onComposerKeyDown={handleComposerKeyDown}
      onComposerPaste={handleComposerPaste}
      onComposerSelect={updateSlashPicker}
      onCommitSlashCommand={commitSlashCommand}
      onAttachFiles={attachConversationFiles}
      onRemoveAttachment={removePendingAttachment}
      onPermissionPresetChange={setSelectedPermissionPreset}
      onModelChange={selectModel}
      onThinkingLevelChange={selectThinkingLevel}
      onSubmit={submitDraft}
      onStop={onStopConversation}
    />
  );

  if (messages.length > 0) {
    return (
      <NormalConversationPage
        summaryOpen={conversationSummaryOpen}
        onCloseSummary={() => setConversationSummaryOpen(false)}
        summaryDockMotion={conversationSummaryDockMotion}
        summaryRows={conversationSummaryRows}
        headerProps={{
          title: resolvedConversationTitle,
          searchInputRef: normalConversationHeader.searchInputRef,
          searchOpen: normalConversationHeader.searchOpen,
          searchQuery: messageSearchQuery,
          searchTriggerRef: normalConversationHeader.searchTriggerRef,
          refreshing: normalConversationHeader.refreshing,
          refreshDisabled: !canRefreshConversation,
          summaryActive: conversationSummaryOpen,
          terminalActive: conversationTerminalOpen,
          terminalDisabled: !workspaceCwd.trim(),
          detailsActive: conversationDockOpen,
          onClearSearch: normalConversationHeader.clearSearch,
          onCloseSearch: () => normalConversationHeader.closeSearch(true),
          onSearchQueryChange: setMessageSearchQuery,
          onToggleSearch: () => {
            setConversationSummaryOpen(false);
            normalConversationHeader.toggleSearch();
          },
          onRefresh: () => void normalConversationHeader.refresh(),
          onToggleSummary: () => {
            normalConversationHeader.closeSearch();
            setConversationSummaryOpen((current) => !current);
          },
          onToggleTerminal: () => {
            normalConversationHeader.closeSearch();
            setConversationTerminalOpen((current) => !current);
          },
          onToggleDetails: () => {
            if (conversationDockOpen) conversationDockController.close();
            setConversationDockOpen((current) => !current);
          },
        }}
        feedProps={{
          messages,
          visibleMessages,
          runById,
          detailContext,
          projectPath: project.projectPath,
          workspaceCwd,
          searchActive: Boolean(normalizedMessageSearchQuery),
          editingMessageId,
          editSaving,
          latestEditableUserMessageId,
          replacementRetryingMessageId,
          replacementRetryError,
          onCancelMessageEdit: () => setEditingMessageId(undefined),
          onEditMessage: setEditingMessageId,
          onSaveMessage: saveEditedMessage,
          onRetryReplacement: retryEditedMessageReplacement,
          onOpenFiles: openConversationFiles,
          onOpenReportFile: openConversationReportFile,
          onOpenReview: openConversationReview,
          onOpenRun,
        }}
        composerNode={composerNode}
        panelsProps={{
          workspaceCwd,
          currentThreadId: detailContext?.threadId,
          dockController: conversationDockController,
          dockViewModel: conversationDockViewModel,
          proposedPlans: proposedPlanArtifacts,
          proposedPlansLoading: proposedPlanHistoryLoading,
          proposedPlansError: proposedPlanHistoryError,
          terminalPresence: conversationTerminalPresence,
          terminalResize: conversationBottomPanelResize,
          terminalSession: workspaceTerminalSession,
          onCloseDock: () => {
            conversationDockController.close();
            setConversationDockOpen(false);
          },
          onCloseTerminal: () => setConversationTerminalOpen(false),
        }}
      />
    );
  }

  return <NormalConversationEmptyState composerNode={composerNode} onApplyShortcut={applyShortcut} />;
}

function createConversationHomeMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `message:${globalThis.crypto.randomUUID()}`;
  }
  return `message:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function upsertConversationHomeMessage(
  messages: readonly ConversationHomeMessage[],
  message: ConversationHomeMessage,
): readonly ConversationHomeMessage[] {
  const messageKey = conversationHomeMessageMergeKey(message);
  const index = messages.findIndex((item) => conversationHomeMessageMergeKey(item) === messageKey);
  const next = index >= 0
    ? messages.map((item) => (conversationHomeMessageMergeKey(item) === messageKey ? message : item))
    : [...messages, message];
  return [...next].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function conversationHomeMessageMergeKey(message: ConversationHomeMessage): string {
  const assistantMatch = /^conversation-assistant:([^:]+)/u.exec(message.id);
  if (assistantMatch?.[1]) {
    return `assistant:${assistantMatch[1]}`;
  }
  const userMatch = /^conversation-user:([^:]+)/u.exec(message.id);
  if (userMatch?.[1]) {
    return `user:${userMatch[1]}`;
  }
  return message.id;
}
