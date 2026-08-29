import type { ReactNode } from "react";
import {
  isConversationTimelineItem,
  projectConversationTimelineItems,
  type ConversationTimelineItem,
  type ConversationTimelineInput,
  type ConversationTimelineProjectionOptions,
  type ConversationTimelineSubAgentItem,
} from "@ling-stack/conversation-ui-core";
import type { ConversationWorkCellRow } from "@ling-stack/conversation-ui-core";
import { ChevronDown, CircleAlert, Loader2, UserRound } from "lucide-react";
import { renderConversationTimelineItem } from "./renderer-registry.js";

export interface ConversationTimelineProps {
  /** Existing WorkCell items are accepted during the migration; they are projected once. */
  readonly items: readonly ConversationTimelineInput[];
  readonly scope?: "primary" | "agent";
  readonly className?: string;
  readonly dataDensity?: "default" | "dense";
  readonly ariaLabel?: string;
  readonly dataConversationWorkStream?: "primary" | "agent";
  readonly projectionOptions?: ConversationTimelineProjectionOptions;
  readonly renderRow: (row: ConversationWorkCellRow, options?: { readonly leading?: boolean }) => ReactNode;
  readonly renderMessage?: (markdown: string) => ReactNode;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly emptyLabel?: ReactNode;
}

/**
 * One renderer boundary for normal, private, channel, and nested-agent operation
 * streams. Surface components provide data and row callbacks; this component owns item
 * dispatch, batching, and nested timeline composition.
 */
export function ConversationTimeline({
  items,
  scope = "primary",
  projectionOptions,
  renderRow,
  renderMessage,
  renderSubAgentAvatar,
  emptyLabel,
  className: customClassName,
  dataDensity = "default",
  ariaLabel,
  dataConversationWorkStream,
}: ConversationTimelineProps): React.JSX.Element {
  const timelineItems = projectItems(items, projectionOptions);
  const className = customClassName ?? (scope === "agent"
    ? "conversation-work-cell-agent-stream conversation-timeline"
    : "conversation-work-cell-active-stream conversation-timeline");

  if (timelineItems.length === 0) {
    return (
      <div className={`${className} empty`} data-conversation-timeline data-conversation-timeline-scope={scope} data-conversation-work-stream={dataConversationWorkStream} data-activity-density={dataDensity} aria-label={ariaLabel}>
        {emptyLabel ?? ""}
      </div>
    );
  }

  return (
    <div className={className} data-conversation-timeline data-conversation-timeline-scope={scope} data-conversation-work-stream={dataConversationWorkStream} data-activity-density={dataDensity} aria-label={ariaLabel}>
      {timelineItems.map((item) => renderTimelineItem(item, {
        renderRow,
        renderMessage,
        renderSubAgentAvatar,
        scope,
        projectionOptions,
      }))}
    </div>
  );
}

function renderTimelineItem(
  item: ConversationTimelineItem,
  context: Pick<ConversationTimelineProps, "renderRow" | "renderMessage" | "renderSubAgentAvatar" | "scope" | "projectionOptions">,
): ReactNode {
  return renderConversationTimelineItem(item, {
    renderRow: context.renderRow,
    renderMessage: context.renderMessage,
    renderSubAgent: (subAgent) => <SubAgentTimelineItem key={subAgent.id} item={subAgent} context={context} />,
  });
}

function SubAgentTimelineItem({
  item,
  context,
}: {
  readonly item: ConversationTimelineSubAgentItem;
  readonly context: Pick<ConversationTimelineProps, "renderRow" | "renderMessage" | "renderSubAgentAvatar" | "scope" | "projectionOptions">;
}): React.JSX.Element {
  const statusLabel = subAgentStatusLabel(item.lifecycle);
  return (
    <section
      className={["conversation-timeline-sub-agent", `lifecycle-${item.lifecycle}`].join(" ")}
      data-conversation-timeline-sub-agent
      data-agent-participant-id={item.participantId}
      aria-label={`${item.label} ${statusLabel}`}
    >
      <header className="conversation-timeline-sub-agent-head">
        <span className="conversation-timeline-sub-agent-icon" aria-hidden="true">
          {context.renderSubAgentAvatar?.(item) ?? <UserRound size={14} />}
        </span>
        <strong>{item.label}</strong>
        <span className="conversation-timeline-sub-agent-status">
          {item.lifecycle === "running" ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
          {item.lifecycle === "blocked" || item.lifecycle === "errored" ? <CircleAlert size={12} aria-hidden="true" /> : null}
          {statusLabel}
        </span>
        {item.childItems.length > 0 ? <ChevronDown size={12} aria-hidden="true" /> : null}
      </header>
      {item.childItems.length > 0 ? (
        <ConversationTimeline
          items={item.childItems}
          scope="agent"
          projectionOptions={item.participantId ? { ...context.projectionOptions, participantScope: item.participantId } : context.projectionOptions}
          renderRow={context.renderRow}
          renderMessage={context.renderMessage}
          renderSubAgentAvatar={context.renderSubAgentAvatar}
        />
      ) : null}
    </section>
  );
}

function projectItems(
  items: ConversationTimelineProps["items"],
  options?: ConversationTimelineProjectionOptions,
): readonly ConversationTimelineItem[] {
  if (items.length === 0) {
    return [];
  }
  if (items.every(isConversationTimelineItem)) {
    return items as readonly ConversationTimelineItem[];
  }
  return projectConversationTimelineItems(items, options);
}

function subAgentStatusLabel(lifecycle: ConversationTimelineSubAgentItem["lifecycle"]): string {
  const labels: Record<ConversationTimelineSubAgentItem["lifecycle"], string> = {
    started: "Started",
    running: "Working",
    waiting: "Waiting",
    interrupted: "Interrupted",
    completed: "Completed",
    blocked: "Blocked",
    errored: "Failed",
  };
  return labels[lifecycle];
}
