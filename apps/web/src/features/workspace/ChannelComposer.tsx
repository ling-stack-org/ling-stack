import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
} from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  FileText,
  ListChecks,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Target,
  Trash2,
  X,
} from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import { conversationPermissionPresetMenuOptions } from "../../lib/session-permissions.js";
import { useI18n } from "../../i18n.js";
import {
  ComposerPendingAssetStrip,
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
  LingThreadGoal,
  PermissionPreset,
} from "../../types.js";
import {
  ChannelComposerFeedback,
  type ChannelComposerInlineFeedback,
  type ChannelComposerInlineFeedbackTone,
  type ChannelComposerSendState,
} from "./ChannelComposerFeedback.js";

export type { ChannelComposerInlineFeedback, ChannelComposerInlineFeedbackTone, ChannelComposerSendState };

const GOAL_CONTINUATION_MAX_DEPTH = 3;

export interface ActiveMentionPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

interface ChannelComposerProps {
  readonly statusNode: ReactNode;
  readonly guidanceModeActive: boolean;
  readonly replyTargetActive: boolean;
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
  readonly isCancellingRun: boolean;
  readonly mentionActiveIndex: number;
  readonly mentionPicker: ActiveMentionPicker | undefined;
  readonly mentionPickerOptions: readonly ChannelMention[];
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly pendingMessageAssetsVisible: boolean;
  readonly permissionLocked: boolean;
  readonly permissionPreset: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly planModeActive: boolean;
  readonly planModeBusy: boolean;
  readonly planModeChipVisible: boolean;
  readonly goal: LingThreadGoal | undefined;
  readonly goalBusy: boolean;
  readonly goalLoading: boolean;
  readonly goalError: string;
  readonly goalExpanded: boolean;
  readonly goalChipVisible: boolean;
  readonly channelTeammateIds: ReadonlySet<string>;
  readonly runGuidanceError: string;
  readonly runGuidanceItems: readonly ConversationGuidanceItem[];
  readonly runGuidanceLoading: boolean;
  readonly runGuidanceSubmitting: "" | "stop" | "queue_followup" | "interrupt_redirect";
  readonly selectedChannelId: string;
  readonly sendError: string;
  readonly sendState: ChannelComposerSendState;
  readonly slashActiveIndex: number;
  readonly slashCommandPickerOptions: readonly ComposerSlashCommandOption[];
  readonly slashPicker: ActiveSlashCommandPicker | undefined;
  readonly submitDisabled: boolean;
  readonly submitLabel: string;
  readonly submitTitle: string;
  readonly value: string;
  readonly onAttachFiles: (files: FileList | readonly File[]) => void | Promise<void>;
  readonly onCommitMention: (option: ChannelMention) => void;
  readonly onCommitSlashCommand: (option: ComposerSlashCommandOption) => void;
  readonly onDismissSendError: () => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onInputChange: (value: string, caret: number) => void;
  readonly onInputKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onInputPasteFiles: (files: readonly File[]) => void;
  readonly onInputSelect: (value: string, caret: number) => void;
  readonly onInsertMentionTrigger: () => void;
  readonly onPermissionPresetChange: (preset: PermissionPreset) => void;
  readonly onTogglePlanMode: () => void;
  readonly onRevealPlanModeChip: () => void;
  readonly onClosePlanModeChip: () => void;
  readonly onOpenGoalEditor: () => void;
  readonly onRevealGoalChip: () => void;
  readonly onCloseGoalChip: () => void;
  readonly onGoalContinue: () => void;
  readonly onGoalPauseResume: () => void;
  readonly onGoalComplete: () => void;
  readonly onGoalClear: () => void;
  readonly onToggleGoalExpanded: () => void;
  readonly onRemovePendingAttachment: (localId: string) => void;
  readonly onResizePointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizePointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onRetrySend: () => void;
  readonly onSubmit: () => void;
}

