import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  conversationTimelineRendererKey,
} from "@ling-stack/conversation-ui-core";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineRowItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";

export interface TimelineFactRowProps {
  readonly item: ConversationTimelineRowItem;
  readonly title: string;
  readonly titleTooltip?: string;
  readonly statusLabel?: string;
  readonly compact?: boolean;
  readonly defaultExpanded?: boolean;
  readonly meta?: ReactNode;
  readonly icon: ReactNode;
  readonly detail?: ReactNode;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
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
  titleTooltip,
  statusLabel,
  compact = false,
  defaultExpanded,
  meta,
  icon,
  detail,
  depth = 0,
}: TimelineFactRowProps): React.JSX.Element {
  const { t } = useI18n();
  const hasDetail = Boolean(detail);
  const disclosure = useConversationBlockView({
    blockId: `timeline-item:${item.id}`,
    revisionKey: String(item.revision),
    defaultExpanded: defaultExpanded ?? (item.status === "running" || item.status === "waiting" ||
      item.status === "blocked" || item.status === "failed" || item.status === "cancelled" || item.status === "partially_succeeded"),
    preserveTouchedStateOnRevision: true,
  });
  const expanded = hasDetail && disclosure.expanded;
  const status = statusLabel ?? timelineStatusLabel(item.status, t);
  const visibleStatus = compact && item.status === "succeeded" ? undefined : status;
  const visibleMeta = meta !== undefined ? meta : compact ? undefined : item.meta;
  const detailId = `conversation-timeline-detail-${domSafeId(item.id)}`;

  return (
    <article
      className={["conversation-timeline-activity", `kind-${item.kind}`, compact ? "compact" : "", item.status ? `status-${item.status}` : "", expanded ? "expanded" : ""].filter(Boolean).join(" ")}
      data-conversation-timeline-activity
      data-conversation-timeline-item={item.kind}
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey(item.kind)}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-item-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-thread-sequence={item.threadSequence}
      data-conversation-timeline-part-index={item.partIndex}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-turn-id={item.turnId}
      data-conversation-diagnostic-code={item.kind === "diagnostic" ? item.code : undefined}
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
          aria-controls={detailId}
          aria-label={`${title}${status ? ` · ${status}` : ""}. ${expanded ? t("Collapse details") : t("Expand details")}`}
          onClick={disclosure.toggleExpanded}
        >
          <StatusAwareIcon item={item} icon={icon} />
          <span className="conversation-timeline-activity-copy">
            <strong title={titleTooltip ?? title}>{title}</strong>
            {visibleMeta ? <small>{visibleMeta}</small> : null}
          </span>
          {visibleStatus ? <span className="conversation-timeline-activity-status">{visibleStatus}</span> : null}
          <span className="conversation-timeline-activity-chevron" aria-hidden="true">⌄</span>
        </button>
      ) : (
        <div className="conversation-timeline-activity-main static">
          <StatusAwareIcon item={item} icon={icon} />
          <span className="conversation-timeline-activity-copy">
            <strong title={titleTooltip ?? title}>{title}</strong>
            {visibleMeta ? <small>{visibleMeta}</small> : null}
          </span>
          {visibleStatus ? <span className="conversation-timeline-activity-status">{visibleStatus}</span> : null}
        </div>
      )}
      {expanded ? (
        <div id={detailId} className="conversation-timeline-activity-detail">
          {detail}
        </div>
      ) : null}
    </article>
  );
}

function StatusAwareIcon({ item, icon }: { readonly item: ConversationTimelineRowItem; readonly icon: ReactNode }): React.JSX.Element {
  if (item.status === "failed" || item.status === "blocked" || item.status === "partially_succeeded") return <CircleAlert size={14} aria-hidden="true" />;
  return <>{icon}</>;
}

export function timelineStatusLabel(
  status: ConversationTimelineRowItem["status"],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (!status) return undefined;
  const labels: Record<NonNullable<ConversationTimelineRowItem["status"]>, string> = {
    pending: t("Pending"), running: t("Working"), waiting: t("Waiting"), blocked: t("Blocked"), failed: t("Failed"), cancelled: t("Cancelled"), partially_succeeded: t("Partially completed"), succeeded: t("Succeeded"),
  };
  return labels[status];
}

function serializeSourceRefs(refs: readonly ConversationOperationSourceRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.id}`).join(",");
}

function domSafeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/gu, "-");
}
