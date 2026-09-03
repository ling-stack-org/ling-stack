import type {
  ConversationTimelineMessageItem,
} from "@ling-stack/conversation-ui-core";
import { conversationTimelineRendererKey } from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { LocalFileLink } from "../blocks/LocalFileLink.js";

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
  readonly renderChrome?: (item: ConversationTimelineMessageItem, body: React.ReactNode) => React.ReactNode;
}

export function ConversationTimelineMessageRenderer({
  item,
  depth,
  cwd,
  renderChrome,
}: ConversationTimelineMessageRendererProps): React.JSX.Element {
  const body = (
    <MessageBodyRenderer
      text={item.markdown}
      cwd={cwd}
      compact={false}
      streaming={item.status === "pending" || item.status === "running"}
      renderLocalFile={({ reference }) => {
        return <LocalFileLink reference={reference} />;
      }}
    />
  );
  const renderedBody = renderChrome?.(item, body) ?? body;
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
