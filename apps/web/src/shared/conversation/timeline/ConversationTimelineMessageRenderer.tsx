import type { ReactNode } from "react";
import type { ConversationTimelineMessageItem } from "@ling-stack/conversation-ui-core";

export function ConversationTimelineMessageRenderer({ item, renderMessage, depth }: { readonly item: ConversationTimelineMessageItem; readonly renderMessage?: (markdown: string) => ReactNode; readonly depth: 0 | 1 }): React.JSX.Element {
  return <div className={`conversation-timeline-message ${item.kind}`} data-conversation-timeline-message data-conversation-timeline-kind={item.kind} data-conversation-timeline-id={item.id} data-conversation-timeline-revision={item.revision} data-conversation-timeline-status={item.status ?? "unknown"} data-conversation-timeline-depth={depth}>{renderMessage ? renderMessage(item.markdown) : <p>{item.markdown}</p>}</div>;
}
