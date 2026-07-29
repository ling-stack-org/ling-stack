import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Textarea } from "@ling-stack/ui-react";
import { CornerDownLeft, FileText, Link2, Loader2, MessageSquareText, MoreHorizontal, Paperclip, PauseCircle, Pencil, Send, Square, Trash2, XCircle } from "lucide-react";

export interface ConversationGuidanceItem {
  readonly id: string;
  readonly instruction: string;
  readonly attachments?: readonly { readonly id: string; readonly label: string }[];
  readonly linkPreviews?: readonly { readonly id: string; readonly label: string }[];
  readonly fileRefs?: readonly { readonly id: string; readonly label: string; readonly status?: string }[];
  readonly statusLabel: string;
  readonly meta?: string;
  readonly promoteLabel?: string;
  readonly promoteDisabled?: boolean;
  readonly promoteLoading?: boolean;
  readonly onPromote?: () => void;
  readonly cancelLabel?: string;
  readonly cancelDisabled?: boolean;
  readonly onCancel?: () => void;
  readonly deleteLabel?: string;
  readonly deleteDisabled?: boolean;
  readonly deleteLoading?: boolean;
  readonly onDelete?: () => void;
  readonly moreLabel?: string;
  readonly editLabel?: string;
  readonly editDisabled?: boolean;
  readonly onEdit?: () => void;
  readonly closeQueueLabel?: string;
  readonly closeQueueDisabled?: boolean;
  readonly closeQueueLoading?: boolean;
  readonly onCloseQueue?: () => void;
}

export interface ConversationGuidanceStripProps {
  readonly title: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly instructionPlaceholder?: string;
  readonly queueLabel?: string;
  readonly redirectLabel?: string;
  readonly stopLabel?: string;
  readonly submitting?: "queue_followup" | "interrupt_redirect" | "stop" | "";
  readonly stopDisabled?: boolean;
  readonly submitDisabled?: boolean;
  readonly items?: readonly ConversationGuidanceItem[];
  readonly onInstructionChange?: (value: string) => void;
  readonly onQueue?: () => void;
  readonly onRedirect?: () => void;
  readonly onStop?: () => void;
}

