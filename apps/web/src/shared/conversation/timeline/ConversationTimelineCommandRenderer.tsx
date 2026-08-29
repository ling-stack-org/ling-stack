import { Terminal } from "lucide-react";
import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { CommandDetail, detailExists, truncateInline } from "./timeline-renderer-details.js";

export function ConversationTimelineCommandRenderer({ item, depth }: { readonly item: ConversationTimelineCommandExecutionItem; readonly depth: 0 | 1 }): React.JSX.Element {
  const title = item.command.trim() ? truncateInline(item.command) : item.title;
  return <TimelineFactRow item={item} depth={depth} title={title} icon={<Terminal size={14} aria-hidden="true" />} detail={detailExists(item) ? <CommandDetail item={item} /> : undefined} />;
}
