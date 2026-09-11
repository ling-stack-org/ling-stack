import {
  resolveProviderModelCapabilitySnapshot,
  type AiTeammate,
  type Channel,
  type ChannelAutoReplyMode,
  type ChannelMessage,
  type ChannelResponseLanguage,
  type ChannelStoreFacet,
  type ProviderModelCapabilityConfidence,
  type ProviderModelCapabilitySource,
  type ProviderPreset,
  type RunStore,
  type WorkspaceStoreFacet,
} from "@ling-stack/core";
import type {
  ConversationContextProjectionMetadata,
  ConversationDomainRefType,
} from "@ling-stack/contracts";
import type { WorkflowAgentContextStamp } from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { formatChannelDiscussionPrompt, type ChannelDiscussionPromptContext, type ChannelDiscussionPromptTeammate } from "./ai-prompts.js";
import {
  resolveEffectiveChannelCollaborationProtocol,
  type ChannelProtocolFieldSource,
  type EffectiveChannelCollaborationProtocolResult,
} from "./collaboration-protocol.js";
import {
  buildLingAgentTurnEnvelope,
  renderLingAgentTurnEnvelopeForPrompt,
  type LingAgentTurnEnvelope,
} from "./ling-agent-turn-envelope.js";
import { promptSectionsFromContextView } from "./context-processing/render.js";
import {
  collectActiveWorkSources,
  collectChannelStateSource,
  collectMaterializedInputSources,
  collectTurnSource,
} from "./context-processing/sources.js";
import { buildProjectedConversationContextSlice } from "./context-processing/conversation-context-adapter.js";
import { channelOperationVisibleSources } from "./channel-operation-sources.js";
import { buildChannelContextView } from "./context-processing/views.js";
import {
  buildWorkflowStepContextView,
  type WorkflowStepContextPackInput,
} from "./context-processing/workflow-steps.js";
import type {
  ChannelContextSection,
  ChannelContextSectionCompactionSurvival,
  ChannelContextSource,
  ChannelContextSourceRef,
  ChannelContextView,
  ChannelContextViewKind,
} from "./context-processing/types.js";
import { providerRuntimeObservationForPreset } from "./provider-runtime-observations.js";
import { createWorkflowAgentContextStamp } from "./agent-context-consistency.js";

export type ContextPackKind =
  | "channel_reply"
  | "visible_multi_reply"
  | "intent_selector"
  | "auto_route_selector"
  | "workflow_step"
  | "private_teammate_reply";

export type ContextBudgetMode = "model_known" | "model_estimated" | "model_unknown";
export type ContextSectionRole = "system" | "instruction" | "user" | "memory" | "evidence";
export type ContextSectionPriority = "must_keep" | "high" | "medium" | "low";

export interface ProviderContextCapabilities {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly tokenizer: "openai-compatible" | "anthropic-compatible" | "estimated";
  readonly supportsStructuredOutput: boolean;
  readonly capabilitySource: ProviderModelCapabilitySource;
  readonly capabilityConfidence: ProviderModelCapabilityConfidence;
}

export interface ContextBudget {
  readonly mode: ContextBudgetMode;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedRuntimeOverheadTokens: number;
  readonly inputBudgetTokens: number;
  readonly tokenizer: ProviderContextCapabilities["tokenizer"];
  readonly capabilitySource: ProviderModelCapabilitySource;
  readonly capabilityConfidence: ProviderModelCapabilityConfidence;
}

export interface ContextSourceRef {
  readonly type:
    | ConversationDomainRefType
    | "teammate"
    | "channel"
    | "provider"
    | "attachment"
    | "link_preview"
    | "decision"
    | "summary"
    | "workflow_selector_decision"
    | "workflow_handoff_intent"
    | "workflow_packet_summary";
  readonly id: string;
  readonly label?: string;
}

export interface ContextSection {
  readonly id: string;
  readonly role: ContextSectionRole;
  readonly priority: ContextSectionPriority;
  readonly compactionSurvival?: ChannelContextSectionCompactionSurvival;
  readonly text: string;
  readonly sourceRefIds?: readonly string[];
  readonly estimatedTokens?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ContextPack {
  readonly kind: ContextPackKind;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: ContextBudget;
  readonly sections: readonly ContextSection[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly contextProjection?: ConversationContextProjectionMetadata;
  readonly agentContext?: WorkflowAgentContextStamp;
}

interface BuildContextPackInput {
  readonly kind: ContextPackKind;
  readonly providerPreset?: ProviderPreset;
  readonly sections: readonly ContextSection[];
  readonly sourceRefs?: readonly ContextSourceRef[];
  readonly compactionIds?: readonly string[];
  readonly contextProjection?: ConversationContextProjectionMetadata;
  readonly agentContext?: WorkflowAgentContextStamp;
}

interface ChannelReplyContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammate: AiTeammate | undefined;
  readonly canonicalTeammateId: string;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly additionalContextMessages?: readonly ChannelMessage[];
  readonly compactedChannelSummary?: ChannelCompactedDiscussionSummary;
  readonly minimal?: boolean;
}

interface ChannelIntentSelectorContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly compactedChannelSummary?: ChannelCompactedDiscussionSummary;
  readonly minimal?: boolean;
}

