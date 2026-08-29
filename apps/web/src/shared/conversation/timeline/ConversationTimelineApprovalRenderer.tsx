import { ShieldAlert } from "lucide-react";
import type { ConversationTimelineApprovalItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ApprovalDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineApprovalRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelineApprovalItem; readonly cwd?: string; readonly onOpenSourceRef?: (ref: ConversationTimelineApprovalItem["sourceRefs"][number]) => void; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ShieldAlert size={14} aria-hidden="true" />} detail={detailExists(item) ? <ApprovalDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
