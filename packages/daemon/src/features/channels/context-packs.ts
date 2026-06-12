import type { AiTeammate, Channel, ChannelAutoReplyMode, ChannelMessage, ChannelResponseLanguage, ChannelWorkflow, ChannelWorkflowStep, ProviderPreset, RunStore, SkillApprovalProfile } from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { formatChannelDiscussionPrompt, type ChannelDiscussionPromptContext, type ChannelDiscussionPromptTeammate } from "./ai-prompts.js";
import {
  resolveEffectiveChannelCollaborationProtocol,
  type ChannelProtocolFieldSource,
  type EffectiveChannelCollaborationProtocolResult,
} from "./collaboration-protocol.js";

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
}

export interface ContextBudget {
  readonly mode: ContextBudgetMode;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedRuntimeOverheadTokens: number;
  readonly inputBudgetTokens: number;
  readonly tokenizer: ProviderContextCapabilities["tokenizer"];
}

export interface ContextSourceRef {
  readonly type:
    | "message"
    | "channel"
    | "teammate"
    | "provider"
    | "memory"
    | "artifact"
    | "run"
    | "decision"
    | "handoff"
    | "summary"
    | "workflow"
    | "workflow_step"
    | "workflow_selector_decision"
    | "workflow_handoff_intent"
    | "context_summary"
    | "workflow_packet_summary";
  readonly id: string;
  readonly label?: string;
}

export interface ContextSection {
  readonly id: string;
  readonly role: ContextSectionRole;
  readonly priority: ContextSectionPriority;
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
}

interface BuildContextPackInput {
  readonly kind: ContextPackKind;
  readonly providerPreset?: ProviderPreset;
  readonly sections: readonly ContextSection[];
  readonly sourceRefs?: readonly ContextSourceRef[];
  readonly compactionIds?: readonly string[];
}

interface ChannelReplyContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammate: AiTeammate | undefined;
  readonly canonicalTeammateId: string;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly compactedChannelSummary?: ChannelCompactedDiscussionSummary;
  readonly minimal?: boolean;
}

interface ChannelIntentSelectorContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
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

export interface ChannelCompactedDiscussionSummary {
  readonly id: string;
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
}

export interface WorkflowStepContextPackInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly prompt: string;
  readonly providerPresetId?: string;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly compactedDependencySummary?: WorkflowStepCompactedDependencySummary;
}

export interface WorkflowStepCompactedDependencySummary {
  readonly id: string;
  readonly text: string;
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly sourceRefIds: readonly string[];
}

const MODEL_UNKNOWN_CONTEXT_WINDOW_TOKENS = 8_192;
const MODEL_ESTIMATED_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 1_024;
const SELECTOR_OUTPUT_TOKENS = 512;
const RUNTIME_OVERHEAD_TOKENS = 512;
const MIN_INPUT_BUDGET_TOKENS = 1_024;

export function resolveProviderContextCapabilities(providerPreset?: ProviderPreset): ProviderContextCapabilities {
  return {
    contextWindowTokens: positiveInteger(providerPreset?.contextWindow),
    maxOutputTokens: positiveInteger(providerPreset?.maxTokens),
    tokenizer: providerPreset?.api === "anthropic-messages" ? "anthropic-compatible" : providerPreset ? "openai-compatible" : "estimated",
    supportsStructuredOutput: providerPreset?.api === "openai-responses" || providerPreset?.api === "openai-completions",
  };
}

export function resolveProviderContextBudget(
  providerPreset: ProviderPreset | undefined,
  kind: ContextPackKind = "channel_reply",
): ContextBudget {
  const capabilities = resolveProviderContextCapabilities(providerPreset);
  const mode = capabilities.contextWindowTokens
    ? "model_known"
    : providerPreset && providerPreset.kind !== "openai-compatible"
      ? "model_estimated"
      : "model_unknown";
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
  };
}

