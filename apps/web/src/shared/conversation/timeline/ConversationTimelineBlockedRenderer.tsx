import { FileText } from "lucide-react";
import type { ConversationTimelineDiagnosticItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineBlockedRenderer({ item, cwd, depth }: { readonly item: ConversationTimelineDiagnosticItem; readonly cwd?: string; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} meta={item.code} icon={<FileText size={14} aria-hidden="true" />} detail={detailExists(item) ? <TextDetail text={item.description ?? item.summary} cwd={cwd} /> : undefined} />;
}
