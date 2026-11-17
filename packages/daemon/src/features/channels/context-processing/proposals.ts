import type {
  Channel,
  ChannelMessage,
  ChannelProtocolSourceRef,
  RunStore,
} from "@ling-stack/core";
import {
  buildLingAgentTurnEnvelope,
  renderLingAgentTurnEnvelopeForPrompt,
  type LingAgentTurnEnvelope,
} from "../ling-agent-turn-envelope.js";
import {
  collectActiveWorkSources,
  collectChannelStateSource,
  collectMaterializedInputSources,
  collectTurnSource,
} from "./sources.js";
import { buildProjectedConversationContextSlice } from "./conversation-context-adapter.js";
import { assessChannelContextViewSourceQuoteEligibility } from "./quote-eligibility.js";
import { contextViewLineageKey } from "./context-view-lineage.js";
import type { ChannelContextSection, ChannelContextSourceRef, ChannelContextView } from "./types.js";
import { buildChannelContextView } from "./views.js";

export interface BuildWorkflowProposalContextViewInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  /** Startup rehydration supplies the persisted identity and skips the write-back. */
  readonly viewId?: string;
  readonly persistLineage?: boolean;
}

export function buildWorkflowProposalContextView(input: BuildWorkflowProposalContextViewInput): ChannelContextView {
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const turnSource = collectTurnSource({ channel: input.channel, envelope });
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "proposal",
  });
  const activeWorkSources = collectActiveWorkSources({
    store: input.store,
    channel: input.channel,
    threadId: projectedContext.projection.metadata.threadId,
    limit: 8,
  });
  const materializedInputSources = collectMaterializedInputSources({ channel: input.channel, envelope });
  const sections: readonly ChannelContextSection[] = [
    {
      id: "proposal_current_turn",
      role: "user",
      priority: "must_keep",
      compactionSurvival: "summarize",
      title: "Current proposal turn",
      text: [`Channel: ${input.channel.name}`, "Latest user turn:", renderLingAgentTurnEnvelopeForPrompt(envelope)].join("\n"),
      sourceRefIds: [input.sourceMessage.id, input.channel.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    ...projectedContext.sections,
    {
      id: "proposal_active_work",
      role: "evidence",
      priority: "medium",
      compactionSurvival: "discard",
      title: "Active work",
      text: activeWorkSources.length > 0
        ? ["Active work:", ...activeWorkSources.map((source) => `${source.title} (${String(source.metadata.entityType ?? source.kind)}:${String(source.metadata.status ?? "unknown")})`)].join("\n")
        : "Active work: none",
      sourceRefIds: activeWorkSources.flatMap((source) => source.sourceRefs.map((ref) => ref.id)),
      visibility: "inspect_only",
      quotePolicy: "inspect_only",
    },
  ];
  return buildChannelContextView({
    kind: "workflow_proposal_view",
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    sections,
    sourceRefs: [
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: input.sourceMessage.id, label: "Proposal source message" },
      ...projectedContext.sourceRefs,
    ],
    contextProjection: projectedContext.projection.metadata,
    ...(input.viewId ? { viewId: input.viewId } : {}),
    ...(input.persistLineage === false ? {} : {
      lineage: {
        store: input.store,
        lineageKey: contextViewLineageKey({
          workspaceId: input.channel.workspaceId,
          channelId: input.channel.id,
          threadId: projectedContext.projection.metadata.threadId,
          sourceItemId: input.sourceMessage.id,
          kind: "workflow_proposal_view",
        }),
        sourceItemId: input.sourceMessage.id,
      },
    }),
    sources: [
      collectChannelStateSource({ channel: input.channel }),
      turnSource,
      ...materializedInputSources,
      ...projectedContext.sources,
      ...activeWorkSources,
    ],
  });
}

export function proposalSourceRefsFromContextView(view: ChannelContextView): readonly ChannelProtocolSourceRef[] {
  return uniqueProtocolSourceRefs(
    view.sourceRefs.flatMap((ref) => {
      if (assessChannelContextViewSourceQuoteEligibility({ view, sourceRef: ref }).status !== "eligible") {
        return [];
      }
      const mapped = protocolSourceRefFromContextSourceRef(ref);
      return mapped ? [mapped] : [];
    }),
  );
}

function protocolSourceRefFromContextSourceRef(ref: ChannelContextSourceRef): ChannelProtocolSourceRef | undefined {
  if (ref.type === "conversation_item") {
    return {
      type: "message",
      id: ref.id,
      ...(ref.label ? { label: ref.label } : {}),
    };
  }
  if (
    ref.type !== "message" &&
    ref.type !== "run" &&
    ref.type !== "workflow" &&
    ref.type !== "workflow_step" &&
    ref.type !== "context_summary" &&
    ref.type !== "channel_decision"
  ) {
    return undefined;
  }
  return {
    type: ref.type,
    id: ref.id,
    ...(ref.label ? { label: ref.label } : {}),
  };
}

function uniqueProtocolSourceRefs(refs: readonly ChannelProtocolSourceRef[]): readonly ChannelProtocolSourceRef[] {
  const seen = new Set<string>();
  const unique: ChannelProtocolSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
