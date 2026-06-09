import type { AiTeammate, RunStore, SecretResolver, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";
import type { RunnerRegistry, RunnerResolution } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { renderUsedMemoryPrompt } from "../memory/prompt.js";
import { acquireRunRuntimeSemaphores } from "../runs/concurrency.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { formatTeammateDirectPrompt } from "./direct-prompts.js";

export async function createAiTeammateDirectReply(input: {
  readonly runnerRegistry: RunnerRegistry;
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly providerPresetId?: string;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly signal?: AbortSignal;
  readonly onWorkUnitStarted?: (handle: {
    readonly workUnitId: string;
    readonly messageId: string;
    readonly teammateId: string;
    readonly threadId: string;
  }) => void;
  readonly stream?: {
    readonly onReady: (aiReply: TeammateDirectMessage) => void;
    readonly onDelta: (aiReply: TeammateDirectMessage, delta: string) => void;
    readonly onDone: (aiReply: TeammateDirectMessage) => void;
    readonly onBlocked: (aiReply: TeammateDirectMessage) => void;
  };
}): Promise<TeammateDirectMessage> {
  const providerPresetId = input.providerPresetId ?? input.teammate.providerPresetId;
  const runnerResolution = input.runnerRegistry.resolve({
    requestedRunnerId: input.teammate.runnerId,
    allowFallback: true,
    tools: [],
  });
  const now = new Date().toISOString();
  const pending = input.store.createTeammateDirectMessage(
    {
      threadId: input.thread.id,
      teammateId: input.teammate.id,
      authorType: "ai-teammate",
      authorId: input.teammate.id,
      body: "",
      status: "pending",
    },
    now,
  );
  input.stream?.onReady(pending);
  const supervised = startRuntimeWorkUnit({
    store: input.store,
    runtimeSupervisor: input.runtimeSupervisor,
    kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message",
    ownerId: input.sourceMessage.id,
    teammateId: input.teammate.id,
    providerPresetId,
    requestedRunnerId: runnerResolution.requestedRunnerId,
    effectiveRunnerId: runnerResolution.effectiveRunnerId,
    fallbackReason: runnerResolution.fallbackReason,
    linkedMessageId: pending.id,
    idempotencyKey: `teammate_direct_reply:${input.sourceMessage.id}:${pending.id}`,
    request: {
      sourceMessageId: input.sourceMessage.id,
      teammateId: input.teammate.id,
      providerPresetId,
      runnerResolution: toRunnerResolutionSnapshot(runnerResolution),
    },
  });
  input.onWorkUnitStarted?.({
    workUnitId: supervised.workUnit.id,
    messageId: pending.id,
    teammateId: input.teammate.id,
    threadId: input.thread.id,
  });
  if (input.teammate.status !== "active") {
    const blocked = finishDirectMessageWorkUnit(input.store, supervised, pending.id, {
      body: `AI teammate is ${input.teammate.status}.`,
      status: "blocked",
      errorMessage: `Teammate status is ${input.teammate.status}.`,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  if (!providerPresetId) {
    const blocked = finishDirectMessageWorkUnit(input.store, supervised, pending.id, {
      body: "AI teammate is blocked: no provider preset is selected.",
      status: "blocked",
      errorMessage: "No provider preset is selected for this teammate.",
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  }

  const recentMessages = input.store.listTeammateDirectMessages({
    teammateId: input.teammate.id,
    threadId: input.thread.id,
    limit: 20,
  });
  const textDeltas: string[] = [];
  try {
    const task = {
      id: input.sourceMessage.id,
      title: `Private chat with ${input.teammate.displayName}`,
      prompt: formatTeammateDirectPrompt(input.teammate, recentMessages),
      channelId: "private",
    };
    const memoryRecall = input.store.recallMemory({
      teammateId: input.teammate.id,
      intent: "private-chat",
      query: input.sourceMessage.body,
      maxResults: 6,
      includePrivate: true,
    });
    const memoryPrompt = renderUsedMemoryPrompt(memoryRecall.memories);
    const systemPrompt = [
      input.teammate.systemPrompt ?? `You are ${input.teammate.displayName}, an AI teammate inside Ling Stack.`,
      ...input.teammate.appendSystemPrompt,
      "Reply concisely to the private conversation.",
      "This private chat has no tool access and cannot mutate files, send external messages, or inspect channel files.",
      "Do not claim to see channel history, attachments, web pages, or memory beyond the explicit Used memory section unless the user pasted that content in this chat.",
      memoryPrompt,
    ].filter((line): line is string => Boolean(line)).join("\n");
    const provider = resolveProviderForRun(
      input.store,
      {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task,
        providerPresetId,
        tools: [],
        thinkingLevel: "medium",
        systemPrompt,
      },
      input.secretResolver,
    );

    acquireRunRuntimeSemaphores({
      store: input.store,
      workUnit: supervised.workUnit,
      attempt: supervised.attempt,
      providerKey: providerPresetId,
      runnerId: runnerResolution.effectiveRunnerId,
      now,
    });

    const result = await runnerResolution.runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      task,
      provider,
      tools: [],
      thinkingLevel: "medium",
      systemPrompt,
      onEvent: (event) => {
        input.store.appendRuntimeEvent({
          workUnitId: supervised.workUnit.id,
          attemptId: supervised.attempt.id,
          type: "work_unit_progress",
          actor: "runner",
          ts: new Date().toISOString(),
          data: { runnerEventType: event.type },
        });
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
          const updated = input.store.updateTeammateDirectMessageRuntime(
            pending.id,
            {
              body: textDeltas.join(""),
              status: "pending",
              errorMessage: null,
            },
            new Date().toISOString(),
          );
          if (updated) {
            input.stream?.onDelta(updated, event.text);
          }
        }
      },
      signal: input.signal,
    });
    const replyText = textDeltas.join("").trim() || extractAssistantText(result.messages) || "AI reply completed without text.";
    const reply = finishDirectMessageWorkUnit(input.store, supervised, pending.id, {
      body: replyText,
      status: "ready",
      errorMessage: null,
    });
    input.stream?.onDone(reply);
    if (memoryRecall.memories.length > 0) {
      input.store.recordUsedMemoryEvent(
        {
          memoryIds: memoryRecall.memories.map((item) => item.memory.id),
          intent: "private-chat",
          recallQuery: memoryRecall.request.query,
          teammateId: input.teammate.id,
          responseId: reply.id,
          policyVersion: memoryRecall.policyVersion,
        },
        new Date().toISOString(),
      );
    }
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = finishDirectMessageWorkUnit(input.store, supervised, pending.id, {
      body: `AI teammate is blocked: ${message}`,
      status: "blocked",
      errorMessage: message,
    });
    input.stream?.onBlocked(blocked);
    return blocked;
  } finally {
    input.store.releaseRuntimeSemaphoreSlotsForOwner(supervised.attempt.id, new Date().toISOString(), "message-reply-finished");
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

function finishDirectMessageWorkUnit(
  store: RunStore,
  supervised: { readonly workUnit: { readonly id: string }; readonly attempt: { readonly id: string } },
  messageId: string,
  input: { readonly body: string; readonly status: TeammateDirectMessage["status"]; readonly errorMessage?: string | null },
): TeammateDirectMessage {
  const now = new Date().toISOString();
  const currentWorkUnit = store.getWorkUnit(supervised.workUnit.id);
  const currentMessage = store.getTeammateDirectMessage(messageId);
  if (currentWorkUnit?.status === "cancelled" && currentMessage?.status === "cancelled") {
    return currentMessage;
  }
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
    store.updateTeammateDirectMessageRuntime(
      messageId,
      {
        body: input.body,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      },
      now,
    ) ?? store.getTeammateDirectMessage(messageId)!
  );
}
