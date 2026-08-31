import type {
  ConversationTrustedSourceRef,
  ConversationTimelineMessageItem,
} from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import type { LocalFileReference } from "../tokens/message-body.js";
import { isTrustedFileSourceRef } from "./source-ref.js";

export interface ConversationTimelineMessageRendererProps {
  readonly item: ConversationTimelineMessageItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void;
}

export function ConversationTimelineMessageRenderer({
  item,
  depth,
  cwd,
  onOpenSourceRef,
}: ConversationTimelineMessageRendererProps): React.JSX.Element {
  const onOpenLocalFile = onOpenSourceRef
    ? (reference: LocalFileReference): void => {
      const trustedRef = item.sourceRefs.find((ref): ref is ConversationTrustedSourceRef =>
        isTrustedFileSourceRef(ref) && ref.path === reference.displayPath,
      );
      if (trustedRef) onOpenSourceRef(trustedRef);
    }
    : undefined;
  return (
    <div
      className={`conversation-timeline-message ${item.kind}`}
      data-conversation-timeline-message
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-timeline-depth={depth}
    >
      <MessageBodyRenderer
        text={item.markdown}
        cwd={cwd}
        compact={false}
        onOpenLocalFile={onOpenLocalFile}
      />
    </div>
  );
}
