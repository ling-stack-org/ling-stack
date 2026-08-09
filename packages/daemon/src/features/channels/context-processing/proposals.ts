import type {
  ApprovalStoreFacet,
  Channel,
  ChannelMessage,
  ChannelProtocolSourceRef,
  ChannelStoreFacet,
  RunExecutionStoreFacet,
  RunStore,
  RunStorePathsFacet,
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
  collectPriorConversationSources,
  collectTurnSource,
} from "./sources.js";
import type { ChannelContextSection, ChannelContextSourceRef, ChannelContextView } from "./types.js";
import { buildChannelContextView } from "./views.js";

type WorkflowProposalContextStore = ChannelStoreFacet & RunExecutionStoreFacet & ApprovalStoreFacet & RunStorePathsFacet & Pick<RunStore, "getLingTurn">;

export interface BuildWorkflowProposalContextViewInput {
  readonly store: WorkflowProposalContextStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
}

export function buildWorkflowProposalContextView(input: BuildWorkflowProposalContextViewInput): ChannelContextView {
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const turnSource = collectTurnSource({ channel: input.channel, envelope });
  const priorSources = collectPriorConversationSources({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    limit: 6,
  });
  const activeWorkSources = collectActiveWorkSources({
    store: input.store,
    channel: input.channel,
    limit: 8,
  });
  const materializedInputSources = collectMaterializedInputSources({ channel: input.channel, envelope });
  const sections: readonly ChannelContextSection[] = [
    {
      id: "proposal_current_turn",
      role: "user",
      priority: "must_keep",
      title: "Current proposal turn",
      text: [`Channel: ${input.channel.name}`, "Latest user turn:", renderLingAgentTurnEnvelopeForPrompt(envelope)].join("\n"),
      sourceRefIds: [input.sourceMessage.id, input.channel.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "proposal_recent_context",
      role: "evidence",
      priority: "high",
      title: "Recent channel context",
      text: priorSources.length > 0
        ? ["Recent channel context:", ...priorSources.map((source) => `${source.title}: ${truncateSourceText(source.text)}`)].join("\n")
        : "Recent channel context: none",
      sourceRefIds: priorSources.flatMap((source) => source.sourceRefs.map((ref) => ref.id)),
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "proposal_active_work",
      role: "evidence",
      priority: "medium",
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
    ],
    sources: [
      collectChannelStateSource({ channel: input.channel }),
      turnSource,
      ...materializedInputSources,
      ...priorSources,
      ...activeWorkSources,
    ],
  });
}

export function proposalSourceRefsFromContextView(view: ChannelContextView): readonly ChannelProtocolSourceRef[] {
  return uniqueProtocolSourceRefs(
    view.sourceRefs.flatMap((ref) => {
      const mapped = protocolSourceRefFromContextSourceRef(ref);
      return mapped ? [mapped] : [];
    }),
  );
}

function protocolSourceRefFromContextSourceRef(ref: ChannelContextSourceRef): ChannelProtocolSourceRef | undefined {
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

function truncateSourceText(text: string | undefined): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "[empty]";
  }
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}