export interface ChannelAutoRouteCandidateContext {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly description: string;
  readonly preferred: boolean;
}

interface ChannelAutoRouteContextPackInput extends ChannelIntentSelectorContextPackInput {
  readonly candidates: readonly ChannelAutoRouteCandidateContext[];
}

type ChannelProtocolContextStore = ChannelStoreFacet & WorkspaceStoreFacet;

export interface ChannelCompactedDiscussionSummary {
  readonly id: string;
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
}

export type { WorkflowStepCompactedDependencySummary, WorkflowStepContextPackInput } from "./context-processing/workflow-steps.js";

const MODEL_UNKNOWN_CONTEXT_WINDOW_TOKENS = 8_192;
const MODEL_ESTIMATED_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 1_024;
const SELECTOR_OUTPUT_TOKENS = 512;
const RUNTIME_OVERHEAD_TOKENS = 512;
const MIN_INPUT_BUDGET_TOKENS = 1_024;

export function resolveProviderContextCapabilities(providerPreset?: ProviderPreset): ProviderContextCapabilities {
  const snapshot = resolveProviderModelCapabilitySnapshot(providerPreset, {
    runtimeObservation: providerRuntimeObservationForPreset(providerPreset),
  });
  return {
    contextWindowTokens: snapshot.chatEligible ? snapshot.contextWindowTokens : undefined,
    maxOutputTokens: snapshot.chatEligible && snapshot.confidence === "known" ? snapshot.maxOutputTokens : undefined,
    tokenizer: snapshot.tokenizer,
    supportsStructuredOutput: snapshot.supportsStructuredOutput,
    capabilitySource: snapshot.source,
    capabilityConfidence: snapshot.confidence,
  };
}

export function resolveProviderContextBudget(
  providerPreset: ProviderPreset | undefined,
  kind: ContextPackKind = "channel_reply",
): ContextBudget {
  const capabilities = resolveProviderContextCapabilities(providerPreset);
  const mode = contextBudgetModeForCapabilities(capabilities);
  const contextWindowTokens =
    capabilities.contextWindowTokens ??
    (mode === "model_estimated" ? MODEL_ESTIMATED_CONTEXT_WINDOW_TOKENS : MODEL_UNKNOWN_CONTEXT_WINDOW_TOKENS);
  const reservedOutputTokens = capabilities.maxOutputTokens ?? (kind.includes("selector") ? SELECTOR_OUTPUT_TOKENS : DEFAULT_OUTPUT_TOKENS);
  const inputBudgetTokens = Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    contextWindowTokens - reservedOutputTokens - RUNTIME_OVERHEAD_TOKENS,
  );
  return {
    mode,
    contextWindowTokens,
    reservedOutputTokens,
    reservedRuntimeOverheadTokens: RUNTIME_OVERHEAD_TOKENS,
    inputBudgetTokens,
    tokenizer: capabilities.tokenizer,
    capabilitySource: capabilities.capabilitySource,
    capabilityConfidence: capabilities.capabilityConfidence,
  };
}

export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const budget = resolveProviderContextBudget(input.providerPreset, input.kind);
  const sections = input.sections.map((section) => ({
    ...section,
    compactionSurvival: section.compactionSurvival ?? defaultCompactionSurvivalForRole(section.role),
    estimatedTokens: section.estimatedTokens ?? estimateTextTokens(section.text),
  }));
  const droppedSectionIds: string[] = [];
  const compactionIds = [...(input.compactionIds ?? [])];
  const keptSections = [...sections];
  let estimatedInputTokens = sumEstimatedTokens(keptSections);

  while (estimatedInputTokens > budget.inputBudgetTokens) {
    const dropIndex = findDropSectionIndex(keptSections);
    if (dropIndex < 0) {
      break;
    }
    const [dropped] = keptSections.splice(dropIndex, 1);
    droppedSectionIds.push(dropped.id);
    compactionIds.push(stableSectionCompactionId("drop", dropped));
    estimatedInputTokens = sumEstimatedTokens(keptSections);
  }

  return {
    kind: input.kind,
    providerPresetId: input.providerPreset?.id,
    modelId: input.providerPreset?.model,
    budget,
    sections: keptSections,
    sourceRefs: input.sourceRefs ?? [],
    droppedSectionIds,
    compactionIds: [...new Set(compactionIds)],
    estimatedInputTokens,
    overBudget: estimatedInputTokens > budget.inputBudgetTokens,
    contextProjection: input.contextProjection,
    agentContext: input.agentContext,
  };
}

