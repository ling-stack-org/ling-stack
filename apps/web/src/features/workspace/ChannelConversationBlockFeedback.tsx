import { CircleAlert, X } from "lucide-react";

export type ConversationBlockFeedbackOwner = "block" | "menu";

export interface ConversationBlockFailure {
  readonly action: "copy";
  readonly blockId: string;
  readonly message: string;
  readonly owner: ConversationBlockFeedbackOwner;
}

export function ChannelConversationBlockFeedback({
  dismissLabel,
  failure,
  onDismiss,
}: {
  readonly dismissLabel: string;
  readonly failure: ConversationBlockFailure;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      className="conversation-block-feedback error"
      data-conversation-block-feedback={failure.action}
      data-feedback-owner={failure.owner}
      role="alert"
      aria-atomic="true"
    >
      <CircleAlert aria-hidden="true" size={14} />
      <span>{failure.message}</span>
      <button
        className="conversation-block-feedback-dismiss"
        type="button"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
