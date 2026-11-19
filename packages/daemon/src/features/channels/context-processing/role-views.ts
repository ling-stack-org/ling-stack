import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import { buildChannelProtocolContextSection } from "../context-packs.js";
import {
  buildLingAgentTurnEnvelope,
  renderLingAgentTurnEnvelopeForPrompt,
} from "../ling-agent-turn-envelope.js";
import {
  collectActiveWorkSources,
  collectChannelStateSource,
  collectMaterializedInputSources,
  collectTurnSource,
} from "./sources.js";
import { buildProjectedConversationContextSlice } from "./conversation-context-adapter.js";
import { contextViewLineageKey } from "./context-view-lineage.js";
import { buildChannelContextView } from "./views.js";
import type { ChannelContextSection, ChannelContextSourceRef, ChannelContextView } from "./types.js";

export interface RoleContextViewBaseInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  /** Startup recovery supplies the persisted identity and skips the write-back. */
  readonly viewId?: string;
  readonly persistLineage?: boolean;
}

export interface BuildSpecialistTaskContextViewInput extends RoleContextViewBaseInput {
  readonly consumerTeammateId: string;
}

/**
 * Rebuilds the role-scoped task envelope from durable turn data. The role view
 * deliberately uses the specialist projection, so private items are admitted
 * only for the exact consumer and historical channel transcript is not copied
 * wholesale into the task prompt.
 */
export function buildSpecialistTaskContextView(
  input: BuildSpecialistTaskContextViewInput,
): ChannelContextView {
  const envelope = buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "specialist",
    consumerTeammateId: input.consumerTeammateId,
  });
  const protocol = buildChannelProtocolContextSection({ store: input.store, channel: input.channel });
  const protocolSection = channelSectionFromContextSection(protocol);
  const activeWorkSources = collectActiveWorkSources({
    store: input.store,
    channel: input.channel,
    threadId: projectedContext.projection.metadata.threadId,
    limit: 12,
  });
  const sections: readonly ChannelContextSection[] = [
    {
      id: "specialist_task_boundary",
      role: "instruction",
      priority: "must_keep",
      compactionSurvival: "rebuild",
      title: "specialist_task_boundary",
      text: [
        "Specialist task boundary:",
        "Work only on the current specialist task.",
        "Do not approve, publish, deploy, or broaden the requested scope.",
        "Return a concise result, evidence references, blockers, and follow-up decisions.",
      ].join("\n"),
      sourceRefIds: [],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    {
      id: "specialist_task_envelope",
      role: "user",
      priority: "must_keep",
      compactionSurvival: "summarize",
      title: "specialist_task_envelope",
      text: [
        `Channel: ${input.channel.name}`,
        `Consumer teammate: ${input.consumerTeammateId}`,
        "Current task turn:",
        renderLingAgentTurnEnvelopeForPrompt(envelope),
      ].join("\n"),
      sourceRefIds: [input.channel.id, input.sourceMessage.id],
      visibility: "prompt",
      quotePolicy: "public_ok",
    },
    ...projectedContext.sections,
    ...(activeWorkSources.length > 0 ? [{
      id: "specialist_active_work",
      role: "evidence" as const,
      priority: "medium" as const,
      compactionSurvival: "summarize" as const,
      title: "specialist_active_work",
      text: [
        "Related active work:",
        ...activeWorkSources.map((source) =>
          `- ${source.title} (${String(source.metadata.entityType ?? source.kind)}:${String(source.metadata.status ?? "unknown")})`),
      ].join("\n"),
      sourceRefIds: activeWorkSources.flatMap((source) => source.sourceRefs.map((ref) => ref.id)),
      visibility: "prompt" as const,
      quotePolicy: "influence_only" as const,
    }] : []),
    protocolSection,
  ];
  return buildChannelContextView({
    kind: "specialist_task_view",
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    consumerTeammateId: input.consumerTeammateId,
    sections,
    sourceRefs: uniqueRefs([
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: input.sourceMessage.id, label: "Specialist task source" },
      ...projectedContext.sourceRefs,
    ]),
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
          kind: "specialist_task_view",
          consumerTeammateId: input.consumerTeammateId,
        }),
        threadId: projectedContext.projection.metadata.threadId,
        sourceItemId: input.sourceMessage.id,
      },
    }),
    sources: [
      collectChannelStateSource({ channel: input.channel, text: protocolSection.text, metadata: protocolSection.metadata }),
      collectTurnSource({ channel: input.channel, envelope }),
      ...collectMaterializedInputSources({ channel: input.channel, envelope }),
      ...projectedContext.sources,
      ...activeWorkSources,
    ],
  });
}

export interface BuildEvidenceInspectContextViewInput extends RoleContextViewBaseInput {
  readonly consumerTeammateId?: string;
}