export function renderContextPack(pack: ContextPack): string {
  return pack.sections.map((section) => section.text).join("\n\n");
}

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.6));
}

interface CompatContextView {
  readonly kind: ContextPackKind;
  readonly providerPreset?: ProviderPreset;
  readonly view: ChannelContextView;
  readonly legacySourceRefs: readonly ContextSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
}

function buildCompatContextView(input: {
  readonly viewKind: ChannelContextViewKind;
  readonly kind: ContextPackKind;
  readonly channel: Channel;
  readonly providerPreset?: ProviderPreset;
  readonly consumerTeammateId?: string;
  readonly sections: readonly ContextSection[];
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly sources?: readonly ChannelContextSource[];
  readonly compactionIds?: readonly string[];
  readonly contextProjection?: ConversationContextProjectionMetadata;
}): CompatContextView {
  const budget = resolveProviderContextBudget(input.providerPreset, input.kind);
  return {
    kind: input.kind,
    providerPreset: input.providerPreset,
    legacySourceRefs: input.sourceRefs,
    view: buildChannelContextView({
      kind: input.viewKind,
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      consumerTeammateId: input.consumerTeammateId,
      sections: input.sections.map(contextSectionToChannelContextSection),
      sourceRefs: input.sourceRefs,
      sources: input.sources,
      compactionIds: input.compactionIds,
      budget: {
        mode: budget.mode,
        inputBudgetTokens: budget.inputBudgetTokens,
        capabilitySource: budget.capabilitySource,
        capabilityConfidence: budget.capabilityConfidence,
      },
      contextProjection: input.contextProjection,
    }),
  };
}

function buildContextPackFromContextView(input: CompatContextView): ContextPack {
  return buildContextPack({
    kind: input.kind,
    providerPreset: input.providerPreset,
    sections: promptSectionsFromContextView(input.view).map(channelContextSectionToContextSection),
    sourceRefs: uniqueContextSourceRefs(input.legacySourceRefs),
    compactionIds: input.view.metadata.compactionIds,
    contextProjection: input.view.contextProjection,
    agentContext: input.agentContext,
  });
}

function legacyContextSourceRefsFromContextView(view: ChannelContextView): readonly ContextSourceRef[] {
  return uniqueContextSourceRefs(
    view.sourceRefs.flatMap((ref): ContextSourceRef[] => {
      if (!isLegacyContextSourceRefType(ref.type)) {
        return [];
      }
      return [{
        type: ref.type,
        id: ref.id,
        ...(ref.label ? { label: ref.label } : {}),
      }];
    }),
  );
}

function isLegacyContextSourceRefType(type: string): type is ContextSourceRef["type"] {
  return (
    type === "message" ||
    type === "channel" ||
    type === "teammate" ||
    type === "provider" ||
    type === "memory" ||
    type === "artifact" ||
    type === "attachment" ||
    type === "link_preview" ||
    type === "run" ||
    type === "decision" ||
    type === "handoff" ||
    type === "summary" ||
    type === "workflow" ||
    type === "workflow_step" ||
    type === "workflow_selector_decision" ||
    type === "workflow_handoff_intent" ||
    type === "context_summary" ||
    type === "workflow_packet_summary"
  );
}

function contextSectionToChannelContextSection(section: ContextSection): ChannelContextSection {
  return {
    id: section.id,
    role: section.role,
    priority: section.priority,
    compactionSurvival: section.compactionSurvival ?? defaultCompactionSurvivalForRole(section.role),
    title: section.id,
    text: section.text,
    sourceRefIds: section.sourceRefIds ?? [],
    visibility: "prompt",
    quotePolicy: section.role === "memory" ? "influence_only" : "public_ok",
    estimatedTokens: section.estimatedTokens,
    metadata: section.metadata,
  };
}

