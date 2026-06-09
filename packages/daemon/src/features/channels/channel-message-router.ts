import type {
  AiTeammate,
  Channel,
  ChannelMessage,
  ChannelMessageRouteAlternative,
  ChannelMessageRouteDecisionCreatedBy,
  ChannelMessageRouteDecisionStatus,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

const ROUTE_CONFIDENCE_THRESHOLD = 0.55;

export interface ChannelMessageRouteInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
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

  if (input.channel.autoReplyMode === "mentions_only") {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "Channel auto reply mode is mentions_only.",
      status: "suppressed",
      createdBy: "deterministic",
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }

  const candidates = buildRouteCandidates(input);
  if (candidates.length === 0) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "No active teammate candidate has a runnable provider.",
      status: "suppressed",
      createdBy: "deterministic",
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }

  if (input.channel.autoReplyMode === "default_teammate") {
    return routeDefaultTeammate(input, candidates);
  }

  if (!input.config.channels.autoRoute) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "Channel auto_route feature flag is disabled.",
      status: "suppressed",
      createdBy: "deterministic",
      alternativesConsidered: candidatesToAlternatives(candidates),
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
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

function routeDefaultTeammate(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): ChannelMessageRouteResult {
  const defaultCandidate = candidates.find((candidate) => candidate.preferred);
  if (!defaultCandidate) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "Channel default teammate is missing, inactive, or not runnable.",
      status: "suppressed",
      createdBy: "deterministic",
      alternativesConsidered: candidatesToAlternatives(candidates),
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }
  if (hasExistingReplyForSource(input, defaultCandidate.teammate.id)) {
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "An AI reply already exists for this source message.",
      status: "suppressed",
      createdBy: "deterministic",
      alternativesConsidered: candidatesToAlternatives(candidates),
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
  }
  const decision = persistRouteDecision(input, {
    action: "reply",
    teammateId: defaultCandidate.teammate.id,
    providerPresetId: defaultCandidate.providerPresetId,
    confidence: 1,
    reason: "Default teammate answered a reply-worthy channel question.",
    status: "accepted",
    createdBy: "deterministic",
    alternativesConsidered: candidatesToAlternatives(candidates),
  });
  return {
    action: "reply",
    decisionId: decision.id,
    teammateId: defaultCandidate.teammate.id,
    providerPresetId: defaultCandidate.providerPresetId,
    reason: decision.reason,
    createdBy: "deterministic",
  };
}

