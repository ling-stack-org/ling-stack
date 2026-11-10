import type {
  ConversationTimelineMessageItem,
} from "@ling-stack/conversation-ui-core";
import { conversationTimelineRendererKey } from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { LocalFileLink } from "../blocks/LocalFileLink.js";
import { useI18n } from "../../../i18n.js";
import { ConversationActivityLabel } from "../feedback/ConversationActivityLabel.js";
import type { ConversationTimelineMessagePresentation } from "./timeline-response-presentation.js";
import { useDaemonObservation } from "../observation/daemon-observation.js";

export interface ConversationTimelineMessageRendererProps {
  readonly item: ConversationTimelineMessageItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  /**
   * Surface chrome (author, timestamp, message actions and resources) is
   * supplied by the adapter, while the Timeline still owns the message item
   * and its position.  This keeps one Timeline owner without forcing the
   * registry to know about surface-specific shell controls.
   */
  readonly renderChrome?: (item: ConversationTimelineMessageItem, body: React.ReactNode, presentation: ConversationTimelineMessagePresentation) => React.ReactNode;
  readonly presentation?: ConversationTimelineMessagePresentation;
}

export function ConversationTimelineMessageRenderer({
  item,
  depth,
  cwd,
  renderChrome,
  presentation = { ownsIdentity: true },
}: ConversationTimelineMessageRendererProps): React.JSX.Element {
  const { t } = useI18n();
  const paused = useDaemonObservation().paused;
  const streaming = item.status === "pending" || item.status === "running";
  // Only explicit adapter placeholders or empty live messages are waiting copy.
  const waiting = item.kind === "agentMessage" && streaming &&
    (item.waitingPlaceholder || !item.markdown.trim());
  const body = waiting ? (
    <div className="conversation-thinking-indicator" role="status">
      <ConversationActivityLabel>{paused ? t("Pending confirmation") : item.markdown || t("Thinking...")}</ConversationActivityLabel>
    </div>
  ) : (
    <MessageBodyRenderer
      text={item.markdown}
      cwd={cwd}
      compact={false}
      streaming={streaming && !paused}
      renderLocalFile={({ reference }) => {
        return <LocalFileLink reference={reference} />;
      }}
    />
  );
  const renderedBody = renderChrome?.(item, body, presentation)
    ?? <div className="conversation-timeline-reading-body">{body}</div>;
  return (
    <div
      className={`conversation-timeline-message ${item.kind}`}
      data-conversation-timeline-message
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey(item.kind)}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-timeline-depth={depth}
    >
      {renderedBody}
    </div>
  );
}
