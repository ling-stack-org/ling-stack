import type { ReactNode } from "react";
import {
  type ConversationTimelineItem,
  type ConversationTimelineSubAgentItem,
} from "@ling-stack/conversation-ui-core";
import { ChevronDown, CircleAlert, Loader2, UserRound } from "lucide-react";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { renderConversationTimelineItem } from "./renderer-registry.js";

export interface ConversationTimelineProps {
  /** Renderer-facing items. Historical rows are projected before this boundary. */
  readonly items: readonly ConversationTimelineItem[];
  readonly scope?: "primary" | "agent";
  readonly className?: string;
  readonly dataDensity?: "default" | "dense";
  readonly ariaLabel?: string;
  readonly dataConversationWorkStream?: "primary" | "agent";
  readonly depth?: 0 | 1;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationTimelineItem["sourceRefs"][number]) => void;
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
  cwd,
  loadPreview,
  onOpenSourceRef,
  renderMessage,
  renderSubAgentAvatar,
  emptyLabel,
  className: customClassName,
  dataDensity = "default",
  ariaLabel,
  dataConversationWorkStream,
  depth = 0,
}: ConversationTimelineProps): React.JSX.Element {
  const timelineItems = items;
  const className = customClassName ?? (scope === "agent"
    ? "conversation-work-cell-agent-stream conversation-timeline"
    : "conversation-work-cell-active-stream conversation-timeline");

  if (timelineItems.length === 0) {
    return (
      <div className={`${className} empty`} data-conversation-timeline="true" data-conversation-scope={scope} data-conversation-timeline-scope={scope} data-conversation-timeline-depth={depth} data-conversation-work-stream={dataConversationWorkStream} data-activity-density={dataDensity} aria-label={ariaLabel}>
        {emptyLabel ?? ""}
      </div>
    );
  }

  return (
    <div className={className} data-conversation-timeline="true" data-conversation-scope={scope} data-conversation-timeline-scope={scope} data-conversation-timeline-depth={depth} data-conversation-work-stream={dataConversationWorkStream} data-activity-density={dataDensity} aria-label={ariaLabel}>
      {timelineItems.map((item) => renderTimelineItem(item, {
        cwd,
        loadPreview,
        onOpenSourceRef,
        renderMessage,
        renderSubAgentAvatar,
        scope,
        depth,
      }))}
    </div>
  );
}

function renderTimelineItem(
  item: ConversationTimelineItem,
  context: Pick<ConversationTimelineProps, "cwd" | "loadPreview" | "onOpenSourceRef" | "renderMessage" | "renderSubAgentAvatar" | "scope" | "depth">,
): ReactNode {
  return renderConversationTimelineItem(item, {
    cwd: context.cwd,
    loadPreview: context.loadPreview,
    onOpenSourceRef: context.onOpenSourceRef,
    renderMessage: context.renderMessage,
    depth: context.depth ?? 0,
    renderSubAgent: (subAgent) => <SubAgentTimelineItem key={subAgent.id} item={subAgent} context={context} />,
  });
}

function SubAgentTimelineItem({
  item,
  context,
}: {
  readonly item: ConversationTimelineSubAgentItem;
  readonly context: Pick<ConversationTimelineProps, "cwd" | "loadPreview" | "onOpenSourceRef" | "renderMessage" | "renderSubAgentAvatar" | "scope" | "depth">;
}): React.JSX.Element {
  const statusLabel = subAgentStatusLabel(item.lifecycle);
  return (
    <section
      className={["conversation-timeline-sub-agent", `lifecycle-${item.lifecycle}`].join(" ")}
      data-conversation-timeline-sub-agent="true"
      data-conversation-timeline-kind="subAgentActivity"
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? item.lifecycle}
      data-conversation-timeline-depth={context.depth}
      data-conversation-participant-id={item.participantId}
      data-conversation-run-id={item.runId}
      data-conversation-attempt-id={item.attemptId}
      data-conversation-workflow-step-id={item.workflowStepId}
      data-conversation-source-refs={item.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}
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
          cwd={context.cwd}
          loadPreview={context.loadPreview}
          onOpenSourceRef={context.onOpenSourceRef}
          renderMessage={context.renderMessage}
          renderSubAgentAvatar={context.renderSubAgentAvatar}
          depth={1}
        />
      ) : null}
    </section>
  );
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
