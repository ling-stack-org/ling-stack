import { ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTrustedSourceRef, ConversationTimelinePlanItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { PlanDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelinePlanRenderer({ item, cwd, onOpenSourceRef, depth, actions }: { readonly item: ConversationTimelinePlanItem; readonly cwd?: string; readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ListChecks size={14} aria-hidden="true" />} detail={detailExists(item) ? <PlanDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} actions={actions} />;
}
