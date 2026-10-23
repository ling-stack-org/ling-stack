import type { Channel, ChannelMessage, ChannelWorkflowStep, RunArtifact, RunExecutionStoreFacet, RunStore } from "@ling-stack/core";
import type { ConversationContextSummary } from "@ling-stack/contracts";
import {
  buildWorkflowStepContextPack,
  type ContextPack,
  type ContextSourceRef,
  type WorkflowStepContextPackInput,
} from "./context-packs.js";
import {
  buildConversationContextProjection,
  projectConversationContextMessages,
} from "./context-processing/conversation-context-projector.js";
import {
  coordinateConversationContextSummary,
  type ConversationSummaryDraft,
} from "./context-processing/conversation-summary-coordinator.js";

export interface WorkflowStepContextCompactionSummary {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: "workflow_packet_summary";
  readonly channelId: string;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly sourceRefs: readonly ContextSourceRef[];
  readonly summary: string;
  readonly dependencyOutputRefs: readonly {
    readonly workflowStepId: string;
    readonly outputArtifactId?: string;
    readonly resultSummary?: string;
  }[];
  readonly openQuestions: readonly string[];
  readonly droppedSectionIds: readonly string[];
  readonly generatedAt: string;
}

export interface WorkflowStepContextCompactionResult {
  readonly contextPack: ContextPack;
  readonly compactions: readonly WorkflowStepContextCompactionSummary[];
}

export interface ChannelDiscussionCompactionResult {
  readonly summary?: ConversationContextSummary;
  readonly compactedSummary: {
    readonly id: string;
    readonly text: string;
    readonly sourceMessageIds: readonly string[];
  };
}

const CONTEXT_LENGTH_ERROR_PATTERNS = [
  /context[_ -]?length/i,
  /context window/i,
  /maximum context/i,
  /token limit/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input.*too long/i,
];

export function isContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CONTEXT_LENGTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export async function compactChannelDiscussionForNoToolsRetry(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly inputBudgetTokens: number;
  readonly now: string;
}): Promise<ChannelDiscussionCompactionResult> {
  // Maintenance requires at least 1024 input tokens. A smaller real budget is
  // not an invitation to invent capacity; the caller still gates the rendered retry.
  const result = Number.isSafeInteger(input.inputBudgetTokens) && input.inputBudgetTokens >= 1024
    ? await coordinateConversationContextSummary({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    inputBudgetTokens: input.inputBudgetTokens,
    policy: {
      softCompletedTurnCount: 2,
      softInputBudgetRatio: 0.01,
      hardInputBudgetRatio: 0.02,
      targetInputBudgetRatio: 0.1,
      rawTailCompletedTurnCount: 1,
      generationChunkBudgetRatio: 0.1,
    },
    generate: emergencySummaryDraft,
    now: input.now,
  }) : undefined;
  const summary = result?.status === "completed" && result.commit.status === "committed"
    ? result.commit.summary
    : selectActiveSegmentSummary(input.store, input.sourceMessage.id);
  const sourceMessages = selectChannelSummaryMessages(input.store, input.channel, input.sourceMessage);
  const summaryText = summary
    ? renderCanonicalConversationSummary(summary)
    : renderChannelDiscussionSummary(input.channel, input.sourceMessage, sourceMessages);
  const sourceMessageIds = summary
    ? summary.sourceRefs
        .filter((ref) => ref.type === "conversation_item")
        .map((ref) => ref.id)
    : sourceMessages.map((message) => message.id);
  return {
    ...(summary ? { summary } : {}),
    compactedSummary: {
      id: summary?.id ?? `context_retry_${input.sourceMessage.id}`,
      text: [
        "Compacted channel discussion summary for a no-tools retry:",
        summaryText,
        "",
        "Use this summary instead of expanding older channel history. It excludes private teammate chat, hidden prompts, provider secrets, raw artifact bodies, and protocol mutations.",
      ].join("\n"),
      sourceMessageIds,
    },
  };
}

async function emergencySummaryDraft(input: {
  readonly current: ConversationSummaryDraft;
  readonly items: readonly import("@ling-stack/contracts").ConversationItemV1[];
}): Promise<ConversationSummaryDraft> {
  const latestUserBody = [...input.items]
    .reverse()
    .find((item) => item.kind === "user_message")?.payload.body;
  return {
    objective: input.current.objective ?? (latestUserBody ? truncateSummary(latestUserBody, 1_200) : undefined),
    decisions: input.current.decisions,
    constraints: input.current.constraints,
    openQuestions: input.current.openQuestions,
  };
}

function selectActiveSegmentSummary(
  store: RunStore,
  sourceItemId: string,
): ConversationContextSummary | undefined {
  const projection = buildConversationContextProjection({ store, sourceItemId, view: "reply" });
  return projection.summaries.find((summary) =>
    summary.scope === "segment" && summary.segmentId === projection.metadata.segmentId);
}

