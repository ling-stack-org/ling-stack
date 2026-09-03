import type { ReactNode } from "react";
import {
  conversationTimelineRendererKey,
  fingerprintConversationTimeline,
  type ConversationTimelineItem,
  type ConversationTimelineSubAgentItem,
  type TimelineSnapshot,
} from "@ling-stack/conversation-ui-core";
import { ChevronDown, CircleAlert, Loader2, UserRound } from "lucide-react";
import { ConversationTimelineBlockedRenderer } from "./ConversationTimelineBlockedRenderer.js";
import { renderConversationTimelineItem } from "./renderer-registry.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";

export interface ConversationTimelineProps {
  /** Immutable, already-scoped canonical/display projection. */
  readonly snapshot: TimelineSnapshot;
  readonly depth: 0 | 1;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly renderMessageChrome?: (item: Extract<ConversationTimelineItem, { kind: "userMessage" | "agentMessage" }>, body: ReactNode) => ReactNode;
  readonly emptyLabel?: ReactNode;
}

/**
 * The only production transcript renderer. It dispatches typed items and owns
 * the single visible nesting composition; it never sorts, groups, fetches, or
 * infers completion from narration.
 */
export function ConversationTimeline({
  snapshot,
  depth,
  cwd,
  onOpenSourceRef,
  renderSubAgentAvatar,
  renderMessageChrome,
  emptyLabel,
  className: customClassName,
  ariaLabel,
}: ConversationTimelineProps): React.JSX.Element {
  const timelineItems = snapshot.items;
  const fingerprint = fingerprintConversationTimeline(timelineItems);
  const effectiveDensity = countAtomicItems(timelineItems) > 10 ? "dense" : "default";
  const className = customClassName ?? `conversation-timeline conversation-timeline-depth-${depth}`;
  const timelineId = `timeline:${snapshot.scope.kind}:${snapshot.scope.threadId}:${snapshot.scope.anchorItemId ?? "root"}`;
  const attrs = {
    "data-conversation-timeline": "true",
    "data-conversation-timeline-id": timelineId,
    "data-conversation-thread-id": snapshot.scope.threadId,
    "data-conversation-timeline-scope": snapshot.scope.kind,
    "data-conversation-timeline-depth": depth,
    "data-conversation-canonical-revision": snapshot.canonicalRevision,
    "data-conversation-sse-cursor": snapshot.sseCursor ?? "none",
    "data-conversation-timeline-renderer-keys": fingerprint.rendererKeys.join(","),
    "data-conversation-timeline-disclosure-count": fingerprint.disclosureCount,
    "data-activity-density": effectiveDensity,
    "aria-label": ariaLabel,
  } as const;

  if (timelineItems.length === 0) {
    return <div className={`${className} empty`} {...attrs}>{emptyLabel ?? ""}</div>;
  }

  return (
    <div className={className} {...attrs}>
      {timelineItems.map((item) => renderTimelineItem(item, {
        cwd,
        onOpenSourceRef,
        renderMessageChrome,
        renderSubAgentAvatar,
        snapshot,
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

type TimelineRenderContext = Pick<ConversationTimelineProps, "cwd" | "onOpenSourceRef" | "renderMessageChrome" | "renderSubAgentAvatar"> & {
  readonly snapshot: TimelineSnapshot;
  readonly depth: 0 | 1;
};

function renderTimelineItem(item: ConversationTimelineItem, context: TimelineRenderContext): ReactNode {
  return renderConversationTimelineItem(item, {
    cwd: context.cwd,
    onOpenSourceRef: context.onOpenSourceRef,
    renderMessageChrome: context.renderMessageChrome,
    depth: context.depth,
    renderSubAgent: (subAgent) => <SubAgentTimelineItem key={subAgent.id} item={subAgent} context={context} />,
  });
}

function SubAgentTimelineItem({
  item,
  context,
}: {
  readonly item: ConversationTimelineSubAgentItem;
  readonly context: TimelineRenderContext;
}): React.JSX.Element {
  if (context.depth === 1) {
    return <ConversationTimelineBlockedRenderer item={nestedDepthExceededDiagnostic(item)} cwd={context.cwd} depth={1} />;
  }

  const statusLabel = subAgentStatusLabel(item.lifecycle);
  const childScope = {
    ...context.snapshot.scope,
    kind: "child" as const,
    anchorItemId: item.itemId ?? context.snapshot.scope.anchorItemId,
    depth: 1 as const,
  };
  const childSnapshot: TimelineSnapshot = {
    ...context.snapshot,
    scope: childScope,
    items: item.childItems,
    activeRun: null,
    canonicalRevision: Math.max(context.snapshot.canonicalRevision, item.revision),
  };

  return (
    <section
      className={["conversation-timeline-sub-agent", `lifecycle-${item.lifecycle}`].join(" ")}
      data-conversation-timeline-sub-agent="true"
      data-conversation-timeline-kind="subAgentActivity"
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey("subAgentActivity")}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? item.lifecycle}
      data-conversation-timeline-depth={context.depth}
      data-conversation-participant-id={item.participantId}
      data-conversation-run-id={item.runId}
      data-conversation-attempt-id={item.attemptId}
      data-conversation-workflow-step-id={item.workflowStepId}
      data-conversation-source-refs={item.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}
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
          snapshot={childSnapshot}
          depth={1}
          cwd={context.cwd}
          onOpenSourceRef={context.onOpenSourceRef}
          renderMessageChrome={context.renderMessageChrome}
          renderSubAgentAvatar={context.renderSubAgentAvatar}
          ariaLabel={`${item.label} activity`}
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
