import { ChevronDown, CircleAlert } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { formatElapsedDuration } from "../../../lib/formatting.js";
import type { ConversationTimelineProcessHeaderDisplayRow } from "./conversation-timeline-display-model.js";
import "./conversation-process-disclosure.css";
import { ConversationActivityLabel } from "../feedback/ConversationActivityLabel.js";
import { summarizeTimelineProcess } from "./timeline-process-summary.js";

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
  const facts = row.process.status === "completed" ? summarizeTimelineProcess(row.process.items) : undefined;
  const summary = facts ? [
    facts.reads ? t("Read {count} times", { count: facts.reads }) : undefined,
    facts.explorations ? t("Explored {count} times", { count: facts.explorations }) : undefined,
    facts.changedFiles ? t("Changed {count} files", { count: facts.changedFiles }) : undefined,
    facts.commands ? t("Ran {count} commands", { count: facts.commands }) : undefined,
    facts.tools ? t("Called {count} tools", { count: facts.tools }) : undefined,
  ].filter(Boolean).join(" · ") : "";
  const title = [summary || label, duration].filter(Boolean).join(" · ");
  return <button type="button" className="conversation-process-header"
    data-conversation-process-header={row.process.id} data-conversation-process-status={row.process.status}
    aria-expanded={row.expanded} aria-controls={row.expanded ? row.groupId : undefined}
    aria-label={`${summary ? `${label}. ` : ""}${title}. ${row.expanded ? t("Collapse details") : t("Expand details")}`}
    onClick={() => onExpandedChange(!row.expanded)}>
    {row.process.status === "attention" ? <CircleAlert size={13} aria-hidden="true" /> : null}
    <ConversationActivityLabel active={row.process.status === "running" && !row.expanded}>{title}</ConversationActivityLabel>
    <ChevronDown size={13} className={row.expanded ? "expanded" : ""} aria-hidden="true" />
  </button>;
}
