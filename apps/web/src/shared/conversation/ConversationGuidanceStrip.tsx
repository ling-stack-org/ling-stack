import { CornerDownLeft, Loader2, PauseCircle, Send, Square } from "lucide-react";

export interface ConversationGuidanceItem {
  readonly id: string;
  readonly instruction: string;
  readonly statusLabel: string;
  readonly meta?: string;
  readonly promoteLabel?: string;
  readonly promoteDisabled?: boolean;
  readonly promoteLoading?: boolean;
  readonly onPromote?: () => void;
  readonly cancelLabel?: string;
  readonly cancelDisabled?: boolean;
  readonly onCancel?: () => void;
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
  readonly instruction: string;
  readonly instructionPlaceholder: string;
  readonly queueLabel: string;
  readonly redirectLabel: string;
  readonly stopLabel: string;
  readonly submitting?: "queue_followup" | "interrupt_redirect" | "stop" | "";
  readonly stopDisabled?: boolean;
  readonly submitDisabled?: boolean;
  readonly items?: readonly ConversationGuidanceItem[];
  readonly onInstructionChange: (value: string) => void;
  readonly onQueue: () => void;
  readonly onRedirect: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  return (
    <section className="conversation-guidance-strip channel-run-guidance-strip" aria-label={title}>
      <div className="channel-run-guidance-head">
        <span>{title}</span>
        {description ? <small>{description}</small> : null}
      </div>
      <textarea
        value={instruction}
        rows={2}
        placeholder={instructionPlaceholder}
        onChange={(event) => onInstructionChange(event.target.value)}
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
      {items && items.length > 0 ? (
        <div className="channel-run-guidance-list">
          {items.map((item) => (
            <div key={item.id} className="channel-run-guidance-row">
              <span className="channel-run-guidance-status">{item.statusLabel}</span>
              <span>{item.instruction}</span>
              {item.meta ? <small>{item.meta}</small> : null}
              {item.onPromote ? (
                <button
                  className="ghost-button compact-button icon-button"
                  type="button"
                  disabled={item.promoteDisabled || item.promoteLoading}
                  onClick={item.onPromote}
                  aria-label={item.promoteLabel ?? "Run now"}
                  title={item.promoteLabel ?? "Run now"}
                >
                  {item.promoteLoading ? <Loader2 className="spin" size={14} /> : <CornerDownLeft size={14} />}
                </button>
              ) : null}
              {item.onCancel ? (
                <button className="ghost-button compact-button" type="button" disabled={item.cancelDisabled} onClick={item.onCancel}>
                  {item.cancelLabel ?? "Cancel"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
