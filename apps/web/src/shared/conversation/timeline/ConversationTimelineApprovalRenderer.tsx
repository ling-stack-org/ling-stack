import { ShieldAlert } from "lucide-react";
import type { ConversationProtocolAction, ConversationTimelineApprovalItem } from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ApprovalDetail, detailExists } from "./timeline-renderer-details.js";
import { ConversationTimelineProtocolActions } from "./ConversationTimelineProtocolActions.js";

export function ConversationTimelineApprovalRenderer({ item, cwd, onOpenSourceRef, onInvokeProtocolAction, depth }: { readonly item: ConversationTimelineApprovalItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler; readonly onInvokeProtocolAction?: (item: ConversationTimelineApprovalItem, action: ConversationProtocolAction) => void | Promise<void>; readonly depth: 0 | 1 }): React.JSX.Element {
  const hasActions = Boolean(onInvokeProtocolAction && item.availableActions?.length);
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ShieldAlert size={14} aria-hidden="true" />} detail={detailExists(item) || hasActions ? <><ApprovalDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /><ConversationTimelineProtocolActions item={item} onInvoke={onInvokeProtocolAction} /></> : undefined} />;
}
