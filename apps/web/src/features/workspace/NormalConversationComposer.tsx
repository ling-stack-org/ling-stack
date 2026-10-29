import { type DragEvent, type KeyboardEvent, type ReactNode, type Ref, useRef } from "react";
import { ArrowUp, CircleAlert, FileText, Mic, MicOff, Plus, RotateCcw, SlidersHorizontal, Square } from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { useI18n } from "../../i18n.js";
import {
  ConversationComposerShell,
  ConversationStatusStrip,
  TokenizedComposerInput,
  type TokenizedComposerInputHandle,
  type TokenizedComposerInputProps,
} from "../../shared/conversation/index.js";
import {
  IconButton,
  InlineFeedback,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { ComposerPendingAssetStrip, type ActiveSlashCommandPicker, type PendingAttachmentItem } from "../../shared/components/index.js";
import { useVoiceDictation } from "../../shared/conversation/use-voice-dictation.js";
import { appendDictation, voiceErrorMessage } from "../../shared/conversation/voice-dictation-machine.js";
import type { AuthorizationMode, ConversationAttachment, PermissionPreset, ProviderThinkingMode } from "../../types.js";
import { normalConversationModelLabel } from "./normal-conversation-composer-options.js";
import { ConversationModelControl } from "./ConversationModelControl.js";
import { ConversationPermissionControl } from "./ConversationPermissionControl.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";

export interface NormalConversationComposerProps {
  readonly draft: string;
  readonly inputRef: Ref<TokenizedComposerInputHandle>;
  readonly inputParts: TokenizedComposerInputProps["parts"];
  readonly slashPicker?: ActiveSlashCommandPicker;
  readonly slashOptions: readonly ComposerSlashCommandOption[];
  readonly slashActiveIndex: number;
  readonly pendingAttachments: readonly PendingAttachmentItem<ConversationAttachment>[];
  readonly authorizationMode: AuthorizationMode;
  readonly permissionPreset: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly modelOptions: readonly ConversationHomeModelOption[];
  readonly selectedProviderPresetId: string;
  readonly defaultProviderPresetId: string;
  readonly defaultProviderLabel: string;
  readonly selectedThinkingLevel: ProviderThinkingMode;
  readonly sendBusy: boolean;
  readonly scopeReady?: boolean;
  readonly recoveringSubmission?: boolean;
  readonly activeRun: boolean;
  readonly stopping: boolean;
  readonly canSend: boolean;
  readonly notice: string;
  readonly dragActive: boolean;
  readonly dropFeedback?: ReactNode;
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
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onRetryAttachment?: (localId: string) => void | Promise<void>;
  readonly attachmentCleanupFailures?: readonly import("../../shared/components/composer-pending-assets.js").AttachmentCleanupFailure[];
  readonly onRetryAttachmentCleanup?: (localId: string) => void | Promise<void>;
  readonly onAuthorizationModeChange: (mode: AuthorizationMode) => void;
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
  dragActive,
  dropFeedback,
  draft,
  inputParts,
  inputRef,
  modelOptions,
  notice,
  onAuthorizationModeChange,
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
  onRemoveAttachment,
  onRetryAttachment,
  attachmentCleanupFailures = [],
  onRetryAttachmentCleanup,
  onStop,
  onSubmit,
  onThinkingLevelChange,
  pendingAttachments,
  authorizationMode,
  permissionPreset,
  fullAccessConfirmed,
  selectedProviderPresetId,
  selectedThinkingLevel,
  sendBusy,
  scopeReady = true,
  recoveringSubmission = false,
  slashActiveIndex,
  slashOptions,
  slashPicker,
  stopping,
}: NormalConversationComposerProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const activeProviderPresetId = selectedProviderPresetId || defaultProviderPresetId;
  const activeModelOption = modelOptions.find((option) => option.id === activeProviderPresetId);
  const modelReady = Boolean(activeModelOption?.runnable ?? activeModelOption?.enabled);
  const activeModelLabel = activeModelOption ? normalConversationModelLabel(activeModelOption) : defaultProviderLabel;

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const voice = useVoiceDictation({
    locale,
    onTranscript: (text) => {
      const next = appendDictation(draftRef.current, text);
      onDraftChange(next, next.length);
    },
  });
  const dictating = voice.status === "recording";

  const configurationLocked = sendBusy || activeRun || !scopeReady;
  const attachmentsLocked = sendBusy || !scopeReady;
  const stopAvailable = activeRun && !canSend && Boolean(onStop);
  const actionLabel = stopAvailable ? (stopping ? t("Stopping") : t("Stop")) : recoveringSubmission ? t("Retry") : t("Send");
  const actionLoading = stopping || sendBusy;
  const ActionIcon = stopAvailable ? Square : recoveringSubmission ? RotateCcw : ArrowUp;

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
      dropZoneClassName={dragActive ? "active" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      inputNode={(
        <div className="conversation-home-composer-body normal-conversation-composer-body" data-dictating={dictating || undefined}>
          {dictating ? (
            <span className="composer-dictating-badge" role="status">
              <Mic size={12} />
              {t("Dictating")}{voice.interim ? ` · ${voice.interim}` : "…"}
            </span>
          ) : null}
          <TokenizedComposerInput
            ref={inputRef}
            readOnly={!scopeReady}
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
      dropHintNode={(dropFeedback || dragActive) ? <>
        {dropFeedback}
        {dragActive ? (
          <div className="composer-drop-hint"><FileText size={16} /><span>{t("Drop files to attach")}</span></div>
        ) : null}
      </> : null}
      previewNode={pendingAttachments.length > 0 || attachmentCleanupFailures.length > 0 ? (
        <ComposerPendingAssetStrip attachments={pendingAttachments} onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment} cleanupFailures={attachmentCleanupFailures} onRetryCleanup={onRetryAttachmentCleanup} />
      ) : null}
      leftToolsNode={(
        <>
          <label
            className="icon-button composer-tool-button composer-attach-button"
            aria-label={t("Attach files")}
            title={!scopeReady ? t("Loading") : sendBusy ? t("Please wait for the current message to be sent.") : t("Attach files")}
            aria-disabled={attachmentsLocked}
          >
            <Plus size={17} />
            <input
              data-ling-control-native="true"
              type="file"
              multiple
              hidden
              disabled={attachmentsLocked}
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
              onChange={(event) => {
                if (event.currentTarget.files) {
                  void onAttachFiles(event.currentTarget.files);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          {voice.supported ? (
            <button
              type="button"
              className={dictating ? "icon-button composer-tool-button composer-dictate-button dictating" : "icon-button composer-tool-button composer-dictate-button"}
              aria-label={dictating ? t("Stop dictation") : t("Dictate message")}
              aria-pressed={dictating}
              data-dictating={dictating || undefined}
              title={dictating ? t("Stop dictation") : t("Dictate message")}
              disabled={attachmentsLocked && !dictating}
              onClick={() => voice.toggle()}
            >
              {dictating ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
          ) : null}
          <ConversationPermissionControl
            authorizationMode={authorizationMode}
            permissionPreset={permissionPreset}
            fullAccessConfirmed={fullAccessConfirmed}
            disabled={configurationLocked}
            onAuthorizationModeChange={onAuthorizationModeChange}
          />
        </>
      )}
      rightToolsNode={(
        <>
          <ConversationModelControl
            modelOptions={modelOptions}
            selectedProviderPresetId={selectedProviderPresetId}
            defaultProviderPresetId={defaultProviderPresetId}
            defaultProviderLabel={defaultProviderLabel}
            thinkingLevel={selectedThinkingLevel}
            disabled={configurationLocked}
            onModelChange={onModelChange}
            onThinkingLevelChange={onThinkingLevelChange}
          />
          <IconButton
            className="conversation-home-send normal-conversation-send"
            icon={ActionIcon}
            label={actionLabel}
            tooltip={actionLabel}
            loading={actionLoading}
            loadingLabel={actionLabel}
            disabled={!scopeReady || (stopAvailable ? stopping : sendBusy || !canSend)}
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
      feedbackNode={(notice || voice.error) ? (
        <InlineFeedback className="conversation-home-notice normal-conversation-composer-feedback" tone="danger">
          {voice.error ? voiceErrorMessage(voice.error, t) : notice}
        </InlineFeedback>
      ) : null}
    />
  );
}