export function ChannelComposer({
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
  onInputPasteFiles,
  onInputSelect,
  onInsertMentionTrigger,
  onPermissionPresetChange,
  onTogglePlanMode,
  onRevealPlanModeChip,
  onClosePlanModeChip,
  onOpenGoalEditor,
  onRevealGoalChip,
  onCloseGoalChip,
  onGoalContinue,
  onGoalPauseResume,
  onGoalComplete,
  onGoalClear,
  onToggleGoalExpanded,
  onRemovePendingAttachment,
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onRetrySend,
  onSubmit,
  pendingAttachments,
  pendingMessageAssetsVisible,
  permissionLocked,
  permissionPreset,
  fullAccessConfirmed,
  planModeActive,
  planModeBusy,
  planModeChipVisible,
  goal,
  goalBusy,
  goalLoading,
  goalError,
  goalExpanded,
  goalChipVisible,
  guidanceModeActive,
  replyTargetActive,
  channelTeammateIds,
  runGuidanceError,
  runGuidanceItems,
  runGuidanceLoading,
  runGuidanceSubmitting,
  selectedChannelId,
  sendError,
  sendState,
  slashActiveIndex,
  slashCommandPickerOptions,
  slashPicker,
  statusNode,
  submitDisabled,
  submitLabel,
  submitTitle,
  value,
}: ChannelComposerProps): React.JSX.Element {
  const { t } = useI18n();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputId = useId();
  const activeMentionIndex = mentionPickerOptions.length > 0
    ? Math.min(mentionActiveIndex, mentionPickerOptions.length - 1)
    : 0;
  const activeSlashIndex = slashCommandPickerOptions.length > 0
    ? Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)
    : 0;
  const goalPaused = goal?.status === "paused";
  const goalContinueDisabled = goalBusy || goalPaused;
  const goalStatusLabel = goal ? t(`goal.status.${goal.status}`) : "";
  const composerRootRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = composerRootRef.current;
    if (!root) {
      return undefined;
    }
    root.dataset.computerUseObstacle = "true";
    root.dataset.computerUseObstacleKind = "composer";
    return () => {
      delete root.dataset.computerUseObstacle;
      delete root.dataset.computerUseObstacleKind;
    };
  }, []);

  useEffect(() => {
    if (!addMenuOpen || typeof document === "undefined") {
      return undefined;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (target && addMenuRef.current?.contains(target)) {
        return;
      }
      setAddMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  return (
    <ConversationComposerShell
      surface="channel"
      density="docked"
      className="channel-composer"
      rootRef={composerRootRef}
      ariaLabel={t("Channel composer")}
      leftToolsAriaLabel={t("Message tools")}
      statusNode={statusNode}
      guidanceNode={(goal || goalLoading || goalError || runGuidanceItems.length > 0 || runGuidanceError || runGuidanceLoading) ? (
        <>
          {goal ? (
            <div className={`goal-floating-panel status-${goal.status}`} role="region" aria-label={t("Goal")}>
              <div className="goal-floating-main">
                <Target size={15} />
                <span className="goal-floating-copy">
                  <strong>{goal.objective}</strong>
                  <small>{goalStatusLabel}</small>
                </span>
                <div className="goal-floating-actions">
                  <button className="icon-button compact-icon-button" type="button" onClick={onGoalContinue} disabled={goalContinueDisabled} aria-label={t("Run goal")} title={goalPaused ? t("Resume the goal before continuing.") : t("Run goal")}>
                    {goalBusy ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  </button>
                  <button className="icon-button compact-icon-button" type="button" onClick={onGoalPauseResume} disabled={goalBusy} aria-label={goalPaused ? t("Resume goal") : t("Pause goal")} title={goalPaused ? t("Resume goal") : t("Pause goal")}>
                    {goalPaused ? <RefreshCw size={14} /> : <Pause size={14} />}
                  </button>
                  <button className="icon-button compact-icon-button" type="button" onClick={onGoalComplete} disabled={goalBusy} aria-label={t("Complete goal")} title={t("Complete goal")}>
                    <CheckCircle2 size={14} />
                  </button>
                  <button className="icon-button compact-icon-button" type="button" onClick={onOpenGoalEditor} disabled={goalBusy} aria-label={t("Edit goal")} title={t("Edit goal")}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-button compact-icon-button" type="button" onClick={onGoalClear} disabled={goalBusy} aria-label={t("Clear goal")} title={t("Clear goal")}>
                    <Trash2 size={14} />
                  </button>
                  <button className="icon-button compact-icon-button" type="button" onClick={onToggleGoalExpanded} aria-label={goalExpanded ? t("Collapse goal details") : t("Expand goal details")} title={goalExpanded ? t("Collapse goal details") : t("Expand goal details")}>
                    {goalExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              {goalExpanded ? (
                <div className="goal-floating-details">
                  <span>{t("Status")}: {goalStatusLabel}</span>
                  {goal.tokenBudget !== undefined ? <span>{t("Budget")}: {goal.tokensUsed}/{goal.tokenBudget}</span> : null}
                  {goal.usageSource ? <span>{t("Source")}: {goal.usageSource}</span> : null}
                  {goal.continuationDepth > 0 ? <span>{t("Continuation")}: {goal.continuationDepth} / {GOAL_CONTINUATION_MAX_DEPTH}</span> : null}
                  {goal.lastContinuationStopReason ? <span>{t("Last auto-stop")}: {goalContinuationStopReasonLabel(goal.lastContinuationStopReason, t)}</span> : null}
                  {goal.lastContinuationEvidenceDelta ? <span>{t("Evidence delta")}: {goalContinuationEvidenceDeltaLabel(goal.lastContinuationEvidenceDelta, t)}</span> : null}
                  {goal.lastRunId ? <span>{t("Last run")}: {goal.lastRunId}</span> : null}
                  {goal.blockedReason ? <span>{t("Blocker")}: {goal.blockedReason}</span> : null}
                </div>
              ) : null}
            </div>
          ) : goalLoading ? (
            <div className="composer-status-row" aria-live="polite">
              <Loader2 className="spin" size={13} />
              <span>{t("Loading goal...")}</span>
            </div>
          ) : null}
          {goalError ? (
            <div className="inline-error compact-inline-error">
              <CircleAlert size={14} />
              {goalError}
            </div>
          ) : null}
          {runGuidanceItems.length > 0 ? (
            <ConversationGuidanceStrip
              title={t("Run guidance")}
              description={t("Guidance is queued.")}
              submitting={runGuidanceSubmitting}
              stopDisabled={!replyTargetActive}
              items={runGuidanceItems}
            />
          ) : null}
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
        <ComposerPendingAssetStrip attachments={pendingAttachments} onRemoveAttachment={onRemovePendingAttachment} />
      ) : null}
      inputNode={(
        <TokenizedComposerInput
          ref={inputRef}
          value={value}
          parts={inputParts}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          onPasteFiles={onInputPasteFiles}
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
          <div className="composer-add-menu" ref={addMenuRef}>
            <button
              className="icon-button composer-tool-button composer-add-button"
              type="button"
              aria-label={t("Add")}
              title={t("Add")}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Plus size={17} />
            </button>
            <input
              data-ling-control-native="true"
              id={fileInputId}
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
            {addMenuOpen ? (
              <div className="composer-add-popover" role="menu" aria-label={t("Add")}>
                <label
                  className="composer-add-menu-row"
                  htmlFor={fileInputId}
                  role="menuitem"
                  tabIndex={0}
                  aria-label={t("Attach files")}
                  title={t("Add files or folders to this message")}
                  onClick={() => setAddMenuOpen(false)}
                >
                  <FileText size={15} />
                  <span>
                    <strong>{t("Attach files")}</strong>
                  </span>
                </label>
                <button
                  className="composer-add-menu-row"
                  type="button"
                  role="menuitem"
                  disabled={!selectedChannelId || composerBusy || planModeBusy || guidanceModeActive}
                  title={planModeActive ? t("Plan Mode is on") : t("Plan first, then implement after review")}
                  onClick={() => {
                    setAddMenuOpen(false);
                    onRevealPlanModeChip();
                    if (!planModeActive) {
                      onTogglePlanMode();
                    }
                  }}
                >
                  {planModeBusy ? <Loader2 className="spin" size={15} /> : <ClipboardList size={15} />}
                  <span>
                    <strong>{t("Plan Mode")}</strong>
                  </span>
                </button>
                <button
                  className="composer-add-menu-row"
                  type="button"
                  role="menuitem"
                  disabled={!selectedChannelId || composerBusy}
                  title={t("Goal")}
                  onClick={() => {
                    setAddMenuOpen(false);
                    onRevealGoalChip();
                  }}
                >
                  <Target size={15} />
                  <span>
                    <strong>{t("Goal")}</strong>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <button className="icon-button composer-tool-button" type="button" onClick={onInsertMentionTrigger} disabled={!selectedChannelId || composerBusy} aria-label={t("Mention teammate")} title={t("Mention teammate")}>
            <AtSign size={16} />
          </button>
          <ComposerPermissionMenu
            preset={permissionPreset}
            options={conversationPermissionPresetMenuOptions(t, fullAccessConfirmed)}
            disabled={permissionLocked}
            disabledReason={t("Permission is locked while this channel run or message is active.")}
            onPresetChange={onPermissionPresetChange}
          />
          {planModeChipVisible ? (
            <span className={planModeActive ? "conversation-mode-chip plan active" : "conversation-mode-chip plan"}>
              <button
                className="conversation-mode-chip-main"
                type="button"
                onClick={onTogglePlanMode}
                disabled={!selectedChannelId || composerBusy || planModeBusy || guidanceModeActive}
                aria-label={t("Plan Mode")}
                title={planModeActive
                  ? t("Plan Mode is on. Click to exit Plan Mode.")
                  : t("Plan Mode is off. Click to plan before implementing.")}
              >
                {planModeBusy ? <Loader2 className="spin" size={15} /> : <ClipboardList size={15} />}
                <span>{t("Plan")}</span>
              </button>
              <button
                className="conversation-mode-chip-close"
                type="button"
                onClick={onClosePlanModeChip}
                disabled={!selectedChannelId || (planModeActive && (composerBusy || planModeBusy || guidanceModeActive))}
                aria-label={planModeActive ? t("Exit and hide Plan Mode") : t("Hide Plan Mode")}
                title={planModeActive ? t("Exit and hide Plan Mode") : t("Hide Plan Mode")}
              >
                <X size={12} />
              </button>
            </span>
          ) : null}
          {goalChipVisible ? (
            <span className={goal ? "conversation-mode-chip goal active" : "conversation-mode-chip goal"}>
              <button
                className="conversation-mode-chip-main"
                type="button"
                onClick={onOpenGoalEditor}
                disabled={!selectedChannelId || composerBusy}
                aria-label={t("Goal")}
                title={goal ? t("Goal is active. Click to edit.") : t("Goal is not set. Click to set a goal.")}
              >
                {goalLoading ? <Loader2 className="spin" size={15} /> : <Target size={15} />}
                <span>{t("Goal")}</span>
              </button>
              <button
                className="conversation-mode-chip-close"
                type="button"
                onClick={onCloseGoalChip}
                disabled={!selectedChannelId || Boolean(goal && (goalBusy || goalLoading))}
                aria-label={goal ? t("Clear and hide goal") : t("Hide goal")}
                title={goal ? t("Clear and hide goal") : t("Hide goal")}
              >
                <X size={12} />
              </button>
            </span>
          ) : null}
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
          {replyTargetActive
            ? composerHasSendableContent
              ? sendState === "sending" ? <Loader2 className="spin" size={15} /> : <Send size={15} />
              : isCancellingRun ? <Loader2 className="spin" size={15} /> : <Square size={15} />
            : sendState === "sending" ? <Loader2 className="spin" size={15} /> : composerSlashCommandActive ? <ListChecks size={15} /> : <Send size={15} />}
        </button>
      )}
      feedbackNode={(
        <ChannelComposerFeedback
          feedback={composerFeedback}
          sendState={sendState}
          sendError={sendError}
          onRetry={onRetrySend}
          onDismiss={onDismissSendError}
        />
      )}
    />
  );
}

function goalContinuationStopReasonLabel(reason: LingThreadGoal["lastContinuationStopReason"], t: (key: string) => string): string {
  switch (reason) {
    case "max_depth":
      return t("Max continuation depth");
    case "no_evidence_threshold":
      return t("No new evidence");
    case "same_blocker_threshold":
      return t("Same blocker repeated");
    case "plan_mode_active":
      return t("Plan Mode active");
    case "pending_approval":
      return t("Pending approval");
    case "active_run_exists":
      return t("Active run exists");
    case "latest_run_not_terminal":
      return t("Latest run not terminal");
    case "goal_not_active":
      return t("Goal not active");
    case "budget_limited":
      return t("Budget limited");
    case "usage_limited":
      return t("Usage limited");
    case "manual_stop":
      return t("Manual stop");
    case "unknown":
    default:
      return t("Unknown");
  }
}

function goalContinuationEvidenceDeltaLabel(delta: NonNullable<LingThreadGoal["lastContinuationEvidenceDelta"]>, t: (key: string, values?: Record<string, string | number>) => string): string {
  return t("{refs} refs, {files} files, {artifacts} artifacts", {
    refs: delta.newEvidenceRefs,
    files: delta.changedFiles,
    artifacts: delta.artifacts,
  });
}
