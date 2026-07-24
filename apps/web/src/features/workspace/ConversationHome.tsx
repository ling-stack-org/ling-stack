import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { collectLocalFileReferences, parseMessageBody } from "@ling-stack/conversation-ui-core";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Copy,
  File,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  PackagePlus,
  Pencil,
  Plus,
  Presentation,
  Search,
  SquareTerminal,
  Table2,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { attachmentContentUrl, deleteAttachment, editConversationMessage, uploadConversationAttachment } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type { AuthorizationMode, ConversationAttachment, ConversationPendingReplacement, ConversationTranscriptStatus, ExecutionAction, LingTurn, PermissionConfirmation, PermissionPreset, ProviderThinkingMode, RunSession, SessionPermissionMode, TerminalReportDto, WorkspaceAccessMode } from "../../types.js";
import {
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  parseComposerInputParts,
  pendingAssetLabel,
  revokePendingAttachmentPreviews,
  TokenizedComposerInput,
  type ActiveSlashCommandPicker,
  type PendingAttachmentItem,
  type TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import {
  ConversationAttachmentStrip,
  ConversationWorkCell,
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationFeed,
  ConversationReplacementRetry,
  InlineMessageEditor,
  ConversationShell,
  MessageActionBar,
  MessageRow,
  type MessageRowAuthorType,
} from "../../shared/conversation/index.js";
import { conversationPermissionPresetMenuOptions, permissionPresetForWorkspaceAccessMode, workspaceAccessModeForPermissionPreset } from "../../lib/session-permissions.js";
import { authorizationAndAccessToLegacyPermission, resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import { buildConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  ConversationSummaryPopover,
  ConversationTopToolbar,
  WorkspaceRightDock,
  mergeDockFileItems,
  mergeEvidenceGroups,
  projectAttachmentsToFileItems,
  projectFilesToEvidenceGroup,
  projectFilesToReviewItems,
  projectMessagesToReviewItems,
  projectRunsToEvidenceGroup,
  projectRunsToReviewItems,
  type RightDockMessageProjectionInput,
  type WorkspaceRightDockFileTarget,
  type WorkspaceRightDockReviewTarget,
} from "./right-dock/index.js";
import { useWorkspaceBottomPanelResizeController } from "./useWorkspaceBottomPanelResizeController.js";
import { useConversationSummaryPanelController, useConversationSummaryPlacementMotion } from "./useConversationSummaryPanelController.js";
import { useWorkspaceRightDockController } from "./useWorkspaceRightDockController.js";
import { useWorkspaceTerminalSession, WorkspaceTerminalPanel } from "./WorkspaceTerminalPanel.js";

export interface ConversationHomeProjectSelection {
  readonly projectPath?: string;
  readonly projectLabel?: string;
}

export interface ConversationHomeModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly label?: string;
  readonly model: string;
  readonly providerId?: string;
  readonly enabled?: boolean;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
}

export interface ConversationHomeModelSelection {
  readonly providerPresetId?: string;
  readonly thinkingLevel?: ProviderThinkingMode;
}

export interface ConversationHomeMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly authorLabel?: string;
  readonly content: string;
  readonly attachments?: readonly ConversationAttachment[];
  readonly status?: ConversationTranscriptStatus;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ConversationHomeDetailContext {
  readonly threadId?: string;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
}

export interface ConversationHomeSendInput {
  readonly message: string;
  readonly attachmentIds: readonly string[];
  readonly project: ConversationHomeProjectSelection;
  readonly model: ConversationHomeModelSelection;
  readonly authorization: {
    readonly authorizationMode: AuthorizationMode;
    readonly workspaceAccessMode: WorkspaceAccessMode;
    readonly permissionMode: SessionPermissionMode;
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  };
  readonly replaceMessages: (messages: readonly ConversationHomeMessage[]) => void;
  readonly upsertMessage: (message: ConversationHomeMessage) => void;
  readonly failMessage: (message: string) => void;
}

export function ConversationHome({
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
  onOpenRun,
  onConfirmFullAccess,
  onRefreshConversation,
  onSendConversation,
}: {
  readonly initialDraft?: string;
  readonly initialMessages?: readonly ConversationHomeMessage[];
  readonly initialProjectPath?: string;
  readonly initialProjectLabel?: string;
  readonly initialProviderPresetId?: string;
  readonly initialThinkingLevel?: ProviderThinkingMode;
  readonly initialAuthorizationMode?: AuthorizationMode;
  readonly initialWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly initialPermissionMode?: SessionPermissionMode;
  readonly initialPermissionPreset?: PermissionPreset;
  readonly detailContext?: ConversationHomeDetailContext;
  readonly defaultProviderLabel: string;
  readonly defaultProviderPresetId: string;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly workspaceCwd: string;
  readonly sending?: boolean;
  readonly onOpenRun?: (runId: string) => void;
  readonly onConfirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly onRefreshConversation?: () => void | Promise<void>;
  readonly onSendConversation: (input: ConversationHomeSendInput) => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [messages, setMessages] = useState<readonly ConversationHomeMessage[]>(initialMessages);
  const [localSending, setLocalSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedProviderPresetId, setSelectedProviderPresetId] = useState(initialProviderPresetId.trim());
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<ProviderThinkingMode>(initialThinkingLevel);
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(() => permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
    initialWorkspaceAccessMode,
    initialPermissionMode,
    initialPermissionPreset,
  )));
  const [messageFeedbackById, setMessageFeedbackById] = useState<Record<string, "up" | "down">>({});
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [conversationDockOpen, setConversationDockOpen] = useState(false);
  const [conversationSummaryOpen, setConversationSummaryOpen] = useState(false);
  const [conversationTerminalOpen, setConversationTerminalOpen] = useState(false);
  const [conversationRefreshing, setConversationRefreshing] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | undefined>();
  const [editSaving, setEditSaving] = useState(false);
  const [replacementRetryingMessageId, setReplacementRetryingMessageId] = useState<string>();
  const [replacementRetryError, setReplacementRetryError] = useState("");
  const [project, setProject] = useState<ConversationHomeProjectSelection>(() => ({
    projectPath: initialProjectPath.trim() || undefined,
    projectLabel: initialProjectLabel.trim() || undefined,
  }));
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const thinkingPickerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const pendingAttachmentsRef = useRef<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
  const conversationDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: conversationDockOpen,
    resizeObserverKey: detailContext?.threadId ?? workspaceCwd.trim(),
  });
  const conversationSummaryPanel = useConversationSummaryPanelController(conversationSummaryOpen);
  const conversationBottomPanelResize = useWorkspaceBottomPanelResizeController({
    containerRef: conversationDockController.containerRef,
    resizeObserverKey: detailContext?.threadId ?? workspaceCwd.trim(),
  });
  const workspaceTerminalSession = useWorkspaceTerminalSession(workspaceCwd.trim());
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
  const activeModelLabel = activeModelOption ? modelTriggerLabel(activeModelOption) : defaultProviderLabel;
  const thinkingMenuOptions = useMemo(
    () => thinkingOptionsForModel(activeModelOption?.thinkingModes ?? []),
    [activeModelOption?.thinkingModes],
  );
  const thinkingEnabled = thinkingMenuOptions.some((mode) => mode !== "off");
  const activeThinkingLabel = thinkingModeLabel(selectedThinkingLevel, t);
  const thinkingOff = selectedThinkingLevel === "off";
  const runById = useMemo(
    () => new Map((detailContext?.runs ?? []).map((run) => [run.id, run])),
    [detailContext?.runs],
  );
  const latestEditableUserMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "user" && !message.pendingReplacement)?.id,
    [messages],
  );
  const normalizedMessageSearchQuery = messageSearchQuery.trim().toLowerCase();
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
  const conversationDockMessages = useMemo<readonly RightDockMessageProjectionInput[]>(
    () => visibleMessages.map((message) => ({
      id: message.id,
      title: message.role === "assistant" ? t("Assistant message") : message.role === "user" ? t("User message") : t("System message"),
      body: message.content,
      status: conversationDockMessageStatus(message.status),
      errorMessage: normalConversationMessageErrorText(message, message.runId ? runById.get(message.runId)?.status : undefined) || undefined,
      runId: message.runId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    [runById, t, visibleMessages],
  );
  const conversationDockFileItems = useMemo(
    () => mergeDockFileItems(
      projectAttachmentsToFileItems(visibleMessages.flatMap((message) => message.attachments ?? []), t),
      visibleMessages.flatMap((message) => collectLocalFileReferences(
        parseMessageBody(message.content, project.projectPath?.trim() || workspaceCwd.trim()),
      ).map((reference, index) => ({
        id: `inline-ref:${message.id}:${reference.raw}:${index}`,
        name: fileNameFromReferencePath(reference.displayPath),
        pathLabel: reference.displayPath,
        kind: "reference" as const,
        status: "available" as const,
        ownerScope: {
          kind: "message" as const,
          id: message.id,
          label: message.role === "assistant" ? t("Assistant message files") : t("User message files"),
          detail: formatConversationTimeLabel(message.updatedAt ?? message.createdAt),
        },
      }))),
    ),
    [project.projectPath, t, visibleMessages, workspaceCwd],
  );
  const conversationDockEvidenceGroups = useMemo(
    () => mergeEvidenceGroups(
      projectRunsToEvidenceGroup(detailContext?.runs ?? [], t),
      projectFilesToEvidenceGroup(conversationDockFileItems, t),
    ),
    [conversationDockFileItems, detailContext?.runs, t],
  );
  const conversationDockReviewItems = useMemo(
    () => [
      ...projectRunsToReviewItems(detailContext?.runs ?? [], t),
      ...projectMessagesToReviewItems(conversationDockMessages, t),
      ...projectFilesToReviewItems(conversationDockFileItems, t),
    ],
    [conversationDockFileItems, conversationDockMessages, detailContext?.runs, t],
  );
  const latestRun = useMemo(() => {
    const runs = detailContext?.runs ?? [];
    return [...runs].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt))[0];
  }, [detailContext?.runs]);
  const conversationSummaryRows = useMemo(() => [
    {
      id: "workspace",
      icon: <Folder size={18} />,
      primary: t("Workspace"),
      secondary: workspaceDisplayLabel(workspaceCwd.trim()),
    },
    {
      id: "messages",
      icon: <MessageSquare size={18} />,
      primary: t("Thread"),
      secondary: visibleMessages.length === 1 ? t("1 item") : t("{count} items", { count: visibleMessages.length }),
    },
    ...(latestRun ? [{
      id: "latest-run",
      icon: <SquareTerminal size={18} />,
      tone: latestRun.status === "failed" ? "failed" as const : latestRun.status === "running" ? "running" as const : "neutral" as const,
      primary: t("Latest run"),
      secondary: runTaskSnapshotTitle(latestRun) ?? latestRun.status,
    }] : []),
    {
      id: "files",
      icon: <FileText size={18} />,
      primary: t("Files"),
      secondary: t("{count} files", { count: conversationDockFileItems.length }),
    },
  ], [conversationDockFileItems.length, latestRun, t, visibleMessages.length, workspaceCwd]);
  const conversationSummaryShouldRender = conversationSummaryPanel.rendered;
  const conversationSummaryInMainLayout = conversationSummaryShouldRender && conversationDockOpen;
  const conversationSummaryPlacementRef = useConversationSummaryPlacementMotion(
    conversationSummaryOpen && conversationSummaryShouldRender,
    conversationSummaryInMainLayout ? "main" : "header",
  );

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
  const conversationSummaryNode = (
    <ConversationSummaryPopover
      title={t("Environment")}
      subtitle={workspaceDisplayLabel(workspaceCwd.trim())}
      rows={conversationSummaryRows}
      onClose={() => setConversationSummaryOpen(false)}
    />
  );

  async function refreshConversation(): Promise<void> {
    if (!onRefreshConversation || conversationRefreshing) {
      return;
    }
    setConversationRefreshing(true);
    try {
      await onRefreshConversation();
    } finally {
      setConversationRefreshing(false);
    }
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
      await refreshConversation();
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
      await refreshConversation();
    } catch (error) {
      setReplacementRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacementRetryingMessageId(undefined);
    }
  }
  const thinkingButtonLabel = thinkingOff
    ? t("Thinking off")
    : t("Thinking {label}", { label: activeThinkingLabel });
  const thinkingButtonTitle = thinkingOff
    ? t("Thinking is off; no thinking level will be sent.")
    : t("This thinking level will be sent with the next message.");
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const visibleModelOptions = useMemo(() => {
    if (!normalizedModelSearch) {
      return modelOptions;
    }
    return modelOptions.filter((option) =>
      [
        option.displayName,
        option.label ?? "",
        option.model,
        option.providerId ?? "",
      ].join(" ").toLowerCase().includes(normalizedModelSearch)
    );
  }, [modelOptions, normalizedModelSearch]);
  const composerInputParts = useMemo(
    () => parseComposerInputParts(draft, {
      cwd: project.projectPath,
      slashCommands,
    }),
    [draft, project.projectPath, slashCommands],
  );

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
  const sendBusy = sending || localSending;

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
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setModelSearch("");
  }, [initialProviderPresetId, initialThinkingLevel]);

  useEffect(() => {
    setSelectedPermissionPreset(permissionPresetForWorkspaceAccessMode(resolveWorkspaceAccessMode(
      initialWorkspaceAccessMode,
      initialPermissionMode,
      initialPermissionPreset,
    )));
  }, [initialPermissionMode, initialPermissionPreset, initialWorkspaceAccessMode]);

  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (
        modelPickerRef.current?.contains(target) ||
        thinkingPickerRef.current?.contains(target)
      ) {
        return;
      }
      setModelMenuOpen(false);
      setThinkingMenuOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelMenuOpen, thinkingMenuOpen]);

  useEffect(() => {
    if (!thinkingEnabled) {
      setSelectedThinkingLevel("off");
      setThinkingMenuOpen(false);
      return;
    }
    if (!thinkingMenuOptions.includes(selectedThinkingLevel)) {
      setSelectedThinkingLevel("off");
    }
  }, [selectedThinkingLevel, thinkingEnabled, thinkingMenuOptions]);

  useEffect(() => {
    if (!sendBusy) {
      return;
    }
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
  }, [sendBusy]);

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
    if (sendBusy) {
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
      permissionConfirmation = onConfirmFullAccess
        ? await onConfirmFullAccess()
        : globalThis.confirm(t("Full access can allow broad local file, network, and tool access for the next run. Continue?"))
          ? {
              mode: "full_access",
              confirmed: true,
              confirmedAt: new Date().toISOString(),
              reason: "user_confirmed_full_access",
            }
          : undefined;
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
    if (fileList.length === 0 || sendBusy) {
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
    if (sendBusy) {
      return;
    }
    setSelectedProviderPresetId(option.id);
    setSelectedThinkingLevel("off");
    setThinkingMenuOpen(false);
    setModelMenuOpen(false);
    setModelSearch("");
    setNotice("");
  }

  function selectThinkingLevel(level: ProviderThinkingMode): void {
    if (sendBusy) {
      return;
    }
    setSelectedThinkingLevel(level);
    setThinkingMenuOpen(false);
    setNotice("");
  }

  const composerNode = (
    <>
      <ConversationComposerShell
        surface="normal_conversation"
        density="floating"
        className="conversation-home-composer"
        ariaLabel={t("New conversation composer")}
        toolbarClassName="conversation-home-toolbar"
        leftToolsClassName="conversation-home-tools"
        rightToolsClassName="conversation-home-right-tools"
        inputNode={(
          <div className="conversation-home-composer-body">
            <TokenizedComposerInput
              ref={composerInputRef}
              value={draft}
              parts={composerInputParts}
              onChange={(value, caret) => {
                setDraft(value);
                setNotice("");
                updateSlashPicker(value, caret);
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              onSelect={updateSlashPicker}
              placeholder={t("Message Ling Stack... (type / for commands)")}
              ariaLabel={t("Conversation message")}
            />
          </div>
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
        previewNode={pendingAttachments.length > 0 ? (
          <div className="pending-assets composer-preview-strip" aria-label={t("Pending message assets")}>
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
                <button className="composer-preview-remove" type="button" onClick={() => removePendingAttachment(item.localId)} aria-label={t("Remove pending attachment")}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        leftToolsNode={(
          <>
            <label className="icon-button composer-tool-button composer-attach-button" aria-label={t("Attach files")} title={t("Attach files")}>
              <Plus size={17} />
              <input
                type="file"
                multiple
                hidden
                accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
                onChange={(event) => {
                  if (event.currentTarget.files) {
                    void attachConversationFiles(event.currentTarget.files);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <ComposerPermissionMenu
              preset={selectedPermissionPreset}
              options={conversationPermissionPresetMenuOptions(t)}
              disabled={sendBusy}
              disabledReason={t("Permission is locked while the current message is running.")}
              fullAccessConfirmationMessage={t("Full access can allow broad local file, network, and tool access for the next run. Continue?")}
              onPresetChange={setSelectedPermissionPreset}
            />
          </>
        )}
        rightToolsNode={(
          <>
            {thinkingEnabled ? (
              <div className="conversation-thinking-picker" ref={thinkingPickerRef}>
                <button
                  className={thinkingOff ? "conversation-thinking-button off" : "conversation-thinking-button active"}
                  type="button"
                  aria-label={t("Selected thinking mode {label}", { label: activeThinkingLabel })}
                  title={thinkingButtonTitle}
                  aria-haspopup="listbox"
                  aria-expanded={thinkingMenuOpen}
                  disabled={sendBusy}
                  onClick={() => setThinkingMenuOpen((current) => !current)}
                >
                  <Brain size={15} />
                  <span>{thinkingButtonLabel}</span>
                  <ChevronDown className={thinkingMenuOpen ? "expanded" : ""} size={13} />
                </button>
                {thinkingMenuOpen ? (
                  <div className="conversation-thinking-menu" role="listbox" aria-label={t("Thinking mode")}>
                    {thinkingMenuOptions.map((level) => {
                      const selected = level === selectedThinkingLevel;
                      return (
                        <button
                          key={level}
                          className={selected ? "conversation-thinking-option selected" : "conversation-thinking-option"}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => selectThinkingLevel(level)}
                        >
                          <span>{thinkingModeLabel(level, t)}</span>
                          {selected ? <Check size={14} /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="conversation-model-picker" ref={modelPickerRef}>
              <button
                className="conversation-model-trigger"
                type="button"
                aria-label={t("Selected model {label}", { label: activeModelLabel })}
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                disabled={sendBusy}
                onClick={() => setModelMenuOpen((current) => !current)}
              >
                <span>{activeModelLabel}</span>
                <ChevronDown className={modelMenuOpen ? "expanded" : ""} size={13} />
              </button>
              {modelMenuOpen ? (
                <div className="conversation-model-menu" role="listbox" aria-label={t("Model options")}>
                  <label className="conversation-model-search">
                    <Search size={14} />
                    <input
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder={t("Search models")}
                      aria-label={t("Search models")}
                      autoFocus
                    />
                  </label>
                  <div className="conversation-model-list">
                    {visibleModelOptions.length > 0 ? visibleModelOptions.map((option) => {
                      const selected = option.id === activeProviderPresetId;
                      return (
                        <button
                          key={option.id}
                          className={selected ? "conversation-model-option selected" : "conversation-model-option"}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => selectModel(option)}
                        >
                          <span className="conversation-model-option-copy">
                            <strong>{modelTriggerLabel(option)}</strong>
                          </span>
                          {option.id === defaultProviderPresetId ? <span className="conversation-model-default-chip">{t("Default")}</span> : null}
                          {selected ? <Check size={14} /> : null}
                        </button>
                      );
                    }) : (
                      <span className="conversation-model-empty">{t("No matching models")}</span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className="conversation-home-send"
              type="button"
              onClick={() => void submitDraft()}
              aria-label={t("Send")}
              disabled={sendBusy || (!draft.trim() && readyAttachmentIds.length === 0)}
            >
              <ArrowUp size={17} />
            </button>
          </>
        )}
        feedbackNode={notice ? <div className="conversation-home-notice" role="status">{notice}</div> : null}
      />
    </>
  );

  if (messages.length > 0) {
    return (
      <ConversationShell
        rootRef={conversationDockController.containerRef}
        style={{
          ...conversationDockController.containerStyle,
          ...conversationBottomPanelResize.panelStyle,
        }}
        className={[
          "normal-conversation-page",
          conversationDockController.visible ? "with-right-dock" : "",
          conversationSummaryInMainLayout ? "with-conversation-summary-panel" : "",
          conversationSummaryInMainLayout ? (conversationSummaryPanel.expanded ? "summary-panel-expanded" : "summary-panel-collapsed") : "",
          conversationDockController.visible && !conversationDockController.expanded ? "workspace-right-dock-collapsed" : "",
          conversationTerminalOpen ? "with-bottom-terminal" : "",
          conversationDockController.resizing ? "is-resizing-workspace-right-dock" : "",
          conversationBottomPanelResize.resizing ? "is-resizing-workspace-bottom-panel" : "",
        ].filter(Boolean).join(" ")}
        ariaLabel={t("Conversation page")}
        headerNode={(
          <header className={messageSearchOpen ? "normal-conversation-header searching" : "normal-conversation-header"}>
            <ConversationTopToolbar
              ariaLabel={t("Conversation workspace toolbar")}
              searchActive={messageSearchOpen}
              searchLabel={t("Search")}
              refreshDisabled={!onRefreshConversation}
              refreshLabel={t("Refresh")}
              refreshLoading={conversationRefreshing}
              summaryActive={conversationSummaryOpen}
              summaryLabel={t("Summary")}
              terminalActive={conversationTerminalOpen}
              terminalDisabled={!workspaceCwd.trim()}
              terminalLabel={t("Terminal")}
              detailsActive={conversationDockOpen}
              detailsLabel={conversationDockOpen ? t("Hide details") : t("Show details")}
              onToggleSearch={() => {
                setConversationSummaryOpen(false);
                setMessageSearchOpen((current) => !current);
              }}
              onRefresh={() => void refreshConversation()}
              onToggleSummary={() => {
                setMessageSearchOpen(false);
                setConversationSummaryOpen((current) => !current);
              }}
              onToggleTerminal={() => {
                setConversationSummaryOpen(false);
                setConversationTerminalOpen((current) => !current);
              }}
              onToggleDetails={() => {
                setConversationDockOpen((current) => !current);
              }}
            />
            {messageSearchOpen ? (
              <label className="conversation-top-search normal-conversation-search">
                <Search size={14} />
                <input value={messageSearchQuery} onChange={(event) => setMessageSearchQuery(event.target.value)} placeholder={t("Search conversation messages")} />
                {messageSearchQuery ? (
                  <button type="button" onClick={() => setMessageSearchQuery("")} aria-label={t("Clear search")}>
                    <X size={14} />
                  </button>
                ) : null}
              </label>
            ) : null}
            {conversationSummaryShouldRender && !conversationSummaryInMainLayout ? (
              <div
                ref={conversationSummaryPlacementRef}
                className={`channel-progress-popover conversation-summary-popover-wrap normal-conversation-summary-popover ${conversationSummaryPanel.motionClass}`}
              >
                {conversationSummaryNode}
              </div>
            ) : null}
          </header>
        )}
        feedNode={(
          <ConversationFeed
            className="normal-conversation-feed"
            ariaLabel={t("Conversation messages")}
            items={visibleMessages}
            emptyLabel={t("No conversation messages yet")}
            getItemId={(message) => message.id}
            renderItem={(message) => {
              const messageFeedback = messageFeedbackById[message.id];
              const linkedRun = message.runId ? runById.get(message.runId) : undefined;
              const relatedRun = linkedRun ?? (message.turnId
                ? runById.get(messages.find((candidate) => candidate.role === "assistant" && candidate.turnId === message.turnId)?.runId ?? "")
                : undefined);
              const terminalReport = detailContext?.terminalReports.find((report) =>
                (message.turnId && report.source.kind === "turn" && report.source.id === message.turnId) ||
                (message.runId && report.source.kind === "run" && report.source.id === message.runId)
              );
              const errorText = normalConversationMessageErrorText(message, linkedRun?.status);
              const messageExecutionActions = linkedRun
                ? detailContext?.executionActions.filter((action) => action.runId === linkedRun.id) ?? []
                : [];
              const workCell = message.role === "assistant" && message.threadId && linkedRun && (
                normalConversationTerminalReportHasWorkEvidence(terminalReport) ||
                messageExecutionActions.length > 0 ||
                linkedRun.status === "queued" ||
                linkedRun.status === "running" ||
                linkedRun.status === "waiting_for_approval"
              ) ? buildConversationWorkCellViewModel({
                threadId: message.threadId,
                runs: [linkedRun],
                allowRunThreadFallback: true,
                approvals: [],
                artifactsByRun: {},
                executionActions: messageExecutionActions,
                t,
                terminalReport,
              }) : undefined;
              const hasStructuredTerminalReport = Boolean(workCell?.terminalReportRows.length);
              return (
                <MessageRow
                  className={normalConversationMessageClassName(message)}
                  authorType={conversationMessageAuthorType(message)}
                  authorName={conversationMessageAuthorName(message, t)}
                  createdAtLabel={formatConversationTimeLabel(message.createdAt)}
                  statusNode={message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
                  body={errorText || hasStructuredTerminalReport ? "" : message.content || (message.status === "running" ? t("Ling Agent is thinking...") : "")}
                  bodyCwd={project.projectPath?.trim() || workspaceCwd.trim()}
                  bodyNode={editingMessageId === message.id ? (
                    <InlineMessageEditor
                      initialValue={message.content}
                      cwd={project.projectPath?.trim() || workspaceCwd.trim()}
                      ariaLabel={t("Edit message")}
                      saveLabel={t("Save and resend")}
                      cancelLabel={t("Cancel")}
                      saving={editSaving}
                      warning={runMayHaveWorkspaceChanges(relatedRun) ? t("This turn changed the workspace. The edited prompt will continue from the current state.") : undefined}
                      onCancel={() => setEditingMessageId(undefined)}
                      onSave={(value) => saveEditedMessage(message, value)}
                    />
                  ) : undefined}
                  bodyCompact
                  bodyStreaming={message.status === "running" || message.status === "pending"}
                  bodyOnOpenLocalFile={openConversationFiles}
                  attachmentsNode={message.attachments && message.attachments.length > 0 ? (
                    <ConversationAttachmentStrip
                      attachments={message.attachments.map((attachment) => ({
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
                  ) : null}
                  workCellNode={workCell ? (
                    <ConversationWorkCell
                      model={workCell}
                      surface="normal_conversation"
                      cwd={detailContext?.runs.find((run) => run.id === workCell.anchorRunId)?.cwd ?? workspaceCwd.trim()}
                      onOpenRun={onOpenRun}
                      onOpenWorkspaceFile={openConversationReportFile}
                      onOpenWorkspaceReview={openConversationReview}
                      loadPreview={loadPreviewContent}
                    />
                  ) : null}
                  errorNode={(
                    <>
                      {errorText ? <div className="inline-error compact-inline-error normal-conversation-message-error" role="alert">{errorText}</div> : null}
                      {message.pendingReplacement ? (
                        <ConversationReplacementRetry
                          failureReason={replacementRetryError || message.pendingReplacement.failureReason}
                          retryLabel={t("Retry response")}
                          retrying={replacementRetryingMessageId === message.id}
                          onRetry={() => void retryEditedMessageReplacement(message)}
                        />
                      ) : null}
                    </>
                  )}
                  actionsNode={message.content && editingMessageId !== message.id ? (
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
                        ...(message.id === latestEditableUserMessageId ? [{
                          id: "edit",
                          kind: "edit_latest" as const,
                          label: t("Edit message"),
                          icon: <Pencil size={14} />,
                          onClick: () => setEditingMessageId(message.id),
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
                          selected: messageFeedback === "up",
                          onClick: () => toggleMessageFeedback(message.id, "up"),
                        },
                        {
                          id: "dislike",
                          kind: "dislike",
                          label: t("Dislike response"),
                          icon: <ThumbsDown size={14} />,
                          selected: messageFeedback === "down",
                          onClick: () => toggleMessageFeedback(message.id, "down"),
                        },
                      ]}
                    />
                  ) : null}
                />
              );
            }}
          />
        )}
        composerNode={(
          <div
            className="normal-conversation-composer-stack"
            data-computer-use-obstacle="true"
            data-computer-use-obstacle-kind="composer"
          >
            {composerNode}
          </div>
        )}
        sideNode={(
          <>
            {conversationSummaryInMainLayout ? (
              <aside
                ref={conversationSummaryPlacementRef}
                className={`channel-progress-popover channel-progress-panel conversation-summary-side-panel normal-conversation-summary-panel ${conversationSummaryPanel.motionClass}`}
                data-computer-use-obstacle="true"
                data-computer-use-obstacle-kind="summary"
                aria-label={t("Summary")}
              >
                {conversationSummaryNode}
              </aside>
            ) : null}
            {conversationDockController.visible ? (
              <button
                className="workspace-right-dock-resize-handle"
                type="button"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("Resize workspace dock")}
                title={t("Drag to resize workspace dock")}
                onPointerDown={conversationDockController.handleResizePointerDown}
                onPointerMove={conversationDockController.handleResizePointerMove}
                onPointerUp={conversationDockController.handleResizePointerEnd}
                onPointerCancel={conversationDockController.handleResizePointerEnd}
                onLostPointerCapture={conversationDockController.handleResizePointerEnd}
              />
            ) : null}
            {conversationDockController.visible ? (
              <div
                className="workspace-right-dock-frame normal-conversation-right-dock-frame"
                data-computer-use-obstacle="true"
                data-computer-use-obstacle-kind="right-dock"
              >
                <WorkspaceRightDock
                  surface="normal_conversation"
                  open={conversationDockOpen}
                  ariaLabel={t("Conversation workspace dock")}
                  className="normal-conversation-right-dock"
                  cwd={workspaceCwd.trim()}
                  launcherTitle={t("Workspace tools")}
                  launcherSubtitle={workspaceDisplayLabel(workspaceCwd.trim())}
                  reviewItems={conversationDockReviewItems}
                  evidenceGroups={conversationDockEvidenceGroups}
                  fileItems={conversationDockFileItems}
                  terminalSession={workspaceTerminalSession}
                  includeActivity
                  pageRequest={conversationDockController.pageRequest}
                  onPageRequestConsumed={conversationDockController.consumePageRequest}
                  onClose={() => setConversationDockOpen(false)}
                />
              </div>
            ) : null}
            {conversationTerminalOpen ? (
              <WorkspaceTerminalPanel
                cwd={workspaceCwd.trim()}
                className="workspace-bottom-terminal normal-conversation-bottom-terminal"
                session={workspaceTerminalSession}
                style={conversationBottomPanelResize.panelStyle}
                resizeHandleNode={(
                  <button
                    className="workspace-bottom-panel-resize-handle"
                    type="button"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={t("Resize terminal panel")}
                    title={t("Drag to resize terminal panel")}
                    onPointerDown={conversationBottomPanelResize.handleResizePointerDown}
                    onPointerMove={conversationBottomPanelResize.handleResizePointerMove}
                    onPointerUp={conversationBottomPanelResize.handleResizePointerEnd}
                    onPointerCancel={conversationBottomPanelResize.handleResizePointerEnd}
                    onLostPointerCapture={conversationBottomPanelResize.handleResizePointerEnd}
                  />
                )}
                onClose={() => setConversationTerminalOpen(false)}
              />
            ) : null}
          </>
        )}
      />
    );
  }

  return (
    <section className="conversation-home" aria-label={t("Conversation home")}>
      <div className="conversation-home-center">
        <div className="conversation-home-mark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}icons/ling-stack-gpt-image-2-icon.png`} alt="" />
        </div>
        <h1>{t("Ling Stack, make work easier.")}</h1>

        {composerNode}

        <div className="conversation-home-shortcuts" aria-label={t("Conversation shortcuts")}>
          <button type="button" onClick={() => applyShortcut(t("Create a Team workspace for this project."))}>
            <PackagePlus size={14} />
            <span>{t("Create Team")}</span>
          </button>
          <button type="button" onClick={() => applyShortcut(t("Draft a slide outline from the current context."))}>
            <Presentation size={14} />
            <span>{t("Slides")}</span>
          </button>
          <button type="button" onClick={() => applyShortcut(t("Analyze an uploaded PDF and summarize the decisions."))}>
            <FileText size={14} />
            <span>{t("PDF")}</span>
          </button>
          <button type="button" onClick={() => applyShortcut(t("Organize the latest documents into action items."))}>
            <File size={14} />
            <span>{t("Docs")}</span>
          </button>
          <button type="button" onClick={() => applyShortcut(t("Generate a table from the current discussion."))}>
            <Table2 size={14} />
            <span>{t("Sheets")}</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function modelTriggerLabel(option: ConversationHomeModelOption): string {
  return option.label?.trim() || option.model;
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

function thinkingOptionsForModel(modes: readonly ProviderThinkingMode[]): readonly ProviderThinkingMode[] {
  const orderedModes = uniqueThinkingModes(modes);
  if (!orderedModes.some((mode) => mode !== "off")) {
    return [];
  }
  return orderedModes.includes("off") ? orderedModes : ["off", ...orderedModes];
}

function uniqueThinkingModes(modes: readonly ProviderThinkingMode[]): readonly ProviderThinkingMode[] {
  const selectedModes = new Set(modes);
  const order: readonly ProviderThinkingMode[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  return order.filter((mode) => selectedModes.has(mode));
}

function thinkingModeLabel(mode: ProviderThinkingMode, t: (key: string) => string): string {
  switch (mode) {
    case "off":
      return t("Off");
    case "auto":
      return t("Auto");
    case "minimal":
      return t("Minimal");
    case "low":
      return t("Low");
    case "medium":
      return t("Medium");
    case "high":
      return t("High");
    case "xhigh":
      return t("XHigh");
  }
}

function conversationAuthorLabel(label: string, t: (key: string) => string): string {
  return label === "Ling Agent" ? t("Ling Agent") : label;
}

function conversationMessageAuthorType(message: ConversationHomeMessage): MessageRowAuthorType {
  if (message.role === "user") {
    return "local-user";
  }
  if (message.role === "system") {
    return "system";
  }
  return "ai-teammate";
}

function conversationMessageAuthorName(message: ConversationHomeMessage, t: (key: string) => string): string {
  if (message.role === "user") {
    return t("You");
  }
  if (message.role === "system") {
    return t("System");
  }
  return conversationAuthorLabel(message.authorLabel || "Ling Agent", t);
}

function conversationDockMessageStatus(
  status: ConversationHomeMessage["status"],
): RightDockMessageProjectionInput["status"] | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "failed":
    case "blocked":
    case "cancelled":
      return status;
    case "succeeded":
      return "ready";
    case undefined:
      return undefined;
  }
}

function workspaceDisplayLabel(cwd: string): string {
  const normalized = cwd.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "-";
  }
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function runTaskSnapshotTitle(run: RunSession): string | undefined {
  const snapshot = run.taskSnapshot;
  if (!snapshot || typeof snapshot !== "object" || !("title" in snapshot)) {
    return undefined;
  }
  const title = snapshot.title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

function runMayHaveWorkspaceChanges(run: RunSession | undefined): boolean {
  if (!run?.requestSnapshot || typeof run.requestSnapshot !== "object") {
    return false;
  }
  const tools = "tools" in run.requestSnapshot ? run.requestSnapshot.tools : undefined;
  return Array.isArray(tools) && tools.some((tool) => tool === "edit" || tool === "write" || tool === "bash");
}

function normalConversationTerminalReportHasWorkEvidence(report: TerminalReportDto | undefined): boolean {
  if (!report) {
    return false;
  }
  if (
    report.outcome.corrections.length > 0 ||
    report.changes.length > 0 ||
    report.artifacts.length > 0 ||
    report.risks.length > 0
  ) {
    return true;
  }
  const hasExecutionReference = (refs: TerminalReportDto["references"]): boolean => refs.some((ref) =>
    ref.visibility !== "developer_only" &&
    ref.sensitivity !== "secret_adjacent" &&
    ["approval", "artifact", "check", "file", "operation"].includes(ref.kind),
  );
  return report.verification.some((verification) =>
    Boolean(verification.command?.trim() || verification.summary?.trim()) || hasExecutionReference(verification.sourceRefs),
  ) || hasExecutionReference(report.references) || hasExecutionReference(report.outcome.sourceRefs);
}

function normalConversationMessageErrorText(message: ConversationHomeMessage, runStatus?: RunSession["status"]): string {
  if (message.role === "user") {
    return "";
  }
  if (message.status !== "blocked" && message.status !== "failed" && runStatus !== "failed" && runStatus !== "cancelled") {
    return "";
  }
  return message.content.trim();
}

function normalConversationMessageClassName(message: ConversationHomeMessage): string {
  return [
    "channel-message-row",
    "normal-conversation-message-row",
    message.status === "blocked" || message.status === "failed" ? "blocked" : "",
  ].filter(Boolean).join(" ");
}

function formatConversationTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fileNameFromReferencePath(path: string): string {
  const withoutLocation = path.replace(/#L\d+(?:-L?\d+)?$/u, "").replace(/:\d+(?::\d+)?$/u, "");
  return withoutLocation.split("/").filter(Boolean).at(-1) ?? withoutLocation;
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
