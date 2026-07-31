import type {
  AiTeammate,
  Channel,
  ChannelMessage,
  ChannelMessageRouteAlternative,
  ChannelMessageRouteContextPackMetadata,
  ChannelMessageRouteDecisionCreatedBy,
  ChannelMessageRouteDecisionStatus,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import { resolveEffectiveTeammateProviderPresetId } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";
import { compactChannelDiscussionForNoToolsRetry, isContextLengthError } from "./context-compaction.js";
import {
  buildChannelAutoRouteContextPack,
  buildChannelReplyContextPack,
  renderContextPack,
  type ChannelAutoRouteCandidateContext,
  type ContextPack,
} from "./context-packs.js";
import { createLingAgentExecutor, LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import {
  buildLingAgentTurnEnvelope,
  turnEnvelopeHasUserInput,
  type LingAgentTurnEnvelope,
} from "./ling-agent-turn-envelope.js";
import { resolveChannelConversationSurface } from "./conversation-surface.js";
import {
  recordProviderContextLengthObservation,
  recordProviderRuntimeAvailabilityIncident,
} from "./provider-runtime-observations.js";

const ROUTE_CONFIDENCE_THRESHOLD = 0.55;

export interface ChannelMessageRouteInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly runnerRegistry: RunnerRegistry;
  readonly secretResolver: SecretResolver;
  readonly config: ResolvedDaemonConfig;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
}

export type ChannelMessageRouteResult =
  | {
      readonly action: "no_reply";
      readonly decisionId?: string;
      readonly reason: string;
    }
  | {
      readonly action: "reply";
      readonly decisionId?: string;
      readonly teammateId: string;
      readonly providerPresetId?: string;
      readonly reason: string;
      readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
    };

interface RouteCandidate {
  readonly teammate: AiTeammate;
  readonly providerPresetId?: string;
  readonly preferred: boolean;
}

interface RouteDecisionDraft {
  readonly action: "reply" | "no_reply";
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly alternativesConsidered?: readonly ChannelMessageRouteAlternative[];
  readonly contextPack?: ChannelMessageRouteContextPackMetadata;
  readonly status: ChannelMessageRouteDecisionStatus;
  readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
  readonly errorMessage?: string;
}

interface ChannelAutoRouteModelOutput {
  readonly action: "reply" | "no_reply";
  readonly teammateId?: string;
  readonly confidence: number;
  readonly reason: string;
  readonly alternativesConsidered?: readonly ChannelMessageRouteAlternative[];
}

class ChannelAutoRouteModelError extends Error {
  constructor(
    message: string,
    readonly contextPack: ChannelMessageRouteContextPackMetadata | undefined,
  ) {
    super(message);
    this.name = "ChannelAutoRouteModelError";
  }
}

export async function routeChannelMessageReply(input: ChannelMessageRouteInput): Promise<ChannelMessageRouteResult> {
  const deterministicSuppression = deterministicNoReplyReason(input);
  if (deterministicSuppression) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: deterministicSuppression,
      status: "suppressed",
      createdBy: "deterministic",
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }

  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const candidates = buildRouteCandidates(input, protocol.protocol.defaultTeammateId);
  if (candidates.length === 0) {
    const decision = persistRouteDecision(input, {
      action: "reply",
      teammateId: "ling_agent",
      reason: "Ling Agent attempted to reply but no runnable provider is configured.",
      status: "failed",
      createdBy: "deterministic",
      errorMessage: "No active teammate candidate has a runnable provider.",
    });
    return {
      action: "reply",
      decisionId: decision.id,
      teammateId: "ling_agent",
      reason: decision.reason,
      createdBy: "deterministic",
    };
  }

  if (protocol.protocol.autoReplyMode === "default_teammate" || protocol.protocol.autoReplyMode === "mentions_only") {
    return routeLingAgentVisibleReply(input, candidates);
  }

  if (!input.config.channels.autoRoute) {
    return routeLingAgentVisibleReply(input, candidates, "Ling Agent used an available reply path because automatic teammate selection is disabled.");
  }

  return routeWithModel(input, candidates);
}

