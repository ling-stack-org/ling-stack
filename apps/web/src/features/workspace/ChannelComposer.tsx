import type {
  ClipboardEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
} from "react";
import {
  AtSign,
  CheckCircle2,
  CircleAlert,
  FileText,
  Info,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Square,
  X,
} from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { conversationPermissionPresetMenuOptions } from "../../lib/session-permissions.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { useI18n } from "../../i18n.js";
import {
  pendingAssetLabel,
  TokenizedComposerInput,
  type ActiveSlashCommandPicker,
  type PendingAttachmentItem,
  type TokenizedComposerInputHandle,
  type TokenizedComposerInputProps,
} from "../../shared/components/index.js";
import {
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationGuidanceStrip,
  type ConversationGuidanceItem,
} from "../../shared/conversation/index.js";
import type {
  ChannelAttachment,
  ChannelMention,
  PermissionPreset,
} from "../../types.js";
import { InlineApprovalStrip } from "../approvals/InlineApprovalStrip.js";
import type { ApprovalResolution } from "../approvals/types.js";

export type ChannelComposerSendState = "idle" | "sending" | "failed";
export type ChannelComposerInlineFeedbackTone = "success" | "info" | "error";

export interface ChannelComposerInlineFeedback {
  readonly id: number;
  readonly tone: ChannelComposerInlineFeedbackTone;
  readonly message: string;
}

export interface ActiveMentionPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

interface ChannelComposerProps {
  readonly statusNode: ReactNode;
  readonly activeRun: boolean;
  readonly composerBusy: boolean;
  readonly composerDragActive: boolean;
  readonly composerDropZoneStyle: CSSProperties;
  readonly composerFeedback: ChannelComposerInlineFeedback | undefined;
  readonly composerHasSendableContent: boolean;
  readonly composerShortcutTitle: string;
  readonly composerSlashCommandActive: boolean;
  readonly composerSlashTargetLabel: string;
  readonly executableSlashCommandId: string | undefined;
  readonly dropZoneClassName?: string;
  readonly inputParts: TokenizedComposerInputProps["parts"];
  readonly inputRef: Ref<TokenizedComposerInputHandle>;
  readonly inlineApprovalViews: readonly InlineApprovalView[];
  readonly isCancellingRun: boolean;
  readonly mentionActiveIndex: number;
  readonly mentionPicker: ActiveMentionPicker | undefined;
  readonly mentionPickerOptions: readonly ChannelMention[];
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly pendingMessageAssetsVisible: boolean;
  readonly permissionLocked: boolean;
  readonly permissionPreset: PermissionPreset;
  readonly channelTeammateIds: ReadonlySet<string>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly runGuidanceError: string;
  readonly runGuidanceItems: readonly ConversationGuidanceItem[];
  readonly runGuidanceLoading: boolean;
  readonly runGuidanceSubmitting: "" | "stop" | "queue_followup" | "interrupt_redirect";
  readonly selectedChannelId: string;
  readonly sendError: string;
  readonly sendState: ChannelComposerSendState;
  readonly showGuidance: boolean;
  readonly slashActiveIndex: number;
  readonly slashCommandPickerOptions: readonly ComposerSlashCommandOption[];
  readonly slashPicker: ActiveSlashCommandPicker | undefined;
  readonly submitDisabled: boolean;
  readonly submitLabel: string;
  readonly submitTitle: string;
  readonly value: string;
  readonly formatBytes: (value: number) => string;
  readonly onAttachFiles: (files: FileList | readonly File[]) => void | Promise<void>;
  readonly onCommitMention: (option: ChannelMention) => void;
  readonly onCommitSlashCommand: (option: ComposerSlashCommandOption) => void;
  readonly onDismissSendError: () => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onInputChange: (value: string, caret: number) => void;
  readonly onInputKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onInputPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onInputSelect: (value: string, caret: number) => void;
  readonly onInsertMentionTrigger: () => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onPermissionPresetChange: (preset: PermissionPreset) => void;
  readonly onRemovePendingAttachment: (localId: string) => void;
  readonly onResizePointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onRetrySend: () => void;
  readonly onSubmit: () => void;
}

