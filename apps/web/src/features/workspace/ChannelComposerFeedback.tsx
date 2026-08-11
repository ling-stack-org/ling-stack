import { CheckCircle2, CircleAlert, Info, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback } from "../../shared/ui/index.js";

export type ChannelComposerSendState = "idle" | "sending" | "failed";
export type ChannelComposerInlineFeedbackTone = "success" | "info" | "error";

export interface ChannelComposerInlineFeedback {
  readonly id: number;
  readonly tone: ChannelComposerInlineFeedbackTone;
  readonly message: string;
}

interface ChannelComposerFeedbackProps {
  readonly feedback?: ChannelComposerInlineFeedback;
  readonly sendState: ChannelComposerSendState;
  readonly sendError: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

export function ChannelComposerFeedback({
  feedback,
  onDismiss,
  onRetry,
  sendError,
  sendState,
}: ChannelComposerFeedbackProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (!feedback && sendState !== "failed") {
    return null;
  }

  return (
    <div className="channel-composer-feedback-stack" aria-live="polite">
      {feedback ? (
        <InlineFeedback
          key={feedback.id}
          className={`composer-status-row ${feedback.tone}`}
          tone={feedback.tone === "error" ? "danger" : feedback.tone}
        >
          <span className="channel-composer-feedback-message">
            {feedback.tone === "success"
              ? <CheckCircle2 size={14} />
              : feedback.tone === "error"
                ? <CircleAlert size={14} />
                : <Info size={14} />}
            <span>{feedback.message}</span>
          </span>
        </InlineFeedback>
      ) : null}
      {sendState === "failed" ? (
        <InlineFeedback className="composer-status-row failed" tone="danger" title={t("Message failed")} role="alert">
          {sendError ? <span>{sendError}</span> : null}
          <div className="channel-composer-feedback-actions">
            <Button size="sm" variant="secondary" leadingIcon={<RefreshCw size={13} />} onClick={onRetry}>
              {t("Retry")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {t("Dismiss")}
            </Button>
          </div>
        </InlineFeedback>
      ) : null}
    </div>
  );
}
