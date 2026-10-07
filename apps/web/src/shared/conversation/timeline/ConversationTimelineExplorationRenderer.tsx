import { FileText, FolderSearch, Search } from "lucide-react";
import type { ConversationTimelineExplorationItem } from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ExplorationDetail, basename, detailExists } from "./timeline-renderer-details.js";
import { useI18n } from "../../../i18n.js";

export function ConversationTimelineExplorationRenderer({ item, cwd, onOpenSourceRef, depth }: { readonly item: ConversationTimelineExplorationItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler; readonly depth: 0 | 1 }): React.JSX.Element {
  const { t } = useI18n();
  const target = item.targets[0];
  const path = target?.path ?? target?.label ?? target?.id;
  const targetLabel = path ? basename(path) : item.inputSummary;
  const verb = item.operation === "read"
    ? item.status === "succeeded" ? "Read action {target}" : item.status === "running" ? "Reading action {target}" : "Read {target}"
    : item.operation === "ls" ? "List {target}"
    : item.status === "succeeded" ? "Searched {target}" : item.status === "running" ? "Searching {target}" : "Search {target}";
  const title = targetLabel ? t(verb, { target: targetLabel }) : item.title;
  const icon = item.operation === "read" ? <FileText size={14} aria-hidden="true" /> : item.operation === "ls" ? <FolderSearch size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />;
  return <TimelineFactRow item={item} depth={depth} compact title={title} titleTooltip={item.inputSummary ?? path} icon={icon} detail={detailExists(item) ? <ExplorationDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined} />;
}
