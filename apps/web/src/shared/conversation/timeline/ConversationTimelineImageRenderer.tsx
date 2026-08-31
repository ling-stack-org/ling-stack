import { Image as ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTimelineImageViewItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineImageRenderer({ item, cwd, depth, actions }: { readonly item: ConversationTimelineImageViewItem; readonly cwd?: string; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ImageIcon size={14} aria-hidden="true" />} detail={detailExists(item) ? <TextDetail text={item.description ?? item.alt} cwd={cwd} /> : undefined} actions={actions} />;
}
