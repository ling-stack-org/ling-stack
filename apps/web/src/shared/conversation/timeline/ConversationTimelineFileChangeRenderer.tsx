import { FilePenLine } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationTrustedSourceRef, ConversationTimelineFileChangeItem } from "@ling-stack/conversation-ui-core";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { FileChangeDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineFileChangeRenderer({ item, cwd, loadPreview, onOpenSourceRef, depth, actions }: { readonly item: ConversationTimelineFileChangeItem; readonly cwd?: string; readonly loadPreview?: ArtifactPreviewLoader; readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void; readonly depth: 0 | 1; readonly actions?: ReactNode }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<FilePenLine size={14} aria-hidden="true" />} detail={detailExists(item) ? <FileChangeDetail item={item} cwd={cwd} loadPreview={loadPreview} onOpenSourceRef={onOpenSourceRef} /> : undefined} actions={actions} />;
}
