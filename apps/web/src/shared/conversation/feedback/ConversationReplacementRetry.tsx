import { Loader2, RotateCcw } from "lucide-react";

export function ConversationReplacementRetry({
  failureReason,
  retryLabel,
  retrying,
  onRetry,
}: {
  readonly failureReason?: string;
  readonly retryLabel: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <div className="conversation-replacement-retry" role="status">
      {failureReason ? <span>{failureReason}</span> : null}
      <button
        className="ghost-button compact-button"
        type="button"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
        <span>{retryLabel}</span>
      </button>
    </div>
  );
}
