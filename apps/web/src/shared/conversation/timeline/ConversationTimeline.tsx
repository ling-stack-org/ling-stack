import type { ReactNode } from "react";
import {
  type ConversationTimelineItem,
  type ConversationTimelineSubAgentItem,
  type ConversationInteractionPolicy,
} from "@ling-stack/conversation-ui-core";
import { ChevronDown, CircleAlert, Loader2, UserRound } from "lucide-react";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { ConversationTimelineBlockedRenderer } from "./ConversationTimelineBlockedRenderer.js";
import { renderConversationTimelineItem } from "./renderer-registry.js";

export interface ConversationTimelineProps {
  /** Renderer-facing items. Historical rows are projected before this boundary. */
  readonly items: readonly ConversationTimelineItem[];
  readonly policy: ConversationInteractionPolicy;
  readonly className?: string;
  readonly timelineId?: string;
  readonly threadId?: string;
  readonly sourceKind?: string;
  readonly activityMode?: "active" | "completed";
  readonly dataDensity?: "default" | "dense";
  readonly ariaLabel?: string;
  readonly depth?: 0 | 1;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationTimelineItem["sourceRefs"][number]) => void;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly emptyLabel?: ReactNode;
}

/**
 * One renderer boundary for normal, private, channel, and nested-agent operation
 * streams. Surface components provide data and row callbacks; this component owns item
 * dispatch, disclosure, and nested timeline composition. Items are projected and
 * display-batched before this boundary; this component never sorts or groups facts.
 */
export function ConversationTimeline({
  items,
  policy,
  cwd,
  loadPreview,
  onOpenSourceRef,
  renderSubAgentAvatar,
  emptyLabel,
  className: customClassName,
  timelineId,
  threadId,
  sourceKind,
  activityMode,
  dataDensity = "default",
  ariaLabel,
  depth = 0,
}: ConversationTimelineProps): React.JSX.Element {
  const timelineItems = items;
  // Density is owned by the shared timeline. Callers may force a mode, but the
  // default derives from the atomic facts after reversible display batching.
  const effectiveDensity = dataDensity === "default" && countAtomicItems(timelineItems) > 10
    ? "dense"
    : dataDensity;
  const className = customClassName ?? `conversation-timeline conversation-timeline-depth-${depth}`;
  const timelineScope = depth === 1 ? "child" : "primary";

  if (timelineItems.length === 0) {
    return (
      <div className={`${className} empty`} data-conversation-timeline="true" data-conversation-timeline-id={timelineId} data-conversation-thread-id={threadId} data-conversation-source-kind={sourceKind} data-conversation-activity-mode={activityMode} data-conversation-surface={policy.surface} data-conversation-timeline-scope={timelineScope} data-conversation-timeline-depth={depth} data-activity-density={effectiveDensity} aria-label={ariaLabel}>
        {emptyLabel ?? ""}
      </div>
    );
  }

  return (
    <div className={className} data-conversation-timeline="true" data-conversation-timeline-id={timelineId} data-conversation-thread-id={threadId} data-conversation-source-kind={sourceKind} data-conversation-activity-mode={activityMode} data-conversation-surface={policy.surface} data-conversation-timeline-scope={timelineScope} data-conversation-timeline-depth={depth} data-activity-density={effectiveDensity} aria-label={ariaLabel}>
      {timelineItems.map((item) => renderTimelineItem(item, {
        cwd,
        loadPreview,
        onOpenSourceRef,
        renderSubAgentAvatar,
        policy,
        depth,
      }))}
    </div>
  );
}

function countAtomicItems(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((count, item) => {
    if (item.kind === "commandBatch") return count + item.batch.commands.length;
    if (item.kind === "explorationBatch") return count + item.batch.children.length;
    if (item.kind === "subAgentActivity") return count + 1 + countAtomicItems(item.childItems);
    return count + 1;
  }, 0);
}

function renderTimelineItem(
  item: ConversationTimelineItem,
  context: Pick<ConversationTimelineProps, "cwd" | "loadPreview" | "onOpenSourceRef" | "renderSubAgentAvatar" | "policy" | "depth">,
): ReactNode {
  return renderConversationTimelineItem(item, {
    cwd: context.cwd,
    loadPreview: context.loadPreview,
    onOpenSourceRef: context.onOpenSourceRef,
    policy: context.policy,
    depth: context.depth ?? 0,
    renderSubAgent: (subAgent) => <SubAgentTimelineItem key={subAgent.id} item={subAgent} context={context} />,
  });
}

function SubAgentTimelineItem({
  item,
  context,
}: {
  readonly item: ConversationTimelineSubAgentItem;
  readonly context: Pick<ConversationTimelineProps, "cwd" | "loadPreview" | "onOpenSourceRef" | "renderSubAgentAvatar" | "policy" | "depth">;
}): React.JSX.Element {
  // Child timelines are intentionally capped at one visible nesting level. A
  // malformed/replayed payload may still contain a nested participant span;
  // preserve its lineage as a diagnostic instead of mounting a third timeline.
  if (context.depth === 1) {
    return (
      <ConversationTimelineBlockedRenderer
        item={nestedDepthExceededDiagnostic(item)}
        cwd={context.cwd}
        depth={1}
      />
    );
  }
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
          policy={context.policy}
          cwd={context.cwd}
          loadPreview={context.loadPreview}
          onOpenSourceRef={context.onOpenSourceRef}
          renderSubAgentAvatar={context.renderSubAgentAvatar}
          timelineId={item.id}
          sourceKind="participant"
          activityMode={item.lifecycle === "completed" ? "completed" : "active"}
          depth={1}
        />
      ) : null}
    </section>
  );
}

function nestedDepthExceededDiagnostic(
  item: ConversationTimelineSubAgentItem,
): import("@ling-stack/conversation-ui-core").ConversationTimelineDiagnosticItem {
  return {
    id: `diagnostic:nested-depth:${item.id}`,
    kind: "diagnostic",
    code: "nested_depth_exceeded",
    revision: item.revision,
    threadSequence: item.threadSequence,
    partIndex: item.partIndex,
    status: "blocked",
    turnId: item.turnId,
    itemId: item.itemId,
    ...(item.actionId ? { actionId: item.actionId } : {}),
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.attemptId ? { attemptId: item.attemptId } : {}),
    participantId: item.participantId,
    workflowStepId: item.workflowStepId,
    sourceRefs: item.sourceRefs,
    title: "Nested Agent activity unavailable",
    description: "Nested Agent activity is hidden beyond the visible depth limit.",
    summary: "Nested Agent activity is hidden beyond the visible depth limit.",
    diagnosticRef: item.sourceRefs[0],
  };
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