export function routeExplicitChannelMention(input: ChannelMessageRouteInput): ChannelMessageRouteResult {
  const teammateId = input.requestedTeammateId ?? input.sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id;
  const teammate = teammateId ? resolveAiTeammateReference(input.store, teammateId) : undefined;
  const providerPresetId = resolveRunnableProviderPresetId(input, teammate);
  const decision = persistRouteDecision(input, {
    action: "reply",
    teammateId: teammate?.id ?? teammateId,
    providerPresetId,
    confidence: 1,
    reason: "Explicit AI teammate mention requested a reply.",
    status: "accepted",
    createdBy: "explicit_mention",
  });
  return {
    action: "reply",
    decisionId: decision.id,
    teammateId: teammate?.id ?? teammateId ?? "ai-teammate",
    providerPresetId,
    reason: decision.reason,
    createdBy: "explicit_mention",
  };
}

function routeLingAgentVisibleReply(
  input: ChannelMessageRouteInput,
  candidates: readonly RouteCandidate[],
  fallbackReason?: string,
  createdBy: ChannelMessageRouteDecisionCreatedBy = "deterministic",
): ChannelMessageRouteResult {
  const lingAgentCandidate = candidates.find((candidate) => candidate.teammate.id === LING_AGENT_EXECUTOR_ID);
  if (!lingAgentCandidate) {
    const decision = persistRouteDecision(input, {
      action: "reply",
      teammateId: LING_AGENT_EXECUTOR_ID,
      reason: "Ling Agent attempted to reply but no runnable provider is configured.",
      status: "failed",
      createdBy,
      alternativesConsidered: candidatesToAlternatives(candidates),
      errorMessage: "No runnable provider is available for Ling Agent.",
    });
    return {
      action: "reply",
      decisionId: decision.id,
      teammateId: LING_AGENT_EXECUTOR_ID,
      reason: decision.reason,
      createdBy,
    };
  }
  if (hasExistingReplyForSource(input, LING_AGENT_EXECUTOR_ID)) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "An AI reply already exists for this source message.",
      status: "suppressed",
      createdBy,
      alternativesConsidered: candidatesToAlternatives(candidates),
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }
  const decision = persistRouteDecision(input, {
    action: "reply",
    teammateId: lingAgentCandidate.teammate.id,
    providerPresetId: lingAgentCandidate.providerPresetId,
    confidence: 1,
    reason: fallbackReason ?? defaultLingAgentReplyReason(input),
    status: "accepted",
    createdBy,
    alternativesConsidered: candidatesToAlternatives(candidates),
  });
  return {
    action: "reply",
    decisionId: decision.id,
    teammateId: lingAgentCandidate.teammate.id,
    providerPresetId: lingAgentCandidate.providerPresetId,
    reason: decision.reason,
    createdBy,
  };
}

async function routeWithModel(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): Promise<ChannelMessageRouteResult> {
  try {
    const route = await requestModelRoute(input, candidates);
    const output = route.output;
    const validated = validateModelRouteOutput(output, candidates);
    if (validated.action === "no_reply") {
      return routeLingAgentVisibleReply(input, candidates, `Ling Agent fallback replied after teammate selection skipped the message: ${validated.reason}`, "model");
    }
    const lingAgentCandidate = candidates.find((candidate) => candidate.teammate.id === LING_AGENT_EXECUTOR_ID);
    if (!lingAgentCandidate) {
      return routeLingAgentVisibleReply(input, candidates, "Ling Agent fallback replied after automatic teammate selection could not find a runnable coordinator.", "model");
    }
    if (hasExistingReplyForSource(input, LING_AGENT_EXECUTOR_ID)) {
      const decision = persistRouteDecision(input, {
        action: "no_reply",
        confidence: validated.confidence,
        reason: "An AI reply already exists for this source message.",
        status: "suppressed",
        createdBy: "model",
        alternativesConsidered: validated.alternativesConsidered,
        contextPack: route.contextPack,
      });
      return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
    }
    const decision = persistRouteDecision(input, {
      action: "reply",
      teammateId: lingAgentCandidate.teammate.id,
      providerPresetId: lingAgentCandidate.providerPresetId,
      confidence: validated.confidence,
      reason: `Ling Agent answered with specialist routing context: ${validated.reason}`,
      status: "accepted",
      createdBy: "model",
      alternativesConsidered: validated.alternativesConsidered,
      contextPack: route.contextPack,
    });
    return {
      action: "reply",
      decisionId: decision.id,
      teammateId: lingAgentCandidate.teammate.id,
      providerPresetId: lingAgentCandidate.providerPresetId,
      reason: decision.reason,
      createdBy: "model",
    };
  } catch {
    return routeLingAgentVisibleReply(input, candidates, "Ling Agent fallback replied after automatic teammate selection failed.", "model");
  }
}

