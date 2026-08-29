import type { ReactNode } from "react";
import type {
  ConversationTimelineItem,
  ConversationTimelineSubAgentItem,
} from "@ling-stack/conversation-ui-core";
import type { ConversationWorkCellRow } from "@ling-stack/conversation-ui-core";
import { ConversationCommandBatch } from "../blocks/ConversationCommandBatch.js";
import { ConversationExplorationBatch } from "../blocks/ConversationExplorationBatch.js";

export interface ConversationTimelineRenderContext {
  readonly renderRow: (row: ConversationWorkCellRow, options?: { readonly leading?: boolean }) => ReactNode;
  readonly renderMessage?: (markdown: string) => ReactNode;
  readonly renderSubAgent: (item: ConversationTimelineSubAgentItem) => ReactNode;
}

type ConversationTimelineItemRenderer = (
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
) => ReactNode;

/**
 * The shared semantic renderer registry. Surface components provide callbacks,
 * while this module owns the item-kind dispatch so a normal, private, channel,
 * and nested-agent item cannot silently acquire different row semantics.
 */
const RENDERERS: ReadonlyMap<ConversationTimelineItem["kind"], ConversationTimelineItemRenderer> = new Map([
  ["commandBatch", (item, context) => {
    if (item.kind !== "commandBatch") return null;
    return (
      <ConversationCommandBatch
        key={item.id}
        batch={item.batch}
        renderCommand={(command) => [
          ...(command.leadingRows ?? []).map((row) => context.renderRow(row, { leading: true })),
          context.renderRow(command.row),
        ]}
      />
    );
  }],
  ["explorationBatch", (item, context) => {
    if (item.kind !== "explorationBatch") return null;
    return (
      <ConversationExplorationBatch
        key={item.id}
        batch={item.batch}
        renderRow={(row) => context.renderRow(row)}
      />
    );
  }],
  ["subAgentActivity", (item, context) => item.kind === "subAgentActivity" ? context.renderSubAgent(item) : null],
  ["agentMessage", renderMessageItem],
  ["userMessage", renderMessageItem],
]);

export function renderConversationTimelineItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  const renderer = RENDERERS.get(item.kind);
  if (renderer) {
    return renderer(item, context);
  }
  return "row" in item
    ? <span key={item.id} data-conversation-timeline-kind={item.kind}>{context.renderRow(item.row)}</span>
    : null;
}

function renderMessageItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "agentMessage" && item.kind !== "userMessage") {
    return null;
  }
  return (
    <div key={item.id} className={`conversation-timeline-message ${item.kind}`} data-conversation-timeline-message>
      {context.renderMessage ? context.renderMessage(item.markdown) : <p>{item.markdown}</p>}
    </div>
  );
}