export function ChannelComposer({
  activeRun,
  composerBusy,
  composerDragActive,
  composerDropZoneStyle,
  composerFeedback,
  composerHasSendableContent,
  composerShortcutTitle,
  composerSlashCommandActive,
  composerSlashTargetLabel,
  executableSlashCommandId,
  dropZoneClassName,
  formatBytes,
  inlineApprovalViews,
  inputParts,
  inputRef,
  isCancellingRun,
  mentionActiveIndex,
  mentionPicker,
  mentionPickerOptions,
  onAttachFiles,
  onCommitMention,
  onCommitSlashCommand,
  onDismissSendError,
  onDragLeave,
  onDragOver,
  onDrop,
  onInputChange,
  onInputKeyDown,
  onInputPaste,
  onInputSelect,
  onInsertMentionTrigger,
  onOpenApproval,
  onPermissionPresetChange,
  onRemovePendingAttachment,
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onResolveApproval,
  onRetrySend,
  onSubmit,
  pendingAttachments,
  pendingMessageAssetsVisible,
  permissionLocked,
  permissionPreset,
  channelTeammateIds,
  resolvingApprovals,
  runGuidanceError,
  runGuidanceItems,
  runGuidanceLoading,
  runGuidanceSubmitting,
  selectedChannelId,
  sendError,
  sendState,
  showGuidance,
  slashActiveIndex,
  slashCommandPickerOptions,
  slashPicker,
  statusNode,
  submitDisabled,
  submitLabel,
  submitTitle,
  value,
}: ChannelComposerProps): JSX.Element {
  const { t } = useI18n();
  const activeMentionIndex = mentionPickerOptions.length > 0
    ? Math.min(mentionActiveIndex, mentionPickerOptions.length - 1)
    : 0;
  const activeSlashIndex = slashCommandPickerOptions.length > 0
    ? Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)
    : 0;

  return (
    <ConversationComposerShell
      surface="channel"
      density="docked"
      className="channel-composer"
      ariaLabel={t("Channel composer")}
      leftToolsAriaLabel={t("Message tools")}
      statusNode={statusNode}
      guidanceNode={showGuidance ? (
        <>
          <ConversationGuidanceStrip
            title={activeRun ? t("Run guidance") : t("Queued guidance")}
            description={activeRun ? t("Type guidance in the message box and press Enter to queue it.") : t("Guidance is queued.")}
            submitting={runGuidanceSubmitting}
            items={runGuidanceItems}
          />
          {runGuidanceError ? (
            <div className="inline-error compact-inline-error">
              <CircleAlert size={14} />
              {runGuidanceError}
            </div>
          ) : null}
          {runGuidanceLoading ? (
            <div className="composer-status-row" aria-live="polite">
              <Loader2 className="spin" size={13} />
              <span>{t("Loading guidance...")}</span>
            </div>
          ) : null}
        </>
      ) : null}
      approvalNode={(
        <InlineApprovalStrip
          approvals={inlineApprovalViews}
          resolvingApprovals={resolvingApprovals}
          onResolve={onResolveApproval}
          onOpenApproval={onOpenApproval}
        />
      )}
      dropZoneClassName={dropZoneClassName}
      dropZoneStyle={composerDropZoneStyle}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      resizeHandleNode={(
        <button
          className="composer-resize-handle"
          type="button"
          aria-label={t("Resize composer")}
          title={t("Resize composer")}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerCancel}
        >
          <span aria-hidden="true" />
        </button>
      )}
      previewNode={pendingMessageAssetsVisible ? (
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
              <button className="composer-preview-remove" type="button" onClick={() => onRemovePendingAttachment(item.localId)} aria-label={t("Remove pending attachment")}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      inputNode={(
        <TokenizedComposerInput
          ref={inputRef}
          value={value}
          parts={inputParts}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          onPaste={onInputPaste}
          onSelect={onInputSelect}
          placeholder={t("Message this channel or @ an AI teammate")}
          ariaLabel={t("Message this channel or @ an AI teammate")}
          title={composerShortcutTitle}
          executableSlashCommandId={executableSlashCommandId}
          executableSlashTargetLabel={composerSlashTargetLabel}
        />
      )}
      mentionPickerNode={mentionPicker ? (
        <div className="mention-picker-popover" role="listbox" aria-label={t("Mention teammate")}>
          {mentionPickerOptions.length > 0 ? mentionPickerOptions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === activeMentionIndex}
              className={index === activeMentionIndex ? "mention-suggestion active" : "mention-suggestion"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommitMention(option)}
            >
              <span>@{option.label}</span>
              {channelTeammateIds.has(option.id) ? <small>{t("Channel teammate")}</small> : <small>{t("Workspace teammate")}</small>}
            </button>
          )) : (
            <span className="mention-suggestion empty">{t("No matching teammates")}</span>
          )}
        </div>
      ) : null}
      slashPickerNode={!mentionPicker && slashPicker ? (
        <div className="mention-picker-popover command-picker-popover" role="listbox" aria-label={t("Slash command")}>
          {slashCommandPickerOptions.length > 0 ? slashCommandPickerOptions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === activeSlashIndex}
              className={index === activeSlashIndex ? "mention-suggestion command active" : "mention-suggestion command"}
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
      dropHintNode={composerDragActive ? (
        <div className="composer-drop-hint">
          <FileText size={16} />
          <span>{t("Drop files to attach")}</span>
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
                if (event.target.files) {
                  void onAttachFiles(event.target.files);
                }
                event.target.value = "";
              }}
            />
          </label>
          <button className="icon-button composer-tool-button" type="button" onClick={onInsertMentionTrigger} disabled={!selectedChannelId || composerBusy} aria-label={t("Mention teammate")} title={t("Mention teammate")}>
            <AtSign size={16} />
          </button>
          <ComposerPermissionMenu
            preset={permissionPreset}
            options={conversationPermissionPresetMenuOptions(t)}
            disabled={permissionLocked}
            disabledReason={t("Permission is locked while this channel run or message is active.")}
            fullAccessConfirmationMessage={t("Full access can allow broad local file, network, and tool access for the next run. Continue?")}
            onPresetChange={onPermissionPresetChange}
          />
        </>
      )}
      rightToolsNode={(
        <button
          className="primary-button composer-send-button"
          type="button"
          onClick={onSubmit}
          disabled={submitDisabled}
          aria-label={submitLabel}
          title={submitTitle}
        >
          {activeRun
            ? composerHasSendableContent
              ? runGuidanceSubmitting === "queue_followup" ? <Loader2 className="spin" size={15} /> : <Send size={15} />
              : isCancellingRun ? <Loader2 className="spin" size={15} /> : <Square size={15} />
            : sendState === "sending" ? <Loader2 className="spin" size={15} /> : composerSlashCommandActive ? <ListChecks size={15} /> : <Send size={15} />}
        </button>
      )}
      feedbackNode={(
        <>
          {composerFeedback ? (
            <div key={composerFeedback.id} className={`composer-status-row ${composerFeedback.tone}`} role="status" aria-live="polite">
              {composerFeedback.tone === "success"
                ? <CheckCircle2 size={14} />
                : composerFeedback.tone === "error"
                  ? <CircleAlert size={14} />
                  : <Info size={14} />}
              <span>{composerFeedback.message}</span>
            </div>
          ) : null}
          {sendState === "failed" ? (
            <div className="composer-status-list" aria-live="polite">
              <div className="composer-status-row failed">
                <CircleAlert size={14} />
                <span>{t("Message failed")}{sendError ? `: ${sendError}` : ""}</span>
                <button className="secondary-button compact-button" type="button" onClick={onRetrySend}>
                  <RefreshCw size={13} />
                  {t("Retry")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={onDismissSendError}>
                  {t("Dismiss")}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    />
  );
}
