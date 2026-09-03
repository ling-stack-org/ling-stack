import { Terminal } from "lucide-react";
import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { commandTarget } from "./command-target.js";
import { CommandDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineCommandRenderer({ item, depth }: { readonly item: ConversationTimelineCommandExecutionItem; readonly depth: 0 | 1 }): React.JSX.Element {
  const { t } = useI18n();
  const target = commandTarget(item.command);
  const title = target ? t("Run command: {target}", { target }) : item.title;
  const meta = commandMeta(item);
  return <TimelineFactRow item={item} depth={depth} title={title} meta={meta} icon={<Terminal size={14} aria-hidden="true" />} detail={detailExists(item) ? <CommandDetail item={item} /> : undefined} />;
}

function commandMeta(item: ConversationTimelineCommandExecutionItem): string | undefined {
  const parts = [
    item.exitCode === undefined ? undefined : `exit ${item.exitCode}`,
    item.durationMs === undefined ? undefined : formatDuration(item.durationMs),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatDuration(value: number): string {
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
