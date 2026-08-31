import type { ReactNode } from "react";
import type {
  ConversationTimelineItem,
  ConversationTimelineSubAgentItem,
} from "@ling-stack/conversation-ui-core";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { ConversationCommandBatch } from "../blocks/ConversationCommandBatch.js";
import { ConversationExplorationBatch } from "../blocks/ConversationExplorationBatch.js";
import { ConversationTimelineMessageRenderer } from "./ConversationTimelineMessageRenderer.js";
import { ConversationTimelineReasoningRenderer } from "./ConversationTimelineReasoningRenderer.js";
import { ConversationTimelinePlanRenderer } from "./ConversationTimelinePlanRenderer.js";
import { ConversationTimelineCommandRenderer } from "./ConversationTimelineCommandRenderer.js";
import { ConversationTimelineExplorationRenderer } from "./ConversationTimelineExplorationRenderer.js";
import { ConversationTimelineFileChangeRenderer } from "./ConversationTimelineFileChangeRenderer.js";
import { ConversationTimelineToolRenderer } from "./ConversationTimelineToolRenderer.js";
import { ConversationTimelineApprovalRenderer } from "./ConversationTimelineApprovalRenderer.js";
import { ConversationTimelineImageRenderer } from "./ConversationTimelineImageRenderer.js";
import { ConversationTimelineCompactionRenderer } from "./ConversationTimelineCompactionRenderer.js";
import { ConversationTimelineBlockedRenderer } from "./ConversationTimelineBlockedRenderer.js";

export interface ConversationTimelineRenderContext {
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationTimelineItem["sourceRefs"][number]) => void;
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
  reasoning: renderReasoningItem,
  plan: renderPlanItem,
  commandExecution: renderCommandItem,
  fileChange: renderFileChangeItem,
  exploration: renderExplorationItem,
  mcpToolCall: renderMcpToolItem,
  dynamicToolCall: renderDynamicToolItem,
  collabAgentToolCall: renderCollabAgentToolItem,
  approval: renderApprovalItem,
  imageView: renderImageItem,
  contextCompaction: renderContextCompactionItem,
  diagnostic: renderDiagnosticItem,
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
  return <ConversationTimelineMessageRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} />;
}

function renderReasoningItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "reasoning" ? <ConversationTimelineReasoningRenderer key={item.id} item={item} depth={context.depth} /> : null;
}

function renderPlanItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "plan" ? <ConversationTimelinePlanRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderCommandItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "commandExecution" ? <ConversationTimelineCommandRenderer key={item.id} item={item} depth={context.depth} /> : null;
}

function renderFileChangeItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "fileChange" ? <ConversationTimelineFileChangeRenderer key={item.id} item={item} cwd={context.cwd} loadPreview={context.loadPreview} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderExplorationItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "exploration" ? <ConversationTimelineExplorationRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderMcpToolItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "mcpToolCall" ? <ConversationTimelineToolRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderDynamicToolItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "dynamicToolCall" ? <ConversationTimelineToolRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderCollabAgentToolItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "collabAgentToolCall" ? <ConversationTimelineToolRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderApprovalItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "approval" ? <ConversationTimelineApprovalRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderImageItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "imageView" ? <ConversationTimelineImageRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderContextCompactionItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "contextCompaction" ? <ConversationTimelineCompactionRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderDiagnosticItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "diagnostic" ? <ConversationTimelineBlockedRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
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
          <ConversationTimelineCommandRenderer item={command} depth={context.depth} />
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
        <ConversationTimelineExplorationRenderer key={child.id} item={child} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} />
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
