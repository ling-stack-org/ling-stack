import { FilePenLine } from "lucide-react";
import type { ConversationTimelineFileChangeItem } from "@ling-stack/conversation-ui-core";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { FileChangeDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineFileChangeRenderer({ item, cwd, loadPreview, onOpenSourceRef, depth }: { readonly item: ConversationTimelineFileChangeItem; readonly cwd?: string; readonly loadPreview?: ArtifactPreviewLoader; readonly onOpenSourceRef?: (ref: ConversationTimelineFileChangeItem["sourceRefs"][number]) => void; readonly depth: 0 | 1 }): React.JSX.Element {
  return <TimelineFactRow item={item} depth={depth} title={item.title} icon={<FilePenLine size={14} aria-hidden="true" />} detail={detailExists(item) ? <FileChangeDetail item={item} cwd={cwd} loadPreview={loadPreview} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
