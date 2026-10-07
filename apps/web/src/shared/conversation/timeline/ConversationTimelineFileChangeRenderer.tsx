import { FilePenLine } from "lucide-react";
import type { ConversationTimelineFileChangeItem } from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { FileChangeDetail, detailExists } from "./timeline-renderer-details.js";
import { useI18n } from "../../../i18n.js";

export function ConversationTimelineFileChangeRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelineFileChangeItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler; readonly depth: 0 | 1 }): React.JSX.Element {
  const { t } = useI18n();
  const count = item.files.length;
  const title = count === 1 ? item.status === "succeeded" || item.status === "running"
    ? t(item.status === "succeeded" ? "Edited {target}" : "Editing {target}", { target: item.files[0]!.displayName })
    : `${t("Edit")} ${item.files[0]!.displayName}`
    : count > 1 ? item.status === "succeeded" ? t("Edited {count} files", { count }) : `${t("Edit")} ${count} ${t("Files")}` : item.title;
  const tooltip = item.files.map((file) => file.fileRef.path ?? file.displayName).join("\n");
  return <TimelineFactRow item={item} depth={depth} compact title={title} titleTooltip={tooltip} icon={<FilePenLine size={14} aria-hidden="true" />} detail={detailExists(item) ? <FileChangeDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
