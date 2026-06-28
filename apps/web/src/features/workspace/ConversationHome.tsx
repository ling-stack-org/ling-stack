import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Copy,
  File,
  FileText,
  Loader2,
  PackagePlus,
  Plus,
  Presentation,
  Search,
  Table2,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { attachmentContentUrl, deleteAttachment, uploadConversationAttachment } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type { ConversationAttachment, ConversationTranscriptStatus, LingTurn, PermissionPreset, ProviderThinkingMode, RunSession, SessionPermissionMode } from "../../types.js";
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
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationFeed,
  ConversationShell,
  MessageActionBar,
  MessageRow,
  type MessageRowAuthorType,
} from "../../shared/conversation/index.js";
import { conversationPermissionPresetMenuOptions, inferPermissionPreset, permissionModeForPreset } from "../../lib/session-permissions.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";

export interface ConversationHomeProjectSelection {
  readonly projectPath?: string;
  readonly projectLabel?: string;
}

export interface ConversationHomeModelOption {
  readonly id: string;
  readonly displayName: string;
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
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ConversationHomeDetailContext {
  readonly threadId?: string;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
}

export interface ConversationHomeSendInput {
  readonly message: string;
  readonly attachmentIds: readonly string[];
  readonly project: ConversationHomeProjectSelection;
  readonly model: ConversationHomeModelSelection;
  readonly authorization: {
    readonly permissionMode: SessionPermissionMode;
    readonly permissionPreset: PermissionPreset;
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
  initialPermissionMode,
  initialPermissionPreset,
  detailContext,
  defaultProviderLabel,
  defaultProviderPresetId,
  modelOptions,
  slashCommands,
  workspaceCwd,
  sending = false,
  onSendConversation,
}: {
  readonly initialDraft?: string;
  readonly initialMessages?: readonly ConversationHomeMessage[];
  readonly initialProjectPath?: string;
  readonly initialProjectLabel?: string;
  readonly initialProviderPresetId?: string;
  readonly initialThinkingLevel?: ProviderThinkingMode;
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
  const [selectedPermissionPreset, setSelectedPermissionPreset] = useState<PermissionPreset>(() => initialPermissionPreset ?? inferPermissionPreset(initialPermissionMode));
  const [messageFeedbackById, setMessageFeedbackById] = useState<Record<string, "up" | "down">>({});
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
  const [project, setProject] = useState<ConversationHomeProjectSelection>(() => ({
    projectPath: initialProjectPath.trim() || undefined,
    projectLabel: initialProjectLabel.trim() || undefined,
  }));
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const thinkingPickerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const pendingAttachmentsRef = useRef<readonly PendingAttachmentItem<ConversationAttachment>[]>([]);
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
    setSelectedPermissionPreset(initialPermissionPreset ?? inferPermissionPreset(initialPermissionMode));
  }, [initialPermissionMode, initialPermissionPreset]);

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
          permissionMode: permissionModeForPreset(selectedPermissionPreset),
          permissionPreset: selectedPermissionPreset,
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
        className="normal-conversation-page"
        ariaLabel={t("Conversation page")}
        feedNode={(
          <ConversationFeed
            className="normal-conversation-feed"
            ariaLabel={t("Conversation messages")}
            items={messages}
            emptyLabel={t("No conversation messages yet")}
            getItemId={(message) => message.id}
            renderItem={(message) => {
              const messageFeedback = messageFeedbackById[message.id];
              const linkedRun = message.runId ? runById.get(message.runId) : undefined;
              const errorText = normalConversationMessageErrorText(message, linkedRun?.status);
              return (
                <MessageRow
                  className={normalConversationMessageClassName(message)}
                  authorType={conversationMessageAuthorType(message)}
                  authorName={conversationMessageAuthorName(message, t)}
                  createdAtLabel={formatConversationTimeLabel(message.createdAt)}
                  body={errorText ? "" : message.content || (message.status === "running" ? t("Ling Agent is thinking...") : "")}
                  bodyCompact
                  bodyStreaming={message.status === "running" || message.status === "pending"}
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
                  errorNode={errorText ? <div className="inline-error compact-inline-error normal-conversation-message-error" role="alert">{errorText}</div> : null}
                  actionsNode={message.role === "assistant" && message.content ? (
                    <MessageActionBar
                      surface="normal_conversation"
                      className="normal-conversation-message-actions"
                      copiedLabel={t("Copied")}
                      actions={[
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
        composerNode={<div className="normal-conversation-composer-stack">{composerNode}</div>}
      />
    );
  }

  return (
    <section className="conversation-home" aria-label={t("Conversation home")}>
      <div className="conversation-home-center">
        <div className="conversation-home-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" focusable="false">
            <path d="M7 21V11.5L13 7h12v14H7Z" />
            <path d="M12 21v-5.5M17 21v-8M22 21v-11" />
          </svg>
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
  return option.model;
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