export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const budget = resolveProviderContextBudget(input.providerPreset, input.kind);
  const sections = input.sections.map((section) => ({
    ...section,
    estimatedTokens: section.estimatedTokens ?? estimateTextTokens(section.text),
  }));
  const droppedSectionIds: string[] = [];
  const keptSections = [...sections];
  let estimatedInputTokens = sumEstimatedTokens(keptSections);

  while (estimatedInputTokens > budget.inputBudgetTokens) {
    const dropIndex = findDropSectionIndex(keptSections);
    if (dropIndex < 0) {
      break;
    }
    const [dropped] = keptSections.splice(dropIndex, 1);
    droppedSectionIds.push(dropped.id);
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
    compactionIds: input.compactionIds ?? [],
    estimatedInputTokens,
    overBudget: estimatedInputTokens > budget.inputBudgetTokens,
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

export function buildChannelReplyContextPack(input: ChannelReplyContextPackInput): ContextPack {
  const discussionPromptContext = buildChannelDiscussionPromptContext(input);
  const protocolSection = buildChannelProtocolContextSection(input);
  const kind: ContextPackKind = (input.visibleParticipantTeammateIds?.length ?? 0) > 0
    ? "visible_multi_reply"
    : "channel_reply";
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const compactedSummarySection = input.compactedChannelSummary
    ? [buildCompactedChannelDiscussionSection(input.compactedChannelSummary)]
    : [];
  return buildContextPack({
    kind,
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sections: [
      protocolSection,
      ...compactedSummarySection,
      {
        id: "channel_discussion",
        role: "user",
        priority: "must_keep",
        text: formatChannelDiscussionPrompt(input.channel, sourceMessage, discussionPromptContext),
        sourceRefIds: [sourceMessage.id, input.channel.id],
      },
    ],
    sourceRefs: [
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: sourceMessage.id, label: "Source message" },
      ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
    ],
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
  });
}

export function buildChannelIntentSelectorContextPack(input: ChannelIntentSelectorContextPackInput): ContextPack {
  const protocolSection = buildChannelProtocolContextSection(input);
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const recentMessages = input.minimal
    ? ""
    : listRecentContextMessages(input.store, input.channel.id, input.sourceMessage)
      .filter((message) => message.id !== input.sourceMessage.id)
      .map((message) => `${message.authorType}: ${message.body.slice(0, 180)}`)
      .join("\n");
  const teammateRoles = input.store
    .listAiTeammates({ status: "active", includeHidden: false, limit: 20 })
    .map((teammate) => ({ id: teammate.id, role: teammate.roleKey, label: teammate.displayName }))
    .slice(0, 12);
  return buildContextPack({
    kind: "intent_selector",
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sections: [
      {
        id: "selector_instructions",
        role: "instruction",
        priority: "must_keep",
        text: [
          "Classify the latest user channel message into exactly one Ling intent.",
          "Return strict JSON only: {\"action\":\"no_reply|single_reply|visible_multi_reply|clarify|workflow_proposal|direct_workflow\",\"reason\":\"short reason\"}.",
          "Use single_reply for ordinary questions one teammate should answer.",
          "Use visible_multi_reply only for explicit discussion-only requests asking multiple teammates for visible opinions; do not use it for implementation, validation, publishing, merge, deploy, or tool-running work.",
          "Use clarify for work-shaped requests missing target, scope, or acceptance checks.",
          "Use workflow_proposal for multi-role work that needs user confirmation before execution.",
          "Use direct_workflow only when the user explicitly asks to start/run a workflow; it still requires confirmation.",
          "Use no_reply only to mean the message is not executable or collaborative work; Ling Agent still falls through to ordinary reply handling.",
        ].join("\n"),
      },
      protocolSection,
      ...(input.compactedChannelSummary ? [buildCompactedChannelDiscussionSection(input.compactedChannelSummary)] : []),
      {
        id: "selector_source_message",
        role: "user",
        priority: "must_keep",
        text: [`Channel: ${input.channel.name}`, `Latest user message: ${sourceMessage.body}`].join("\n"),
        sourceRefIds: [input.channel.id, sourceMessage.id],
      },
      {
        id: "selector_recent_context",
        role: "evidence",
        priority: "low",
        text: recentMessages ? `Recent context:\n${recentMessages}` : "Recent context: none",
      },
      {
        id: "selector_teammate_roles",
        role: "evidence",
        priority: "high",
        text: `Available teammate roles JSON: ${JSON.stringify(teammateRoles)}`,
      },
    ],
    sourceRefs: [
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: sourceMessage.id, label: "Latest user message" },
      ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
    ],
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
  });
}

