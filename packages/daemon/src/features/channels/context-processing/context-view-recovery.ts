import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import {
  projectConversationItemToChannelMessage,
  type ConversationContextViewLineage,
  type RunStore,
} from "@ling-stack/core";
import {
  buildConversationContextProjection,
  type ConversationContextProjection,
  type ConversationContextProjectionView,
} from "./conversation-context-projector.js";
import { buildChannelProtocolContextSection } from "../context-packs.js";
import { buildPrivateChatContextView } from "./private-chat.js";
import { buildWorkflowProposalContextView } from "./proposals.js";
import { buildWorkflowStepContextView } from "./workflow-steps.js";
import { fingerprintContextViewShape } from "./context-view-lineage.js";
import type { ChannelContextSection, ChannelContextView } from "./types.js";

export type ContextViewLineageRecoveryStatus =
  | "current"
  | "reconstructed"
  | "stale"
  | "blocked"
  | "unsupported";

export interface ContextViewLineageRecoveryEntry {
  readonly lineageKey: string;
  readonly kind: string;
  readonly status: ContextViewLineageRecoveryStatus;
  readonly contextViewId: string;
  readonly projection?: ConversationContextProjection;
  /** A full surface view is returned only when it can be rebuilt from durable sources. */
  readonly view?: ChannelContextView;
  readonly reason?: string;
}

export interface ContextViewLineageRecoveryReport {
  readonly scanned: number;
  readonly current: number;
  readonly reconstructed: number;
  readonly stale: number;
  readonly blocked: number;
  readonly unsupported: number;
  readonly entries: readonly ContextViewLineageRecoveryEntry[];
}

/**
 * Rebuilds the canonical conversation projection from durable messages,
 * assignments, summaries and visibility policy after a daemon restart. The
 * worker never rewrites lineage here: a changed projection must be reviewed by
 * the next Host-owned materialization, so an active Run cannot silently adopt a
 * different context under the same contextViewId.
 */
