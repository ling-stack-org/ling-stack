import type { Channel, ChannelMessage, RunStore, SecretResolver } from "@ling-stack/core";
import type { RunnerAdapter } from "../../context.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { renderUsedMemoryPrompt } from "../memory/prompt.js";
import { isRunTool } from "../runs/approvals.js";
import { acquireRunRuntimeSemaphores } from "../runs/concurrency.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { extractChannelExecutionProposal } from "./ai-proposals.js";
import { formatChannelDiscussionPrompt } from "./ai-prompts.js";

export async function createAiChannelReply(input: {
  readonly runner: RunnerAdapter;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
}): Promise<ChannelMessage> {
  const teammateId =
    input.teammateId ??
    input.sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id ??
    input.channel.defaultTeammateId ??
    "ai-teammate";
  const teammate = resolveAiTeammateReference(input.store, teammateId);
  const canonicalTeammateId = teammate?.id ?? teammateId;
  const providerPresetId = input.providerPresetId ?? teammate?.providerPresetId ?? input.channel.defaultProviderPresetId;
  const now = new Date().toISOString();
  const pending = input.store.createChannelMessage(
    {
      channelId: input.channel.id,
      threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: canonicalTeammateId,
      body: "AI teammate is preparing a reply...",
      status: "pending",
    },
    now,
  );
  const supervised = startRuntimeWorkUnit({
    store: input.store,
    runtimeSupervisor: input.runtimeSupervisor,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: input.sourceMessage.id,
    channelId: input.channel.id,
    teammateId: canonicalTeammateId,
    providerPresetId,
    linkedMessageId: pending.id,
    idempotencyKey: `channel_ai_reply:${input.sourceMessage.id}:${pending.id}`,
    request: {
      sourceMessageId: input.sourceMessage.id,
      providerPresetId,
      teammateId: canonicalTeammateId,
    },
  });

  void completeAiChannelReply({
    ...input,
    pending,
    supervised,
    teammate,
    canonicalTeammateId,
    providerPresetId,
    now,
  });
  return pending;
}

async function completeAiChannelReply(input: {
  readonly runner: RunnerAdapter;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly pending: ChannelMessage;
  readonly supervised: ReturnType<typeof startRuntimeWorkUnit>;
  readonly teammate: ReturnType<typeof resolveAiTeammateReference>;
  readonly canonicalTeammateId: string;
  readonly now: string;
}): Promise<void> {
  if (input.teammate && input.teammate.status !== "active") {
    finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: `AI teammate is ${input.teammate.status}.`,
      status: "blocked",
      errorMessage: `Teammate status is ${input.teammate.status}.`,
    });
    return;
  }

  if (!input.providerPresetId) {
    finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: "AI teammate is not configured for this channel.",
      status: "blocked",
      errorMessage: "No provider preset is selected for this channel discussion.",
    });
    return;
  }

  const textDeltas: string[] = [];
  try {
    const memoryRecall = input.store.recallMemory({
      teammateId: input.canonicalTeammateId,
      channelId: input.channel.id,
      intent: "channel-reply",
      query: input.sourceMessage.body,
      maxResults: 6,
    });
    const memoryPrompt = renderUsedMemoryPrompt(memoryRecall.memories);
    const systemPrompt = [
      "You are an AI teammate inside a Ling Stack channel.",
      "Reply concisely and only to the current channel discussion.",
      "This MVP does not give you attachment contents or web page bodies. Do not claim to inspect them.",
      "Do not perform tool use or side effects.",
      "When the work is clear enough to start, include one hidden proposal block after your visible reply:",
      `Use exact teammate ids in proposal JSON. Default assigneeTeammateId and collaboration teammateId to "${input.canonicalTeammateId}" unless the user explicitly selected another teammate id.`,
      `<ling_task_proposal>{"title":"...","prompt":"...","assigneeTeammateId":"${input.canonicalTeammateId}","acceptanceCriteria":["..."],"collaborationSteps":[{"teammateId":"${input.canonicalTeammateId}","action":"coordinated","summary":"..."}],"requiredTools":["read"],"riskSummary":"..."}</ling_task_proposal>`,
      "Do not include a proposal block for ordinary notes, unclear work, or pure discussion.",
      memoryPrompt,
    ].filter((line): line is string => Boolean(line)).join("\n");
    const provider = resolveProviderForRun(
      input.store,
      {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel discussion in ${input.channel.name}`,
          prompt: formatChannelDiscussionPrompt(input.channel, input.sourceMessage),
          channelId: input.channel.id,
        },
        providerPresetId: input.providerPresetId,
        tools: [],
        thinkingLevel: "medium",
        systemPrompt,
      },
      input.secretResolver,
    );

    acquireRunRuntimeSemaphores({
      store: input.store,
      workUnit: input.supervised.workUnit,
      attempt: input.supervised.attempt,
      channel: input.channel,
      providerKey: input.providerPresetId,
      now: input.now,
    });

    const result = await input.runner.runTask({
      cwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel discussion in ${input.channel.name}`,
        prompt: formatChannelDiscussionPrompt(input.channel, input.sourceMessage),
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
        }
      },
    });
    const rawReplyText = textDeltas.join("").trim() || extractAssistantText(result.messages) || "AI reply completed without text.";
    const extractedProposal = extractChannelExecutionProposal(rawReplyText, input.canonicalTeammateId, isRunTool);
    const replyText = extractedProposal?.visibleBody || rawReplyText;
    const reply = finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: replyText,
      status: "ready",
      errorMessage: null,
    });
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
        },
        new Date().toISOString(),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishChannelMessageWorkUnit(input.store, input.supervised, input.pending.id, {
      body: `AI teammate is blocked: ${message}`,
      status: "blocked",
      errorMessage: message,
    });
  } finally {
    input.store.releaseRuntimeSemaphoreSlotsForOwner(input.supervised.attempt.id, new Date().toISOString(), "message-reply-finished");
  }
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