function channelContextSectionToContextSection(section: ChannelContextSection): ContextSection {
  return {
    id: section.id,
    role: section.role,
    priority: section.priority,
    compactionSurvival: section.compactionSurvival,
    text: section.text,
    sourceRefIds: section.sourceRefIds,
    estimatedTokens: section.estimatedTokens,
    metadata: section.metadata,
  };
}

export function buildChannelReplyContextPack(input: ChannelReplyContextPackInput): ContextPack {
  const discussionPromptContext = buildChannelDiscussionPromptContext(input);
  const protocolSection = buildChannelProtocolContextSection(input);
  const kind: ContextPackKind = (input.visibleParticipantTeammateIds?.length ?? 0) > 0
    ? "visible_multi_reply"
    : "channel_reply";
  const envelope = resolveTurnEnvelope(input);
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const sourceMessageForPrompt = {
    ...sourceMessage,
    body: renderLingAgentTurnEnvelopeForPrompt(envelope),
  };
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "reply",
    consumerTeammateId: input.canonicalTeammateId,
    explicitItemIds: input.additionalContextMessages?.map((message) => message.id),
    minimal: input.minimal,
  });
  const compactedSummarySection = input.compactedChannelSummary
    ? [buildCompactedChannelDiscussionSection(input.compactedChannelSummary)]
    : [];
  const sections: readonly ContextSection[] = [
    protocolSection,
    ...compactedSummarySection,
    ...projectedContext.sections.map(channelContextSectionToContextSection),
    {
      id: "channel_discussion",
      role: "user",
      priority: "must_keep",
      text: formatChannelDiscussionPrompt(input.channel, sourceMessageForPrompt, discussionPromptContext),
      sourceRefIds: [sourceMessage.id, input.channel.id],
    },
  ];
  const sourceRefs: readonly ContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "message", id: sourceMessage.id, label: "Source message" },
    ...projectedContext.sourceRefs,
    ...turnEnvelopeSourceRefs(envelope),
    ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
  ];
  const view = buildCompatContextView({
    viewKind: "ling_agent_channel_view",
    kind,
    channel: input.channel,
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    consumerTeammateId: input.canonicalTeammateId,
    sections,
    sourceRefs,
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
    contextProjection: projectedContext.projection.metadata,
    sources: [
      collectChannelStateSource({ channel: input.channel, text: protocolSection.text, metadata: protocolSection.metadata }),
      collectTurnSource({ channel: input.channel, envelope }),
      ...collectMaterializedInputSources({ channel: input.channel, envelope }),
      ...projectedContext.sources,
      ...collectActiveWorkSources({ store: input.store, channel: input.channel }),
    ],
  });
  return buildContextPackFromContextView(view);
}

