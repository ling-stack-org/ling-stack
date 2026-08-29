import type { ReactNode } from "react";
import type {
  ConversationTimelineItem,
  ConversationTimelineRowItem,
  ConversationTimelineSubAgentItem,
} from "@ling-stack/conversation-ui-core";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { ConversationCommandBatch } from "../blocks/ConversationCommandBatch.js";
import { ConversationExplorationBatch } from "../blocks/ConversationExplorationBatch.js";
import { ConversationTimelineActivityRenderer } from "./ConversationTimelineActivityRenderer.js";

export interface ConversationTimelineRenderContext {
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationTimelineItem["sourceRefs"][number]) => void;
  readonly renderMessage?: (markdown: string) => ReactNode;
  readonly renderSubAgent: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly depth: 0 | 1;
}

type ConversationTimelineItemRenderer = (
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
) => ReactNode;

/**
 * Exhaustive semantic registry. Adding a timeline kind without a renderer is a
 * compile error; known items never fall through to a generic WorkCell row.
 */
const RENDERERS = {
  userMessage: renderMessageItem,
  agentMessage: renderMessageItem,
  reasoningSummary: renderActivityItem,
  plan: renderActivityItem,
  commandExecution: renderActivityItem,
  fileChange: renderActivityItem,
  exploration: renderActivityItem,
  mcpToolCall: renderActivityItem,
  dynamicToolCall: renderActivityItem,
  collabAgentToolCall: renderActivityItem,
  approval: renderActivityItem,
  imageView: renderActivityItem,
  contextCompaction: renderActivityItem,
  genericActivity: renderActivityItem,
  commandBatch: renderCommandBatchItem,
  explorationBatch: renderExplorationBatchItem,
  subAgentActivity: renderSubAgentItem,
} satisfies Record<ConversationTimelineItem["kind"], ConversationTimelineItemRenderer>;

export function renderConversationTimelineItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  return RENDERERS[item.kind](item, context);
}

function renderMessageItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "agentMessage" && item.kind !== "userMessage") return null;
  return (
    <div
      key={item.id}
      className={`conversation-timeline-message ${item.kind}`}
      data-conversation-timeline-message
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-timeline-depth={context.depth}
    >
      {context.renderMessage ? context.renderMessage(item.markdown) : <p>{item.markdown}</p>}
    </div>
  );
}

function renderActivityItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (!isActivityItem(item)) return null;
  return (
    <ConversationTimelineActivityRenderer
      key={item.id}
      item={item}
      cwd={context.cwd}
      loadPreview={context.loadPreview}
      onOpenSourceRef={context.onOpenSourceRef}
      depth={context.depth}
    />
  );
}

function renderCommandBatchItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "commandBatch") return null;
  return (
    <ConversationCommandBatch
      key={item.id}
      batch={item.batch}
      actionIds={item.actionIds}
      revision={item.revision}
      depth={context.depth}
      renderCommand={(command) => (
        <div key={command.id} className="conversation-command-batch-child">
          {command.leadingItems?.map((leading) => renderConversationTimelineItem(leading, context))}
          <ConversationTimelineActivityRenderer
            item={command}
            cwd={context.cwd}
            loadPreview={context.loadPreview}
            onOpenSourceRef={context.onOpenSourceRef}
            depth={context.depth}
          />
        </div>
      )}
    />
  );
}

function renderExplorationBatchItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "explorationBatch") return null;
  return (
    <ConversationExplorationBatch
      key={item.id}
      batch={item.batch}
      actionIds={item.actionIds}
      revision={item.revision}
      depth={context.depth}
      renderItem={(child) => (
        <ConversationTimelineActivityRenderer
          key={child.id}
          item={child}
          cwd={context.cwd}
          loadPreview={context.loadPreview}
          onOpenSourceRef={context.onOpenSourceRef}
          depth={context.depth}
        />
      )}
    />
  );
}

function renderSubAgentItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  return item.kind === "subAgentActivity" ? context.renderSubAgent(item) : null;
}

function isActivityItem(item: ConversationTimelineItem): item is ConversationTimelineRowItem {
  return item.kind !== "userMessage" &&
    item.kind !== "agentMessage" &&
    item.kind !== "commandBatch" &&
    item.kind !== "explorationBatch" &&
    item.kind !== "subAgentActivity";
}
