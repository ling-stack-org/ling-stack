import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineRowItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export interface TimelineFactRowProps {
  readonly item: ConversationTimelineRowItem;
  readonly title: string;
  readonly icon: ReactNode;
  readonly detail?: ReactNode;
  readonly cwd?: string;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
  readonly depth?: 0 | 1;
}

/**
 * The only factual row shell used by every typed renderer. It owns disclosure,
 * stable identity and status presentation; semantic renderers only provide the
 * title, icon and bounded detail body.
 */
export function TimelineFactRow({
  item,
  title,
  icon,
  detail,
  depth = 0,
}: TimelineFactRowProps): React.JSX.Element {
  const { t } = useI18n();
  const hasDetail = Boolean(detail);
  const disclosure = useConversationBlockView({
    blockId: `timeline-item:${item.id}`,
    revisionKey: String(item.revision),
    defaultExpanded: item.status === "running" || item.status === "waiting" ||
      item.status === "blocked" || item.status === "failed",
    preserveTouchedStateOnRevision: true,
  });
  const expanded = hasDetail && disclosure.expanded;
  const status = timelineStatusLabel(item.status, t);

  return (
    <div
      className={["conversation-timeline-activity", `kind-${item.kind}`, item.status ? `status-${item.status}` : "", expanded ? "expanded" : ""].filter(Boolean).join(" ")}
      data-conversation-timeline-activity
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-item-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-timeline-depth={depth}
      data-conversation-action-id={item.actionId}
      data-conversation-run-id={item.runId}
      data-conversation-attempt-id={item.attemptId}
      data-conversation-work-unit-id={item.workUnitId}
      data-conversation-workflow-step-id={item.workflowStepId}
      data-conversation-participant-id={item.participantId}
      data-conversation-source-refs={serializeSourceRefs(item.sourceRefs)}
    >
      {hasDetail ? (
        <button
          className="conversation-timeline-activity-main"
          type="button"
          aria-expanded={expanded}
          aria-label={`${title}${status ? ` · ${status}` : ""}. ${expanded ? t("Collapse details") : t("Expand details")}`}
          onClick={disclosure.toggleExpanded}
        >
          <StatusAwareIcon item={item} icon={icon} />
          <span className="conversation-timeline-activity-copy">
            <strong>{title}</strong>
            {item.meta ? <small>{item.meta}</small> : null}
          </span>
          {status ? <span className="conversation-timeline-activity-status">{status}</span> : null}
          <span className="conversation-timeline-activity-chevron" aria-hidden="true">⌄</span>
        </button>
      ) : (
        <div className="conversation-timeline-activity-main static">
          <StatusAwareIcon item={item} icon={icon} />
          <span className="conversation-timeline-activity-copy">
            <strong>{title}</strong>
            {item.meta ? <small>{item.meta}</small> : null}
          </span>
          {status ? <span className="conversation-timeline-activity-status">{status}</span> : null}
        </div>
      )}
      {expanded ? <div className="conversation-timeline-activity-detail">{detail}</div> : null}
    </div>
  );
}

function StatusAwareIcon({ item, icon }: { readonly item: ConversationTimelineRowItem; readonly icon: ReactNode }): React.JSX.Element {
  if (item.status === "failed" || item.status === "blocked") return <CircleAlert size={14} aria-hidden="true" />;
  if (item.status === "succeeded") return <CheckCircle2 size={14} aria-hidden="true" />;
  return <>{icon}</>;
}

export function timelineStatusLabel(
  status: ConversationTimelineRowItem["status"],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (!status) return undefined;
  const labels: Record<NonNullable<ConversationTimelineRowItem["status"]>, string> = {
    pending: t("Pending"), running: t("Running"), waiting: t("Waiting"), blocked: t("Blocked"), failed: t("Failed"), cancelled: t("Cancelled"), succeeded: t("Done"),
  };
  return labels[status];
}

function serializeSourceRefs(refs: readonly ConversationOperationSourceRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.id}`).join(",");
}
