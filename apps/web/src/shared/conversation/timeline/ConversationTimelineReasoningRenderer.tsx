import { Brain } from "lucide-react";
import type { ConversationTimelineReasoningItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineReasoningRenderer({ item, depth }: { readonly item: ConversationTimelineReasoningItem; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<Brain size={14} aria-hidden="true" />} detail={detailExists(item) ? <TextDetail text={item.summary} /> : undefined} />;
}
