import { CircleAlert, FileText, Plus, Send, SlidersHorizontal, Square } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  conversationAuthorizationModeMenuOptions,
  conversationPermissionPresetMenuOptions,
} from "../../lib/session-permissions.js";
import {
  ComposerFileReferenceToken,
  ComposerPendingAssetStrip,
} from "../../shared/components/index.js";
import {
  ComposerAuthorizationMenu,
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationBottomStatusStrip,
  ConversationGuidanceStrip,
  ConversationStatusStrip,
  isConversationGuidanceQueueVisible,
  TokenizedComposerInput,
} from "../../shared/conversation/index.js";
import { IconButton, StatusIndicator } from "../../shared/ui/index.js";
import type { TeammateDirectLinkPreview, TeammatePrivateAttachment } from "../../types.js";
import type { TeammatePrivateChatSurfaceProps } from "./teammate-private-chat-types.js";
import {
  directFileRefLabel,
  teammateDirectInterventionModeLabel,
  teammateDirectInterventionStatusLabel,
} from "./teammate-workspace-utils.js";
import type { TeammatePrivateComposerController } from "./useTeammatePrivateComposerController.js";

export type TeammatePrivateChatComposerProps = Pick<TeammatePrivateChatSurfaceProps,
  | "composerDragActive"
  | "composerModelLabel"
  | "runtimeMetrics"
  | "composerFileReferenceParts"
  | "composerFileReferenceTokens"
  | "composerInputParts"
  | "directGuidanceCancelingId"
  | "directGuidancePromotingId"
  | "directGuidanceSubmitting"
  | "directLinkPreviewById"
  | "directReplyActive"
  | "fullAccessConfirmed"
  | "hasDirectRuntimeActivity"
  | "messageDraft"
  | "modelNotice"
  | "onCancelDirectGuidance"
  | "onComposerDragLeave"
  | "onComposerDragOver"
  | "onComposerDrop"
  | "onComposerPasteFiles"
  | "onEditDirectGuidance"
  | "onOpenModelSettings"
  | "onPromoteDirectGuidance"
  | "onRemoveComposerFileReference"
  | "onRemovePendingAttachment"
  | "onRetryPendingAttachment"
  | "attachmentCleanupFailures"
  | "onRetryAttachmentCleanup"
  | "onRemovePendingLinkPreview"
  | "onUploadPrivateFiles"
  | "openDirectInterventions"
  | "pendingAttachments"
  | "pendingDirectLinkPreviews"
  | "privateAttachmentById"
  | "privateComposerHasGuidancePayload"
  | "privateComposerPlaceholder"
  | "privateComposerSendDisabled"
  | "privateComposerSendLabel"
  | "privateComposerSending"
  | "privateComposerSendingLabel"
  | "uploadingAttachments"
> & {
  readonly controller: TeammatePrivateComposerController;
};