export function buildChannelIntentSelectorContextPack(input: ChannelIntentSelectorContextPackInput): ContextPack {
  const protocolSection = buildChannelProtocolContextSection(input);
  const envelope = resolveTurnEnvelope(input);
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "selector",
    minimal: input.minimal,
  });
  const teammateRoles = input.store
    .listAiTeammates({ status: "active", includeHidden: false, limit: 20 })
    .map((teammate) => ({ id: teammate.id, role: teammate.roleKey, label: teammate.displayName }))
    .slice(0, 12);
  const sections: readonly ContextSection[] = [
    {
      id: "selector_instructions",
      role: "instruction",
      priority: "must_keep",
      text: [
        "Classify the latest user channel message into exactly one Ling intent.",
        "Return strict JSON only. For reply/no_reply/visible_multi_reply: {\"action\":\"...\",\"reason\":\"short reason\"}. For clarify add {\"clarification\":{\"missingFields\":[\"field\"],\"question\":\"specific question\"}}. Both execute and workflow_proposal require execution.schemaVersion=2 and a complete operations array.",
        "Each operation: {id, kind: file_read|file_create|file_edit|run_command|open_local_target, targetKind: file|command, required: true, dependsOn: [], sourceQuote, owner: {participantId, sourceQuote} or {kind: host_default}, target?: {path, sourceQuote, sourceItemId?, relativeTo?: {path, sourceQuote, sourceItemId?}}, inputs?: [{path, sourceQuote, sourceItemId?, relativeTo?, fromOperationId?}], command?: {text, sourceQuote}, contentSource?: {kind: literal|generated_objective, text, sourceQuote, sourceItemId?, inputOperationIds?: []}}. The operation sourceQuote and explicit owner/command/input quotes MUST come from the current user message. For unnamed owners request host_default without participantId; Host routing alone selects the default. Use stable participant IDs only for explicitly requested owners, never role-based reassignment.",
        "For an explicit shell command use command with its verbatim current-operation quote. For a natural-language request to use Node to invoke an exported function, use commandGoal instead: {kind: node_function, module: {path, sourceQuote, sourceItemId?, relativeTo?}, invocation: 'formatProof(\"7319\")', sourceQuote}. The invocation is the exact quoted function call with JSON-literal arguments, not generated code. Preserve the module, function and all arguments; dependsOn must include the operation that creates or reads the module when it is referenced from another instruction span. Do not invent a shell command or quote Node alone as the entire goal. Never return both command and commandGoal. Host generates and binds the invocation command; actual execution still requires policy and sandbox support.",
        "Target and content quotes may name sourceItemId from the projected canonical source registry below. Omission means the current item. Preserve exact quoted content; do not promote prior assistant text into a new execution instruction. The current user operation quote supplies current execution intent; historical references supply only material. Unlisted, unrelated-segment, invisible or stale item IDs are invalid.",
        "Use reply for ordinary questions and in-conversation content generation.",
        "Use visible_multi_reply only for explicit discussion-only requests asking multiple teammates for visible opinions; do not use it for implementation, validation, publishing, merge, deploy, or tool-running work.",
        "Use clarify for work-shaped requests missing target, scope, or acceptance checks.",
        "Use workflow_proposal for multi-role work that needs proposal evidence before execution.",
        "Use execute only when the user explicitly requests bounded file, command, workspace, or other external side-effect work; approval and tool policy still apply.",
        "Include every explicitly requested operation and preserve separate outputs and owners. Bind standalone reads as file_read, not shell commands. When an exact command itself must read a named file, list that file in command inputs; if a prior file operation produces it, set fromOperationId and include that operation in dependsOn. For review-writing, use separate file_read operations plus file_create with contentSource.kind=generated_objective and inputOperationIds naming that owner's read operations; dependsOn must include those reads. The text is the quoted objective, not a guessed literal report. Literal content must be its own quoted value, never an output path or the remaining instruction suffix.",
        "Targets are quoted workspace-relative paths. When the user names a directory and later a basename, bind the basename as path and the explicitly named directory as relativeTo, each with its own quote. If any owner, target, content source or dependency is ambiguous, use clarify. Do not return targetRef, binding, fingerprint, requiredTools or permissions; the host alone computes them.",
        "Respect negative constraints semantically: reading or reviewing does not authorize code edits, and verification does not authorize inventing a command. Never add operations not requested. A sourceQuote proves provenance, not user permission; existing channel and runtime effect policies remain mandatory. open_local_target is distinct from reading and may be unsupported by the host binder.",
        "A follow-up asking Ling to write, save, create, edit, run, open, preview, or put work into the local workspace is execute only when that side effect is explicit and the projected context contains one clear target.",
        "Use clarify only when a current product decision is genuinely missing. missingFields must be non-empty and the question must name the missing decision. Never ask for a local target for an independently answerable content request.",
        "Use no_reply only to mean the message is not executable or collaborative work; Ling Agent still falls through to ordinary reply handling.",
      ].join("\n"),
    },
    protocolSection,
    ...(input.compactedChannelSummary ? [buildCompactedChannelDiscussionSection(input.compactedChannelSummary)] : []),
    ...projectedContext.sections.map(channelContextSectionToContextSection),
    {
      id: "selector_source_message",
      role: "user",
      priority: "must_keep",
      text: [`Channel: ${input.channel.name}`, "Latest user turn:", renderLingAgentTurnEnvelopeForPrompt(envelope)].join("\n"),
      sourceRefIds: [input.channel.id, sourceMessage.id],
    },
    {
      id: "selector_teammate_roles",
      role: "evidence",
      priority: "high",
      text: `Available teammate roles JSON: ${JSON.stringify(teammateRoles)}`,
    },
    {
      id: "selector_operation_source_registry",
      role: "evidence",
      priority: "high",
      text: `Projected canonical operation source registry JSON: ${JSON.stringify(channelOperationVisibleSources({
        store: input.store, sourceItemId: input.sourceMessage.id, projection: projectedContext.projection,
      }).map(({ body: _body, ...source }) => source))}`,
    },
  ];
  const sourceRefs: readonly ContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "message", id: sourceMessage.id, label: "Latest user message" },
    ...projectedContext.sourceRefs,
    ...turnEnvelopeSourceRefs(envelope),
    ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
  ];
  const view = buildCompatContextView({
    viewKind: "selector_view",
    kind: "intent_selector",
    channel: input.channel,
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sections,
    sourceRefs,
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
    contextProjection: projectedContext.projection.metadata,
    sources: [
      collectChannelStateSource({ channel: input.channel, text: protocolSection.text, metadata: protocolSection.metadata }),
      collectTurnSource({ channel: input.channel, envelope }),
      ...collectMaterializedInputSources({ channel: input.channel, envelope }),
      ...projectedContext.sources,
      ...collectActiveWorkSources({ store: input.store, channel: input.channel }),
    ],
  });
  return buildContextPackFromContextView(view);
}

