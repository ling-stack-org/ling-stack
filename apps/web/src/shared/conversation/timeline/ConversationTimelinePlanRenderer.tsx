import { ListChecks } from "lucide-react";
import type { ConversationTimelinePlanItem } from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { PlanDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelinePlanRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelinePlanItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ListChecks size={14} aria-hidden="true" />} detail={detailExists(item) ? <PlanDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