function deterministicNoReplyReason(input: ChannelMessageRouteInput): string | undefined {
  const message = input.sourceMessage;
  if (message.authorType !== "local-user") {
    return "Only local-user messages can trigger automatic replies.";
  }
  if (message.kind !== "message") {
    return "Only ordinary channel messages can trigger automatic replies.";
  }
  if (message.intent !== "discuss") {
    return "Only discussion messages can trigger automatic replies.";
  }
  const surface = resolveChannelConversationSurface(input.store, input.channel.id, message);
  if (surface.kind === "topic") {
    return "Topic replies are outside the first auto-reply scope.";
  }
  if (surface.kind === "thread") {
    return "Thread replies are outside the first auto-reply scope.";
  }
  if (input.channel.status !== "active") {
    return "Channel is not active.";
  }
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: message,
  });
  if (!turnEnvelopeHasUserInput(envelope)) {
    return "Message is empty.";
  }
  return undefined;
}

function defaultLingAgentReplyReason(input: ChannelMessageRouteInput): string {
  const surface = resolveChannelConversationSurface(input.store, input.channel.id, input.sourceMessage);
  if (surface.kind === "branch") {
    return "Ling Agent answered a channel branch message.";
  }
  return "Ling Agent answered a root channel message.";
}

function buildRouteCandidates(input: ChannelMessageRouteInput, defaultTeammateId: string | undefined): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  const lingAgentProviderPresetId = resolveRunnableProviderPresetId(input, undefined);
  if (lingAgentProviderPresetId) {
    candidates.push({
      teammate: input.store.getAiTeammate(LING_AGENT_EXECUTOR_ID) ?? createLingAgentExecutor(new Date().toISOString()),
      providerPresetId: lingAgentProviderPresetId,
      preferred: true,
    });
  }
  const defaultTeammate = defaultTeammateId
    ? resolveAiTeammateReference(input.store, defaultTeammateId)
    : undefined;
  if (defaultTeammate) {
    const providerPresetId = resolveRunnableProviderPresetId(input, defaultTeammate);
    if (providerPresetId) {
      candidates.push({ teammate: defaultTeammate, providerPresetId, preferred: false });
    }
  }

  for (const teammate of input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 50 })) {
    if (candidates.some((candidate) => candidate.teammate.id === teammate.id)) {
      continue;
    }
    if (!isChannelMember(input.store, teammate.id, input.channel.id)) {
      continue;
    }
    const providerPresetId = resolveRunnableProviderPresetId(input, teammate);
    if (providerPresetId) {
      candidates.push({ teammate, providerPresetId, preferred: false });
    }
    if (candidates.length >= 8) {
      break;
    }
  }
  return candidates;
}

function isChannelMember(store: RunStore, teammateId: string, channelId: string): boolean {
  return store.listTeammateChannelMemberships(teammateId).some((membership) => membership.channelId === channelId);
}

