import { type Channel, type ChannelMessage, type RunSession, type RunStore, type SecretResolver } from "@ling-stack/core";
import { renderUsedMemoryPromptForView } from "../memory/prompt.js";
import { isRunTool } from "../runs/approvals.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import { extractChannelExecutionProposal } from "./ai-proposals.js";
import { compactChannelDiscussionForNoToolsRetry, isContextLengthError } from "./context-compaction.js";
import { buildChannelReplyContextPack, renderContextPack } from "./context-packs.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import {
  buildLingAgentTurnEnvelope,
  renderLingAgentTurnEnvelopeSearchText,
  type LingAgentTurnEnvelope,
} from "./ling-agent-turn-envelope.js";
import { runChannelObserverBusForTurn } from "./observer-bus.js";
import {
  recordProviderContextLengthObservation,
  recordProviderRuntimeAvailabilityIncident,
} from "./provider-runtime-observations.js";
import { resolveChannelResponseLanguage, responseLanguageInstruction } from "./response-language.js";
import { buildChannelWebContext, prependChannelWebContext, type ChannelWebContext } from "./web-tools.js";
import {
  recordMessageWebEvidenceEvent,
  recordMessageWebEvidenceProgressEvent,
  renderWebEvidenceProgressPendingBody,
} from "../web/message-web-evidence.js";
import type { WebEvidenceProgressEvent } from "../web/web-evidence-service.js";
import { buildChannelReplyRunRequest } from "./channel-reply-execution.js";
import {
  CHANNEL_PROMPT_LEAK_ERROR_MESSAGE,
  createChannelReplyRunProjection,
  isChannelReplyPromptLeak,
  visibleChannelReplyText,
} from "./channel-reply-run-projection.js";

export type StartChannelReplyRun = (runRequest: RunRequest, sink: RunExecutionSink) => Promise<string | undefined>;

