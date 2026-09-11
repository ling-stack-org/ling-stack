import { Terminal } from "lucide-react";
import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { CommandDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineCommandRenderer({ item, depth }: { readonly item: ConversationTimelineCommandExecutionItem; readonly depth: 0 | 1 }): React.JSX.Element {
  const { t } = useI18n();
  const verb = t(item.status === "succeeded" ? "Ran command" : item.status === "running" ? "Running command" : "Run command");
  const title = item.command ? `${verb} ${item.command}` : item.title;
  return <TimelineFactRow item={item} depth={depth} compact title={title} titleTooltip={item.command} statusLabel={item.timedOut ? t("Timed out") : undefined} icon={<Terminal size={14} aria-hidden="true" />} detail={detailExists(item) ? <CommandDetail item={item} /> : undefined} />;
}