export function ConversationGuidanceStrip({
  title,
  description,
  instruction,
  instructionPlaceholder,
  queueLabel,
  redirectLabel,
  stopLabel,
  submitting,
  stopDisabled,
  submitDisabled,
  items,
  onInstructionChange,
  onQueue,
  onRedirect,
  onStop,
}: ConversationGuidanceStripProps): JSX.Element {
  const showCompose = Boolean(
    typeof instruction === "string" &&
      instructionPlaceholder &&
      queueLabel &&
      redirectLabel &&
      stopLabel &&
      onInstructionChange &&
      onQueue &&
      onRedirect &&
      onStop,
  );

  return (
    <section className="conversation-guidance-strip" aria-label={title}>
      <div className="conversation-guidance-head">
        <span>{title}</span>
        {description ? <small>{description}</small> : null}
      </div>
      {showCompose ? (
        <>
          <Textarea
            className="conversation-guidance-input"
            value={instruction ?? ""}
            rows={2}
            placeholder={instructionPlaceholder ?? ""}
            onChange={(event) => onInstructionChange?.(event.target.value)}
          />
          <div className="conversation-guidance-actions">
            <Button
              disabled={stopDisabled}
              leadingIcon={<Square size={14} />}
              loading={submitting === "stop"}
              loadingLabel={stopLabel}
              onClick={onStop}
              size="sm"
              variant="secondary"
            >
              {stopLabel}
            </Button>
            <Button
              disabled={submitDisabled}
              leadingIcon={<Send size={14} />}
              loading={submitting === "queue_followup"}
              loadingLabel={queueLabel}
              onClick={onQueue}
              size="sm"
              variant="secondary"
            >
              {queueLabel}
            </Button>
            <Button
              disabled={submitDisabled}
              leadingIcon={<PauseCircle size={14} />}
              loading={submitting === "interrupt_redirect"}
              loadingLabel={redirectLabel}
              onClick={onRedirect}
              size="sm"
              variant="primary"
            >
              {redirectLabel}
            </Button>
          </div>
        </>
      ) : null}
      {items && items.length > 0 ? (
        <div className="conversation-guidance-list">
          {items.map((item) => {
            const deleteAction = item.onDelete ?? item.onCancel;
            const deleteLabel = item.deleteLabel ?? item.cancelLabel ?? "Delete queued guidance";
            const deleteDisabled = item.deleteDisabled ?? item.cancelDisabled;
            const hasPromoteAction = Boolean(item.onPromote || item.promoteLabel);
            const hasMoreMenu = Boolean(item.onEdit || item.onCloseQueue);

            return (
              <div key={item.id} className="conversation-guidance-row">
                <span className="conversation-guidance-row-main">
                  <span className="conversation-guidance-token" aria-hidden="true">
                    <MessageSquareText size={14} />
                  </span>
                  <span className="conversation-guidance-copy">
                    <span className="conversation-guidance-instruction">{item.instruction}</span>
                    <small>
                      <span>{item.statusLabel}</span>
                      {item.meta ? <span>{item.meta}</span> : null}
                      {item.attachments?.map((attachment) => (
                        <span key={`attachment:${attachment.id}`} title={attachment.label}>
                          <Paperclip size={11} />
                          {attachment.label}
                        </span>
                      ))}
                      {item.linkPreviews?.map((preview) => (
                        <span key={`link:${preview.id}`} title={preview.label}>
                          <Link2 size={11} />
                          {preview.label}
                        </span>
                      ))}
                      {item.fileRefs?.map((fileRef) => (
                        <span key={`file:${fileRef.id}`} title={fileRef.status ? `${fileRef.label}: ${fileRef.status}` : fileRef.label}>
                          <FileText size={11} />
                          {fileRef.label}
                        </span>
                      ))}
                    </small>
                  </span>
                </span>
                <span className="conversation-guidance-row-actions">
                  {hasPromoteAction ? (
                    <IconButton
                      disabled={!item.onPromote || item.promoteDisabled || item.promoteLoading}
                      icon={CornerDownLeft}
                      label={item.promoteLabel ?? "Run this guidance now"}
                      loading={item.promoteLoading}
                      loadingLabel={item.promoteLabel ?? "Run this guidance now"}
                      onClick={() => item.onPromote?.()}
                      size="sm"
                      variant="ghost"
                    />
                  ) : null}
                  {deleteAction ? (
                    <IconButton
                      disabled={deleteDisabled || item.deleteLoading}
                      icon={Trash2}
                      label={deleteLabel}
                      loading={item.deleteLoading}
                      loadingLabel={deleteLabel}
                      onClick={deleteAction}
                      size="sm"
                      variant="ghost"
                    />
                  ) : null}
                  {hasMoreMenu ? (
                    <Menu modal={false}>
                      <MenuTrigger asChild>
                        <IconButton
                          icon={MoreHorizontal}
                          label={item.moreLabel ?? "More guidance actions"}
                          size="sm"
                          variant="ghost"
                        />
                      </MenuTrigger>
                      <MenuContent align="end" side="top">
                        {item.onEdit ? (
                          <MenuItem disabled={item.editDisabled} onSelect={() => item.onEdit?.()}>
                            <Pencil size={14} />
                            {item.editLabel ?? "Edit message"}
                          </MenuItem>
                        ) : null}
                        {item.onCloseQueue ? (
                          <MenuItem
                            disabled={item.closeQueueDisabled || item.closeQueueLoading}
                            onSelect={() => item.onCloseQueue?.()}
                          >
                            {item.closeQueueLoading ? <Loader2 className="spin" size={14} /> : <XCircle size={14} />}
                            {item.closeQueueLabel ?? "Close queue"}
                          </MenuItem>
                        ) : null}
                      </MenuContent>
                    </Menu>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
