import { PlugZap, UsersRound, Wrench } from "lucide-react";
import type { ConversationTrustedSourceRef, ConversationTimelineToolCallItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ToolDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineToolRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelineToolCallItem; readonly cwd?: string; readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void; readonly depth: 0 | 1 }): React.JSX.Element {
  const icon = item.kind === "mcpToolCall" ? <PlugZap size={14} aria-hidden="true" /> : item.kind === "dynamicToolCall" ? <Wrench size={14} aria-hidden="true" /> : <UsersRound size={14} aria-hidden="true" />;
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={icon} detail={detailExists(item) ? <ToolDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
