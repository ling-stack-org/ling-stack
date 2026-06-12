import { useState } from "react";
import { CornerDownLeft, Link2, Loader2, MessageSquareText, MoreHorizontal, Paperclip, PauseCircle, Pencil, Send, Square, Trash2, XCircle } from "lucide-react";

export interface ConversationGuidanceItem {
  readonly id: string;
  readonly instruction: string;
  readonly attachments?: readonly { readonly id: string; readonly label: string }[];
  readonly linkPreviews?: readonly { readonly id: string; readonly label: string }[];
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
}: {
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
}): JSX.Element {
  const [openMenuItemId, setOpenMenuItemId] = useState("");
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
    <section className="conversation-guidance-strip channel-run-guidance-strip" aria-label={title}>
      <div className="channel-run-guidance-head">
        <span>{title}</span>
        {description ? <small>{description}</small> : null}
      </div>
      {showCompose ? (
        <>
          <textarea
            value={instruction ?? ""}
            rows={2}
            placeholder={instructionPlaceholder ?? ""}
            onChange={(event) => onInstructionChange?.(event.target.value)}
          />
          <div className="channel-run-guidance-actions">
            <button className="secondary-button compact-button" type="button" disabled={stopDisabled || submitting === "stop"} onClick={onStop}>
              {submitting === "stop" ? <Loader2 className="spin" size={14} /> : <Square size={14} />}
              {stopLabel}
            </button>
            <button className="secondary-button compact-button" type="button" disabled={submitDisabled || submitting === "queue_followup"} onClick={onQueue}>
              {submitting === "queue_followup" ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
              {queueLabel}
            </button>
            <button className="primary-button compact-button" type="button" disabled={submitDisabled || submitting === "interrupt_redirect"} onClick={onRedirect}>
              {submitting === "interrupt_redirect" ? <Loader2 className="spin" size={14} /> : <PauseCircle size={14} />}
              {redirectLabel}
            </button>
          </div>
        </>
      ) : null}
      {items && items.length > 0 ? (
        <div className="channel-run-guidance-list">
          {items.map((item) => {
            const deleteAction = item.onDelete ?? item.onCancel;
            const deleteLabel = item.deleteLabel ?? item.cancelLabel ?? "删除排队引导";
            const deleteDisabled = item.deleteDisabled ?? item.cancelDisabled;
            const hasPromoteAction = Boolean(item.onPromote || item.promoteLabel);
            const hasMoreMenu = Boolean(item.onEdit || item.onCloseQueue);
            const menuOpen = openMenuItemId === item.id;

            return (
              <div key={item.id} className="channel-run-guidance-row">
                <span className="channel-run-guidance-row-main">
                  <span className="channel-run-guidance-token" aria-hidden="true">
                    <MessageSquareText size={14} />
                  </span>
                  <span className="channel-run-guidance-copy">
                    <span className="channel-run-guidance-instruction">{item.instruction}</span>
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
                    </small>
                  </span>
                </span>
                <span className="channel-run-guidance-row-actions">
                  {hasPromoteAction ? (
                    <button
                      className="ghost-button compact-button icon-button"
                      type="button"
                      disabled={!item.onPromote || item.promoteDisabled || item.promoteLoading}
                      onClick={() => item.onPromote?.()}
                      aria-label={item.promoteLabel ?? "立即执行"}
                      title={item.promoteLabel ?? "立即执行"}
                    >
                      {item.promoteLoading ? <Loader2 className="spin" size={14} /> : <CornerDownLeft size={14} />}
                    </button>
                  ) : null}
                  {deleteAction ? (
                    <button
                      className="ghost-button compact-button icon-button"
                      type="button"
                      disabled={deleteDisabled || item.deleteLoading}
                      onClick={deleteAction}
                      aria-label={deleteLabel}
                      title={deleteLabel}
                    >
                      {item.deleteLoading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                    </button>
                  ) : null}
                  {hasMoreMenu ? (
                    <span className="channel-run-guidance-more">
                      <button
                        className="ghost-button compact-button icon-button"
                        type="button"
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        aria-label={item.moreLabel ?? "更多引导操作"}
                        title={item.moreLabel ?? "更多引导操作"}
                        onClick={() => setOpenMenuItemId(menuOpen ? "" : item.id)}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {menuOpen ? (
                        <span className="channel-run-guidance-menu" role="menu">
                          {item.onEdit ? (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={item.editDisabled}
                              onClick={() => {
                                setOpenMenuItemId("");
                                item.onEdit?.();
                              }}
                            >
                              <Pencil size={14} />
                              {item.editLabel ?? "编辑消息"}
                            </button>
                          ) : null}
                          {item.onCloseQueue ? (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={item.closeQueueDisabled || item.closeQueueLoading}
                              onClick={() => {
                                setOpenMenuItemId("");
                                item.onCloseQueue?.();
                              }}
                            >
                              {item.closeQueueLoading ? <Loader2 className="spin" size={14} /> : <XCircle size={14} />}
                              {item.closeQueueLabel ?? "关闭排队"}
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
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
