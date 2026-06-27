import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  File,
  FileText,
  Folder,
  FolderPlus,
  PackagePlus,
  Plus,
  Presentation,
  Search,
  Table2,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ConversationTranscriptStatus, PermissionPreset, ProviderThinkingMode, SessionPermissionMode } from "../../types.js";
import { ConversationAuthorizationMenu } from "./ConversationAuthorizationMenu.js";
import {
  AvatarInitial,
} from "../../shared/components/index.js";
import {
  ConversationFeed,
  ConversationShell,
  MessageRow,
  type MessageRowAuthorType,
} from "../../shared/conversation/index.js";
import {
  authorizationModeToPermission,
  permissionToAuthorizationMode,
  type ConversationAuthorizationSelection,
} from "../../lib/conversation-authorization.js";

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
  readonly role: "user" | "assistant" | "system";
  readonly authorLabel?: string;
  readonly content: string;
  readonly status?: ConversationTranscriptStatus;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface ConversationHomeSendInput {
  readonly message: string;
  readonly project: ConversationHomeProjectSelection;
  readonly model: ConversationHomeModelSelection;
  readonly authorization: ConversationAuthorizationSelection;
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
  defaultProviderLabel,
  defaultProviderPresetId,
  modelOptions,
  slashCommands,
  onChooseProjectDirectory,
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
  readonly defaultProviderLabel: string;
  readonly defaultProviderPresetId: string;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly onChooseProjectDirectory: () => Promise<ConversationHomeProjectSelection | undefined>;
  readonly sending?: boolean;
  readonly onSendConversation: (input: ConversationHomeSendInput) => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [messages, setMessages] = useState<readonly ConversationHomeMessage[]>(initialMessages);
  const [localSending, setLocalSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [skillMenuVisible, setSkillMenuVisible] = useState(false);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedProviderPresetId, setSelectedProviderPresetId] = useState(initialProviderPresetId.trim());
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<ProviderThinkingMode>(initialThinkingLevel);
  const [authorizationMode, setAuthorizationMode] = useState(() => permissionToAuthorizationMode(initialPermissionMode, initialPermissionPreset));
  const [project, setProject] = useState<ConversationHomeProjectSelection>(() => ({
    projectPath: initialProjectPath.trim() || undefined,
    projectLabel: initialProjectLabel.trim() || undefined,
  }));
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const thinkingPickerRef = useRef<HTMLDivElement>(null);
  const visibleCommands = useMemo(() => slashCommands.slice(0, 4), [slashCommands]);
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
  const effectiveProjectLabel = project.projectLabel || (project.projectPath ? summarizePathLabel(project.projectPath) : "");
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
    setFolderMenuOpen(false);
  }, [initialProjectLabel, initialProjectPath]);

  useEffect(() => {
    setSelectedProviderPresetId(initialProviderPresetId.trim());
    setSelectedThinkingLevel(initialThinkingLevel);
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setModelSearch("");
  }, [initialProviderPresetId, initialThinkingLevel]);

  useEffect(() => {
    setAuthorizationMode(permissionToAuthorizationMode(initialPermissionMode, initialPermissionPreset));
  }, [initialPermissionMode, initialPermissionPreset]);

  useEffect(() => {
    if (!folderMenuOpen && !modelMenuOpen && !thinkingMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (
        folderPickerRef.current?.contains(target) ||
        modelPickerRef.current?.contains(target) ||
        thinkingPickerRef.current?.contains(target)
      ) {
        return;
      }
      setFolderMenuOpen(false);
      setModelMenuOpen(false);
      setThinkingMenuOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setFolderMenuOpen(false);
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
  }, [folderMenuOpen, modelMenuOpen, thinkingMenuOpen]);

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

  async function submitDraft(): Promise<void> {
    const trimmedDraft = draft.trim();
    if (!trimmedDraft) {
      setNotice(t("Type a message before sending."));
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
      content: trimmedDraft,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    setMessages((current) => [
      ...current,
      pendingUserMessage,
    ]);
    setDraft("");
    setNotice("");
    setLocalSending(true);
    try {
      await onSendConversation({
        message: trimmedDraft,
        project: project.projectPath ? project : {},
        model: {
          providerPresetId,
          ...(thinkingEnabled && selectedThinkingLevel !== "off" ? { thinkingLevel: selectedThinkingLevel } : {}),
        },
        authorization: authorizationModeToPermission(authorizationMode),
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
    } finally {
      setLocalSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitDraft();
    }
  }

  function insertSkill(command: ComposerSlashCommandOption): void {
    setDraft((current) => {
      const suffix = current.trim() ? ` ${current.trim()}` : "";
      return `/${command.id}${suffix}`;
    });
    setSkillMenuVisible(false);
    setNotice("");
  }

  function handleSkillLauncherBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setSkillMenuVisible(false);
    }
  }

  function applyShortcut(prompt: string): void {
    setDraft(prompt);
    setNotice("");
  }

  async function chooseNewProject(): Promise<void> {
    if (folderPickerBusy) {
      return;
    }
    setFolderPickerBusy(true);
    setNotice("");
    try {
      const selection = await onChooseProjectDirectory();
      if (selection?.projectPath) {
        setProject(selection);
      }
      setFolderMenuOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Folder picker unavailable."));
    } finally {
      setFolderPickerBusy(false);
    }
  }

  function selectModel(option: ConversationHomeModelOption): void {
    setSelectedProviderPresetId(option.id);
    setSelectedThinkingLevel("off");
    setThinkingMenuOpen(false);
    setModelMenuOpen(false);
    setModelSearch("");
    setNotice("");
  }

  function selectThinkingLevel(level: ProviderThinkingMode): void {
    setSelectedThinkingLevel(level);
    setThinkingMenuOpen(false);
    setNotice("");
  }

  const composerNode = (
    <>
      <div className="conversation-home-composer" aria-label={t("New conversation composer")}>
        <div className="conversation-home-composer-body">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setNotice("");
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder={t("Message Ling Stack... (type / for commands)")}
            aria-label={t("Conversation message")}
            rows={3}
          />
        </div>

        <div className="conversation-home-toolbar">
          <div className="conversation-home-tools">
            <div
              className="conversation-skill-launcher"
              onMouseEnter={() => setSkillMenuVisible(true)}
              onMouseLeave={() => setSkillMenuVisible(false)}
              onFocus={() => setSkillMenuVisible(true)}
              onBlur={handleSkillLauncherBlur}
            >
              <button
                type="button"
                aria-label={t("Skills")}
                title={t("Skills")}
                aria-haspopup="listbox"
                aria-expanded={skillMenuVisible}
              >
                <Plus size={15} />
              </button>
              {skillMenuVisible ? (
                <div className="conversation-skill-popover" role="listbox" aria-label={t("Skill menu")}>
                  <div className="conversation-skill-tabs" aria-hidden="true">
                    <span>{t("Skills")}</span>
                    <span>{t("AI teammates")}</span>
                  </div>
                  <div className="conversation-skill-list">
                    {visibleCommands.length > 0 ? visibleCommands.map((command) => (
                      <button key={command.id} type="button" onClick={() => insertSkill(command)}>
                        <span>/{command.id}</span>
                        <small>{command.label}</small>
                      </button>
                    )) : (
                      <span className="conversation-skill-empty">{t("No visible skills")}</span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <ConversationAuthorizationMenu mode={authorizationMode} onModeChange={setAuthorizationMode} />
          </div>
          <div className="conversation-home-right-tools">
            {thinkingEnabled ? (
              <div className="conversation-thinking-picker" ref={thinkingPickerRef}>
                <button
                  className={thinkingOff ? "conversation-thinking-button off" : "conversation-thinking-button active"}
                  type="button"
                  aria-label={t("Selected thinking mode {label}", { label: activeThinkingLabel })}
                  title={thinkingButtonTitle}
                  aria-haspopup="listbox"
                  aria-expanded={thinkingMenuOpen}
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
            <button className="conversation-home-send" type="button" onClick={() => void submitDraft()} aria-label={t("Send")} disabled={sendBusy}>
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
        {notice ? <div className="conversation-home-notice" role="status">{notice}</div> : null}
      </div>
      <div className="conversation-folder-row">
        <div className="conversation-folder-picker" ref={folderPickerRef}>
          <button
            className="conversation-folder-trigger"
            type="button"
            aria-label={effectiveProjectLabel ? t("Selected folder {label}", { label: effectiveProjectLabel }) : t("Select folder")}
            aria-haspopup="menu"
            aria-expanded={folderMenuOpen}
            title={project.projectPath}
            onClick={() => setFolderMenuOpen((current) => !current)}
          >
            <Folder size={16} />
            <span>{effectiveProjectLabel || t("Select folder")}</span>
            <ChevronDown className={folderMenuOpen ? "expanded" : ""} size={13} />
          </button>
          {folderMenuOpen ? (
            <div className="conversation-folder-popover" role="menu" aria-label={t("Project folder options")}>
              {project.projectPath ? (
                <>
                  <span className="conversation-folder-section-label">{t("Recent")}</span>
                  <button
                    className="conversation-folder-option has-tooltip"
                    type="button"
                    role="menuitem"
                    onClick={() => setFolderMenuOpen(false)}
                  >
                    <Folder size={15} />
                    <span className="conversation-folder-option-copy">
                      <strong>{effectiveProjectLabel}</strong>
                      <small>{project.projectPath}</small>
                    </span>
                    <span className="conversation-folder-tooltip" role="tooltip">{project.projectPath}</span>
                  </button>
                </>
              ) : null}
              <button
                className="conversation-folder-option"
                type="button"
                role="menuitem"
                disabled={folderPickerBusy}
                onClick={() => void chooseNewProject()}
              >
                <FolderPlus size={15} />
                <span>{folderPickerBusy ? t("Selecting project...") : t("Choose new project")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
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
            renderItem={(message) => (
              <MessageRow
                className={normalConversationMessageClassName(message)}
                authorType={conversationMessageAuthorType(message)}
                avatar={conversationMessageAvatar(message)}
                authorName={conversationMessageAuthorName(message, t)}
                createdAtLabel={formatConversationTimeLabel(message.createdAt)}
                body={message.content || (message.status === "running" ? t("Ling Agent is thinking...") : "")}
                bodyCompact
                bodyStreaming={message.status === "running" || message.status === "pending"}
              />
            )}
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

function summarizePathLabel(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/u, "");
  const label = normalizedPath.split(/[\\/]/u).filter(Boolean).at(-1);
  return label || path;
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

function conversationMessageAvatar(message: ConversationHomeMessage): JSX.Element | undefined {
  if (message.role === "user") {
    return <AvatarInitial label="Y" tone="default" />;
  }
  if (message.role === "system") {
    return <AvatarInitial label="S" tone="violet" />;
  }
  return <AvatarInitial label="L" tone="violet" />;
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