export function buildChannelAutoRouteContextPack(input: ChannelAutoRouteContextPackInput): ContextPack {
  const protocolSection = buildChannelProtocolContextSection(input);
  const envelope = resolveTurnEnvelope(input);
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const projectedContext = buildProjectedConversationContextSlice({
    store: input.store,
    channel: input.channel,
    sourceItemId: input.sourceMessage.id,
    view: "selector",
    minimal: input.minimal,
  });
  const sections: readonly ContextSection[] = [
    {
      id: "auto_route_instructions",
      role: "instruction",
      priority: "must_keep",
      text: [
        "Decide whether one AI teammate should reply to the latest user channel message.",
        "Return strict JSON only with fields: action, teammateId, confidence, reason, alternativesConsidered.",
        "Root local-user messages should produce a visible Ling outcome. Choose reply for acknowledgements, greetings, punctuation fragments, and short status messages; keep the reply concise.",
        "Use action no_reply only for messages that are not a local-user root turn or cannot be handled as channel discussion.",
        "Never create tasks, runs, workflows, approvals, memory authority changes, or multiple replies.",
      ].join("\n"),
    },
    protocolSection,
    ...(input.compactedChannelSummary ? [buildCompactedChannelDiscussionSection(input.compactedChannelSummary)] : []),
    ...projectedContext.sections.map(channelContextSectionToContextSection),
    {
      id: "auto_route_source_message",
      role: "user",
      priority: "must_keep",
      text: [`Channel: ${input.channel.name}`, "Latest user turn:", renderLingAgentTurnEnvelopeForPrompt(envelope)].join("\n"),
      sourceRefIds: [input.channel.id, sourceMessage.id],
    },
    {
      id: "auto_route_candidates",
      role: "evidence",
      priority: "high",
      text: `Candidates JSON: ${JSON.stringify(input.candidates)}`,
    },
  ];
  const sourceRefs: readonly ContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "message", id: sourceMessage.id, label: "Latest user message" },
    ...projectedContext.sourceRefs,
    ...turnEnvelopeSourceRefs(envelope),
    ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
  ];
  const view = buildCompatContextView({
    viewKind: "selector_view",
    kind: "auto_route_selector",
    channel: input.channel,
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sections,
    sourceRefs,
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
    contextProjection: projectedContext.projection.metadata,
    sources: [
      collectChannelStateSource({ channel: input.channel, text: protocolSection.text, metadata: protocolSection.metadata }),
      collectTurnSource({ channel: input.channel, envelope }),
      ...collectMaterializedInputSources({ channel: input.channel, envelope }),
      ...projectedContext.sources,
      ...collectActiveWorkSources({ store: input.store, channel: input.channel }),
    ],
  });
  return buildContextPackFromContextView(view);
}

function resolveTurnEnvelope(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
}): LingAgentTurnEnvelope {
  return input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
}

function turnEnvelopeSourceRefs(envelope: LingAgentTurnEnvelope): readonly ContextSourceRef[] {
  return [
    ...envelope.attachments.map((attachment): ContextSourceRef => ({
      type: "attachment",
      id: attachment.id,
      label: attachment.fileName,
    })),
    ...envelope.linkPreviews.map((preview): ContextSourceRef => ({
      type: "link_preview",
      id: preview.id,
      label: preview.title ?? preview.normalizedUrl,
    })),
  ];
}

