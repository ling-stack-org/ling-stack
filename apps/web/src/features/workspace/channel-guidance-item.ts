import type { Translate } from "../../i18n.js";
import type { ConversationGuidanceItem } from "../../shared/conversation/index.js";
import type { ChannelAttachment, ChannelLinkPreview, ChannelMention, RunIntervention } from "../../types.js";
import {
  channelGuidanceTargetLabel,
  channelRunInterventionModeLabel,
  channelRunInterventionStatusLabel,
} from "./channel-guidance-label.js";

export function projectAuthoritativeChannelGuidanceItem(input: {
  readonly intervention: RunIntervention;
  readonly attachmentById: ReadonlyMap<string, ChannelAttachment>;
  readonly linkPreviewById: ReadonlyMap<string, ChannelLinkPreview>;
  readonly teammateOptions: readonly ChannelMention[];
  readonly cancelingId: string;
  readonly onCancel: (interventionId: string) => void;
  readonly onEdit: (intervention: RunIntervention) => void;
  readonly t: Translate;
}): ConversationGuidanceItem {
  const { intervention, t } = input;
  const isQueued = intervention.status === "queued";
  const rowBusy = input.cancelingId === intervention.id;
  return {
    id: intervention.id,
    instruction: intervention.messagePayload?.body || intervention.instruction,
    attachments: (intervention.messagePayload?.attachmentIds ?? [])
      .map((attachmentId) => input.attachmentById.get(attachmentId))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment))
      .map((attachment) => ({ id: attachment.id, label: attachment.fileName })),
    linkPreviews: (intervention.messagePayload?.linkPreviewIds ?? [])
      .map((previewId) => input.linkPreviewById.get(previewId))
      .filter((preview): preview is ChannelLinkPreview => Boolean(preview))
      .map((preview) => ({ id: preview.id, label: preview.title || preview.url })),
    fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((fileRef, index) => ({
      id: `${fileRef.path}:${fileRef.label ?? ""}:${index}`,
      label: fileRef.label ?? fileRef.path,
      status: fileRef.materializationStatus,
    })),
    statusLabel: channelRunInterventionStatusLabel(intervention.status, t),
    meta: `${channelGuidanceTargetLabel({
      teammateId: intervention.messagePayload?.targetTeammateId,
      teammateOptions: input.teammateOptions,
      lingAgentLabel: t("Ling Agent"),
      fallbackLabel: t("AI teammate"),
    })} · ${channelRunInterventionModeLabel(intervention.mode, t)}`,
    deleteLabel: t("Delete queued guidance"),
    deleteDisabled: rowBusy,
    deleteLoading: rowBusy,
    onDelete: isQueued ? () => input.onCancel(intervention.id) : undefined,
    moreLabel: t("More guidance actions"),
    editLabel: t("Edit message"),
    editDisabled: rowBusy,
    onEdit: isQueued ? () => input.onEdit(intervention) : undefined,
    closeQueueLabel: t("Close queue"),
    closeQueueDisabled: rowBusy,
    closeQueueLoading: rowBusy,
    onCloseQueue: isQueued ? () => input.onCancel(intervention.id) : undefined,
  };
}