function resolveRunnableProviderPresetId(input: ChannelMessageRouteInput, teammate: AiTeammate | undefined): string | undefined {
  const resolvedProviderPresetId = teammate
    ? resolveEffectiveTeammateProviderPresetId({
        teammate,
        surface: "channel",
        requestedProviderPresetId: input.requestedProviderPresetId,
        workspaceDefaultProviderPresetId: input.store.getWorkspaceSettings().defaultProviderPresetId,
        channelDefaultProviderPresetId: input.channel.defaultProviderPresetId,
      })
    : input.channel.defaultProviderPresetId;
  const candidateIds = resolvedProviderPresetId ? [resolvedProviderPresetId] : [];
  for (const providerPresetId of [...new Set(candidateIds)]) {
    try {
      resolveProviderForRun(input.store, {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel route decision in ${input.channel.name}`,
          prompt: input.sourceMessage.body || "Route channel message",
          channelId: input.channel.id,
        },
        providerPresetId,
        tools: [],
        thinkingLevel: "low",
      }, input.secretResolver);
      return providerPresetId;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function requestModelRoute(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): Promise<{
  readonly output: ChannelAutoRouteModelOutput;
  readonly contextPack: ChannelMessageRouteContextPackMetadata;
}> {
  const providerPresetId = resolveRunnableProviderPresetId(input, undefined);
  if (!providerPresetId) {
    throw new Error("No runnable provider is available for channel auto_route.");
  }
  let contextPack = buildChannelAutoRouteContextPack({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    turnEnvelope: input.turnEnvelope,
    providerPresetId,
    candidates: candidatesToRouteContext(candidates),
  });
  let contextPackMetadata = summarizeContextPack(contextPack);
  let prompt = renderContextPack(contextPack);
  const runnerResolution = input.runnerRegistry.resolve({ tools: [], allowFallback: true });
  const textDeltas: string[] = [];
  const runRouteTask = async (taskPrompt: string) => {
    const provider = resolveProviderForRun(input.store, {
      cwd: input.store.paths.cwd,
      workspaceCwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel auto route in ${input.channel.name}`,
        prompt: taskPrompt,
        channelId: input.channel.id,
      },
      providerPresetId,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: "You are Ling's channel message router. Return strict JSON only.",
    }, input.secretResolver);
    return runnerResolution.runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel auto route in ${input.channel.name}`,
        prompt: taskPrompt,
        channelId: input.channel.id,
      },
      provider,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: "You are Ling's channel message router. Return strict JSON only.",
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
        }
      },
    });
  };
  let result: Awaited<ReturnType<typeof runRouteTask>>;
  try {
    result = await runRouteTask(prompt);
  } catch (error) {
    if (!isContextLengthError(error)) {
      throw error;
    }
    const observedAt = new Date().toISOString();
    const providerPreset = contextPack.providerPresetId ? input.store.getProviderPreset(contextPack.providerPresetId) : undefined;
    recordProviderContextLengthObservation({
      providerPreset,
      contextPack,
      now: observedAt,
    });
    recordProviderRuntimeAvailabilityIncident({
      store: input.store,
      providerPreset,
      providerPresetId: contextPack.providerPresetId,
      code: "context_length_error",
      error,
      now: observedAt,
    });
    const compaction = compactChannelDiscussionForNoToolsRetry({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      now: observedAt,
    });
    contextPack = buildChannelAutoRouteContextPack({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope: input.turnEnvelope,
      providerPresetId,
      candidates: candidatesToRouteContext(candidates),
      compactedChannelSummary: compaction.compactedSummary,
      minimal: true,
    });
    contextPackMetadata = summarizeContextPack(contextPack);
    prompt = renderContextPack(contextPack);
    textDeltas.length = 0;
    result = await runRouteTask(prompt);
  }
  const text = textDeltas.join("").trim() || extractAssistantText(result.messages) || "";
  try {
    return {
      output: parseModelRouteOutput(text),
      contextPack: contextPackMetadata,
    };
  } catch (error) {
    throw new ChannelAutoRouteModelError(error instanceof Error ? error.message : String(error), contextPackMetadata);
  }
}

function candidatesToRouteContext(candidates: readonly RouteCandidate[]): readonly ChannelAutoRouteCandidateContext[] {
  return candidates.map((candidate) => ({
    id: candidate.teammate.id,
    label: candidate.teammate.displayName,
    role: candidate.teammate.roleKey,
    description: candidate.teammate.description.slice(0, 300),
    preferred: candidate.preferred,
  }));
}

function parseModelRouteOutput(text: string): ChannelAutoRouteModelOutput {
  const parsed = JSON.parse(readStrictJsonObject(text)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Route model output must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const action = record.action;
  const confidence = record.confidence;
  const reason = record.reason;
  if (
    (action !== "reply" && action !== "no_reply") ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    typeof reason !== "string"
  ) {
    throw new Error("Route model output schema is invalid.");
  }
  const teammateId = typeof record.teammateId === "string" ? record.teammateId : undefined;
  return {
    action,
    teammateId,
    confidence,
    reason,
    alternativesConsidered: parseModelAlternatives(record.alternativesConsidered),
  };
}

function readStrictJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  throw new Error("Route model output must be a strict JSON object.");
}

function parseModelAlternatives(value: unknown): readonly ChannelMessageRouteAlternative[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ChannelMessageRouteAlternative[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.reason !== "string") {
      return [];
    }
    const score = typeof record.score === "number" && Number.isFinite(record.score) ? record.score : undefined;
    return [{
      teammateId: typeof record.teammateId === "string" ? record.teammateId : undefined,
      label: record.label,
      score,
      reason: record.reason,
    }];
  });
}

function validateModelRouteOutput(output: ChannelAutoRouteModelOutput, candidates: readonly RouteCandidate[]):
  | {
      readonly action: "no_reply";
      readonly confidence: number;
      readonly reason: string;
      readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
    }
  | {
      readonly action: "reply";
      readonly teammateId: string;
      readonly providerPresetId?: string;
      readonly confidence: number;
      readonly reason: string;
      readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
    } {
  const alternativesConsidered = output.alternativesConsidered?.length ? output.alternativesConsidered : candidatesToAlternatives(candidates);
  if (output.confidence < ROUTE_CONFIDENCE_THRESHOLD) {
    return {
      action: "no_reply",
      confidence: output.confidence,
      reason: "Route model confidence was below threshold.",
      alternativesConsidered,
    };
  }
  if (output.action === "no_reply") {
    return {
      action: "no_reply",
      confidence: output.confidence,
      reason: output.reason,
      alternativesConsidered,
    };
  }
  const selected = candidates.find((candidate) => candidate.teammate.id === output.teammateId);
  if (!selected) {
    throw new Error(`Route model selected an unknown teammate: ${output.teammateId ?? ""}`);
  }
  return {
    action: "reply",
    teammateId: selected.teammate.id,
    providerPresetId: selected.providerPresetId,
    confidence: output.confidence,
    reason: output.reason,
    alternativesConsidered,
  };
}

function hasExistingReplyForSource(input: ChannelMessageRouteInput, teammateId: string): boolean {
  return input.store
    .listChannelMessages({ channelId: input.channel.id, threadId: input.sourceMessage.id, limit: 20 })
    .some((message) => message.kind === "ai_reply" && message.authorId === teammateId && message.status !== "failed");
}

function persistRouteDecision(input: ChannelMessageRouteInput, draft: RouteDecisionDraft) {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const contextPack = draft.contextPack ?? buildReplyRouteContextPackMetadata(input, draft);
  return input.store.createChannelMessageRouteDecision({
    channelId: input.channel.id,
    sourceMessageId: input.sourceMessage.id,
    mode: protocol.protocol.autoReplyMode,
    action: draft.action,
    selectedTeammateId: draft.teammateId,
    selectedProviderPresetId: draft.providerPresetId,
    confidence: draft.confidence,
    reason: draft.reason,
    alternativesConsidered: draft.alternativesConsidered,
    contextPack,
    status: draft.status,
    createdBy: draft.createdBy,
    errorMessage: draft.errorMessage,
  }, new Date().toISOString());
}

function buildReplyRouteContextPackMetadata(
  input: ChannelMessageRouteInput,
  draft: RouteDecisionDraft,
): ChannelMessageRouteContextPackMetadata | undefined {
  if (draft.action !== "reply" || !draft.teammateId) {
    return undefined;
  }
  const teammate = resolveAiTeammateReference(input.store, draft.teammateId);
  const contextPack = buildChannelReplyContextPack({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    turnEnvelope: input.turnEnvelope,
    providerPresetId: draft.providerPresetId,
    teammate,
    canonicalTeammateId: teammate?.id ?? draft.teammateId,
  });
  return summarizeContextPack(contextPack);
}

function summarizeContextPack(pack: ContextPack): ChannelMessageRouteContextPackMetadata {
  const sourceRefCounts: Record<string, number> = {};
  for (const sourceRef of pack.sourceRefs) {
    sourceRefCounts[sourceRef.type] = (sourceRefCounts[sourceRef.type] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    kind: pack.kind,
    providerPresetId: pack.providerPresetId,
    modelId: pack.modelId,
    sectionIds: pack.sections.map((section) => section.id),
    droppedSectionIds: pack.droppedSectionIds,
    sourceRefCounts,
    compactionIds: pack.compactionIds,
  };
}

function candidatesToAlternatives(candidates: readonly RouteCandidate[]): readonly ChannelMessageRouteAlternative[] {
  return candidates.map((candidate) => ({
    teammateId: candidate.teammate.id,
    label: candidate.teammate.displayName,
    score: candidate.preferred ? 1 : undefined,
    reason: candidate.preferred ? "Ling Agent visible coordinator candidate." : "Specialist teammate candidate.",
  }));
}