function renderCanonicalConversationSummary(summary: ConversationContextSummary): string {
  return [
    summary.objective ? `Objective: ${summary.objective}` : undefined,
    summary.decisions.length > 0 ? `Decisions: ${summary.decisions.join(" | ")}` : undefined,
    summary.constraints.length > 0 ? `Constraints: ${summary.constraints.join(" | ")}` : undefined,
    summary.openQuestions.length > 0 ? `Open questions: ${summary.openQuestions.join(" | ")}` : undefined,
    `Coverage: ${summary.coveredFromSequence}-${summary.coveredThroughSequence}`,
    `Source refs: ${summary.sourceRefs.length}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function maybeCompactWorkflowStepContext(input: {
  readonly packInput: WorkflowStepContextPackInput;
  readonly contextPack: ContextPack;
  readonly now: string;
}): WorkflowStepContextCompactionResult {
  if (!shouldCompactWorkflowStepContext(input.contextPack)) {
    return { contextPack: input.contextPack, compactions: [] };
  }

  const dependencies = workflowStepDependencies(input.packInput);
  if (dependencies.length === 0) {
    return { contextPack: input.contextPack, compactions: [] };
  }

  const summary = buildWorkflowStepCompactionSummary({
    ...input.packInput,
    dependencies,
    droppedSectionIds: input.contextPack.droppedSectionIds,
    now: input.now,
  });
  const compactedDependencySummary = {
    id: summary.id,
    text: renderWorkflowStepCompactionSection(summary),
    sourceRefs: summary.sourceRefs,
    sourceRefIds: summary.sourceRefs.map((ref) => ref.id),
  };
  const compactedPack = buildWorkflowStepContextPack({
    ...input.packInput,
    compactedDependencySummary,
  });
  return {
    contextPack: compactedPack,
    compactions: [summary],
  };
}

function shouldCompactWorkflowStepContext(pack: ContextPack): boolean {
  return pack.overBudget || pack.droppedSectionIds.some((id) => id === "workflow_dependencies" || id.startsWith("workflow_dependency_"));
}

function selectChannelSummaryMessages(store: RunStore, channel: Channel, sourceMessage: ChannelMessage): readonly ChannelMessage[] {
  const projection = buildConversationContextProjection({
    store,
    sourceItemId: sourceMessage.id,
    view: "reply",
    maxTailTextChars: 8_192,
  });
  return projectConversationContextMessages(projection, store)
    .filter((message) => message.status !== "pending" && Boolean(message.body.trim()));
}

function renderChannelDiscussionSummary(channel: Channel, sourceMessage: ChannelMessage, messages: readonly ChannelMessage[]): string {
  const projectedLines = messages.map((message) => [
    `- ${message.createdAt} ${message.authorType}${message.authorId ? `:${message.authorId}` : ""}`,
    message.threadId ? `thread=${message.threadId}` : undefined,
    `kind=${message.kind}`,
    `body=${truncateSummary(message.body, 240)}`,
  ].filter((line): line is string => line !== undefined).join("; "));
  return [
    `Channel: ${channel.name} (${channel.id})`,
    `Source message: ${sourceMessage.id}`,
    `Compacted visible message count: ${messages.length}.`,
    "Projected visible conversation items:",
    ...projectedLines,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function workflowStepDependencies(input: WorkflowStepContextPackInput): readonly ChannelWorkflowStep[] {
  const stepsById = new Map(input.workflowSteps.map((step) => [step.id, step] as const));
  return (input.step.metadata?.dependsOnStepIds ?? [])
    .map((stepId) => stepsById.get(stepId))
    .filter((step): step is ChannelWorkflowStep => step !== undefined);
}

function buildWorkflowStepCompactionSummary(input: WorkflowStepContextPackInput & {
  readonly dependencies: readonly ChannelWorkflowStep[];
  readonly droppedSectionIds: readonly string[];
  readonly now: string;
}): WorkflowStepContextCompactionSummary {
  const sourceRefs = buildCompactionSourceRefs(input.store, input.dependencies);
  const dependencyOutputRefs = input.dependencies.map((dependency) => ({
    workflowStepId: dependency.id,
    outputArtifactId: dependency.metadata?.outputArtifactId,
    resultSummary: dependency.resultSummary ? truncateSummary(dependency.resultSummary, 260) : undefined,
  }));
  return {
    schemaVersion: 1,
    id: stableCompactionId(input.workflow.id, input.step.id, input.droppedSectionIds, input.dependencies),
    kind: "workflow_packet_summary",
    channelId: input.channel.id,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    sourceRefs,
    summary: [
      `Compacted dependency context for workflow step "${input.step.title}".`,
      `Dependency count: ${input.dependencies.length}.`,
      "The summary contains dependency statuses, terminal summaries, and artifact references only.",
      "It does not include private teammate chat, raw artifact bodies, channel protocol edits, or memory authority changes.",
      "",
      ...input.dependencies.slice(0, 20).map((dependency) => renderDependencySummary(input.store, dependency)),
      input.dependencies.length > 20 ? `- ${input.dependencies.length - 20} additional dependencies omitted from prompt summary; see source refs.` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n"),
    dependencyOutputRefs,
    openQuestions: [],
    droppedSectionIds: input.droppedSectionIds,
    generatedAt: input.now,
  };
}

function buildCompactionSourceRefs(store: RunExecutionStoreFacet, dependencies: readonly ChannelWorkflowStep[]): readonly ContextSourceRef[] {
  const refs: ContextSourceRef[] = [];
  for (const dependency of dependencies) {
    refs.push({ type: "workflow_step", id: dependency.id, label: dependency.title });
    if (dependency.runId) {
      refs.push({ type: "run", id: dependency.runId, label: "Dependency run" });
    }
    for (const artifact of dependencyArtifacts(store, dependency)) {
      refs.push({ type: "artifact", id: artifact.id, label: artifact.title ?? artifact.path });
    }
  }
  return uniqueSourceRefs(refs);
}

function renderWorkflowStepCompactionSection(summary: WorkflowStepContextCompactionSummary): string {
  const dependencyLines = summary.dependencyOutputRefs.slice(0, 20).map((ref) => [
    `- workflowStepId: ${ref.workflowStepId}`,
    ref.outputArtifactId ? `outputArtifactId: ${ref.outputArtifactId}` : "outputArtifactId: none",
    `resultSummary: ${ref.resultSummary ? truncateSummary(ref.resultSummary, 120) : "none"}`,
  ].join("; "));
  return [
    "Compacted workflow dependency summary:",
    `Compaction id: ${summary.id}`,
    `Dependency outputs compacted: ${summary.dependencyOutputRefs.length}.`,
    `Dropped sections before compaction: ${summary.droppedSectionIds.length > 0 ? summary.droppedSectionIds.join(", ") : "none"}`,
    "Dependency output refs:",
    ...dependencyLines,
    summary.dependencyOutputRefs.length > dependencyLines.length
      ? `- ${summary.dependencyOutputRefs.length - dependencyLines.length} additional dependency refs omitted from prompt; inspect the compaction artifact.`
      : undefined,
    `Source ref count: ${summary.sourceRefs.length}.`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderDependencySummary(store: RunExecutionStoreFacet, dependency: ChannelWorkflowStep): string {
  const artifacts = dependencyArtifacts(store, dependency);
  const artifactIds = artifacts.map((artifact) => artifact.id).slice(0, 8);
  return [
    `- ${dependency.title} (${dependency.status})`,
    `  workflowStepId: ${dependency.id}`,
    dependency.runId ? `  runId: ${dependency.runId}` : undefined,
    dependency.metadata?.outputArtifactId ? `  outputArtifactId: ${dependency.metadata.outputArtifactId}` : undefined,
    artifactIds.length > 0 ? `  artifactIds: ${artifactIds.join(", ")}` : undefined,
    artifacts.length > artifactIds.length ? `  additionalArtifacts: ${artifacts.length - artifactIds.length}` : undefined,
    `  resultSummary: ${dependency.resultSummary ? truncateSummary(dependency.resultSummary, 220) : "none"}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function dependencyArtifacts(store: RunExecutionStoreFacet, dependency: ChannelWorkflowStep): readonly RunArtifact[] {
  const artifacts = new Map<string, RunArtifact>();
  for (const artifactId of [
    dependency.metadata?.outputArtifactId,
    ...(dependency.metadata?.outputArtifactIds ?? []),
  ]) {
    if (!artifactId) {
      continue;
    }
    const artifact = store.getArtifact(artifactId);
    if (artifact) {
      artifacts.set(artifact.id, artifact);
    }
  }
  if (dependency.runId) {
    for (const artifact of store.listArtifacts(dependency.runId)) {
      artifacts.set(artifact.id, artifact);
    }
  }
  return [...artifacts.values()];
}

function stableCompactionId(
  workflowId: string,
  stepId: string,
  droppedSectionIds: readonly string[],
  dependencies: readonly ChannelWorkflowStep[],
): string {
  const seed = [
    workflowId,
    stepId,
    droppedSectionIds.join(","),
    dependencies.map((dependency) => `${dependency.id}:${dependency.status}:${dependency.metadata?.outputArtifactId ?? ""}`).join("|"),
  ].join("::");
  let hash = 0;
  for (const character of seed) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return `workflow_packet_summary_${Math.abs(hash).toString(36)}`;
}

function truncateSummary(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function uniqueSourceRefs(refs: readonly ContextSourceRef[]): readonly ContextSourceRef[] {
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
