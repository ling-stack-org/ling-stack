import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTimelineDiagnosticItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineBlockedRenderer({ item, cwd, depth, actions }: { readonly item: ConversationTimelineDiagnosticItem; readonly cwd?: string; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} meta={item.code} icon={<FileText size={14} aria-hidden="true" />} detail={detailExists(item) ? <TextDetail text={item.description ?? item.summary} cwd={cwd} /> : undefined} actions={actions} />;
}