export function buildChannelAutoRouteContextPack(input: ChannelAutoRouteContextPackInput): ContextPack {
  const protocolSection = buildChannelProtocolContextSection(input);
  const sourceMessage = contextSourceMessage(input.sourceMessage, input.minimal ? 1_200 : undefined);
  const recentMessages = input.minimal
    ? ""
    : listRecentContextMessages(input.store, input.channel.id, input.sourceMessage)
      .filter((message) => message.id !== input.sourceMessage.id)
      .map((message) => `${message.authorType}: ${message.body.slice(0, 180)}`)
      .join("\n");
  return buildContextPack({
    kind: "auto_route_selector",
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sections: [
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
      {
        id: "auto_route_source_message",
        role: "user",
        priority: "must_keep",
        text: [`Channel: ${input.channel.name}`, `Latest user message: ${sourceMessage.body}`].join("\n"),
        sourceRefIds: [input.channel.id, sourceMessage.id],
      },
      {
        id: "auto_route_recent_context",
        role: "evidence",
        priority: "low",
        text: recentMessages ? `Recent context:\n${recentMessages}` : "Recent context: none",
      },
      {
        id: "auto_route_candidates",
        role: "evidence",
        priority: "high",
        text: `Candidates JSON: ${JSON.stringify(input.candidates)}`,
      },
    ],
    sourceRefs: [
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "message", id: sourceMessage.id, label: "Latest user message" },
      ...(input.compactedChannelSummary ? [{ type: "context_summary" as const, id: input.compactedChannelSummary.id, label: "Compacted channel discussion" }] : []),
    ],
    compactionIds: input.compactedChannelSummary ? [input.compactedChannelSummary.id] : undefined,
  });
}

