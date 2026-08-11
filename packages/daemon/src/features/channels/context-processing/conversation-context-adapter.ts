import type { ConversationDomainRef, ConversationItemV1 } from "@ling-stack/contracts";
import type { Channel, RunStore } from "@ling-stack/core";
import {
  buildConversationContextProjection,
  projectConversationContextMessages,
  type ConversationContextProjection,
  type ConversationContextProjectionView,
} from "./conversation-context-projector.js";
import { collectRecentConversationSources } from "./sources.js";
import type {
  ChannelContextSection,
  ChannelContextSource,
} from "./types.js";

const PROJECTED_ITEM_BODY_CHARS = 1_200;

export interface ProjectedConversationContextSlice {
  readonly projection: ConversationContextProjection;
  readonly sections: readonly ChannelContextSection[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly sources: readonly ChannelContextSource[];
}

export function buildProjectedConversationContextSlice(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceItemId: string;
  readonly view: ConversationContextProjectionView;
  readonly consumerTeammateId?: string;
  readonly explicitItemIds?: readonly string[];
  readonly minimal?: boolean;
}): ProjectedConversationContextSlice {
  const projection = buildConversationContextProjection({
    store: input.store,
    sourceItemId: input.sourceItemId,
    view: input.view,
    consumerTeammateId: input.consumerTeammateId,
    maxTailTextChars: input.minimal ? 2_048 : undefined,
    explicitItemIds: input.explicitItemIds,
  });
  const contextItems = projection.items.filter((item) => item.id !== input.sourceItemId);
  const summarySection = buildProjectionSharedCoreSection(projection);
  const itemSection: ChannelContextSection | undefined = contextItems.length > 0 ? {
    id: "conversation_projection_items",
    role: "evidence",
    priority: "high",
    title: "Conversation projection items",
    text: [
      "Conversation context selected by Continuity v2 for the current segment:",
      "Use these source-linked items to resolve follow-ups. Do not infer facts from unrelated segments.",
      ...contextItems.map(formatProjectedConversationItem),
    ].join("\n\n"),
    sourceRefIds: contextItems.map((item) => item.id),
    visibility: "prompt",
    quotePolicy: "public_ok",
    metadata: {
      projectionVersion: projection.metadata.projectionVersion,
      segmentId: projection.metadata.segmentId,
    },
  } : undefined;
  const projectedMessages = projectConversationContextMessages(projection, input.store)
    .filter((message) => message.id !== input.sourceItemId);
  return {
    projection,
    sections: [summarySection, itemSection].filter((section): section is ChannelContextSection => Boolean(section)),
    sourceRefs: projection.metadata.sourceRefs,
    sources: projectedMessages.length > 0
      ? collectRecentConversationSources({
          workspaceId: input.channel.workspaceId,
          channelId: input.channel.id,
          messages: projectedMessages,
          limit: projectedMessages.length,
        })
      : [],
  };
}

function buildProjectionSharedCoreSection(
  projection: ConversationContextProjection,
): ChannelContextSection | undefined {
  const lines = [
    renderProjectionFacts("Objectives", projection.sharedCore.objectives),
    renderProjectionFacts("Confirmed decisions", projection.sharedCore.decisions),
    renderProjectionFacts("Constraints", projection.sharedCore.constraints),
    renderProjectionFacts("Open questions", projection.sharedCore.openQuestions),
    projection.sharedCore.activeWorkRefs.length > 0
      ? `Active work refs:\n${projection.sharedCore.activeWorkRefs.map((ref) => `- ${ref.type}:${ref.id}`).join("\n")}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return {
    id: "conversation_projection_shared_core",
    role: "evidence",
    priority: "high",
    title: "Conversation projection shared core",
    text: [
      `Shared context core for segment ${projection.segment.label ?? projection.segment.id}:`,
      ...lines,
    ].join("\n\n"),
    sourceRefIds: projection.metadata.summaryIds,
    visibility: "prompt",
    quotePolicy: "public_ok",
    metadata: {
      projectionVersion: projection.metadata.projectionVersion,
      segmentId: projection.metadata.segmentId,
    },
  };
}

function renderProjectionFacts(label: string, values: readonly string[]): string | undefined {
  return values.length > 0 ? `${label}:\n${values.map((value) => `- ${value}`).join("\n")}` : undefined;
}

function formatProjectedConversationItem(item: ConversationItemV1): string {
  return [
    `Item ${item.id} (sequence=${item.sequence}, kind=${item.kind}, actor=${item.actorType})`,
    truncateProjectedItemBody(projectedConversationItemBody(item), PROJECTED_ITEM_BODY_CHARS),
  ].join("\n");
}

function projectedConversationItemBody(item: ConversationItemV1): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
      return item.payload.body;
    case "tool_call":
      return item.payload.inputSummary ?? item.payload.title ?? item.payload.toolName;
    case "tool_result":
      return item.payload.outputSummary ?? item.payload.errorCode ?? item.payload.status;
    case "approval_request":
      return item.payload.summary ?? item.payload.title;
    case "approval_decision":
      return item.payload.reason ?? item.payload.decision;
    case "handoff":
      return item.payload.summary;
    case "operation_state":
      return item.payload.summary ?? item.payload.title;
    case "artifact_ref":
      return item.payload.title ?? item.payload.artifactId;
    case "system_event":
      return item.payload.summary;
  }
}

function truncateProjectedItemBody(body: string, maxLength: number): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxLength) {
    return trimmed || "[empty]";
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 48))}\n[truncated projected conversation item]`;
}