export function buildWorkflowStepContextPack(input: WorkflowStepContextPackInput): ContextPack {
  const protocolSection = buildChannelProtocolContextSection(input);
  const providerPreset = input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined;
  const budget = resolveProviderContextBudget(providerPreset, "workflow_step");
  const view = buildWorkflowStepContextView({
    ...input,
    protocolSection: contextSectionToChannelContextSection(protocolSection),
    budget: {
      mode: budget.mode,
      inputBudgetTokens: budget.inputBudgetTokens,
      capabilitySource: budget.capabilitySource,
      capabilityConfidence: budget.capabilityConfidence,
    },
  });
  const pack = buildContextPackFromContextView({
    kind: "workflow_step",
    providerPreset,
    view,
    legacySourceRefs: legacyContextSourceRefsFromContextView(view),
  });
  const sourceItemId = input.step.metadata?.sourceMessageId ?? input.workflow.metadata?.sourceMessageId;
  const roleEvidenceWasKept = pack.sections.some((section) => section.id === "workflow_role_evidence");
  const roleEvidenceRefs = roleEvidenceWasKept
    ? (input.roleEvidence?.sourceRefs ?? [])
        .filter((ref): ref is ContextSourceRef & { readonly type: "memory" } => ref.type === "memory")
        .map((ref) => ({ type: "memory" as const, id: ref.id }))
    : [];
  const agentContext = sourceItemId && pack.contextProjection
    ? createWorkflowAgentContextStamp({
        store: input.store,
        sourceItemId,
        contextProjection: pack.contextProjection,
        consumerTeammateId: input.consumerTeammateId ?? input.step.toParticipantId,
        roleEvidenceRefs,
      })
    : undefined;
  return agentContext ? { ...pack, agentContext } : pack;
}

export function buildChannelProtocolContextSection(input: {
  readonly store: ChannelProtocolContextStore;
  readonly channel: Channel;
}): ContextSection {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  return {
    id: "channel_collaboration_protocol",
    role: "instruction",
    priority: "high",
    text: renderChannelProtocolContext(protocol),
    sourceRefIds: [input.channel.id],
    metadata: {
      responseLanguage: protocol.protocol.responseLanguage,
      responseLanguageSource: protocol.sources.responseLanguage.source,
      autoReplyMode: protocol.protocol.autoReplyMode,
      autoReplyModeSource: protocol.sources.autoReplyMode.source,
      defaultTeammateId: protocol.protocol.defaultTeammateId,
      defaultTeammateSource: protocol.sources.defaultTeammateId.source,
    } satisfies {
      responseLanguage: ChannelResponseLanguage;
      responseLanguageSource: ChannelProtocolFieldSource;
      autoReplyMode: ChannelAutoReplyMode;
      autoReplyModeSource: ChannelProtocolFieldSource;
      defaultTeammateId?: string;
      defaultTeammateSource: ChannelProtocolFieldSource;
    },
  };
}

function renderChannelProtocolContext(protocol: EffectiveChannelCollaborationProtocolResult): string {
  return [
    "Channel collaboration protocol:",
    `- Response language: ${protocol.protocol.responseLanguage} (source=${protocol.sources.responseLanguage.source})`,
    `- Auto reply mode: ${protocol.protocol.autoReplyMode} (source=${protocol.sources.autoReplyMode.source})`,
    `- Default teammate: ${protocol.protocol.defaultTeammateId ?? "none"} (source=${protocol.sources.defaultTeammateId.source})`,
    `- Default workflow preference: ${protocol.protocol.defaultWorkflowPreference} (source=${protocol.sources.defaultWorkflowPreference.source})`,
    `- Visible multi-reply max participants: ${protocol.protocol.visibleMultiReplyMaxParticipants} (source=${protocol.sources.visibleMultiReplyMaxParticipants.source})`,
    "- Private teammate chat, hidden prompts, provider secrets, and unreviewed memory are excluded unless an explicit future approved flow promotes them.",
  ].join("\n");
}

function buildCompactedChannelDiscussionSection(summary: ChannelCompactedDiscussionSummary): ContextSection {
  return {
    id: "channel_discussion_summary",
    role: "evidence",
    priority: "high",
    text: summary.text,
    sourceRefIds: [summary.id, ...summary.sourceMessageIds],
  };
}

function contextSourceMessage(sourceMessage: ChannelMessage, maxBodyLength: number | undefined): ChannelMessage {
  if (!maxBodyLength || sourceMessage.body.length <= maxBodyLength) {
    return sourceMessage;
  }
  return {
    ...sourceMessage,
    body: `${sourceMessage.body.slice(0, Math.max(0, maxBodyLength - 80))}\n\n[Message body truncated for no-tools context retry. Full text remains in the channel message record: ${sourceMessage.id}]`,
  };
}

