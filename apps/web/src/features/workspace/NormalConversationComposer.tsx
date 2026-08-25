import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type Ref } from "react";
import { ArrowUp, Brain, Check, ChevronDown, CircleAlert, FileText, Plus, Search, SlidersHorizontal, Square } from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { useI18n } from "../../i18n.js";
import { conversationPermissionPresetMenuOptions } from "../../lib/session-permissions.js";
import {
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationStatusStrip,
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
  StatusIndicator,
} from "../../shared/ui/index.js";
import { ComposerPendingAssetStrip, type ActiveSlashCommandPicker, type PendingAttachmentItem } from "../../shared/components/index.js";
import type { ConversationAttachment, PermissionPreset, ProviderThinkingMode } from "../../types.js";
import {
  normalConversationModelLabel,
  normalConversationThinkingLabel,
  normalConversationThinkingOptions,
} from "./normal-conversation-composer-options.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { InlineApprovalStrip } from "../approvals/InlineApprovalStrip.js";
import type { ApprovalResolution } from "../approvals/types.js";

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
  readonly inlineApprovalViews: readonly InlineApprovalView[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly stopping: boolean;
  readonly canSend: boolean;
  readonly notice: string;
  readonly dragActive: boolean;
  readonly onDraftChange: (value: string, caret: number) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onComposerPasteFiles: (files: readonly File[]) => void;
  readonly onComposerSelect: (value: string, caret: number) => void;
  readonly onCommitSlashCommand: (option: ComposerSlashCommandOption) => void;
  readonly onAttachFiles: (files: FileList) => void | Promise<void>;
  readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onOpenModelWorkbench?: () => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onPermissionPresetChange: (preset: PermissionPreset) => void;
  readonly onModelChange: (option: ConversationHomeModelOption) => void;
  readonly onThinkingLevelChange: (level: ProviderThinkingMode) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onStop?: () => void | Promise<void>;
}

export function NormalConversationComposer({
  activeRun,
  inlineApprovalViews,
  canSend,
  defaultProviderLabel,
  defaultProviderPresetId,
  dragActive,
  draft,
  inputParts,
  inputRef,
  modelOptions,
  notice,
  onAttachFiles,
  onDragLeave,
  onDragOver,
  onDrop,
  onCommitSlashCommand,
  onComposerKeyDown,
  onComposerPasteFiles,
  onComposerSelect,
  onDraftChange,
  onModelChange,
  onOpenModelWorkbench,
  onOpenApproval,
  onPermissionPresetChange,
  onRemoveAttachment,
  onStop,
  onSubmit,
  onResolveApproval,
  onThinkingLevelChange,
  pendingAttachments,
  permissionPreset,
  fullAccessConfirmed,
  selectedProviderPresetId,
  selectedThinkingLevel,
  resolvingApprovals,
  sendBusy,
  slashActiveIndex,
  slashOptions,
  slashPicker,
  stopping,
}: NormalConversationComposerProps): React.JSX.Element {
  const { t } = useI18n();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const activeProviderPresetId = selectedProviderPresetId || defaultProviderPresetId;
  const activeModelOption = modelOptions.find((option) => option.id === activeProviderPresetId);
  const modelReady = Boolean(activeModelOption?.runnable ?? activeModelOption?.enabled);
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

  const configurationLocked = sendBusy || activeRun;
  const stopAvailable = activeRun && !canSend && Boolean(onStop);
  const actionLabel = stopAvailable ? (stopping ? t("Stopping") : t("Stop")) : t("Send");
  const actionLoading = stopping || sendBusy;
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
      statusNode={!modelReady && !activeRun ? (
        <ConversationStatusStrip
          className="conversation-composer-status-strip normal-conversation-model-status attention"
          icon={<CircleAlert size={15} />}
          title={t("Model needs setup")}
          description={activeModelOption?.blocker || t("Please configure a chat model before sending.")}
          statusNode={<StatusIndicator label={t("Blocked")} tone="warning" />}
          metaItems={[{ id: "model", label: t("Model"), value: activeModelLabel }]}
          actions={onOpenModelWorkbench ? [{
            id: "configure-model",
            label: t("Configure model"),
            icon: <SlidersHorizontal size={14} />,
            onClick: onOpenModelWorkbench,
          }] : []}
        />
      ) : null}
      approvalNode={(
        <InlineApprovalStrip
          approvals={inlineApprovalViews}
          resolvingApprovals={resolvingApprovals}
          onResolve={onResolveApproval}
          onOpenApproval={onOpenApproval}
        />
      )}
      dropZoneClassName={dragActive ? "active" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      inputNode={(
        <div className="conversation-home-composer-body normal-conversation-composer-body">
          <TokenizedComposerInput
            ref={inputRef}
            value={draft}
            parts={inputParts}
            onChange={onDraftChange}
            onKeyDown={onComposerKeyDown}
            onPasteFiles={onComposerPasteFiles}
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
      dropHintNode={dragActive ? (
        <div className="composer-drop-hint"><FileText size={16} /><span>{t("Drop files to attach")}</span></div>
      ) : null}
      previewNode={pendingAttachments.length > 0 ? (
        <ComposerPendingAssetStrip attachments={pendingAttachments} onRemoveAttachment={onRemoveAttachment} />
      ) : null}
      leftToolsNode={(
        <>
          <label
            className="icon-button composer-tool-button composer-attach-button"
            aria-label={t("Attach files")}
            title={sendBusy ? t("Please wait for the current message to be sent.") : t("Attach files")}
            aria-disabled={sendBusy}
          >
            <Plus size={17} />
            <input
              data-ling-control-native="true"
              type="file"
              multiple
              hidden
              disabled={sendBusy}
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
            disabled={configurationLocked}
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
                  disabled={configurationLocked}
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
                disabled={configurationLocked}
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
