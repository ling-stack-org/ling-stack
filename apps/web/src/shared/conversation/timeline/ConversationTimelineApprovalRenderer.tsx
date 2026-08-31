import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTrustedSourceRef, ConversationTimelineApprovalItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ApprovalDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineApprovalRenderer({ item, cwd, onOpenSourceRef, depth, actions }: { readonly item: ConversationTimelineApprovalItem; readonly cwd?: string; readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ShieldAlert size={14} aria-hidden="true" />} detail={detailExists(item) ? <ApprovalDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} actions={actions} />;
}
