import { ChevronDown, CircleAlert, FilePenLine, Globe, Search, SquareTerminal, Wrench } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { formatElapsedDuration } from "../../../lib/formatting.js";
import type { ConversationTimelineProcessHeaderDisplayRow } from "./conversation-timeline-display-model.js";
import "./conversation-process-disclosure.css";
import { summarizeTimelineProcess, timelineActivityCategory } from "./timeline-process-summary.js";

const activityIcons = { tool: Wrench, edit: FilePenLine, search: Search, web: Globe, command: SquareTerminal };

/** A view-only process entrance, never a second final answer or execution fact. */
export function ConversationTimelineProcessHeader({ row, onExpandedChange }: {
  readonly row: ConversationTimelineProcessHeaderDisplayRow;
  readonly onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const activity = row.process.presentation === "activity";
  const duration = formatElapsedDuration(row.process.durationMs, locale);
  const facts = activity ? summarizeTimelineProcess(row.process.items) : undefined;
  const summary = facts ? [
    facts.toolLoads ? t("Loaded tools") : undefined,
    facts.tools ? t("Called tools") : undefined,
    facts.changedFiles === 1 ? t("Edited a file") : facts.changedFiles ? t("Edited files") : undefined,
    facts.reads ? t("Read files") : undefined,
    facts.explorations ? t("Searched files") : undefined,
    facts.commands ? t("Ran commands") : undefined,
    facts.webSearches ? t("Searched the web") : undefined,
  ].filter(Boolean).join(" · ") : "";
  const title = activity ? summary || t("Execution details")
    : row.process.status === "attention" ? t("Needs attention")
      : duration ? t("Worked for {duration}", { duration }) : t("Execution details");
  const category = facts ? timelineActivityCategory(facts) : undefined;
  const Icon = category ? activityIcons[category] : Wrench;
  return <button type="button" className={`conversation-process-header presentation-${row.process.presentation}`}
    data-conversation-process-header={row.process.id} data-conversation-process-status={row.process.status}
    data-conversation-process-presentation={row.process.presentation}
    data-conversation-activity-category={category}
    aria-expanded={row.expanded} aria-controls={row.expanded ? row.groupId : undefined}
    aria-label={`${title}. ${row.expanded ? t("Collapse details") : t("Expand details")}`}
    onClick={() => onExpandedChange(!row.expanded)}>
    {row.process.status === "attention" ? <CircleAlert size={13} aria-hidden="true" /> : null}
    {activity ? <Icon size={14} aria-hidden="true" /> : null}
    <span>{title}</span>
    <ChevronDown size={13} className={row.expanded ? "expanded" : ""} aria-hidden="true" />
  </button>;
}
