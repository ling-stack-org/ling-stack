import { ArrowDown } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton, InlineFeedback, Spinner } from "../../shared/ui/index.js";
import type { ReactNode } from "react";

interface ChannelFeedStatusProps {
  readonly loading: boolean;
  readonly error: boolean;
}

export function ChannelFeedStatus({ error, loading }: ChannelFeedStatusProps): JSX.Element | null {
  const { t } = useI18n();
  if (!loading && !error) {
    return null;
  }
  return (
    <div className="channel-feed-status-stack">
      {loading ? (
        <InlineFeedback className="activity-feed-status" tone="neutral">
          <span className="channel-feed-status-message">
            <Spinner size="sm" />
            <span>{t("Loading activity events...")}</span>
          </span>
        </InlineFeedback>
      ) : null}
      {error ? (
        <InlineFeedback className="activity-feed-status warning" tone="warning">
          {t("Some activity changes could not be loaded")}
        </InlineFeedback>
      ) : null}
    </div>
  );
}

interface ChannelFeedLatestControlProps {
  readonly feedbackNode?: ReactNode;
  readonly visible: boolean;
  readonly onActivate: () => void;
}

export function ChannelFeedLatestControl({
  feedbackNode,
  onActivate,
  visible,
}: ChannelFeedLatestControlProps): JSX.Element {
  const { t } = useI18n();
  return (
    <>
      {feedbackNode}
      {visible ? (
        <IconButton
          className="message-feed-latest-button"
          data-channel-feed-action="latest"
          icon={ArrowDown}
          label={t("Jump to latest message")}
          onClick={onActivate}
        />
      ) : null}
    </>
  );
}