function buildChannelDiscussionPromptContext(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly teammate: AiTeammate | undefined;
  readonly canonicalTeammateId: string;
  readonly visibleParticipantTeammateIds?: readonly string[];
}): ChannelDiscussionPromptContext {
  const currentTeammate = {
    id: input.canonicalTeammateId,
    displayName: input.teammate?.displayName ?? input.canonicalTeammateId,
    roleKey: input.teammate?.roleKey ?? "custom",
  };
  const includeRoster =
    (input.visibleParticipantTeammateIds?.length ?? 0) > 0 ||
    isChannelRosterQuestion(input.sourceMessage.body);
  if (!includeRoster) {
    return { currentTeammate };
  }
  return {
    currentTeammate,
    channelTeammates: buildCompactChannelRoster({
      store: input.store,
      channel: input.channel,
      currentTeammateId: input.canonicalTeammateId,
      visibleParticipantTeammateIds: input.visibleParticipantTeammateIds ?? [],
    }),
    visibleParticipantTeammateIds: input.visibleParticipantTeammateIds,
  };
}

function buildCompactChannelRoster(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly currentTeammateId: string;
  readonly visibleParticipantTeammateIds: readonly string[];
}): readonly ChannelDiscussionPromptTeammate[] {
  const visibleParticipantIds = new Set(input.visibleParticipantTeammateIds);
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const defaultTeammate = protocol.protocol.defaultTeammateId
    ? resolveAiTeammateReference(input.store, protocol.protocol.defaultTeammateId)
    : undefined;
  const defaultTeammateId = defaultTeammate?.id ?? protocol.protocol.defaultTeammateId;
  const roster = new Map<string, AiTeammate>();

  for (const teammate of input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 })) {
    const belongsToChannel =
      teammate.id === input.currentTeammateId ||
      teammate.id === defaultTeammateId ||
      visibleParticipantIds.has(teammate.id) ||
      input.store.listTeammateChannelMemberships(teammate.id).some((membership) => membership.channelId === input.channel.id);
    if (belongsToChannel) {
      roster.set(teammate.id, teammate);
    }
  }
  if (defaultTeammate && defaultTeammate.status === "active" && !defaultTeammate.hidden) {
    roster.set(defaultTeammate.id, defaultTeammate);
  }
  for (const teammateId of visibleParticipantIds) {
    const teammate = input.store.getAiTeammate(teammateId);
    if (teammate && teammate.status === "active" && !teammate.hidden) {
      roster.set(teammate.id, teammate);
    }
  }

  return [...roster.values()].map((teammate) => ({
    id: teammate.id,
    displayName: teammate.displayName,
    roleKey: teammate.roleKey,
    isDefault: teammate.id === defaultTeammateId,
    isCurrent: teammate.id === input.currentTeammateId,
    isVisibleParticipant: visibleParticipantIds.has(teammate.id),
  }));
}

function isChannelRosterQuestion(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    /频道.{0,20}(队友|成员|同伴|agent|teammate|member)/i.test(normalized) ||
    /(看到|看见|知道|都有|有谁|多少).{0,20}(队友|成员|同伴|agent|teammate|member)/i.test(normalized) ||
    /(teammates|members).{0,40}(channel|visible|see|available|configured)/i.test(normalized)
  );
}

function uniqueContextSourceRefs(refs: readonly ContextSourceRef[]): readonly ContextSourceRef[] {
  const seen = new Set<string>();
  const unique: ContextSourceRef[] = [];
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

function sumEstimatedTokens(sections: readonly ContextSection[]): number {
  return sections.reduce((total, section) => total + (section.estimatedTokens ?? estimateTextTokens(section.text)), 0);
}

function contextBudgetModeForCapabilities(capabilities: ProviderContextCapabilities): ContextBudgetMode {
  if (capabilities.capabilitySource === "conservative_default" || capabilities.capabilitySource === "non_chat") {
    return "model_unknown";
  }
  return capabilities.capabilityConfidence === "known" ? "model_known" : "model_estimated";
}

function findDropSectionIndex(sections: readonly ContextSection[]): number {
  for (const survival of ["discard", "summarize"] as const) {
    for (const priority of ["low", "medium", "high", "must_keep"] as const) {
      for (let index = sections.length - 1; index >= 0; index -= 1) {
        if (sections[index].compactionSurvival === survival && sections[index].priority === priority) {
          return index;
        }
      }
    }
  }
  return -1;
}

function defaultCompactionSurvivalForRole(role: ContextSectionRole): ChannelContextSectionCompactionSurvival {
  switch (role) {
    case "system":
    case "instruction":
      return "rebuild";
    case "user":
    case "memory":
    case "evidence":
      return "summarize";
  }
}

function stableSectionCompactionId(kind: "text" | "drop", section: ContextSection): string {
  let hash = 0;
  for (const character of `${kind}:${section.id}:${section.text.length}`) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return `context_condenser_section_${kind}_${Math.abs(hash).toString(36)}`;
}
