import { ChevronDown, CircleAlert, Loader2 } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { formatElapsedDuration } from "../../../lib/formatting.js";
import type { ConversationTimelineProcessHeaderDisplayRow } from "./conversation-timeline-display-model.js";
import "./conversation-process-disclosure.css";

/** A view-only process entrance, never a second final answer or execution fact. */
export function ConversationTimelineProcessHeader({ row, onExpandedChange }: {
  readonly row: ConversationTimelineProcessHeaderDisplayRow;
  readonly onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const label = row.process.status === "running" ? t("Working")
    : row.process.status === "completed" ? t("Completed")
      : row.process.status === "attention" ? t("Needs attention") : t("Execution details");
  const duration = formatElapsedDuration(row.process.durationMs, locale);
  const title = duration ? `${label} · ${duration}` : label;
  return <button type="button" className="conversation-process-header"
    data-conversation-process-header={row.process.id} data-conversation-process-status={row.process.status}
    aria-expanded={row.expanded} aria-controls={row.expanded ? row.groupId : undefined}
    aria-label={`${title}. ${row.expanded ? t("Collapse details") : t("Expand details")}`}
    onClick={() => onExpandedChange(!row.expanded)}>
    {row.process.status === "running" ? <Loader2 size={13} className="spin" aria-hidden="true" />
      : row.process.status === "attention" ? <CircleAlert size={13} aria-hidden="true" /> : null}
    <span>{title}</span><ChevronDown size={13} className={row.expanded ? "expanded" : ""} aria-hidden="true" />
  </button>;
}
