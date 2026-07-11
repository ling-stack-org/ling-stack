import type { AiTeammate, RunStore, SecretResolver, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";
import type { RunnerRegistry, RunnerResolution } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { buildPrivateChatContextView } from "../channels/context-processing/private-chat.js";
import { renderChannelContextView } from "../channels/context-processing/render.js";
import { createProviderBackedImageVisionSummarizer } from "../channels/materialization/provider-vision.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import { renderUsedMemoryPromptForView } from "../memory/prompt.js";
import { acquireRunRuntimeSemaphores } from "../runs/concurrency.js";
import { resolveProviderForRun } from "../runs/providers.js";
import {
  recordMessageWebEvidenceEvent,
  recordMessageWebEvidenceProgressEvent,
  renderWebEvidenceProgressPendingBody,
} from "../web/message-web-evidence.js";
import { buildWebEvidenceContext, prependWebEvidenceContext, type WebEvidenceProgressEvent } from "../web/web-evidence-service.js";
import { materializeInlineTeammateDirectInputs } from "./direct-materialization.js";
import type { DirectWorkspaceReady } from "./direct-workspace.js";

export async function createAiTeammateDirectReply(input: {
  readonly runnerRegistry: RunnerRegistry;
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly providerPresetId?: string;
  readonly workspace?: DirectWorkspaceReady;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
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
  const workspaceCwd = input.store.paths.cwd;
  const executionCwd = input.workspace?.executionCwd ?? workspaceCwd;
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
      workspaceCwd,
      executionCwd,
      directWorkspaceBinding: input.workspace?.binding,
      directWorkspaceSnapshot: input.workspace?.snapshot,
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
  const privateAttachments = input.store.listTeammatePrivateAttachments({
    teammateId: input.teammate.id,
    threadId: input.thread.id,
    scope: "teammate_direct_thread",
    limit: 500,
  });
  const privateAttachmentsById = new Map(privateAttachments.map((attachment) => [attachment.id, attachment]));
  const textDeltas: string[] = [];
  try {
    const imageVisionSummarizer = input.imageVisionSummarizer ?? createProviderBackedImageVisionSummarizer({
      store: input.store,
      requestedProviderPresetId: providerPresetId,
      secretResolver: input.secretResolver,
    });
    const materializedAttachments = await materializeInlineTeammateDirectInputs({
      store: input.store,
      teammateId: input.teammate.id,
      threadId: input.thread.id,
      sourceMessage: input.sourceMessage,
      now,
      imageVisionSummarizer,
    });
    const memoryRecall = input.store.recallMemory({
      teammateId: input.teammate.id,
      intent: "private-chat",
      query: input.sourceMessage.body,
      maxResults: 6,
      includePrivate: true,
    });
    const renderedMemory = renderUsedMemoryPromptForView({
      memories: memoryRecall.memories,
      recallPolicyVersion: memoryRecall.policyVersion,
      viewKind: "private_chat_view",
      workspaceId: input.teammate.workspaceId,
      consumerTeammateId: input.teammate.id,
    });
    const privateChatView = buildPrivateChatContextView({
      store: input.store,
      teammate: input.teammate,
      thread: input.thread,
      messages: recentMessages,
      sourceMessage: input.sourceMessage,
      attachmentsById: privateAttachmentsById,
      materializationsByAttachmentId: materializedAttachments,
      memorySources: renderedMemory.sources,
      memoryDropped: renderedMemory.dropped,
      now,
    });
    const webContext = await buildWebEvidenceContext({
      providerPreset: input.store.getProviderPreset(providerPresetId),
      webSearchProviderPresets: input.store.listProviderPresets({ enabled: true }),
      providerStore: input.store,
      sourceText: input.sourceMessage.body,
      secretResolver: input.secretResolver,
      fetch: input.webFetch,
      resolveHostAddresses: input.webResolveHostAddresses,
      promptHeader: "Ling web context:",
      promptInstruction: "Use this web context only as cited evidence for the current private reply. Do not claim access to web pages beyond the included results.",
      allowPublicSearchFallback: false,
      onProgress: (progress) => {
        recordDirectWebEvidenceProgress({
          store: input.store,
          supervised,
          sourceMessage: input.sourceMessage,
          pending,
          stream: input.stream,
        }, progress);
      },
    });
    recordMessageWebEvidenceEvent({
      store: input.store,
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      sourceMessageId: input.sourceMessage.id,
      linkedMessageId: pending.id,
      context: webContext,
      ts: new Date().toISOString(),
    });
    const task = {
      id: input.sourceMessage.id,
      title: `Private chat with ${input.teammate.displayName}`,
      prompt: prependWebEvidenceContext(renderChannelContextView(privateChatView), webContext),
      channelId: "private",
    };
    const memoryPrompt = renderedMemory.prompt;
    const systemPrompt = [
      input.teammate.systemPrompt ?? `You are ${input.teammate.displayName}, an AI teammate inside Ling Stack.`,
      ...input.teammate.appendSystemPrompt,
      "Reply concisely to the private conversation.",
      "This private chat uses its own isolated workspace context. Treat attachments, link previews, and workspace file references as explicit private-chat context only.",
      "This private chat has no tool access and cannot mutate files or send external messages.",
      "Do not claim to see channel history, attachments, web pages, or memory beyond the explicit Used memory and Ling web context sections unless the user pasted or attached that content in this chat.",
      "If Ling web context is included, you may use only those web_search/open_url results and must keep cited source URLs visible in the reply.",
      "If Ling web context is blocked, degraded, or has no usable source URLs, explain the limitation briefly in user-facing language and do not repeat provider, relay, or protocol diagnostics verbatim.",
      memoryPrompt,
    ].filter((line): line is string => Boolean(line)).join("\n");
    const provider = resolveProviderForRun(
      input.store,
      {
        cwd: executionCwd,
        workspaceCwd,
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
      cwd: executionCwd,
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
    if (renderedMemory.memoryIds.length > 0) {
      input.store.recordUsedMemoryEvent(
        {
          memoryIds: renderedMemory.memoryIds,
          intent: "private-chat",
          recallQuery: memoryRecall.request.query,
          teammateId: input.teammate.id,
          responseId: reply.id,
          policyVersion: renderedMemory.policyVersion,
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

function recordDirectWebEvidenceProgress(
  input: {
    readonly store: RunStore;
    readonly supervised: ReturnType<typeof startRuntimeWorkUnit>;
    readonly sourceMessage: TeammateDirectMessage;
    readonly pending: TeammateDirectMessage;
    readonly stream?: {
      readonly onReady: (aiReply: TeammateDirectMessage) => void;
      readonly onDelta: (aiReply: TeammateDirectMessage, delta: string) => void;
      readonly onDone: (aiReply: TeammateDirectMessage) => void;
      readonly onBlocked: (aiReply: TeammateDirectMessage) => void;
    };
  },
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
  const updated = input.store.updateTeammateDirectMessageRuntime(
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
