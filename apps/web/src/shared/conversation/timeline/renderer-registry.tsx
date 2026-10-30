import type { ReactNode } from "react";
import type {
  ConversationTimelineItem,
  ConversationProtocolAction,
  ConversationTimelineSubAgentItem,
  ConversationTimelineUserInputItem,
  ConversationTimelineScopeKind,
} from "@ling-stack/conversation-ui-core";
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
import { ConversationTimelineDiagnosticRenderer } from "./ConversationTimelineDiagnosticRenderer.js";
import { ConversationTimelineProtocolRenderer } from "./ConversationTimelineProtocolRenderer.js";
import { ConversationTimelineTerminalReportRenderer } from "./ConversationTimelineTerminalReportRenderer.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { ConversationTimelineUserInputRenderer } from "./ConversationTimelineUserInputRenderer.js";
import type { ConversationTimelineBatchDisclosure } from "./conversation-timeline-display-model.js";
import type { ConversationTimelineMessagePresentation } from "./timeline-response-presentation.js";
import type { UserInputAnswerAcceptedResponseV1, UserInputAnswerCommandV1 } from "../../../types.js";

export interface ConversationTimelineRenderContext {
  readonly scopeKind?: ConversationTimelineScopeKind;
  readonly renderUserInputAvatar?: (item: ConversationTimelineUserInputItem) => ReactNode;
  readonly onSubmitUserInputAnswer?: (
    command: UserInputAnswerCommandV1,
  ) => Promise<UserInputAnswerAcceptedResponseV1>;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
  readonly onInvokeProtocolAction?: (
    item: Extract<ConversationTimelineItem, { kind: "protocolEvent" | "approval" }>,
    action: ConversationProtocolAction,
  ) => void | Promise<void>;
  readonly renderMessageChrome?: (item: Extract<ConversationTimelineItem, { kind: "userMessage" | "agentMessage" }>, body: ReactNode, presentation: ConversationTimelineMessagePresentation) => ReactNode;
  readonly messagePresentation?: ConversationTimelineMessagePresentation;
  readonly hasResponseNarration?: boolean;
  readonly renderSubAgent: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly depth: 0 | 1;
  readonly batchDisclosure?: ConversationTimelineBatchDisclosure;
  readonly onBatchExpandedChange?: (expanded: boolean) => void;
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
  userInputRequest: renderUserInputItem,
  userInputAnswer: renderUserInputItem,
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
  terminalReport: renderTerminalReportItem,
  protocolEvent: renderProtocolEventItem,
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
  return <ConversationTimelineMessageRenderer key={item.id} item={item} cwd={context.cwd} renderChrome={context.renderMessageChrome} presentation={context.messagePresentation} depth={context.depth} />;
}

function renderReasoningItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "reasoning" ? <ConversationTimelineReasoningRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderUserInputItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "userInputRequest" || item.kind === "userInputAnswer"
    ? <ConversationTimelineUserInputRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth}
        scopeKind={context.scopeKind} renderAvatar={context.renderUserInputAvatar}
        onSubmitAnswer={context.onSubmitUserInputAnswer} /> : null;
}

function renderPlanItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "plan" ? <ConversationTimelinePlanRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
}

function renderCommandItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "commandExecution" ? <ConversationTimelineCommandRenderer key={item.id} item={item} depth={context.depth} onOpenSourceRef={context.onOpenSourceRef} /> : null;
}

function renderFileChangeItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "fileChange" ? <ConversationTimelineFileChangeRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} /> : null;
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
  return item.kind === "approval" ? <ConversationTimelineApprovalRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} onInvokeProtocolAction={context.onInvokeProtocolAction} depth={context.depth} /> : null;
}

function renderImageItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "imageView" ? <ConversationTimelineImageRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderContextCompactionItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "contextCompaction" ? <ConversationTimelineCompactionRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderTerminalReportItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "terminalReport" ? <ConversationTimelineTerminalReportRenderer key={item.id} item={item} cwd={context.cwd} onOpenSourceRef={context.onOpenSourceRef} depth={context.depth} hasNarration={context.hasResponseNarration} /> : null;
}

function renderDiagnosticItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "diagnostic" ? <ConversationTimelineDiagnosticRenderer key={item.id} item={item} cwd={context.cwd} depth={context.depth} /> : null;
}

function renderProtocolEventItem(item: ConversationTimelineItem, context: ConversationTimelineRenderContext): ReactNode {
  return item.kind === "protocolEvent"
    ? <ConversationTimelineProtocolRenderer key={item.id} item={item} onInvokeProtocolAction={context.onInvokeProtocolAction} depth={context.depth} />
    : null;
}

function renderCommandBatchItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "commandBatch" || !context.batchDisclosure || !context.onBatchExpandedChange) return null;
  return (
    <ConversationCommandBatch
      key={item.id}
      batch={item.batch}
      actionIds={item.actionIds}
      revision={item.revision}
      depth={context.depth}
      disclosure={context.batchDisclosure}
      onExpandedChange={context.onBatchExpandedChange}
    />
  );
}

function renderExplorationBatchItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  if (item.kind !== "explorationBatch" || !context.batchDisclosure || !context.onBatchExpandedChange) return null;
  return (
    <ConversationExplorationBatch
      key={item.id}
      batch={item.batch}
      actionIds={item.actionIds}
      revision={item.revision}
      depth={context.depth}
      disclosure={context.batchDisclosure}
      onExpandedChange={context.onBatchExpandedChange}
    />
  );
}

function renderSubAgentItem(
  item: ConversationTimelineItem,
  context: ConversationTimelineRenderContext,
): ReactNode {
  return item.kind === "subAgentActivity" ? context.renderSubAgent(item) : null;
}