export function reconcileContextViewLineagesAtStartup(input: {
  readonly store: RunStore;
  readonly workspaceId?: string;
  readonly limit?: number;
}): ContextViewLineageRecoveryReport {
  const lineages = input.store.listConversationContextViewLineages({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const entries: ContextViewLineageRecoveryEntry[] = [];
  for (const lineage of lineages) {
    entries.push(reconcileLineage(input.store, lineage));
  }
  return {
    scanned: entries.length,
    current: entries.filter((entry) => entry.status === "current").length,
    reconstructed: entries.filter((entry) => entry.status === "reconstructed").length,
    stale: entries.filter((entry) => entry.status === "stale").length,
    blocked: entries.filter((entry) => entry.status === "blocked").length,
    unsupported: entries.filter((entry) => entry.status === "unsupported").length,
    entries,
  };
}

function reconcileLineage(
  store: Parameters<typeof buildConversationContextProjection>[0]["store"],
  lineage: ConversationContextViewLineage,
): ContextViewLineageRecoveryEntry {
  const base = {
    lineageKey: lineage.lineageKey,
    kind: lineage.kind,
    contextViewId: lineage.contextViewId,
  } as const;

  if (lineage.kind === "private_chat_view") {
    return reconcilePrivateChatLineage(store, lineage, base);
  }

  const projectionView = projectionViewForLineageKind(lineage.kind);
  if (!projectionView) {
    return { ...base, status: "unsupported", reason: "view_kind_has_no_rebuild_contract" };
  }
  if (!lineage.sourceItemId || !lineage.projection) {
    return { ...base, status: "blocked", reason: "projection_lineage_missing_source" };
  }

  try {
    const projection = buildConversationContextProjection({
      store,
      sourceItemId: lineage.sourceItemId,
      view: projectionView,
      ...(lineage.consumerTeammateId ? { consumerTeammateId: lineage.consumerTeammateId } : {}),
    });
    const status = sameProjectionMetadata(projection.metadata, lineage.projection)
      ? "current"
      : projection.metadata.throughItemSequence < lineage.projection.throughItemSequence
        ? "stale"
        : "reconstructed";
    const surface = rehydrateSurfaceView(store, lineage);
    if (surface.status === "blocked") {
      return { ...base, status: "blocked", projection, reason: surface.reason };
    }
    const view = surface.view;
    const viewMatches = !surface.compareFingerprint
      || (view ? fingerprintContextViewShape(view) === lineage.viewFingerprint : true);
    const finalStatus = status === "stale"
      ? status
      : viewMatches ? status : "reconstructed";
    return {
      ...base,
      status: finalStatus,
      projection,
      ...(view ? { view } : {}),
      ...(!viewMatches
        ? { reason: "durable_view_shape_changed" }
        : status === "stale" ? { reason: "durable_projection_changed" } : {}),
    };
  } catch (error) {
    return { ...base, status: "blocked", reason: safeRecoveryReason(error) };
  }
}

function reconcilePrivateChatLineage(
  store: Parameters<typeof buildConversationContextProjection>[0]["store"],
  lineage: ConversationContextViewLineage,
  base: Pick<ContextViewLineageRecoveryEntry, "lineageKey" | "kind" | "contextViewId">,
): ContextViewLineageRecoveryEntry {
  if (!lineage.threadId || !lineage.sourceItemId || !lineage.consumerTeammateId) {
    return { ...base, status: "blocked", reason: "private_lineage_missing_scope" };
  }
  const thread = store.listTeammateDirectThreads({ teammateId: lineage.consumerTeammateId, limit: 500 })
    .find((candidate) => candidate.id === lineage.threadId);
  if (!thread) return { ...base, status: "blocked", reason: "private_thread_missing" };
  const source = store.listTeammateDirectMessages({
    teammateId: lineage.consumerTeammateId,
    threadId: lineage.threadId,
    limit: 500,
  }).find((message) => message.id === lineage.sourceItemId);
  if (!source) return { ...base, status: "blocked", reason: "private_source_message_missing" };
  const teammate = store.getAiTeammate(lineage.consumerTeammateId);
  if (!teammate) return { ...base, status: "blocked", reason: "private_teammate_missing" };
  try {
    const messages = store.listTeammateDirectMessages({
      teammateId: lineage.consumerTeammateId,
      threadId: lineage.threadId,
      limit: 500,
    });
    const attachments = new Map(store.listTeammatePrivateAttachments({
      teammateId: lineage.consumerTeammateId,
      threadId: lineage.threadId,
      limit: 500,
    }).map((attachment) => [attachment.id, attachment] as const));
    const linkPreviews = new Map(store.listTeammateDirectLinkPreviews({
      teammateId: lineage.consumerTeammateId,
      threadId: lineage.threadId,
      limit: 500,
    }).map((preview) => [preview.id, preview] as const));
    const view = buildPrivateChatContextView({
      store,
      teammate,
      thread,
      messages,
      sourceMessage: source,
      attachmentsById: attachments,
      // Attachment bodies are materialized by the active request owner. A
      // restart must never guess or read them as a side effect.
      materializationsByAttachmentId: new Map(),
      viewId: lineage.contextViewId,
      persistLineage: false,
      now: lineage.contextViewCreatedAt,
    });
    const viewMatches = fingerprintContextViewShape(view) === lineage.viewFingerprint;
    return {
      ...base,
      status: viewMatches ? "current" : "reconstructed",
      view,
      ...(viewMatches ? {} : { reason: "durable_view_shape_changed" }),
    };
  } catch (error) {
    return { ...base, status: "blocked", reason: safeRecoveryReason(error) };
  }
}

function rehydrateSurfaceView(
  store: RunStore,
  lineage: ConversationContextViewLineage,
): {
  readonly status: "available";
  readonly view?: ChannelContextView;
  readonly compareFingerprint: boolean;
} | { readonly status: "blocked"; readonly reason: string } {
  try {
    switch (lineage.kind) {
      case "workflow_proposal_view": {
        if (!lineage.sourceItemId) return { status: "blocked", reason: "proposal_lineage_missing_source" };
        const item = store.getEffectiveConversationItem(lineage.sourceItemId);
        if (!item) return { status: "blocked", reason: "proposal_source_message_missing" };
        const sourceMessage = projectConversationItemToChannelMessage(item);
        const channel = store.getChannel(lineage.channelId ?? sourceMessage.channelId);
        if (!channel) return { status: "blocked", reason: "proposal_channel_missing" };
        return {
          status: "available",
          compareFingerprint: true,
          view: buildWorkflowProposalContextView({
            store,
            channel,
            sourceMessage,
            viewId: lineage.contextViewId,
            persistLineage: false,
            turnEnvelope: undefined,
          }),
        };
      }
      case "workflow_step_view":
        return rehydrateWorkflowStepView(store, lineage);
      default:
        // Channel reply and selector views are projection-owned here. Their
        // prompt-specific envelope is rebuilt by the next Host request.
        return {
          status: "available",
          compareFingerprint: false,
        };
    }
  } catch (error) {
    return { status: "blocked", reason: safeRecoveryReason(error) };
  }
}

function rehydrateWorkflowStepView(
  store: RunStore,
  lineage: ConversationContextViewLineage,
): {
  readonly status: "available";
  readonly view: ChannelContextView;
  readonly compareFingerprint: true;
} | { readonly status: "blocked"; readonly reason: string } {
  if (!lineage.threadId) return { status: "blocked", reason: "workflow_lineage_missing_thread" };
  const thread = store.getLingThread(lineage.threadId);
  const workflowId = thread?.workflowId;
  const stepId = thread?.workflowStepId;
  const directWorkflow = workflowId ? store.getChannelWorkflow(workflowId) : undefined;
  const candidateWorkflows = directWorkflow
    ? [directWorkflow]
    : lineage.channelId
      ? store.listChannelWorkflows({ channelId: lineage.channelId, limit: 500 })
      : [];
  const directStep = stepId ? store.getChannelWorkflowStep(stepId) : undefined;
  const resolved = directStep
    ? { workflow: directWorkflow ?? store.getChannelWorkflow(directStep.workflowId), step: directStep }
    : candidateWorkflows
      .map((candidate) => ({
        workflow: candidate,
        step: store.listChannelWorkflowSteps({ workflowId: candidate.id, complete: true })
          .find((workflowStep) => workflowStep.metadata?.sourceMessageId === lineage.sourceItemId),
      }))
      .find((candidate): candidate is { workflow: NonNullable<typeof candidate.workflow>; step: NonNullable<typeof candidate.step> } => Boolean(candidate.step));
  const workflow = resolved?.workflow;
  const step = resolved?.step;
  if (!workflow || !step) return { status: "blocked", reason: "workflow_step_missing" };
  const channel = store.getChannel(lineage.channelId ?? workflow.channelId);
  if (!channel) return { status: "blocked", reason: "workflow_channel_missing" };
  const protocol = buildChannelProtocolContextSection({ store, channel });
  const protocolSection: ChannelContextSection = {
    id: protocol.id,
    role: protocol.role,
    priority: protocol.priority,
    compactionSurvival: protocol.compactionSurvival ?? "rebuild",
    title: protocol.id,
    text: protocol.text,
    sourceRefIds: protocol.sourceRefIds ?? [],
    visibility: "prompt",
    quotePolicy: "public_ok",
    ...(protocol.estimatedTokens === undefined ? {} : { estimatedTokens: protocol.estimatedTokens }),
    ...(protocol.metadata ? { metadata: protocol.metadata } : {}),
  };
  return {
    status: "available",
    compareFingerprint: true,
    view: buildWorkflowStepContextView({
      store,
      channel,
      workflow,
      step,
      prompt: step.prompt,
      providerPresetId: step.metadata?.providerPresetId,
      consumerTeammateId: lineage.consumerTeammateId ?? step.toParticipantId,
      workflowSteps: store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true }),
      protocolSection,
      viewId: lineage.contextViewId,
      persistLineage: false,
    }),
  };
}

function projectionViewForLineageKind(kind: string): ConversationContextProjectionView | undefined {
  switch (kind) {
    case "ling_agent_channel_view": return "reply";
    case "specialist_task_view": return "specialist";
    case "selector_view": return "selector";
    case "workflow_proposal_view": return "proposal";
    case "workflow_step_view": return "workflow_step";
    case "evidence_inspect_view": return "inspect";
    default: return undefined;
  }
}

function sameProjectionMetadata(
  left: ConversationContextProjectionMetadata,
  right: ConversationContextProjectionMetadata,
): boolean {
  return left.projectionVersion === right.projectionVersion
    && left.sourceStateFingerprint === right.sourceStateFingerprint
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.segmentId === right.segmentId
    && left.throughItemSequence === right.throughItemSequence
    && left.visibilityFingerprint === right.visibilityFingerprint
    && left.policyVersion === right.policyVersion;
}

function safeRecoveryReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.replace(/[\r\n\t]/g, " ").slice(0, 240);
  }
  return "durable_projection_rebuild_failed";
}
