import { Archive } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTimelineContextCompactionItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineCompactionRenderer({ item, cwd, depth, actions }: { readonly item: ConversationTimelineContextCompactionItem; readonly cwd?: string; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<Archive size={14} aria-hidden="true" />} detail={detailExists(item) ? <TextDetail text={item.summary} cwd={cwd} /> : undefined} actions={actions} />;
}