async function routeWithModel(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): Promise<ChannelMessageRouteResult> {
  try {
    const output = await requestModelRoute(input, candidates);
    const validated = validateModelRouteOutput(output, candidates);
    if (validated.action === "no_reply") {
      const decision = persistRouteDecision(input, {
        action: "no_reply",
        confidence: validated.confidence,
        reason: validated.reason,
        status: "suppressed",
        createdBy: "model",
        alternativesConsidered: validated.alternativesConsidered,
      });
      return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
    }
    if (hasExistingReplyForSource(input, validated.teammateId)) {
      const decision = persistRouteDecision(input, {
        action: "no_reply",
        confidence: validated.confidence,
        reason: "An AI reply already exists for this source message.",
        status: "suppressed",
        createdBy: "model",
        alternativesConsidered: validated.alternativesConsidered,
      });
      return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
    }
    const decision = persistRouteDecision(input, {
      action: "reply",
      teammateId: validated.teammateId,
      providerPresetId: validated.providerPresetId,
      confidence: validated.confidence,
      reason: validated.reason,
      status: "accepted",
      createdBy: "model",
      alternativesConsidered: validated.alternativesConsidered,
    });
    return {
      action: "reply",
      decisionId: decision.id,
      teammateId: validated.teammateId,
      providerPresetId: validated.providerPresetId,
      reason: decision.reason,
      createdBy: "model",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const decision = persistRouteDecision(input, {
      action: "no_reply",
      reason: "Model route failed closed.",
      status: "failed",
      createdBy: "model",
      alternativesConsidered: candidatesToAlternatives(candidates),
      errorMessage: message,
    });
    return { action: "no_reply", decisionId: decision.id, reason: decision.reason };
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
  if (message.threadId) {
    return "Thread replies are outside the first auto-reply scope.";
  }
  if (input.channel.status !== "active") {
    return "Channel is not active.";
  }
  if (!message.body.trim() && message.attachmentIds.length === 0 && message.linkPreviewIds.length === 0) {
    return "Message is empty.";
  }
  if (!isReplyWorthy(message, input.store)) {
    return "Message is not reply-worthy.";
  }
  if (isRepeatedShortGreeting(input)) {
    return "Repeated short greeting was suppressed.";
  }
  return undefined;
}

function isReplyWorthy(message: ChannelMessage, store: RunStore): boolean {
  const text = message.body.trim();
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, " ");
  const noReply = new Set(["ok", "okay", "k", "yes", "no", "thanks", "done", "收到", "好的", "嗯", "好", "可以", "行", "谢谢"]);
  if (noReply.has(compact)) {
    return false;
  }
  if (message.attachmentIds.length > 0 || message.linkPreviewIds.length > 0) {
    return hasQuestionMarker(text) || text.length >= 12;
  }
  if (normalizeGreeting(text)) {
    return true;
  }
  if (hasQuestionMarker(text)) {
    return true;
  }
  if (/^(what|how|why|can|should|is|do|help|explain|define|summarize)\b/i.test(text)) {
    return true;
  }
  if (/(什么|怎么|为什么|是否|能不能|可以吗|是什么|怎么做|有多少|多少个|几个|几位|有没有|吗|呢|谁|哪里|哪儿|何时|如何)/u.test(text)) {
    return true;
  }
  if (text.length >= 48 && !looksLikePathOrId(text)) {
    return true;
  }
  return false;
}

function hasQuestionMarker(text: string): boolean {
  return text.includes("?") || text.includes("？");
}

function looksLikePathOrId(text: string): boolean {
  return /^[./~\w-]+(?:\/[./~\w-]+)+$/.test(text) || /^[a-zA-Z0-9_-]{12,}$/.test(text);
}

function isRepeatedShortGreeting(input: ChannelMessageRouteInput): boolean {
  const normalized = normalizeGreeting(input.sourceMessage.body);
  if (!normalized) {
    return false;
  }
  const recent = input.store
    .listChannelMessages({ channelId: input.channel.id, limit: 12 })
    .filter((message) => message.id !== input.sourceMessage.id);
  const matchingGreetingIds = new Set(
    recent
      .filter((message) => message.authorType === "local-user" && normalizeGreeting(message.body) === normalized)
      .map((message) => message.id),
  );
  return recent.some((message) =>
    message.kind === "ai_reply" &&
    message.status !== "failed" &&
    message.threadId !== undefined &&
    matchingGreetingIds.has(message.threadId)
  );
}

function normalizeGreeting(text: string): string | undefined {
  const normalized = text.toLowerCase().replace(/[?!？！，,.\s]/g, "").trim();
  if (!normalized || normalized.length > 12) {
    return undefined;
  }
  return ["hi", "hello", "hey", "你好", "您好", "哈喽"].includes(normalized) ? normalized : undefined;
}

function buildRouteCandidates(input: ChannelMessageRouteInput): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  const defaultTeammate = input.channel.defaultTeammateId
    ? resolveAiTeammateReference(input.store, input.channel.defaultTeammateId)
    : undefined;
  if (defaultTeammate) {
    const providerPresetId = resolveRunnableProviderPresetId(input, defaultTeammate);
    if (providerPresetId) {
      candidates.push({ teammate: defaultTeammate, providerPresetId, preferred: true });
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
  const candidateIds = [
    input.requestedProviderPresetId,
    teammate?.providerPresetId,
    input.channel.defaultProviderPresetId,
    ...input.store.listProviderPresets({ enabled: true })
      .filter((preset) => preset.capabilities.includes("chat") && preset.api !== "media-job")
      .map((preset) => preset.id),
  ].filter((id): id is string => Boolean(id));
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

async function requestModelRoute(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): Promise<ChannelAutoRouteModelOutput> {
  const providerPresetId = resolveRunnableProviderPresetId(input, undefined);
  if (!providerPresetId) {
    throw new Error("No runnable provider is available for channel auto_route.");
  }
  const provider = resolveProviderForRun(input.store, {
    cwd: input.store.paths.cwd,
    workspaceCwd: input.store.paths.cwd,
    task: {
      id: input.sourceMessage.id,
      title: `Channel auto route in ${input.channel.name}`,
      prompt: buildModelRoutePrompt(input, candidates),
      channelId: input.channel.id,
    },
    providerPresetId,
    tools: [],
    thinkingLevel: "low",
    systemPrompt: "You are Ling's channel message router. Return strict JSON only.",
  }, input.secretResolver);
  const runnerResolution = input.runnerRegistry.resolve({ tools: [], allowFallback: true });
  const textDeltas: string[] = [];
  const result = await runnerResolution.runner.adapter.runTask({
    cwd: input.store.paths.cwd,
    task: {
      id: input.sourceMessage.id,
      title: `Channel auto route in ${input.channel.name}`,
      prompt: buildModelRoutePrompt(input, candidates),
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
  const text = textDeltas.join("").trim() || extractAssistantText(result.messages) || "";
  return parseModelRouteOutput(text);
}

function buildModelRoutePrompt(input: ChannelMessageRouteInput, candidates: readonly RouteCandidate[]): string {
  const recentMessages = input.store
    .listChannelMessages({ channelId: input.channel.id, limit: 8 })
    .filter((message) => message.id !== input.sourceMessage.id)
    .map((message) => `${message.authorType}: ${message.body.slice(0, 180)}`)
    .join("\n");
  const candidateJson = candidates.map((candidate) => ({
    id: candidate.teammate.id,
    label: candidate.teammate.displayName,
    role: candidate.teammate.roleKey,
    description: candidate.teammate.description.slice(0, 300),
    preferred: candidate.preferred,
  }));
  return [
    "Decide whether one AI teammate should reply to the latest user channel message.",
    "Return strict JSON only with fields: action, teammateId, confidence, reason, alternativesConsidered.",
    "Use action no_reply for acknowledgements, repeated greetings, ambiguous fragments, or messages that do not need AI.",
    "Never create tasks, runs, workflows, approvals, memory activation, or multiple replies.",
    `Channel: ${input.channel.name}`,
    `Latest user message: ${input.sourceMessage.body}`,
    recentMessages ? `Recent context:\n${recentMessages}` : "Recent context: none",
    `Candidates JSON: ${JSON.stringify(candidateJson)}`,
  ].join("\n\n");
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
  return input.store.createChannelMessageRouteDecision({
    channelId: input.channel.id,
    sourceMessageId: input.sourceMessage.id,
    mode: input.channel.autoReplyMode,
    action: draft.action,
    selectedTeammateId: draft.teammateId,
    selectedProviderPresetId: draft.providerPresetId,
    confidence: draft.confidence,
    reason: draft.reason,
    alternativesConsidered: draft.alternativesConsidered,
    status: draft.status,
    createdBy: draft.createdBy,
    errorMessage: draft.errorMessage,
  }, new Date().toISOString());
}

function candidatesToAlternatives(candidates: readonly RouteCandidate[]): readonly ChannelMessageRouteAlternative[] {
  return candidates.map((candidate) => ({
    teammateId: candidate.teammate.id,
    label: candidate.teammate.displayName,
    score: candidate.preferred ? 1 : undefined,
    reason: candidate.preferred ? "Channel default teammate candidate." : "Active channel teammate candidate.",
  }));
}
