import { ScanText } from "lucide-react";
import type { ConversationTimelineContextCompactionItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail } from "./timeline-renderer-details.js";
import { useI18n } from "../../../i18n.js";

export function ConversationTimelineCompactionRenderer({ item, cwd, depth }: { readonly item: ConversationTimelineContextCompactionItem; readonly cwd?: string; readonly depth: 0 | 1 }): React.JSX.Element {
  const { t, locale } = useI18n();
  const title = item.status === "running" ? t("Compacting context…")
    : item.status === "failed" ? t("Context compaction failed")
      : item.status === "cancelled" ? t("Context compaction cancelled")
        : item.status === "blocked" ? t("Compaction result unavailable")
          : item.status === "succeeded" ? item.reason === "threshold" || item.reason === "overflow"
            ? t("Context automatically compacted") : t("Context compacted") : item.title;
  const tokens = item.status === "succeeded" && item.tokensBefore !== undefined && item.estimatedTokensAfter !== undefined
    ? t("{before} tokens before · about {after} after", {
      before: item.tokensBefore.toLocaleString(locale), after: item.estimatedTokensAfter.toLocaleString(locale),
    }) : undefined;
  const meta = tokens ?? (item.compactedTurnCount !== undefined ? t("{count} turns compacted", { count: item.compactedTurnCount }) : undefined);
  const fallback = item.status === "blocked" ? t("No matching compaction result was recorded.")
    : item.status === "failed" ? t("Context compaction did not complete. Check the run status for details.") : undefined;
  const needsDetail = Boolean(item.summary?.trim()) || item.status === "failed" || item.status === "blocked" || item.status === "cancelled";
  return <TimelineFactRow item={item} depth={depth} title={title} titleTooltip={meta ? `${title} · ${meta}` : title} compact statusLabel=""
    icon={<ScanText size={14} aria-hidden="true" />}
    detail={needsDetail && (item.summary || fallback) ? <TextDetail text={item.summary || fallback} cwd={cwd} /> : undefined} />;
}