export async function createAiChannelReply(input: {
  readonly startRun: StartChannelReplyRun;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly secretResolver: SecretResolver;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly teamObserverBusEnabled?: boolean;
  readonly completionMode?: "background" | "inline";
  readonly trackCompletion?: (completion: Promise<unknown>) => void;
  readonly replyMessageId?: string;
  readonly disableWebEvidence?: boolean;
  readonly onRunLinked?: (runId: string) => void;
  readonly onDispatchSettled?: () => void;
  readonly stream?: {
    readonly onReady: (message: ChannelMessage) => void;
    readonly onRunLinked?: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
}): Promise<ChannelMessage> {
  if (input.replyMessageId) {
    const existing = input.store.getChannelMessage(input.replyMessageId);
    if (existing) {
      notifyDispatchSettled(input.onDispatchSettled);
      return existing;
    }
  }
  const now = new Date().toISOString();
  const teammateId =
    input.teammateId ??
    input.sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id ??
    LING_AGENT_EXECUTOR_ID;
  const target = resolveChannelReplyExecutionTarget({
    store: input.store,
    channel: input.channel,
    requestedTeammateId: teammateId,
    requestedProviderPresetId: input.providerPresetId,
    now,
  });
  const { teammate, teammateId: canonicalTeammateId, providerPresetId } = target;
  const pending = input.store.createChannelMessage(
    {
      ...(input.replyMessageId ? { id: input.replyMessageId } : {}),
      channelId: input.channel.id,
      threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: canonicalTeammateId,
      body: input.completionMode === "inline" ? "" : "AI teammate is preparing a reply...",
      status: "pending",
    },
    now,
  );
  input.stream?.onReady(pending);

  const completion = completeAiChannelReply({
    ...input,
    pending,
    teammate,
    canonicalTeammateId,
    providerPresetId,
    now,
  }).finally(() => notifyDispatchSettled(input.onDispatchSettled));
  if (input.completionMode === "inline") {
    return await completion;
  }
  input.trackCompletion?.(completion);
  void completion;
  return pending;
}

async function completeAiChannelReply(input: {
  readonly startRun: StartChannelReplyRun;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly secretResolver: SecretResolver;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly teamObserverBusEnabled?: boolean;
  readonly disableWebEvidence?: boolean;
  readonly onRunLinked?: (runId: string) => void;
  readonly pending: ChannelMessage;
  readonly teammate: ReturnType<typeof resolveChannelReplyExecutionTarget>["teammate"];
  readonly canonicalTeammateId: string;
  readonly now: string;
  readonly stream?: {
    readonly onReady: (message: ChannelMessage) => void;
    readonly onRunLinked?: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
}): Promise<ChannelMessage> {
  if (input.teammate && input.teammate.status !== "active") {
    const blocked = finishChannelMessage(input.store, input.pending.id, {
      body: `AI teammate is ${input.teammate.status}.`,
      status: "blocked",
      errorMessage: `Teammate status is ${input.teammate.status}.`,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  if (!input.providerPresetId) {
    const blocked = finishChannelMessage(input.store, input.pending.id, {
      body: "AI teammate is not configured for this channel.",
      status: "blocked",
      errorMessage: "No provider preset is selected for this channel discussion.",
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  const webProgressEvents: WebEvidenceProgressEvent[] = [];
  let observerBusError: string | undefined;
  try {
    const turnEnvelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
    });
    try {
      runChannelObserverBusForTurn({
        enabled: input.teamObserverBusEnabled === true,
        store: input.store,
        channel: input.channel,
        sourceMessageId: input.sourceMessage.id,
        turnEnvelope,
        now: input.now,
      });
    } catch (error) {
      observerBusError = error instanceof Error ? error.message : String(error);
    }
    const memoryRecall = input.store.recallMemory({
      teammateId: input.canonicalTeammateId,
      channelId: input.channel.id,
      intent: "channel-reply",
      query: renderLingAgentTurnEnvelopeSearchText(turnEnvelope) || input.sourceMessage.body,
      maxResults: 6,
    });
    const renderedMemory = renderUsedMemoryPromptForView({
      memories: memoryRecall.memories,
      recallPolicyVersion: memoryRecall.policyVersion,
      viewKind: "ling_agent_channel_view",
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      consumerTeammateId: input.canonicalTeammateId,
    });
    const memoryPrompt = renderedMemory.prompt;
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    let discussionContextPack = buildChannelReplyContextPack({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
      providerPresetId: input.providerPresetId,
      teammate: input.teammate,
      canonicalTeammateId: input.canonicalTeammateId,
      visibleParticipantTeammateIds: input.visibleParticipantTeammateIds,
    });
    const webContext = input.disableWebEvidence
      ? { status: "not_applicable" as const }
      : await buildChannelWebContext({
        store: input.store,
        providerPresetId: input.providerPresetId,
        sourceMessage: input.sourceMessage,
        turnEnvelope,
        secretResolver: input.secretResolver,
        fetch: input.webFetch,
        resolveHostAddresses: input.webResolveHostAddresses,
        onProgress: (progress) => {
          webProgressEvents.push(progress);
          updateChannelWebEvidenceProgress(input, progress);
        },
      });
    let discussionPrompt = prependChannelWebContext(renderContextPack(discussionContextPack), webContext);
    const conversationMode = input.sourceMessage.threadId
      ? input.store.getLingThreadConversationMode(input.sourceMessage.threadId)
      : undefined;
    const planModeActive = conversationMode?.mode === "plan";
    const proposalBlocksAllowed = input.proposalMode !== "disabled" && !planModeActive;
    const systemPrompt = [
      "You are an AI teammate inside a Ling Stack channel.",
      "Reply concisely and only to the current channel discussion.",
      responseLanguageInstruction(responseLanguage),
      planModeActive ? renderPlanModeInstruction() : undefined,
      "Use only attachment/link metadata and preview/extraction text that is explicitly included in the turn envelope. Do not claim to inspect unavailable attachment bodies or web page bodies.",
      "If Ling web context is included, you may use only those web_search/open_url results and must keep cited source URLs visible in the reply.",
      "If Ling web context is blocked, degraded, or has no usable source URLs, explain the limitation briefly in user-facing language and do not repeat provider, relay, or protocol diagnostics verbatim.",
      "Do not perform tool use or side effects.",
      ...(!proposalBlocksAllowed
        ? [
            "Do not include hidden proposal blocks. Do not create or suggest tasks, runs, workflows, branches, approvals, or side effects.",
          ]
        : [
            "When the work is clear enough to start, include one hidden proposal block after your visible reply:",
            `Use exact teammate ids in proposal JSON. Default assigneeTeammateId and collaboration teammateId to "${input.canonicalTeammateId}" unless the user explicitly selected another teammate id.`,
            `<ling_task_proposal>{"title":"...","prompt":"...","assigneeTeammateId":"${input.canonicalTeammateId}","acceptanceCriteria":["..."],"collaborationSteps":[{"teammateId":"${input.canonicalTeammateId}","action":"coordinated","summary":"..."}],"requiredTools":["read"],"riskSummary":"..."}</ling_task_proposal>`,
            "Do not include a proposal block for ordinary notes, unclear work, or pure discussion.",
          ]),
      memoryPrompt,
    ].filter((line): line is string => Boolean(line)).join("\n");

    let execution = await startProjectedChannelReplyRun({
      input,
      prompt: discussionPrompt,
      systemPrompt,
      webContext,
      webProgressEvents,
      observerBusError,
    });
    const firstRunFailure = channelReplyRunFailure(execution.run, execution.projection.error());
    if (firstRunFailure && isContextLengthError(firstRunFailure)) {
      const observedAt = new Date().toISOString();
      const providerPreset = discussionContextPack.providerPresetId ? input.store.getProviderPreset(discussionContextPack.providerPresetId) : undefined;
      recordProviderContextLengthObservation({
        providerPreset,
        contextPack: discussionContextPack,
        now: observedAt,
      });
      recordProviderRuntimeAvailabilityIncident({
        store: input.store,
        providerPreset,
        providerPresetId: discussionContextPack.providerPresetId,
        code: "context_length_error",
        error: firstRunFailure,
        now: observedAt,
      });
      const compaction = compactChannelDiscussionForNoToolsRetry({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        now: observedAt,
      });
      discussionContextPack = buildChannelReplyContextPack({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        turnEnvelope,
        providerPresetId: input.providerPresetId,
        teammate: input.teammate,
        canonicalTeammateId: input.canonicalTeammateId,
        visibleParticipantTeammateIds: input.visibleParticipantTeammateIds,
        compactedChannelSummary: compaction.compactedSummary,
        minimal: true,
      });
      discussionPrompt = prependChannelWebContext(renderContextPack(discussionContextPack), webContext);
      const reset = input.store.updateChannelMessageRuntime(
        input.pending.id,
        {
          body: "",
          status: "pending",
          errorMessage: null,
        },
        new Date().toISOString(),
      );
      if (reset) {
        input.stream?.onDelta(reset, "");
      }
      execution = await startProjectedChannelReplyRun({
        input,
        prompt: discussionPrompt,
        systemPrompt,
        webContext,
        webProgressEvents,
        observerBusError,
        parentRunId: execution.run.id,
        compactedRetry: true,
      });
    }
    if (execution.run.status === "queued" || execution.run.status === "running" || execution.run.status === "waiting_for_approval") {
      return input.store.getChannelMessage(input.pending.id) ?? input.pending;
    }
    if (execution.run.status === "cancelled") {
      const stopped = finishChannelMessage(input.store, input.pending.id, {
        body: "Reply stopped.",
        status: "blocked",
        errorMessage: "Channel reply was stopped by the user.",
      });
      input.stream?.onBlocked(stopped);
      return stopped;
    }
    const runFailure = channelReplyRunFailure(execution.run, execution.projection.error());
    if (runFailure) {
      throw new Error(runFailure);
    }
    const rawReplyText = execution.projection.rawText().trim() || "AI reply completed without text.";
    if (execution.projection.promptLeakDetected() || isChannelReplyPromptLeak(rawReplyText)) {
      throw new Error(CHANNEL_PROMPT_LEAK_ERROR_MESSAGE);
    }
    const extractedProposal = !proposalBlocksAllowed
      ? undefined
      : extractChannelExecutionProposal(rawReplyText, input.canonicalTeammateId, isRunTool);
    const fallbackReplyText = input.stream ? visibleChannelReplyText(rawReplyText) : rawReplyText;
    const replyText = extractedProposal?.visibleBody ?? (fallbackReplyText || rawReplyText);
    const replyReference = {
      ...(input.store.getChannelMessage(input.pending.id) ?? input.pending),
      body: replyText,
    };
    if (renderedMemory.memoryIds.length > 0) {
      input.store.recordUsedMemoryEvent(
        {
          memoryIds: renderedMemory.memoryIds,
          intent: "channel-reply",
          recallQuery: memoryRecall.request.query,
          teammateId: input.canonicalTeammateId,
          channelId: input.channel.id,
          responseId: replyReference.id,
          policyVersion: renderedMemory.policyVersion,
        },
        new Date().toISOString(),
      );
    }
    if (extractedProposal) {
      input.store.createChannelExecutionProposal(
        {
          channelId: input.channel.id,
          sourceMessageId: replyReference.id,
          proposedByTeammateId: input.canonicalTeammateId,
          title: extractedProposal.title,
          prompt: extractedProposal.prompt,
          assigneeTeammateId: extractedProposal.assigneeTeammateId,
          acceptanceCriteria: extractedProposal.acceptanceCriteria,
          collaborationSteps: extractedProposal.collaborationSteps,
          requiredTools: extractedProposal.requiredTools,
          riskSummary: extractedProposal.riskSummary,
          responseLanguage,
        },
        new Date().toISOString(),
      );
    }
    recordProposedPlanArtifactFromReply(input.store, replyReference, rawReplyText);
    const reply = finishChannelMessage(input.store, input.pending.id, {
      body: replyText,
      status: "ready",
      errorMessage: null,
    });
    input.stream?.onDone(reply);
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordProviderRuntimeAvailabilityIncident({
      store: input.store,
      providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
      providerPresetId: input.providerPresetId,
      error,
      now: new Date().toISOString(),
    });
    const blocked = finishChannelMessage(input.store, input.pending.id, {
      body: `AI teammate is blocked: ${message}`,
      status: "blocked",
      errorMessage: message,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }
}

const proposedPlanPattern = /<proposed_plan(?:\s+title=(?:"([^"]+)"|'([^']+)'))?\s*>([\s\S]*?)<\/proposed_plan>/i;

function recordProposedPlanArtifactFromReply(store: RunStore, reply: ChannelMessage, rawReplyText: string): void {
  if (!reply.threadId) {
    return;
  }
  const match = proposedPlanPattern.exec(rawReplyText);
  if (!match) {
    return;
  }
  const bodyMarkdown = (match[3] ?? "").trim();
  if (!bodyMarkdown) {
    return;
  }
  const title = (match[1] ?? match[2] ?? readFirstMarkdownHeading(bodyMarkdown) ?? "Proposed plan").trim();
  store.upsertProposedPlanArtifact(
    {
      id: `proposed_plan_${reply.id}`,
      threadId: reply.threadId,
      sourceMessageId: reply.id,
      sourceRunId: reply.linkedRunId,
      title,
      bodyMarkdown,
      status: "draft",
    },
    new Date().toISOString(),
  );
}

function readFirstMarkdownHeading(markdown: string): string | undefined {
  return markdown.split(/\n/u).map((line) => /^#{1,3}\s+(.+)$/.exec(line.trim())?.[1]?.trim()).find(Boolean);
}

function renderPlanModeInstruction(): string {
  return [
    "Session mode: Plan Mode is active for this thread.",
    "Treat this turn as planning only: inspect, reason, ask clarifying questions, and produce an implementation-ready plan.",
    "Do not claim to implement, edit files, run migrations, create branches, start workflows, or perform side effects.",
    "When you provide the final plan, wrap it in exactly one <proposed_plan title=\"...\">...</proposed_plan> block.",
    "Plan Mode is not a permission preset and does not grant tool authority.",
  ].join("\n");
}

async function startProjectedChannelReplyRun(input: {
  readonly input: Parameters<typeof completeAiChannelReply>[0];
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly webContext: ChannelWebContext;
  readonly webProgressEvents: readonly WebEvidenceProgressEvent[];
  readonly observerBusError?: string;
  readonly parentRunId?: string;
  readonly compactedRetry?: boolean;
}): Promise<{
  readonly run: RunSession;
  readonly projection: ReturnType<typeof createChannelReplyRunProjection>;
}> {
  const projection = createChannelReplyRunProjection({
    store: input.input.store,
    pendingMessageId: input.input.pending.id,
    stream: input.input.stream,
    onRunLinked: ({ runId, workUnitId, attemptId }) => {
      recordBufferedChannelWebEvidence({
        store: input.input.store,
        workUnitId,
        attemptId,
        sourceMessage: input.input.sourceMessage,
        pending: input.input.pending,
        webContext: input.webContext,
        progressEvents: input.webProgressEvents,
      });
      if (input.observerBusError) {
        input.input.store.appendRuntimeEvent({
          workUnitId,
          attemptId,
          type: "work_unit_progress",
          actor: "system",
          ts: new Date().toISOString(),
          data: {
            channelTeamObserverBus: "failed",
            error: input.observerBusError,
          },
        });
      }
      notifyRunLinked(input.input.onRunLinked, runId);
    },
  });
  const startedRunId = await input.input.startRun(buildChannelReplyRunRequest({
    store: input.input.store,
    channel: input.input.channel,
    sourceMessage: input.input.sourceMessage,
    replyMessage: input.input.pending,
    teammate: input.input.teammate,
    teammateId: input.input.canonicalTeammateId,
    providerPresetId: input.input.providerPresetId!,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    channelParallelLimit: input.input.channelParallelLimit,
    parentRunId: input.parentRunId,
    compactedRetry: input.compactedRetry,
  }), projection.sink);
  const runId = startedRunId ?? projection.runId();
  if (!runId) {
    throw new Error(projection.error() ?? "Channel reply run failed to start.");
  }
  const run = input.input.store.getRun(runId);
  if (!run) {
    throw new Error(`Channel reply run was not persisted: ${runId}`);
  }
  return { run, projection };
}

function notifyRunLinked(callback: ((runId: string) => void) | undefined, runId: string): void {
  try {
    callback?.(runId);
  } catch {
    // Reply execution remains authoritative when an in-memory dispatch observer closes early.
  }
}

function notifyDispatchSettled(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Reply execution remains authoritative when an in-memory dispatch observer closes early.
  }
}

function channelReplyRunFailure(run: RunSession, projectionError: string | undefined): string | undefined {
  if (run.status !== "failed") {
    return undefined;
  }
  return run.errorMessage?.trim() || projectionError?.trim() || "Channel reply run failed.";
}

function updateChannelWebEvidenceProgress(
  input: Pick<Parameters<typeof completeAiChannelReply>[0], "store" | "sourceMessage" | "pending" | "stream">,
  progress: WebEvidenceProgressEvent,
): void {
  const now = new Date().toISOString();
  const body = renderWebEvidenceProgressPendingBody(progress, input.sourceMessage.body);
  const updated = input.store.updateChannelMessageRuntime(
    input.pending.id,
    {
      body,
      status: "pending",
      errorMessage: null,
    },
    now,
  );
  if (updated) {
    input.stream?.onDelta(updated, "");
  }
}

function recordBufferedChannelWebEvidence(input: {
  readonly store: RunStore;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly sourceMessage: ChannelMessage;
  readonly pending: ChannelMessage;
  readonly webContext: ChannelWebContext;
  readonly progressEvents: readonly WebEvidenceProgressEvent[];
}): void {
  for (const progress of input.progressEvents) {
    recordMessageWebEvidenceProgressEvent({
      store: input.store,
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      sourceMessageId: input.sourceMessage.id,
      linkedMessageId: input.pending.id,
      progress,
      ts: new Date().toISOString(),
    });
  }
  recordMessageWebEvidenceEvent({
    store: input.store,
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
    sourceMessageId: input.sourceMessage.id,
    linkedMessageId: input.pending.id,
    context: input.webContext,
    ts: new Date().toISOString(),
  });
}

function finishChannelMessage(
  store: RunStore,
  messageId: string,
  input: { readonly body: string; readonly status: ChannelMessage["status"]; readonly errorMessage?: string | null },
): ChannelMessage {
  const now = new Date().toISOString();
  return (
    store.updateChannelMessageRuntime(
      messageId,
      {
        body: input.body,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      },
      now,
    ) ?? store.getChannelMessage(messageId)!
  );
}
