import type { Channel, ChannelMessage, RunStore, SecretResolver } from "@ling-stack/core";
import type { RunnerRegistry, RunnerResolution } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { renderUsedMemoryPrompt } from "../memory/prompt.js";
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
import { resolveChannelResponseLanguage, responseLanguageInstruction } from "./response-language.js";

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
  try {
    const turnEnvelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
    });
    const memoryRecall = input.store.recallMemory({
      teammateId: input.canonicalTeammateId,
      channelId: input.channel.id,
      intent: "channel-reply",
      query: renderLingAgentTurnEnvelopeSearchText(turnEnvelope) || input.sourceMessage.body,
      maxResults: 6,
    });
    const memoryPrompt = renderUsedMemoryPrompt(memoryRecall.memories);
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
      teammate: input.teammate,
      canonicalTeammateId: input.canonicalTeammateId,
      visibleParticipantTeammateIds: input.visibleParticipantTeammateIds,
    });
    let discussionPrompt = renderContextPack(discussionContextPack);
    const systemPrompt = [
      "You are an AI teammate inside a Ling Stack channel.",
      "Reply concisely and only to the current channel discussion.",
      responseLanguageInstruction(responseLanguage),
      "Use only attachment/link metadata and preview/extraction text that is explicitly included in the turn envelope. Do not claim to inspect unavailable attachment bodies or web page bodies.",
      "Do not perform tool use or side effects.",
      ...(input.proposalMode === "disabled"
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
      const compaction = compactChannelDiscussionForNoToolsRetry({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        now: new Date().toISOString(),
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
      discussionPrompt = renderContextPack(discussionContextPack);
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
    const extractedProposal = input.proposalMode === "disabled"
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
    if (memoryRecall.memories.length > 0) {
      input.store.recordUsedMemoryEvent(
        {
          memoryIds: memoryRecall.memories.map((item) => item.memory.id),
          intent: "channel-reply",
          recallQuery: memoryRecall.request.query,
          teammateId: input.canonicalTeammateId,
          channelId: input.channel.id,
          responseId: reply.id,
          policyVersion: memoryRecall.policyVersion,
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
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
