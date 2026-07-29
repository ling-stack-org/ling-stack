import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { ArrowUp, Brain, Check, ChevronDown, FileText, Loader2, Plus, Search, Square, X } from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { useI18n } from "../../i18n.js";
import { conversationPermissionPresetMenuOptions } from "../../lib/session-permissions.js";
import {
  ComposerPermissionMenu,
  ConversationComposerShell,
  TokenizedComposerInput,
  type TokenizedComposerInputHandle,
  type TokenizedComposerInputProps,
} from "../../shared/conversation/index.js";
import {
  Button,
  IconButton,
  InlineFeedback,
  Input,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../shared/ui/index.js";
import { pendingAssetLabel, type ActiveSlashCommandPicker, type PendingAttachmentItem } from "../../shared/components/index.js";
import type { ConversationAttachment, PermissionPreset, ProviderThinkingMode } from "../../types.js";
import {
  normalConversationModelLabel,
  normalConversationThinkingLabel,
  normalConversationThinkingOptions,
} from "./normal-conversation-composer-options.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";

export interface NormalConversationComposerProps {
  readonly draft: string;
  readonly inputRef: Ref<TokenizedComposerInputHandle>;
  readonly inputParts: TokenizedComposerInputProps["parts"];
  readonly slashPicker?: ActiveSlashCommandPicker;
  readonly slashOptions: readonly ComposerSlashCommandOption[];
  readonly slashActiveIndex: number;
  readonly pendingAttachments: readonly PendingAttachmentItem<ConversationAttachment>[];
  readonly permissionPreset: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly selectedProviderPresetId: string;
  readonly defaultProviderPresetId: string;
  readonly defaultProviderLabel: string;
  readonly selectedThinkingLevel: ProviderThinkingMode;
  readonly sendBusy: boolean;
  readonly activeRun: boolean;
  readonly stopping: boolean;
  readonly canSend: boolean;
  readonly notice: string;
  readonly onDraftChange: (value: string, caret: number) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerSelect: (value: string, caret: number) => void;
  readonly onCommitSlashCommand: (option: ComposerSlashCommandOption) => void;
  readonly onAttachFiles: (files: FileList) => void | Promise<void>;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onPermissionPresetChange: (preset: PermissionPreset) => void;
  readonly onModelChange: (option: ConversationHomeModelOption) => void;
  readonly onThinkingLevelChange: (level: ProviderThinkingMode) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
}

export function NormalConversationComposer({
  activeRun,
  canSend,
  defaultProviderLabel,
  defaultProviderPresetId,
  draft,
  inputParts,
  inputRef,
  modelOptions,
  notice,
  onAttachFiles,
  onCommitSlashCommand,
  onComposerKeyDown,
  onComposerPaste,
  onComposerSelect,
  onDraftChange,
  onModelChange,
  onPermissionPresetChange,
  onRemoveAttachment,
  onStop,
  onSubmit,
  onThinkingLevelChange,
  pendingAttachments,
  permissionPreset,
  fullAccessConfirmed,
  selectedProviderPresetId,
  selectedThinkingLevel,
  sendBusy,
  slashActiveIndex,
  slashOptions,
  slashPicker,
  stopping,
}: NormalConversationComposerProps): JSX.Element {
  const { t } = useI18n();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const activeProviderPresetId = selectedProviderPresetId || defaultProviderPresetId;
  const activeModelOption = modelOptions.find((option) => option.id === activeProviderPresetId);
  const activeModelLabel = activeModelOption ? normalConversationModelLabel(activeModelOption) : defaultProviderLabel;
  const thinkingOptions = useMemo(
    () => normalConversationThinkingOptions(activeModelOption?.thinkingModes ?? []),
    [activeModelOption?.thinkingModes],
  );
  const thinkingEnabled = thinkingOptions.length > 0;
  const activeThinkingLabel = normalConversationThinkingLabel(selectedThinkingLevel, t);
  const thinkingOff = selectedThinkingLevel === "off";
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const visibleModelOptions = useMemo(() => {
    if (!normalizedModelSearch) {
      return modelOptions;
    }
    return modelOptions.filter((option) => [
      option.displayName,
      option.label ?? "",
      option.model,
      option.providerId ?? "",
    ].join(" ").toLowerCase().includes(normalizedModelSearch));
  }, [modelOptions, normalizedModelSearch]);

  useEffect(() => {
    if (!sendBusy && !activeRun) {
      return;
    }
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
  }, [activeRun, sendBusy]);

  useEffect(() => {
    if (!thinkingEnabled && thinkingMenuOpen) {
      setThinkingMenuOpen(false);
    }
  }, [thinkingEnabled, thinkingMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    const frame = globalThis.requestAnimationFrame(() => modelSearchRef.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [modelMenuOpen]);

  function selectModel(option: ConversationHomeModelOption): void {
    onModelChange(option);
    setModelMenuOpen(false);
    setModelSearch("");
  }

  function selectThinkingLevel(level: ProviderThinkingMode): void {
    onThinkingLevelChange(level);
    setThinkingMenuOpen(false);
  }

  const interactionLocked = sendBusy || activeRun;
  const stopAvailable = activeRun && Boolean(onStop);
  const actionLabel = stopAvailable ? (stopping ? t("Stopping") : t("Stop")) : t("Send");
  const actionLoading = stopping || (sendBusy && !stopAvailable);
  const ActionIcon = stopAvailable ? Square : ArrowUp;

  return (
    <ConversationComposerShell
      surface="normal_conversation"
      density="floating"
      className="conversation-home-composer normal-conversation-composer"
      ariaLabel={t("New conversation composer")}
      toolbarClassName="conversation-home-toolbar normal-conversation-composer-toolbar"
      leftToolsClassName="conversation-home-tools normal-conversation-composer-tools"
      rightToolsClassName="conversation-home-right-tools normal-conversation-composer-actions"
      inputNode={(
        <div className="conversation-home-composer-body normal-conversation-composer-body">
          <TokenizedComposerInput
            ref={inputRef}
            value={draft}
            parts={inputParts}
            onChange={onDraftChange}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            onSelect={onComposerSelect}
            placeholder={t("Message Ling Stack... (type / for commands)")}
            ariaLabel={t("Conversation message")}
          />
        </div>
      )}
      slashPickerNode={slashPicker ? (
        <div className="mention-picker-popover command-picker-popover conversation-composer-popover" role="listbox" aria-label={t("Slash command")}>
          {slashOptions.length > 0 ? slashOptions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === Math.min(slashActiveIndex, slashOptions.length - 1)}
              className={index === Math.min(slashActiveIndex, slashOptions.length - 1) ? "mention-suggestion command active" : "mention-suggestion command"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommitSlashCommand(option)}
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
                <span className="composer-preview-file-icon" aria-hidden="true"><FileText size={17} /></span>
              )}
              <span className="composer-preview-body">
                <strong title={item.fileName}>{item.fileName}</strong>
                <small>{item.error ?? `${t(pendingAssetLabel(item.state))} · ${formatBytes(item.attachment?.sizeBytes ?? item.sizeBytes)}`}</small>
              </span>
              {item.state === "uploading" ? <Loader2 className="composer-preview-state-icon spin" size={13} /> : null}
              <IconButton
                className="composer-preview-remove"
                icon={X}
                label={t("Remove pending attachment")}
                tooltip=""
                onClick={() => onRemoveAttachment(item.localId)}
              />
            </div>
          ))}
        </div>
      ) : null}
      leftToolsNode={(
        <>
          <label
            className="icon-button composer-tool-button composer-attach-button"
            aria-label={t("Attach files")}
            title={interactionLocked ? t("Permission is locked while the current message is running.") : t("Attach files")}
            aria-disabled={interactionLocked}
          >
            <Plus size={17} />
            <input
              data-ling-control-native="true"
              type="file"
              multiple
              hidden
              disabled={interactionLocked}
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
              onChange={(event) => {
                if (event.currentTarget.files) {
                  void onAttachFiles(event.currentTarget.files);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          <ComposerPermissionMenu
            preset={permissionPreset}
            options={conversationPermissionPresetMenuOptions(t, fullAccessConfirmed)}
            disabled={interactionLocked}
            disabledReason={t("Permission is locked while the current message is running.")}
            onPresetChange={onPermissionPresetChange}
          />
        </>
      )}
      rightToolsNode={(
        <>
          {thinkingEnabled ? (
            <Menu open={thinkingMenuOpen} onOpenChange={setThinkingMenuOpen}>
              <MenuTrigger asChild>
                <Button
                  className={thinkingOff ? "conversation-thinking-button off" : "conversation-thinking-button active"}
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Brain size={15} />}
                  trailingIcon={<ChevronDown className={thinkingMenuOpen ? "expanded" : ""} size={13} />}
                  aria-label={t("Selected thinking mode {label}", { label: activeThinkingLabel })}
                  title={thinkingOff
                    ? t("Thinking is off; no thinking level will be sent.")
                    : t("This thinking level will be sent with the next message.")}
                  disabled={interactionLocked}
                >
                  {thinkingOff ? t("Thinking off") : t("Thinking {label}", { label: activeThinkingLabel })}
                </Button>
              </MenuTrigger>
              <MenuContent
                className="conversation-thinking-menu"
                side="top"
                align="end"
                sideOffset={8}
                aria-label={t("Thinking mode")}
              >
                <MenuRadioGroup value={selectedThinkingLevel}>
                  {thinkingOptions.map((level) => {
                    const selected = level === selectedThinkingLevel;
                    return (
                      <MenuRadioItem
                        key={level}
                        className={selected ? "conversation-thinking-option selected" : "conversation-thinking-option"}
                        value={level}
                        onSelect={(event) => {
                          event.preventDefault();
                          selectThinkingLevel(level);
                        }}
                      >
                        <span>{normalConversationThinkingLabel(level, t)}</span>
                        {selected ? <Check size={14} /> : null}
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          ) : null}
          <Menu
            open={modelMenuOpen}
            onOpenChange={(open) => {
              setModelMenuOpen(open);
              if (!open) setModelSearch("");
            }}
          >
            <MenuTrigger asChild>
              <Button
                className="conversation-model-trigger"
                variant="ghost"
                size="sm"
                trailingIcon={<ChevronDown className={modelMenuOpen ? "expanded" : ""} size={13} />}
                aria-label={t("Selected model {label}", { label: activeModelLabel })}
                disabled={interactionLocked}
              >
                {activeModelLabel}
              </Button>
            </MenuTrigger>
            <MenuContent
              className="conversation-model-menu"
              side="top"
              align="end"
              sideOffset={8}
              aria-label={t("Model options")}
            >
              <Input
                ref={modelSearchRef}
                containerClassName="conversation-model-search"
                size="sm"
                prefix={<Search size={14} />}
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={t("Search models")}
                aria-label={t("Search models")}
              />
              <MenuRadioGroup className="conversation-model-list" value={activeProviderPresetId}>
                {visibleModelOptions.length > 0 ? visibleModelOptions.map((option) => {
                  const selected = option.id === activeProviderPresetId;
                  return (
                    <MenuRadioItem
                      key={option.id}
                      className={selected ? "conversation-model-option selected" : "conversation-model-option"}
                      value={option.id}
                      onSelect={(event) => {
                        event.preventDefault();
                        selectModel(option);
                      }}
                    >
                      <span className="conversation-model-option-copy"><strong>{normalConversationModelLabel(option)}</strong></span>
                      {option.id === defaultProviderPresetId ? <span className="conversation-model-default-chip">{t("Default")}</span> : null}
                      {selected ? <Check size={14} /> : null}
                    </MenuRadioItem>
                  );
                }) : (
                  <span className="conversation-model-empty">{t("No matching models")}</span>
                )}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
          <IconButton
            className="conversation-home-send normal-conversation-send"
            icon={ActionIcon}
            label={actionLabel}
            tooltip={actionLabel}
            loading={actionLoading}
            loadingLabel={actionLabel}
            disabled={stopAvailable ? stopping : sendBusy || !canSend}
            onClick={() => {
              if (stopAvailable) {
                void onStop?.();
                return;
              }
              void onSubmit();
            }}
          />
        </>
      )}
      feedbackNode={notice ? (
        <InlineFeedback className="conversation-home-notice normal-conversation-composer-feedback" tone="danger">
          {notice}
        </InlineFeedback>
      ) : null}
    />
  );
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
