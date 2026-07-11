import type { Channel, ChannelMessage, RunStore, SecretResolver } from "@ling-stack/core";
import type { RunnerRegistry, RunnerResolution } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { renderUsedMemoryPromptForView } from "../memory/prompt.js";
import { isRunTool } from "../runs/approvals.js";
import { acquireRunRuntimeSemaphores } from "../runs/concurrency.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { extractChannelExecutionProposal } from "./ai-proposals.js";
import { compactChannelDiscussionForNoToolsRetry, isContextLengthError } from "./context-compaction.js";
import { buildChannelReplyContextPack, renderContextPack } from "./context-packs.js";
import { createLingAgentExecutor, isLingAgentExecutorId, LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
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
import { buildChannelWebContext, prependChannelWebContext } from "./web-tools.js";
import {
  recordMessageWebEvidenceEvent,
  recordMessageWebEvidenceProgressEvent,
  renderWebEvidenceProgressPendingBody,
} from "../web/message-web-evidence.js";
import type { WebEvidenceProgressEvent } from "../web/web-evidence-service.js";

export async function createAiChannelReply(input: {
  readonly runnerRegistry: RunnerRegistry;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly teamObserverBusEnabled?: boolean;
  readonly completionMode?: "background" | "inline";
  readonly stream?: {
    readonly onReady: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
}): Promise<ChannelMessage> {
  const now = new Date().toISOString();
  const teammateId =
    input.teammateId ??
    input.sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id ??
    LING_AGENT_EXECUTOR_ID;
  const teammate = isLingAgentExecutorId(teammateId)
    ? input.store.getAiTeammate(teammateId) ?? createLingAgentExecutor(now)
    : resolveAiTeammateReference(input.store, teammateId);
  const canonicalTeammateId = teammate?.id ?? teammateId;
  const providerPresetId = input.providerPresetId ?? teammate?.providerPresetId ?? input.channel.defaultProviderPresetId;
  const runnerResolution = input.runnerRegistry.resolve({
    requestedRunnerId: teammate?.runnerId,
    allowFallback: true,
    tools: [],
  });
  const pending = input.store.createChannelMessage(
    {
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
  const supervised = startRuntimeWorkUnit({
    store: input.store,
    runtimeSupervisor: input.runtimeSupervisor,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: input.sourceMessage.id,
    channelId: input.channel.id,
    teammateId: canonicalTeammateId,
    providerPresetId,
    requestedRunnerId: runnerResolution.requestedRunnerId,
    effectiveRunnerId: runnerResolution.effectiveRunnerId,
    fallbackReason: runnerResolution.fallbackReason,
    linkedMessageId: pending.id,
    idempotencyKey: `channel_ai_reply:${input.sourceMessage.id}:${pending.id}`,
    request: {
      sourceMessageId: input.sourceMessage.id,
      providerPresetId,
      teammateId: canonicalTeammateId,
      runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
    },
  });

  const completion = completeAiChannelReply({
    ...input,
    pending,
    supervised,
    teammate,
    canonicalTeammateId,
    providerPresetId,
    runnerResolution,
    now,
  });
  if (input.completionMode === "inline") {
    return await completion;
  }
  void completion;
  return pending;
}

async function completeAiChannelReply(input: {
  readonly runnerRegistry: RunnerRegistry;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly teamObserverBusEnabled?: boolean;
  readonly pending: ChannelMessage;
  readonly supervised: ReturnType<typeof startRuntimeWorkUnit>;
  readonly teammate: ReturnType<typeof resolveAiTeammateReference>;
  readonly canonicalTeammateId: string;
  readonly runnerResolution: RunnerResolution;
  readonly now: string;
  readonly stream?: {
    readonly onReady: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
}): Promise<ChannelMessage> {
  if (input.teammate && input.teammate.status !== "active") {
    const blocked = finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: `AI teammate is ${input.teammate.status}.`,
      status: "blocked",
      errorMessage: `Teammate status is ${input.teammate.status}.`,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  if (!input.providerPresetId) {
    const blocked = finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: "AI teammate is not configured for this channel.",
      status: "blocked",
      errorMessage: "No provider preset is selected for this channel discussion.",
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  const textDeltas: string[] = [];
  let lastVisibleStreamBody = "";
  let promptLeakDetected = false;
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
      input.store.appendRuntimeEvent({
        workUnitId: input.supervised.workUnit.id,
        attemptId: input.supervised.attempt.id,
        type: "work_unit_progress",
        actor: "system",
        ts: new Date().toISOString(),
        data: {
          channelTeamObserverBus: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
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
    const webContext = await buildChannelWebContext({
      store: input.store,
      providerPresetId: input.providerPresetId,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
      secretResolver: input.secretResolver,
      fetch: input.webFetch,
      resolveHostAddresses: input.webResolveHostAddresses,
      onProgress: (progress) => {
        recordChannelWebEvidenceProgress(input, progress);
      },
    });
    recordMessageWebEvidenceEvent({
      store: input.store,
      workUnitId: input.supervised.workUnit.id,
      attemptId: input.supervised.attempt.id,
      sourceMessageId: input.sourceMessage.id,
      linkedMessageId: input.pending.id,
      context: webContext,
      ts: new Date().toISOString(),
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

    acquireRunRuntimeSemaphores({
      store: input.store,
      workUnit: input.supervised.workUnit,
      attempt: input.supervised.attempt,
      channel: input.channel,
      channelParallelLimit: input.channelParallelLimit,
      providerKey: input.providerPresetId,
      runnerId: input.runnerResolution.effectiveRunnerId,
      now: input.now,
    });

    const runDiscussionTask = async (prompt: string) => {
      const provider = resolveProviderForRun(
        input.store,
        {
          cwd: input.store.paths.cwd,
          workspaceCwd: input.store.paths.cwd,
          task: {
            id: input.sourceMessage.id,
            title: `Channel discussion in ${input.channel.name}`,
            prompt,
            channelId: input.channel.id,
          },
          providerPresetId: input.providerPresetId,
          tools: [],
          thinkingLevel: "medium",
          systemPrompt,
        },
        input.secretResolver,
      );
      return input.runnerResolution.runner.adapter.runTask({
        cwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel discussion in ${input.channel.name}`,
          prompt,
          channelId: input.channel.id,
        },
        provider,
        tools: [],
        thinkingLevel: "medium",
        systemPrompt,
        onEvent: (event) => {
          input.store.appendRuntimeEvent({
            workUnitId: input.supervised.workUnit.id,
            attemptId: input.supervised.attempt.id,
            type: "work_unit_progress",
            actor: "runner",
            ts: new Date().toISOString(),
            data: { runnerEventType: event.type },
          });
          if (event.type === "assistant_text_delta") {
            textDeltas.push(event.text);
            const visibleBody = visibleReplyTextSoFar(textDeltas.join(""));
            if (promptLeakDetected || isChannelReplyPromptLeak(visibleBody)) {
              promptLeakDetected = true;
              if (lastVisibleStreamBody !== PROMPT_LEAK_PENDING_BODY) {
                lastVisibleStreamBody = PROMPT_LEAK_PENDING_BODY;
                const updated = input.store.updateChannelMessageRuntime(
                  input.pending.id,
                  {
                    body: PROMPT_LEAK_PENDING_BODY,
                    status: "pending",
                    errorMessage: null,
                  },
                  new Date().toISOString(),
                );
                if (updated) {
                  input.stream?.onDelta(updated, "");
                }
              }
              return;
            }
            if (visibleBody !== lastVisibleStreamBody) {
              const delta = visibleBody.startsWith(lastVisibleStreamBody)
                ? visibleBody.slice(lastVisibleStreamBody.length)
                : visibleBody;
              lastVisibleStreamBody = visibleBody;
              const updated = input.store.updateChannelMessageRuntime(
                input.pending.id,
                {
                  body: visibleBody,
                  status: "pending",
                  errorMessage: null,
                },
                new Date().toISOString(),
              );
              if (updated) {
                input.stream?.onDelta(updated, delta);
              }
            }
          }
        },
      });
    };

    let result: Awaited<ReturnType<typeof runDiscussionTask>>;
    try {
      result = await runDiscussionTask(discussionPrompt);
    } catch (error) {
      if (!isContextLengthError(error)) {
        throw error;
      }
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
        error,
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
      textDeltas.length = 0;
      lastVisibleStreamBody = "";
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
      result = await runDiscussionTask(discussionPrompt);
    }
    const rawReplyText = textDeltas.join("").trim() || extractAssistantText(result.messages) || "AI reply completed without text.";
    if (isChannelReplyPromptLeak(rawReplyText)) {
      throw new Error(PROMPT_LEAK_ERROR_MESSAGE);
    }
    const extractedProposal = !proposalBlocksAllowed
      ? undefined
      : extractChannelExecutionProposal(rawReplyText, input.canonicalTeammateId, isRunTool);
    const fallbackReplyText = input.stream ? visibleReplyText(rawReplyText) : rawReplyText;
    const replyText = extractedProposal?.visibleBody ?? (fallbackReplyText || rawReplyText);
    const reply = finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: replyText,
      status: "ready",
      errorMessage: null,
    });
    input.stream?.onDone(reply);
    if (renderedMemory.memoryIds.length > 0) {
      input.store.recordUsedMemoryEvent(
        {
          memoryIds: renderedMemory.memoryIds,
          intent: "channel-reply",
          recallQuery: memoryRecall.request.query,
          teammateId: input.canonicalTeammateId,
          channelId: input.channel.id,
          responseId: reply.id,
          policyVersion: renderedMemory.policyVersion,
        },
        new Date().toISOString(),
      );
    }
    if (extractedProposal) {
      input.store.createChannelExecutionProposal(
        {
          channelId: input.channel.id,
          sourceMessageId: input.pending.id,
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
    recordProposedPlanArtifactFromReply(input.store, reply, rawReplyText);
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
    const blocked = finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: `AI teammate is blocked: ${message}`,
      status: "blocked",
      errorMessage: message,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  } finally {
    input.store.releaseRuntimeSemaphoreSlotsForOwner(input.supervised.attempt.id, new Date().toISOString(), "message-reply-finished");
  }
}

const PROMPT_LEAK_PENDING_BODY = "AI teammate response was blocked because the runner echoed internal channel context.";
const PROMPT_LEAK_ERROR_MESSAGE = "Runner echoed internal channel context instead of an assistant reply.";
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

function isChannelReplyPromptLeak(raw: string): boolean {
  const text = raw.trim();
  const blockedPrefixes = [
    "Channel collaboration protocol:",
    "Recent channel context before the latest turn:",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
  ];
  if (blockedPrefixes.some((prefix) => text.startsWith(prefix))) {
    return true;
  }
  if (/^Attachments:\s*(?:none)?/u.test(text) && text.includes("Link previews:")) {
    return true;
  }
  if (text.length < 80) {
    return false;
  }
  const markers = [
    "Channel collaboration protocol:",
    "Response language:",
    "Auto reply mode:",
    "Default workflow preference:",
    "Private teammate chat, hidden prompts, provider secrets",
    "Recent channel context before the latest turn:",
    "Use this context to resolve short follow-ups",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
    "Current teammate:",
    "User message:",
    "Attachments:",
    "Link previews:",
    "Workspace file refs:",
  ];
  const matchedMarkers = markers.filter((marker) => text.includes(marker));
  const hasProtocol = text.includes("Channel collaboration protocol:");
  const hasReplyInstruction = text.includes("Reply as the channel AI teammate. Keep the response actionable and brief.");
  const hasRecentContext = text.includes("Recent channel context before the latest turn:");
  const hasEnvelopeCluster =
    (text.includes("Attachments:") || text.includes("Attachments: none")) &&
    (text.includes("Link previews:") || text.includes("Link previews: none")) &&
    (text.includes("Workspace file refs:") || text.includes("Workspace file refs: none"));
  return (
    (hasReplyInstruction && (hasProtocol || hasEnvelopeCluster || hasRecentContext)) ||
    (hasProtocol && matchedMarkers.length >= 4) ||
    (hasEnvelopeCluster && matchedMarkers.length >= 5)
  );
}

function visibleReplyTextSoFar(raw: string): string {
  const visible = stripHiddenProposalText(raw);
  if (visible.length !== raw.length) {
    return visible;
  }
  const marker = "<ling_task_proposal";
  const lower = raw.toLowerCase();
  const maxPrefixLength = Math.min(marker.length - 1, lower.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    if (marker.startsWith(lower.slice(-length))) {
      return raw.slice(0, raw.length - length);
    }
  }
  return raw;
}

function visibleReplyText(raw: string): string {
  return stripHiddenProposalText(raw).trim();
}

function stripHiddenProposalText(raw: string): string {
  return raw
    .replace(/<ling_task_proposal[\s\S]*?<\/ling_task_proposal>/giu, "")
    .replace(/<ling_task_proposal[\s\S]*$/iu, "");
}

function recordChannelWebEvidenceProgress(
  input: Pick<Parameters<typeof completeAiChannelReply>[0], "store" | "supervised" | "sourceMessage" | "pending" | "stream">,
  progress: WebEvidenceProgressEvent,
): void {
  const now = new Date().toISOString();
  recordMessageWebEvidenceProgressEvent({
    store: input.store,
    workUnitId: input.supervised.workUnit.id,
    attemptId: input.supervised.attempt.id,
    sourceMessageId: input.sourceMessage.id,
    linkedMessageId: input.pending.id,
    progress,
    ts: now,
  });
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

function toRunnerResolutionSnapshot(resolution: RunnerResolution): {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly fallbackReason?: RunnerResolution["fallbackReason"];
} {
  return {
    requestedRunnerId: resolution.requestedRunnerId,
    effectiveRunnerId: resolution.effectiveRunnerId,
    fallbackReason: resolution.fallbackReason,
  };
}

function finishChannelMessageWorkUnit(
  store: RunStore,
  supervised: { readonly workUnit: { readonly id: string }; readonly attempt: { readonly id: string } },
  messageId: string,
  input: { readonly body: string; readonly status: ChannelMessage["status"]; readonly errorMessage?: string | null },
): ChannelMessage {
  const now = new Date().toISOString();
  transitionWorkUnitTerminal(store, {
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    event: input.status === "ready" ? "runner_succeeded" : "runner_failed",
    attemptStatus: input.status === "ready" ? "succeeded" : "failed",
    runtimeEventType: input.status === "ready" ? "work_unit_succeeded" : "work_unit_failed",
    actor: "runner",
    now,
    errorCode: input.status === "ready" ? undefined : "message_reply_blocked",
    errorMessage: input.errorMessage ?? undefined,
  });
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