/**
 * Rebuilds the operator inspect envelope with bounded projection text and
 * metadata only. Raw artifact bodies and private teammate content are never
 * inferred during restart; visibility is enforced by the inspect projection.
 */
export function buildEvidenceInspectContextView(
  input: BuildEvidenceInspectContextViewInput,
): ChannelContextView {
  const envelope = buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "inspect",
    ...(input.consumerTeammateId ? { consumerTeammateId: input.consumerTeammateId } : {}),
  });
  const activeWorkSources = collectActiveWorkSources({
    store: input.store,
    channel: input.channel,
    threadId: projectedContext.projection.metadata.threadId,
    limit: 16,
  });
  const sections: readonly ChannelContextSection[] = [
    {
      id: "inspect_metadata",
      role: "evidence",
      priority: "must_keep",
      compactionSurvival: "rebuild",
      title: "inspect_metadata",
      text: JSON.stringify({
        projectionVersion: projectedContext.projection.metadata.projectionVersion,
        sourceStateFingerprint: projectedContext.projection.metadata.sourceStateFingerprint,
        threadId: projectedContext.projection.metadata.threadId,
        turnId: projectedContext.projection.metadata.turnId,
        segmentId: projectedContext.projection.metadata.segmentId,
        throughItemSequence: projectedContext.projection.metadata.throughItemSequence,
        summaryIds: projectedContext.projection.metadata.summaryIds,
        sourceRefCount: projectedContext.projection.metadata.sourceRefs.length,
      }),
      sourceRefIds: projectedContext.projection.metadata.sourceRefs.map((ref) => ref.id),
      visibility: "prompt",
      quotePolicy: "inspect_only",
    },
    {
      id: "inspect_current_turn",
      role: "user",
      priority: "high",
      compactionSurvival: "summarize",
      title: "inspect_current_turn",
      text: renderLingAgentTurnEnvelopeForPrompt(envelope),
      sourceRefIds: [input.sourceMessage.id],
      visibility: "prompt",
      quotePolicy: "inspect_only",
    },
    ...projectedContext.sections.map((section) => ({
      ...section,
      visibility: "prompt" as const,
      quotePolicy: "inspect_only" as const,
    })),
    ...(activeWorkSources.length > 0 ? [{
      id: "inspect_active_work",
      role: "evidence" as const,
      priority: "low" as const,
      compactionSurvival: "discard" as const,
      title: "inspect_active_work",
      text: [
        "Related active work metadata:",
        ...activeWorkSources.map((source) =>
          `- ${source.title} (${String(source.metadata.entityType ?? source.kind)}:${String(source.metadata.status ?? "unknown")})`),
      ].join("\n"),
      sourceRefIds: activeWorkSources.flatMap((source) => source.sourceRefs.map((ref) => ref.id)),
      visibility: "prompt" as const,
      quotePolicy: "inspect_only" as const,
    }] : []),
  ];
  return buildChannelContextView({
    kind: "evidence_inspect_view",
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    ...(input.consumerTeammateId ? { consumerTeammateId: input.consumerTeammateId } : {}),
    sections,
    sourceRefs: uniqueRefs([
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: input.sourceMessage.id, label: "Inspect source" },
      ...projectedContext.sourceRefs,
    ]),
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
          kind: "evidence_inspect_view",
          ...(input.consumerTeammateId ? { consumerTeammateId: input.consumerTeammateId } : {}),
        }),
        threadId: projectedContext.projection.metadata.threadId,
        sourceItemId: input.sourceMessage.id,
      },
    }),
    sources: [
      collectChannelStateSource({ channel: input.channel }),
      collectTurnSource({ channel: input.channel, envelope }),
      ...collectMaterializedInputSources({ channel: input.channel, envelope }),
      ...projectedContext.sources,
      ...activeWorkSources,
    ],
  });
}

function channelSectionFromContextSection(input: {
  readonly id: string;
  readonly role: "system" | "instruction" | "user" | "memory" | "evidence";
  readonly priority: "must_keep" | "high" | "medium" | "low";
  readonly compactionSurvival?: "rebuild" | "summarize" | "discard";
  readonly text: string;
  readonly sourceRefIds?: readonly string[];
  readonly estimatedTokens?: number;
  readonly metadata?: Record<string, unknown>;
}): ChannelContextSection {
  return {
    id: input.id,
    role: input.role,
    priority: input.priority,
    compactionSurvival: input.compactionSurvival ?? "rebuild",
    title: input.id,
    text: input.text,
    sourceRefIds: input.sourceRefIds ?? [],
    visibility: "prompt",
    quotePolicy: "public_ok",
    ...(input.estimatedTokens === undefined ? {} : { estimatedTokens: input.estimatedTokens }),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function uniqueRefs(refs: readonly ChannelContextSourceRef[]): readonly ChannelContextSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