function listRecentContextMessages(store: RunStore, channelId: string, sourceMessage: ChannelMessage): readonly ChannelMessage[] {
  const historicalGuidanceMessageIds = new Set(
    store
      .listRunInterventions({ limit: 500 })
      .map((intervention) => parseChannelMessageGuidanceIdempotencyKey(intervention.idempotencyKey))
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  return store
    .listChannelMessages({ channelId, limit: 8 })
    .filter((message) => message.id === sourceMessage.id || !historicalGuidanceMessageIds.has(message.id));
}

function parseChannelMessageGuidanceIdempotencyKey(idempotencyKey: string): string | undefined {
  const prefix = "channel_message:";
  const suffix = ":queue_followup";
  if (!idempotencyKey.startsWith(prefix) || !idempotencyKey.endsWith(suffix)) {
    return undefined;
  }
  return idempotencyKey.slice(prefix.length, -suffix.length) || undefined;
}

export function buildWorkflowStepContextPack(input: WorkflowStepContextPackInput): ContextPack {
  const sourceRefs = buildWorkflowStepContextSourceRefs(input);
  const protocolSection = buildChannelProtocolContextSection(input);
  const dependencySections = input.compactedDependencySummary
    ? [buildCompactedWorkflowDependencySection(input.compactedDependencySummary)]
    : buildWorkflowStepDependencySections(input);
  const contextSummary = input.step.contextSummaryId
    ? input.store.getChannelContextSummary(input.step.contextSummaryId)
    : undefined;
  return buildContextPack({
    kind: "workflow_step",
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    sourceRefs: input.compactedDependencySummary
      ? uniqueContextSourceRefs([...sourceRefs, ...input.compactedDependencySummary.sourceRefs])
      : sourceRefs,
    compactionIds: input.compactedDependencySummary ? [input.compactedDependencySummary.id] : undefined,
    sections: [
      {
        id: "workflow_runtime_boundary",
        role: "instruction",
        priority: "must_keep",
        text: [
          "Workflow step runtime boundary:",
          "- Complete this step only.",
          "- Do not start, approve, skip, or mark later workflow steps.",
          "- The Ling orchestrator owns sequencing, workflow state transitions, and approval gates.",
          "- Do not self-approve tools, writes, releases, external sends, deploys, or other side effects.",
          "- Return a concise terminal summary plus artifacts, blockers, decisions, or handoff needs for later steps.",
        ].join("\n"),
      },
      {
        id: "workflow_objective",
        role: "user",
        priority: "must_keep",
        text: [
          "Workflow objective:",
          input.workflow.objective || "No objective provided.",
          "",
          `Workflow: ${input.workflow.title}`,
          `Channel: ${input.channel.name}`,
          input.channel.boundPath ? `Bound path: ${input.channel.boundPath}` : undefined,
        ].filter((line): line is string => line !== undefined).join("\n"),
        sourceRefIds: [input.workflow.id, input.channel.id],
      },
      {
        id: "workflow_current_step",
        role: "user",
        priority: "must_keep",
        text: [
          "Current workflow step:",
          `Title: ${input.step.title}`,
          `Workflow step id: ${input.step.id}`,
          input.step.metadata?.templateStepId ? `Template step id: ${input.step.metadata.templateStepId}` : undefined,
          input.step.metadata?.graphNodeId ? `Graph node id: ${input.step.metadata.graphNodeId}` : undefined,
          input.step.toParticipantId ? `Assigned teammate: ${input.step.toParticipantLabel ?? input.step.toParticipantId} (${input.step.toParticipantId})` : undefined,
          input.step.metadata?.skillId ? `Skill: ${input.step.metadata.skillId}` : undefined,
          "",
          "Step instruction:",
          input.prompt,
        ].filter((line): line is string => line !== undefined).join("\n"),
        sourceRefIds: [input.step.id],
      },
      {
        id: "workflow_approval_gates",
        role: "instruction",
        priority: "high",
        text: [
          "Approval gates:",
          ...formatWorkflowApprovalGatePromptLines(input.step),
        ].join("\n"),
        sourceRefIds: [input.step.id],
      },
      ...dependencySections,
      ...formatWorkflowDecisionAndHandoffSections(input),
      ...(contextSummary
        ? [{
            id: "workflow_context_summary",
            role: "evidence" as const,
            priority: "medium" as const,
            text: [
              "Channel context summary:",
              contextSummary.summary,
              contextSummary.acceptanceCriteria.length > 0 ? `Acceptance criteria: ${contextSummary.acceptanceCriteria.join("; ")}` : undefined,
              contextSummary.openQuestions.length > 0 ? `Open questions: ${contextSummary.openQuestions.join("; ")}` : undefined,
            ].filter((line): line is string => line !== undefined).join("\n"),
            sourceRefIds: [contextSummary.id],
          }]
        : []),
      protocolSection,
    ],
  });
}

export function buildChannelProtocolContextSection(input: {
  readonly store: RunStore;
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

function buildCompactedWorkflowDependencySection(summary: WorkflowStepCompactedDependencySummary): ContextSection {
  return {
    id: "workflow_dependency_summary",
    role: "evidence",
    priority: "high",
    text: summary.text,
    sourceRefIds: summary.sourceRefIds,
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

function buildWorkflowStepDependencySections(input: WorkflowStepContextPackInput): readonly ContextSection[] {
  const stepsById = new Map(input.workflowSteps.map((candidate) => [candidate.id, candidate] as const));
  const dependencies = (input.step.metadata?.dependsOnStepIds ?? [])
    .map((stepId) => stepsById.get(stepId))
    .filter((candidate): candidate is ChannelWorkflowStep => candidate !== undefined);
  if (dependencies.length === 0) {
    return [{
      id: "workflow_dependencies",
      role: "evidence",
      priority: "high",
      text: "Dependencies:\n- none",
      sourceRefIds: [input.step.id],
    }];
  }
  return dependencies.map((dependency, index) => {
    const artifactIds = uniqueStrings([
      dependency.metadata?.outputArtifactId,
      ...(dependency.metadata?.outputArtifactIds ?? []),
      ...(dependency.runId ? input.store.listArtifacts(dependency.runId).map((artifact) => artifact.id) : []),
    ]);
    return {
      id: `workflow_dependency_${index + 1}`,
      role: "evidence",
      priority: "high",
      text: [
        "Dependency output:",
        `- ${dependency.title} (${dependency.status})`,
        `  workflowStepId: ${dependency.id}`,
        `  runId: ${dependency.runId ?? "none"}`,
        `  outputArtifactId: ${dependency.metadata?.outputArtifactId ?? "none"}`,
        `  artifactIds: ${artifactIds.length > 0 ? artifactIds.join(", ") : "none"}`,
        `  resultSummary: ${dependency.resultSummary ? truncateWorkflowPromptValue(dependency.resultSummary, 420) : "none"}`,
      ].filter((line): line is string => line !== undefined).join("\n"),
      sourceRefIds: [dependency.id, ...artifactIds],
    };
  });
}

function formatWorkflowDecisionAndHandoffSections(input: WorkflowStepContextPackInput): readonly ContextSection[] {
  const selectorDecisionIds = input.step.metadata?.selectorDecisionIds ?? [];
  const handoffIntentIds = input.step.metadata?.handoffIntentIds ?? [];
  const sections: ContextSection[] = [];
  if (selectorDecisionIds.length > 0) {
    const lines = selectorDecisionIds.map((decisionId) => {
      const decision = input.store.getWorkflowSelectorDecision(decisionId);
      return decision
        ? `- ${decision.targetKind}: ${decision.reason} (status=${decision.status}, createdBy=${decision.createdBy})`
        : `- ${decisionId}: missing selector decision`;
    });
    sections.push({
      id: "workflow_selector_decisions",
      role: "evidence",
      priority: "high",
      text: ["Workflow selector decisions:", ...lines].join("\n"),
      sourceRefIds: selectorDecisionIds,
    });
  }
  if (handoffIntentIds.length > 0) {
    const lines = handoffIntentIds.map((intentId) => {
      const intent = input.store.getWorkflowHandoffIntent(intentId);
      return intent
        ? `- ${intent.fromParticipantLabel} -> ${intent.toParticipantLabel ?? intent.toParticipantId}: ${intent.reason} (status=${intent.status})`
        : `- ${intentId}: missing handoff intent`;
    });
    sections.push({
      id: "workflow_handoff_intents",
      role: "evidence",
      priority: "high",
      text: ["Workflow handoff intents:", ...lines].join("\n"),
      sourceRefIds: handoffIntentIds,
    });
  }
  return sections;
}

function buildWorkflowStepContextSourceRefs(input: WorkflowStepContextPackInput): readonly ContextSourceRef[] {
  const refs: ContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "workflow", id: input.workflow.id, label: input.workflow.title },
    { type: "workflow_step", id: input.step.id, label: input.step.title },
  ];
  if (input.step.contextSummaryId) {
    const summary = input.store.getChannelContextSummary(input.step.contextSummaryId);
    refs.push({ type: "context_summary", id: input.step.contextSummaryId, label: summary?.summary });
  }
  for (const stepId of input.step.metadata?.dependsOnStepIds ?? []) {
    const dependency = input.workflowSteps.find((candidate) => candidate.id === stepId);
    refs.push({ type: "workflow_step", id: stepId, label: dependency?.title });
    if (dependency?.metadata?.outputArtifactId) {
      const artifact = input.store.getArtifact(dependency.metadata.outputArtifactId);
      refs.push({ type: "artifact", id: dependency.metadata.outputArtifactId, label: artifact?.title ?? artifact?.path });
    }
    for (const artifactId of dependency?.metadata?.outputArtifactIds ?? []) {
      const artifact = input.store.getArtifact(artifactId);
      refs.push({ type: "artifact", id: artifactId, label: artifact?.title ?? artifact?.path });
    }
    if (dependency?.runId) {
      refs.push({ type: "run", id: dependency.runId, label: "Dependency run" });
      for (const artifact of input.store.listArtifacts(dependency.runId)) {
        refs.push({ type: "artifact", id: artifact.id, label: artifact.title ?? artifact.path });
      }
    }
  }
  for (const decisionId of input.step.metadata?.selectorDecisionIds ?? []) {
    const decision = input.store.getWorkflowSelectorDecision(decisionId);
    refs.push({ type: "workflow_selector_decision", id: decisionId, label: decision?.reason });
  }
  for (const intentId of input.step.metadata?.handoffIntentIds ?? []) {
    const intent = input.store.getWorkflowHandoffIntent(intentId);
    refs.push({ type: "workflow_handoff_intent", id: intentId, label: intent?.reason });
  }
  return uniqueContextSourceRefs(refs);
}

function formatWorkflowApprovalGatePromptLines(step: ChannelWorkflowStep): readonly string[] {
  const lines: string[] = [];
  if (step.metadata?.approvalGate) {
    lines.push(`- pre-run: ${formatApprovalProfileSummary(step.metadata.approvalGate)}`);
  }
  for (const gate of step.metadata?.gates ?? []) {
    lines.push(`- ${gate.stage}: ${gate.title} (${formatApprovalProfileSummary(gate.approvalProfile)})`);
    lines.push(`  reason: ${truncateWorkflowPromptValue(gate.reason, 180)}`);
    lines.push(`  requiredForStatuses: ${gate.requiredForStatuses?.join(", ") ?? "any"}`);
  }
  return lines.length > 0 ? lines : ["- none"];
}

function formatApprovalProfileSummary(profile: SkillApprovalProfile): string {
  return [
    `mode=${profile.mode}`,
    profile.risk ? `risk=${profile.risk}` : undefined,
    profile.requiredForTools?.length ? `tools=${profile.requiredForTools.join(",")}` : undefined,
    profile.requiredForActions?.length ? `actions=${profile.requiredForActions.join(",")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
}

function truncateWorkflowPromptValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
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

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function sumEstimatedTokens(sections: readonly ContextSection[]): number {
  return sections.reduce((total, section) => total + (section.estimatedTokens ?? estimateTextTokens(section.text)), 0);
}

function findDropSectionIndex(sections: readonly ContextSection[]): number {
  for (const priority of ["low", "medium", "high"] as const) {
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      if (sections[index].priority === priority) {
        return index;
      }
    }
  }
  return -1;
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}
