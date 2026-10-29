import { useNativeConversationSelection } from "./useNativeConversationSelection.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  FileText,
  Folder,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { AuthorizationMode, ConversationAttachment, PermissionConfirmation, PermissionPreset, ProviderThinkingMode, ReasoningSummaryMode } from "../../types.js";
import {
  filterSlashCommandPickerOptions,
  composerWorkspaceFileParts,
  findActiveSlashCommand,
  insertSlashCommandToken,
  parseComposerInputParts,
  type ActiveSlashCommandPicker,
  type TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import { useConversationSendLifecycle } from "../../shared/conversation/index.js";
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
import { RuntimeApprovalComposerGate } from "../approvals/RuntimeApprovalComposerGate.js";
import { NormalConversationEmptyState } from "./NormalConversationEmptyState.js";
import { NormalConversationPage } from "./NormalConversationPage.js";
import {
  buildNormalConversationDockViewModel,
  runTaskSnapshotTitle,
} from "./normal-conversation-dock-projections.js";
import { normalConversationDefaultThinkingLevel, normalConversationThinkingLabel, normalConversationThinkingOptions } from "./normal-conversation-composer-options.js";
import {
  createConversationHomeMessageId,
  upsertConversationHomeMessage,
} from "./normal-conversation-message-state.js";
import type {
  ConversationHomeMessage,
  ConversationHomeModelOption,
  ConversationHomeProjectSelection,
  ConversationHomeProps,
} from "./normal-conversation-types.js";
import { useNormalConversationHeaderController } from "./useNormalConversationHeaderController.js";
import { useNormalConversationActionFeedback } from "./useNormalConversationActionFeedback.js";
import { useNormalConversationAttachmentController } from "./useNormalConversationAttachmentController.js";
import { useNormalConversationIdentityController } from "./useNormalConversationIdentityController.js";
import { useNormalConversationOperationOwner } from "./useNormalConversationOperationOwner.js";
import { useChannelPlanHistory } from "./useChannelPlanHistory.js";
import { useWorkspaceTerminalSession } from "./WorkspaceTerminalPanel.js";
import { submitNormalConversationGuidance } from "./normal-conversation-guidance-controller.js";
import { hasPendingNormalGuidance } from "./normal-conversation-guidance.js";
import { createNormalConversationMessageEditController } from "./normal-conversation-message-edit-controller.js";
import { useNormalConversationDropController } from "./useNormalConversationDropController.js";

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
  userProfile,
  conversationTitle = "",
  initialDraft = "",
  initialMessages = [],
  initialProjectPath = "",
  initialProjectLabel = "",
  initialProviderPresetId = "",
  initialThinkingLevel = "off",
  initialReasoningSummary = "auto",
  initialAuthorizationMode,
  initialWorkspaceAccessMode,
  defaultWorkspaceAccessMode = "workspace_write",
  initialPermissionMode,
  initialPermissionPreset,
  detailContext,
  conversationIdentity,
  defaultProviderLabel,
  defaultProviderPresetId,
  modelOptions: piModelOptions,
  slashCommands,
  workspaceCwd,
  executionSelectionRevision,
  conversationErrorMessage = "",
  sending = false,
  activeRun,
  inlineApprovalViews,
  approvalErrors,
  stopping = false,
  fullAccessConfirmed = false,
  onOpenRun,
  onOpenModelWorkbench,
  onConfirmFullAccess,
  onConfirmFullAccessSelection,
  onFullAccessConversationBound,
  onRefreshConversation,
  onStopConversation,
  onResolveApproval,
  resolvingApprovals,
  onSendConversation,
}: ConversationHomeProps): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [messages, setMessages] = useState<readonly ConversationHomeMessage[]>(initialMessages);
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [selectedProviderPresetId, setSelectedProviderPresetId] = useState(initialProviderPresetId.trim());
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<ProviderThinkingMode>(initialThinkingLevel);
  const [selectedReasoningSummary, setSelectedReasoningSummary] = useState<ReasoningSummaryMode>(initialReasoningSummary);
  const [selectedAuthorizationMode, setSelectedAuthorizationMode] = useState<AuthorizationMode>(() => resolveAuthorizationMode(
    initialAuthorizationMode,
    initialPermissionMode,
    initialPermissionPreset,
  ));
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(() => permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
    initialWorkspaceAccessMode,
    initialPermissionMode,
    initialPermissionPreset,
  )));
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [conversationDockOpen, setConversationDockOpen] = useState(false);
  const [conversationSummaryOpen, setConversationSummaryOpen] = useState(false);
  const [conversationTerminalOpen, setConversationTerminalOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | undefined>();
  const [project, setProject] = useState<ConversationHomeProjectSelection>(() => ({
    projectPath: initialProjectPath.trim() || undefined,
    projectLabel: initialProjectLabel.trim() || undefined,
  }));
  const conversationIdentityController = useNormalConversationIdentityController({
    workspaceCwd,
    threadId: detailContext?.threadId,
    identity: conversationIdentity,
  });
  const sendLifecycle = useConversationSendLifecycle(conversationIdentityController.ownerKey);
  const actionFeedback = useNormalConversationActionFeedback(conversationIdentityController.ownerKey);
  const guidanceOperation = useNormalConversationOperationOwner<boolean>(conversationIdentityController.ownerKey);
  const editSaveOperation = useNormalConversationOperationOwner<string>(conversationIdentityController.ownerKey);
  const replacementRetryOperation = useNormalConversationOperationOwner<string>(conversationIdentityController.ownerKey);
  const localSending = sendLifecycle.phase === "submitting" || sendLifecycle.phase === "message_accepted";
  const editSaving = editSaveOperation.busy;
  const replacementRetryingMessageId = replacementRetryOperation.activeValue;
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const permissionSelectionBoundThreadRef = useRef("");
  const permissionBeforeFullAccessRef = useRef<PermissionPreset | undefined>(undefined);
  const permissionSelectionSequenceRef = useRef(0);
  const sendBusy = sending || localSending || guidanceOperation.busy;
  const composerBusy = sendBusy || !conversationIdentityController.ready;
  const activeReply = sendLifecycle.activeReplies[0] ?? (activeRun && activeReplyStatus(activeRun.status) ? {
    runId: activeRun.id,
    sourceRunId: activeRun.parentRunId ?? activeRun.id,
    workUnitId: activeRun.workUnitId,
    threadId: activeRun.threadId,
    teammateId: activeRun.teammateId,
    status: activeRun.status,
    createdAt: activeRun.createdAt,
    updatedAt: activeRun.updatedAt,
  } : undefined);
  const guidancePending = hasPendingNormalGuidance(workspaceCwd, detailContext?.threadId);
  const attachmentController = useNormalConversationAttachmentController({
    composerBusy,
    ownerKey: conversationIdentityController.ownerKey,
    captureIdentity: conversationIdentityController.capture,
    isCurrentIdentity: conversationIdentityController.isCurrent,
    report: (message) => actionFeedback.report("attachment", message),
    clear: () => actionFeedback.clear("attachment"),
    translate: t,
  });
  const { pendingAttachments, readyAttachmentIds } = attachmentController;
  const recoveryDraftRef = useRef<{ threadId: string; draft: string; attachments: typeof pendingAttachments } | undefined>(undefined);
  const composerDropController = useNormalConversationDropController({
    blocked: composerBusy,
    resetKey: conversationIdentityController.ownerKey,
    onFiles: attachmentController.attachFiles,
  });
  const conversationDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: conversationDockOpen,
    resizeObserverKey: conversationIdentityController.ownerKey,
  });
  const conversationBottomPanelResize = useWorkspaceBottomPanelResizeController({
    containerRef: conversationDockController.containerRef,
    resizeObserverKey: conversationIdentityController.ownerKey,
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
  const refreshConversationSurface = useCallback(async (): Promise<void> => {
    refreshProposedPlanHistory();
    await onRefreshConversation?.();
  }, [onRefreshConversation, refreshProposedPlanHistory]);
  const normalConversationHeader = useNormalConversationHeaderController({
    identityKey: conversationIdentityController.ownerKey,
    onSearchChange: setMessageSearchQuery,
  });
  const slashCommandPickerOptions = useMemo(
    () => filterSlashCommandPickerOptions(slashCommands, slashPicker),
    [slashCommands, slashPicker],
  );
  const selectionAccessMode = workspaceAccessModeForPermissionPreset(selectedPermissionPreset);
  const selectionLegacyPermission = authorizationAndAccessToLegacyPermission(selectedAuthorizationMode, selectionAccessMode);
  const nativeSelection = useNativeConversationSelection(workspaceCwd, { threadId: detailContext?.threadId,
    projectPath: project.projectPath, authorizationMode: selectedAuthorizationMode, workspaceAccessMode: selectionAccessMode,
    ...selectionLegacyPermission }, t("Native execution is blocked. Review the engine configuration and execution verification."), executionSelectionRevision);
  const modelOptions = nativeSelection.option ? [nativeSelection.option, ...piModelOptions] : piModelOptions;
  const effectiveDefaultModelId = nativeSelection.defaultId ?? defaultProviderPresetId;
  const activeProviderPresetId = selectedProviderPresetId || effectiveDefaultModelId;
  const activeModelOption = modelOptions.find((option) => option.id === activeProviderPresetId);
  const activeModelReady = (!nativeSelection.pending || Boolean(selectedProviderPresetId)) && Boolean(activeModelOption?.runnable ?? activeModelOption?.enabled);
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
  const messageEditController = createNormalConversationMessageEditController({
    workspaceCwd,
    detailContext,
    threadId: detailContext?.threadId,
    providerPresetId: activeModelOption?.executionBinding ? undefined : activeProviderPresetId,
    permissionPreset: selectedPermissionPreset,
    identityController: conversationIdentityController,
    editOperation: editSaveOperation,
    replacementOperation: replacementRetryOperation,
    actionFeedback,
    setMessages,
    setEditingMessageId,
    refresh: refreshConversationSurface,
  });

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
  const composerInputParts = useMemo(
    () => parseComposerInputParts(draft, {
      cwd: project.projectPath,
      deferTrailingAtomicTokens: true,
      slashCommands,
    }),
    [draft, project.projectPath, slashCommands],
  );
  const composerSubmissionInputParts = useMemo(
    () => parseComposerInputParts(draft, {
      cwd: project.projectPath,
      slashCommands,
    }),
    [draft, project.projectPath, slashCommands],
  );
  const composerFileRefs = useMemo(
    () => composerWorkspaceFileParts(composerSubmissionInputParts).map((part) => ({
      path: part.path,
      ...(part.line !== undefined ? { line: part.line } : {}),
      source: "composer" as const,
    })),
    [composerSubmissionInputParts],
  );

  useEffect(() => {
    const recovery = recoveryDraftRef.current;
    if (recovery?.threadId === conversationIdentityController.identity) {
      setDraft(recovery.draft);
      attachmentController.restoreForIdentity(recovery.attachments, conversationIdentityController.capture());
      recoveryDraftRef.current = undefined;
    } else {
      setDraft(initialDraft);
    }
  }, [conversationIdentityController.ownerKey, initialDraft]);

  useEffect(() => {
    setMessages(initialMessages);
    if (initialMessages.length === 0) {
      setConversationDockOpen(false);
    }
  }, [conversationIdentityController.ownerKey, initialMessages]);

  useEffect(() => {
    setMessageSearchQuery("");
    setConversationSummaryOpen(false);
    setConversationTerminalOpen(false);
    setEditingMessageId(undefined);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [conversationIdentityController.ownerKey]);

  useEffect(() => {
    setProject({
      projectPath: initialProjectPath.trim() || undefined,
      projectLabel: initialProjectLabel.trim() || undefined,
    });
  }, [conversationIdentityController.ownerKey, initialProjectLabel, initialProjectPath]);

  useEffect(() => {
    setSelectedProviderPresetId(initialProviderPresetId.trim());
    setSelectedThinkingLevel(initialThinkingLevel);
    setSelectedReasoningSummary(initialReasoningSummary);
  }, [conversationIdentityController.ownerKey, initialProviderPresetId, initialReasoningSummary, initialThinkingLevel]);

  useEffect(() => {
    if (permissionSelectionBoundThreadRef.current === conversationIdentityController.identity) {
      return;
    }
    permissionSelectionBoundThreadRef.current = "";
    permissionBeforeFullAccessRef.current = undefined;
    permissionSelectionSequenceRef.current += 1;
    setSelectedAuthorizationMode(resolveAuthorizationMode(
      initialAuthorizationMode,
      initialPermissionMode,
      initialPermissionPreset,
    ));
    setSelectedPermissionPreset(permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
      initialWorkspaceAccessMode,
      initialPermissionMode,
      initialPermissionPreset,
    )));
  }, [conversationIdentityController.ownerKey, initialAuthorizationMode, initialPermissionMode, initialPermissionPreset, initialWorkspaceAccessMode]);

  useEffect(() => {
    if (!thinkingEnabled) {
      setSelectedThinkingLevel("off");
      return;
    }
    if (!thinkingMenuOptions.includes(selectedThinkingLevel)) {
      setSelectedThinkingLevel(normalConversationDefaultThinkingLevel(thinkingMenuOptions));
    }
  }, [selectedThinkingLevel, thinkingEnabled, thinkingMenuOptions]);

  useEffect(() => {
    if (!composerBusy) {
      return;
    }
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [composerBusy]);

  async function submitDraft(): Promise<void> {
    const trimmedDraft = draft.trim();
    if (!guidancePending && !trimmedDraft && readyAttachmentIds.length === 0 && composerFileRefs.length === 0) {
      actionFeedback.report("validation", t("Type a message before sending."));
      return;
    }
    if (pendingAttachments.some((item) => item.state !== "ready")) {
      actionFeedback.report("validation", t("Wait for attachments to finish uploading."));
      return;
    }
    if (composerBusy) {
      return;
    }
    if (activeReply || hasPendingNormalGuidance(workspaceCwd, detailContext?.threadId)) {
      await submitRunGuidance(trimmedDraft);
      return;
    }
    const providerPresetId = activeProviderPresetId.trim();
    if ((!providerPresetId && !activeModelOption?.executionBinding) || !activeModelReady) {
      actionFeedback.report("validation", activeModelOption?.blocker || t("Please configure a chat model before sending."));
      return;
    }
    const workspaceAccessMode = workspaceAccessModeForPermissionPreset(selectedPermissionPreset);
    let permissionConfirmation: PermissionConfirmation | undefined;
    if (workspaceAccessMode === "full_access") {
      permissionConfirmation = await onConfirmFullAccess?.();
      if (!permissionConfirmation) {
        return;
      }
    }
    const legacyPermission = authorizationAndAccessToLegacyPermission(selectedAuthorizationMode, workspaceAccessMode);
    const now = new Date().toISOString();
    const pendingUserMessage: ConversationHomeMessage = {
      id: createConversationHomeMessageId(),
      role: "user",
      content: trimmedDraft || t("User attached files."),
      attachments: pendingAttachments
        .map((item) => item.attachment)
        .filter((attachment): attachment is ConversationAttachment => Boolean(attachment)),
      status: "pending",
      fileRefs: composerFileRefs,
      createdAt: now,
      updatedAt: now,
    };
    const operationIdentity = conversationIdentityController.capture();
    const pendingAttachmentsSnapshot = attachmentController.consumeForSend();
    const readyAttachmentIdsSnapshot = readyAttachmentIds;
    const commitGuard = conversationIdentityController.createCommitGuard();
    let sendBound = false;
    let submissionUnknown = false;
    let recoveryOnly = false;
    const onThreadBound = (threadId: string): void => {
      permissionSelectionBoundThreadRef.current = threadId;
      onFullAccessConversationBound?.(threadId);
      if (!sendBound) {
        sendBound = true;
        attachmentController.markSendBound(pendingAttachmentsSnapshot);
      }
    };
    const shouldCommit = (threadId?: string): boolean => {
      return commitGuard(threadId);
    };
    setMessages((current) => [
      ...current,
      pendingUserMessage,
    ]);
    setDraft("");
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    actionFeedback.clear("validation");
    actionFeedback.clear("stream");
    const sendOperation = sendLifecycle.begin();
    try {
      await onSendConversation({
        message: trimmedDraft,
        attachmentIds: readyAttachmentIdsSnapshot,
        fileRefs: composerFileRefs,
        project: project.projectPath ? project : {},
        model: {
          ...(activeModelOption?.executionBinding ? { executionBinding: activeModelOption.executionBinding } : { providerPresetId }),
          ...(thinkingEnabled && selectedThinkingLevel !== "off" ? { thinkingLevel: selectedThinkingLevel } : {}),
          reasoningSummary: selectedReasoningSummary,
        },
        authorization: {
          authorizationMode: selectedAuthorizationMode,
          workspaceAccessMode,
          permissionMode: legacyPermission.permissionMode,
          permissionPreset: legacyPermission.permissionPreset,
          permissionConfirmation,
        },
        replaceMessages: (nextMessages) => {
          if (shouldCommit()) setMessages(nextMessages);
        },
        upsertMessage: (message) => {
          if (shouldCommit(message.threadId)) {
            setMessages((current) => upsertConversationHomeMessage(current, message));
          }
        },
        failMessage: (message) => {
          if (!shouldCommit()) return;
          // Once the server has accepted the turn, its typed assistant/evidence
          // projection owns the failure. Keep composer feedback for transport
          // failures that happen before a durable message exists only.
          if (sendBound) return;
          actionFeedback.report("stream", message);
        },
        onThreadBound,
        shouldCommit,
        onMessageAccepted: () => {
          sendLifecycle.accept(sendOperation);
        },
        onSubmissionUnknown: (onlyQueries) => {
          submissionUnknown = true;
          recoveryOnly = Boolean(onlyQueries);
          if (shouldCommit()) actionFeedback.report("stream", t("Pending confirmation"));
        },
        onSubmissionRecovered: (threadId, originalBody) => {
          if (!shouldCommit(threadId)) return;
          recoveryOnly = true;
          const retainedDraft = trimmedDraft === originalBody.trim() && !pendingAttachmentsSnapshot.length ? "" : trimmedDraft;
          recoveryDraftRef.current = { threadId, draft: retainedDraft, attachments: pendingAttachmentsSnapshot };
          setMessages(current => current.filter(item => item.id !== pendingUserMessage.id));
          setDraft(retainedDraft);
          attachmentController.restoreForIdentity(pendingAttachmentsSnapshot, operationIdentity);
        },
        onReplyLinked: (target) => {
          sendLifecycle.accept(sendOperation);
          sendLifecycle.link(sendOperation, target);
        },
      });
      if (submissionUnknown) {
        sendLifecycle.defer(sendOperation);
        if (recoveryOnly && shouldCommit()) {
          setMessages(current => current.filter(item => item.id !== pendingUserMessage.id));
          setDraft(trimmedDraft);
          attachmentController.restoreForIdentity(pendingAttachmentsSnapshot, operationIdentity);
        }
        return;
      }
      if (recoveryOnly) {
        sendLifecycle.defer(sendOperation);
        return;
      }
      if (sendBound) {
        attachmentController.markSendBound(pendingAttachmentsSnapshot);
      } else if (commitGuard()) {
        setDraft(trimmedDraft);
        attachmentController.restoreForIdentity(pendingAttachmentsSnapshot, operationIdentity);
      } else {
        attachmentController.abandonSend(pendingAttachmentsSnapshot);
      }
      sendLifecycle.settle(sendOperation);
    } catch (error) {
      const failure = sendLifecycle.fail(sendOperation);
      if (sendBound) {
        attachmentController.markSendBound(pendingAttachmentsSnapshot);
      } else if (failure.restoreInput && commitGuard()) {
        setDraft(trimmedDraft);
        attachmentController.restoreForIdentity(pendingAttachmentsSnapshot, operationIdentity);
        actionFeedback.report("stream", error instanceof Error ? error.message : String(error));
      } else {
        attachmentController.abandonSend(pendingAttachmentsSnapshot);
      }
    }
  }

  async function submitRunGuidance(body: string): Promise<void> {
    await submitNormalConversationGuidance({
      activeReply,
      threadId: detailContext?.threadId,
      workspaceCwd,
      body,
      fileRefs: composerFileRefs,
      notReadyMessage: t("This conversation is not ready for another message yet."),
      attachmentController,
      identityController: conversationIdentityController,
      operationOwner: guidanceOperation,
      actionFeedback,
      onAccepted: (message) => {
        setMessages((current) => upsertConversationHomeMessage(current, message));
        setDraft(current => current.trim() === body ? "" : current);
        setSlashPicker(undefined);
        setSlashActiveIndex(0);
      },
      onRecovered: clearDraft => {
        if (clearDraft) setDraft(current => current.trim() === body ? "" : current);
      },
      refresh: refreshConversationSurface,
    });
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

  function handleComposerPasteFiles(files: readonly File[]): void {
    actionFeedback.clear("validation");
    void attachmentController.attachFiles(files);
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
    actionFeedback.clear("validation");
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function applyShortcut(prompt: string): void {
    setDraft(prompt);
    actionFeedback.clear("validation");
  }

  function selectModel(option: ConversationHomeModelOption): void {
    if (composerBusy || activeReply) {
      return;
    }
    setSelectedProviderPresetId(option.id);
    const supported = normalConversationThinkingOptions(option.thinkingModes ?? []);
    const nextLevel = supported.includes(selectedThinkingLevel)
      ? selectedThinkingLevel : normalConversationDefaultThinkingLevel(supported);
    setSelectedThinkingLevel(nextLevel);
    actionFeedback.clear("validation");
    if (nextLevel !== selectedThinkingLevel) {
      actionFeedback.report("validation", t("Reasoning level changed to {level} because the selected model does not support {previous}.", {
        level: normalConversationThinkingLabel(nextLevel, t), previous: normalConversationThinkingLabel(selectedThinkingLevel, t),
      }));
    }
  }

  function selectThinkingLevel(level: ProviderThinkingMode): void {
    if (composerBusy || activeReply) {
      return;
    }
    setSelectedThinkingLevel(level);
    actionFeedback.clear("validation");
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
      authorizationMode={selectedAuthorizationMode}
      permissionPreset={selectedPermissionPreset}
      fullAccessConfirmed={fullAccessConfirmed}
      modelOptions={modelOptions}
      selectedProviderPresetId={selectedProviderPresetId}
      defaultProviderPresetId={effectiveDefaultModelId}
      defaultProviderLabel={defaultProviderLabel}
      selectedThinkingLevel={selectedThinkingLevel}
      sendBusy={sendBusy}
      scopeReady={conversationIdentityController.ready}
      recoveringSubmission={guidancePending}
      activeRun={Boolean(activeReply)}
      stopping={stopping}
      canSend={!pendingAttachments.some(item => item.state !== "ready") && (guidancePending || (Boolean(activeReply) || activeModelReady) && Boolean(draft.trim() || readyAttachmentIds.length > 0 || composerFileRefs.length > 0))}
      notice={conversationErrorMessage || actionFeedback.message}
      dragActive={composerDropController.active}
      dropFeedback={composerDropController.feedback}
      onDraftChange={(value, caret) => {
        setDraft(value);
        actionFeedback.clear("validation");
        updateSlashPicker(value, caret);
      }}
      onComposerKeyDown={handleComposerKeyDown}
      onComposerPasteFiles={handleComposerPasteFiles}
      onComposerSelect={updateSlashPicker}
      onCommitSlashCommand={commitSlashCommand}
      onAttachFiles={attachmentController.attachFiles}
      onDragOver={composerDropController.onDragOver}
      onDragLeave={composerDropController.onDragLeave}
      onDrop={composerDropController.onDrop}
      onOpenModelWorkbench={onOpenModelWorkbench}
      onRemoveAttachment={attachmentController.removeAttachment}
      onRetryAttachment={attachmentController.retryAttachment}
      attachmentCleanupFailures={attachmentController.cleanupFailures}
      onRetryAttachmentCleanup={attachmentController.retryCleanup}
      onAuthorizationModeChange={(mode) => {
        const selectionSequence = ++permissionSelectionSequenceRef.current;
        if (mode !== "always") {
          if (selectedAuthorizationMode === "always" && selectedPermissionPreset === "full_access") {
            setSelectedPermissionPreset(permissionBeforeFullAccessRef.current ?? permissionPresetForWorkspaceAccessMode(defaultWorkspaceAccessMode));
          }
          permissionBeforeFullAccessRef.current = undefined;
          setSelectedAuthorizationMode(mode);
          return;
        }
        if (!onConfirmFullAccessSelection) {
          actionFeedback.report("validation", t("Use full access for this conversation after explicit confirmation."));
          return;
        }
        const selectionIdentity = conversationIdentityController.capture();
        void onConfirmFullAccessSelection()
          .then((confirmation) => {
            if (!confirmation || selectionSequence !== permissionSelectionSequenceRef.current || !conversationIdentityController.isCurrent(selectionIdentity)) return;
            if (selectedAuthorizationMode !== "always" || selectedPermissionPreset !== "full_access") {
              permissionBeforeFullAccessRef.current = selectedPermissionPreset;
            }
            setSelectedAuthorizationMode("always");
            setSelectedPermissionPreset("full_access");
          })
          .catch((error: unknown) => {
            if (selectionSequence !== permissionSelectionSequenceRef.current || !conversationIdentityController.isCurrent(selectionIdentity)) return;
            actionFeedback.report("validation", error instanceof Error ? error.message : String(error));
          });
      }}
      onModelChange={selectModel}
      onThinkingLevelChange={selectThinkingLevel}
      onSubmit={submitDraft}
      onStop={activeReply && onStopConversation ? () => onStopConversation(activeReply) : undefined}
    />
  );

  const approvalGateNode = (
    <RuntimeApprovalComposerGate
      approvals={inlineApprovalViews}
      approvalErrors={approvalErrors}
      resolvingApprovals={resolvingApprovals}
      surface="normal_conversation"
      onResolve={onResolveApproval}
    />
  );
  const visibleComposerNode = inlineApprovalViews.length > 0 ? approvalGateNode : composerNode;

  if (messages.length > 0) {
    return (
      <>
        <NormalConversationPage
        onOpenSummaryChanges={(reviewCwd) => openConversationReview({ cwd: reviewCwd, baseline: "head" })}
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
          terminalActive: conversationTerminalOpen,
          terminalDisabled: !workspaceCwd.trim(),
          detailsActive: conversationDockController.expanded,
          detailsDisabled: !conversationDockController.available,
          onClearSearch: normalConversationHeader.clearSearch,
          onCloseSearch: () => normalConversationHeader.closeSearch(true),
          onSearchQueryChange: setMessageSearchQuery,
          onToggleSearch: () => {
            setConversationSummaryOpen(false);
            normalConversationHeader.toggleSearch();
          },
          onToggleSummary: () => {
            normalConversationHeader.closeSearch();
            setConversationSummaryOpen((current) => !current);
          },
          onToggleTerminal: () => {
            normalConversationHeader.closeSearch();
            setConversationTerminalOpen((current) => !current);
          },
          onToggleDetails: () => {
            if (!conversationDockController.available) return;
            if (conversationDockOpen) conversationDockController.close();
            setConversationDockOpen((current) => !current);
          },
        }}
        feedProps={{
          messages,
          visibleMessages,
          userProfile,
          runById,
          detailContext,
          composerGateApprovals: inlineApprovalViews,
          generatedMedia: detailContext?.generatedMedia ?? [],
          projectPath: project.projectPath,
          workspaceCwd,
          searchActive: Boolean(normalizedMessageSearchQuery),
          editingMessageId,
          editSaving,
          latestEditableUserMessageId,
          replacementRetryingMessageId,
          replacementRetryError: actionFeedback.messageFor("replacement"),
          onCancelMessageEdit: () => setEditingMessageId(undefined),
          onEditMessage: setEditingMessageId,
          onSaveMessage: messageEditController.save,
          onRetryReplacement: messageEditController.retryReplacement,
          onOpenFiles: openConversationFiles,
          onOpenReportFile: openConversationReportFile,
          onOpenReview: openConversationReview,
          onOpenRun,
        }}
        composerNode={visibleComposerNode}
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
      </>
    );
  }

  return (
    <>
      <NormalConversationEmptyState composerNode={visibleComposerNode} onApplyShortcut={applyShortcut} />
    </>
  );
}

function activeReplyStatus(status: string): status is "queued" | "running" | "waiting_for_approval" {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}
