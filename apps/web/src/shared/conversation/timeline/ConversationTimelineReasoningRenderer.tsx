import type { ConversationTimelineReasoningItem } from "@ling-stack/conversation-ui-core";
import { conversationTimelineRendererKey } from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";

export function ConversationTimelineReasoningRenderer({ item, cwd, depth }: {
  readonly item: ConversationTimelineReasoningItem;
  readonly cwd?: string;
  readonly depth: 0 | 1;
}): React.JSX.Element {
  return (
    <section
      className="conversation-timeline-reasoning"
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey(item.kind)}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-depth={depth}
    >
      <div className="conversation-timeline-reasoning-body">
        <MessageBodyRenderer text={item.summary} cwd={cwd} compact streaming={false} />
      </div>
    </section>
  );
}
