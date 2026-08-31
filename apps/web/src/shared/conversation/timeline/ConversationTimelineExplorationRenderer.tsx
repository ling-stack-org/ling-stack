import { Search } from "lucide-react";
import type { ConversationTrustedSourceRef, ConversationTimelineExplorationItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ExplorationDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineExplorationRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelineExplorationItem; readonly cwd?: string; readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<Search size={14} aria-hidden="true" />} detail={detailExists(item) ? <ExplorationDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