export function TeammatePrivateChatComposer({
  composerDragActive,
  composerModelLabel,
  runtimeMetrics,
  composerFileReferenceParts,
  composerFileReferenceTokens,
  composerInputParts,
  controller,
  directGuidanceCancelingId,
  directGuidancePromotingId,
  directGuidanceSubmitting,
  directLinkPreviewById,
  directReplyActive,
  fullAccessConfirmed,
  hasDirectRuntimeActivity,
  messageDraft,
  modelNotice,
  onCancelDirectGuidance,
  onComposerDragLeave,
  onComposerDragOver,
  onComposerDrop,
  onComposerPasteFiles,
  onEditDirectGuidance,
  onOpenModelSettings,
  onPromoteDirectGuidance,
  onRemoveComposerFileReference,
  onRemovePendingAttachment,
  onRetryPendingAttachment,
  attachmentCleanupFailures = [],
  onRetryAttachmentCleanup,
  onRemovePendingLinkPreview,
  onUploadPrivateFiles,
  openDirectInterventions,
  pendingAttachments,
  pendingDirectLinkPreviews,
  privateAttachmentById,
  privateComposerHasGuidancePayload,
  privateComposerPlaceholder,
  privateComposerSendDisabled,
  privateComposerSendLabel,
  privateComposerSending,
  privateComposerSendingLabel,
  uploadingAttachments,
}: TeammatePrivateChatComposerProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const permissionLocked = privateComposerSending || hasDirectRuntimeActivity || Boolean(directGuidanceSubmitting);
  const visibleDirectInterventions = openDirectInterventions.filter((intervention) =>
    isConversationGuidanceQueueVisible(intervention.status)
  );
  const SendIcon = directReplyActive && !privateComposerHasGuidancePayload ? Square : Send;
  const sendLabel = privateComposerSending ? privateComposerSendingLabel : privateComposerSendLabel;

  return (
    <div className="teammate-private-composer-owner" data-ui2-teammate-private-composer="true">
      {modelNotice ? (
        <ConversationStatusStrip
          className="conversation-composer-status-strip teammate-model-status-strip attention"
          icon={<CircleAlert size={15} />}
          title={t("Model needs setup")}
          description={modelNotice.description}
          statusNode={<StatusIndicator className="teammate-model-status-indicator" label={t("Blocked")} tone="warning" />}
          metaItems={[{ id: "model", label: t("Model"), value: modelNotice.modelLabel }]}
          actions={[{
            id: "configure-model",
            label: t("Configure model"),
            icon: <SlidersHorizontal size={14} />,
            onClick: onOpenModelSettings,
          }]}
        />
      ) : null}
      {directReplyActive || visibleDirectInterventions.length > 0 ? (
        <ConversationGuidanceStrip
          title={directGuidanceSubmitting === "stop" ? t("Stopping") : directReplyActive ? t("Replying") : t("Private guidance")}
          description={directGuidanceSubmitting === "stop" ? undefined : directReplyActive ? t("Stop the current reply or queue new guidance.") : t("Guidance is queued.")}
          submitting={directGuidanceSubmitting}
          stopDisabled={!directReplyActive}
          items={visibleDirectInterventions.map((intervention) => {
            const isQueued = intervention.status === "queued";
            const rowBusy = directGuidanceCancelingId === intervention.id || directGuidancePromotingId === intervention.id;
            return {
              id: intervention.id,
              instruction: intervention.messagePayload?.body || intervention.instruction,
              attachments: (intervention.messagePayload?.attachmentIds ?? [])
                .map((attachmentId) => privateAttachmentById.get(attachmentId))
                .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
                .map((attachment) => ({ id: attachment.id, label: attachment.fileName })),
              linkPreviews: (intervention.messagePayload?.linkPreviewIds ?? [])
                .map((previewId) => directLinkPreviewById.get(previewId))
                .filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview))
                .map((preview) => ({ id: preview.id, label: preview.title || preview.siteName || preview.url })),
              fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((fileRef, index) => ({
                id: `${intervention.id}:file:${index}`,
                label: directFileRefLabel(fileRef),
              })),
              statusLabel: teammateDirectInterventionStatusLabel(intervention.status, t),
              meta: teammateDirectInterventionModeLabel(intervention.mode, t),
              promoteLabel: t("Run this guidance now"),
              promoteDisabled: rowBusy || Boolean(directGuidanceSubmitting),
              promoteLoading: directGuidancePromotingId === intervention.id,
              onPromote: isQueued ? () => void onPromoteDirectGuidance(intervention.id) : undefined,
              deleteLabel: t("Delete queued guidance"),
              deleteDisabled: rowBusy,
              deleteLoading: directGuidanceCancelingId === intervention.id,
              onDelete: isQueued ? () => void onCancelDirectGuidance(intervention.id) : undefined,
              moreLabel: t("More guidance actions"),
              editLabel: t("Edit message"),
              editDisabled: rowBusy,
              onEdit: isQueued ? () => void onEditDirectGuidance(intervention) : undefined,
              closeQueueLabel: t("Close queue"),
              closeQueueDisabled: rowBusy,
              closeQueueLoading: directGuidanceCancelingId === intervention.id,
              onCloseQueue: isQueued ? () => void onCancelDirectGuidance(intervention.id) : undefined,
            };
          })}
        />
      ) : null}
      <ConversationComposerShell
        surface="teammate_direct"
        density="docked"
        className="teammate-direct-composer"
        ariaLabel={t("Private chat composer")}
        bottomStatusNode={<ConversationBottomStatusStrip
          ariaLabel={t("Conversation status")}
        translate={t}
          metrics={runtimeMetrics}
          locale={locale}
        />}
        dropZoneClassName={composerDragActive ? "active" : undefined}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        previewNode={pendingAttachments.length > 0 || attachmentCleanupFailures.length > 0 || pendingDirectLinkPreviews.length > 0 || composerFileReferenceParts.length > 0 ? (
          <ComposerPendingAssetStrip
            attachments={pendingAttachments}
            leadingItems={composerFileReferenceTokens.map(({ occurrenceIndex, part }, index) => (
              <ComposerFileReferenceToken
                key={`${part.raw}-${index}`}
                path={part.path}
                line={part.line}
                removeLabel={t("Remove file reference")}
                onRemove={() => onRemoveComposerFileReference(part.raw, occurrenceIndex)}
              />
            ))}
            links={pendingDirectLinkPreviews.map((preview) => ({
              id: preview.id,
              url: preview.url,
              label: preview.title || preview.siteName || preview.url,
              detail: preview.normalizedUrl,
            }))}
            onRemoveAttachment={onRemovePendingAttachment}
            onRetryAttachment={onRetryPendingAttachment}
            cleanupFailures={attachmentCleanupFailures}
            onRetryCleanup={onRetryAttachmentCleanup}
            onRemoveLink={onRemovePendingLinkPreview}
          />
        ) : null}
        inputNode={(
          <TokenizedComposerInput
            ref={controller.composerInputRef}
            value={messageDraft}
            parts={composerInputParts}
            onChange={controller.handleComposerValueChange}
            onKeyDown={controller.handleComposerInputKeyDown}
            onPasteFiles={onComposerPasteFiles}
            onSelect={controller.updateSlashPicker}
            placeholder={privateComposerPlaceholder}
            ariaLabel={privateComposerPlaceholder}
          />
        )}
        slashPickerNode={controller.slashPicker ? (
          <div className="mention-picker-popover command-picker-popover conversation-composer-popover" role="listbox" aria-label={t("Slash command")}>
            {controller.slashCommandPickerOptions.length > 0 ? controller.slashCommandPickerOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === Math.min(controller.slashActiveIndex, controller.slashCommandPickerOptions.length - 1)}
                className={index === Math.min(controller.slashActiveIndex, controller.slashCommandPickerOptions.length - 1) ? "mention-suggestion command active" : "mention-suggestion command"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => controller.commitSlashCommand(option)}
              >
                <span>/{option.id}</span>
                <small>{option.label}</small>
              </button>
            )) : <span className="mention-suggestion empty">{t("No matching commands")}</span>}
          </div>
        ) : null}
        dropHintNode={composerDragActive ? (
          <div className="composer-drop-hint"><FileText size={16} /><span>{t("Drop files to attach")}</span></div>
        ) : null}
        leftToolsNode={(
          <>
            <label
              className="icon-button composer-tool-button composer-attach-button"
              aria-label={uploadingAttachments ? t("Uploading...") : t("Attach files")}
              title={uploadingAttachments ? t("Uploading...") : t("Attach files")}
            >
              <Plus size={17} />
              <input
                data-ling-control-native="true"
                type="file"
                multiple
                hidden
                accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  if (files && files.length > 0) void onUploadPrivateFiles(Array.from(files));
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <ComposerAuthorizationMenu
              mode={controller.selectedAuthorizationMode}
              options={conversationAuthorizationModeMenuOptions(t)}
              disabled={permissionLocked}
              disabledReason={t("Authorization is locked while the private reply is running.")}
              selectedModeLabel={t("Selected authorization mode {label}")}
              menuLabel={t("Authorization mode")}
              onModeChange={controller.handleAuthorizationModeChange}
            />
            <ComposerPermissionMenu
              preset={controller.selectedPermissionPreset}
              options={conversationPermissionPresetMenuOptions(t, fullAccessConfirmed)}
              disabled={permissionLocked}
              disabledReason={t("Permission is locked while the private reply is running.")}
              selectedPermissionLabel={t("Selected permission preset {label}")}
              menuLabel={t("Permission preset")}
              onPresetChange={controller.handlePermissionPresetChange}
            />
          </>
        )}
        rightToolsNode={(
          <IconButton
            className="composer-send-button"
            variant="primary"
            icon={SendIcon}
            label={sendLabel}
            aria-label={sendLabel}
            loading={privateComposerSending}
            loadingLabel={privateComposerSendingLabel}
            onClick={controller.submitComposer}
            disabled={privateComposerSendDisabled || privateComposerSending}
          />
        )}
      />
    </div>
  );
}
