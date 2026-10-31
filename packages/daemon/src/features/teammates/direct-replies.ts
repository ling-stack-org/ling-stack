import {
  resolveEffectiveTeammateProviderPresetId,
  type AiTeammate,
  type AuthorizationMode,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunTool,
  type RunStore,
  type SecretResolver,
  type SkillOptimizationMode,
  type TeammateDirectMessage,
  type TeammateDirectThread,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import { buildPrivateChatContextView } from "../channels/context-processing/private-chat.js";
import { renderChannelContextView } from "../channels/context-processing/render.js";
import { createProviderBackedImageVisionSummarizer } from "../channels/materialization/provider-vision.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import { renderUsedMemoryPromptForView } from "../memory/prompt.js";
import { recallMemory } from "../memory/recall-service.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import {
  recordMessageWebEvidenceEvent,
  recordMessageWebEvidenceProgressEvent,
  renderWebEvidenceProgressPendingBody,
} from "../web/message-web-evidence.js";
import {
  buildWebEvidenceContext,
  prependWebEvidenceContext,
  type WebEvidenceContext,
  type WebEvidenceProgressEvent,
} from "../web/web-evidence-service.js";
import { resolveTeammateDirectExecutionContext } from "./direct-execution-context.js";
import {
  createTeammateDirectRunProjection,
  type TeammateDirectReplyStream,
} from "./direct-execution-projection.js";
import { materializeInlineTeammateDirectInputs } from "./direct-materialization.js";
import type { DirectWorkspaceReady } from "./direct-workspace.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededTeammateDirectMessages,
} from "../conversations/supersession-projection.js";
import { responseLanguageInstruction } from "../channels/response-language.js";
import { assertTeammateDirectMessageScope } from "./direct-run-owner.js";
import { settleTeammateDirectMessage, updateUndispatchedTeammateDirectMessage,
  type DirectMessageLifecycleSettlement } from "./direct-message-lifecycle.js";

export type StartTeammateDirectRun = (runRequest: RunRequest, sink: RunExecutionSink) => Promise<string | undefined>;

export async function createAiTeammateDirectReply(input: {
  readonly startRun: StartTeammateDirectRun;
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly providerPresetId?: string;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly continuationReason?: "queue_followup" | "interrupt_redirect";
  readonly workspace?: DirectWorkspaceReady;
  readonly secretResolver: SecretResolver;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly signal?: AbortSignal;
  readonly replyMessageId?: string;
  readonly toolsOverride?: readonly RunTool[];
  readonly disableWebEvidence?: boolean;
  readonly systemPromptAppend?: string;
  readonly idempotencyKeyOverride?: string;
  readonly onWorkUnitStarted?: (handle: {
    readonly workUnitId: string;
    readonly messageId: string;
    readonly teammateId: string;
    readonly threadId: string;
  }) => void;
  readonly stream?: TeammateDirectReplyStream;
}): Promise<TeammateDirectMessage> {
  assertTeammateDirectMessageScope({ ...input, messages: [] });
  if (input.replyMessageId) {
    const existing = input.store.getTeammateDirectMessage(input.replyMessageId);
    if (existing) {
      assertTeammateDirectMessageScope({ ...input, messages: [existing] });
      if (existing.authorType !== "ai-teammate") {
        throw new Error("Teammate direct reply author mismatch");
      }
      return existing;
    }
  }
  const providerPresetId = resolveEffectiveTeammateProviderPresetId({
    teammate: input.teammate,
    surface: "private",
    requestedProviderPresetId: input.providerPresetId,
    workspaceDefaultProviderPresetId: input.store.getWorkspaceSettings().defaultProviderPresetId,
  });
  const responseLanguagePreference = input.store.getWorkspaceSettings().responseLanguage ?? "follow_user";
  const now = new Date().toISOString();
  const pending = input.store.createTeammateDirectMessage(
    {
      ...(input.replyMessageId ? { id: input.replyMessageId } : {}),
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

  const blockedReason = directExecutionBlockedReason(input.teammate, providerPresetId, input.workspace);
  if (blockedReason) {
    const settlement = finishUndispatchedDirectMessage(input.store, pending, {
      body: `AI teammate is blocked: ${blockedReason}`,
      status: "blocked",
      errorMessage: blockedReason,
    });
    if (settlement.terminal && !input.signal?.aborted) input.stream?.onBlocked(settlement.message);
    return settlement.message;
  }

  const recentMessages = filterSupersededTeammateDirectMessages(
    input.store.listTeammateDirectMessages({
      teammateId: input.teammate.id,
      threadId: input.thread.id,
      limit: 20,
    }),
    buildConversationSupersessionProjection(input.store, {
      surfaces: ["teammate_direct"],
      ownerId: input.teammate.id,
      laneId: input.thread.id,
    }),
  );
  const privateAttachments = input.store.listTeammatePrivateAttachments({
    teammateId: input.teammate.id,
    threadId: input.thread.id,
    scope: "teammate_direct_thread",
    limit: 500,
  });
  const privateAttachmentsById = new Map(privateAttachments.map((attachment) => [attachment.id, attachment]));
  const webProgressEvents: WebEvidenceProgressEvent[] = [];
  let projection: ReturnType<typeof createTeammateDirectRunProjection> | undefined;

  try {
    const imageVisionSummarizer = input.imageVisionSummarizer ?? createProviderBackedImageVisionSummarizer({
      store: input.store,
      requestedProviderPresetId: providerPresetId!,
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
    const memoryRecall = await recallMemory(input.store, {
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
    const webContext: WebEvidenceContext = input.disableWebEvidence
      ? { status: "not_applicable" }
      : await buildWebEvidenceContext({
        providerPreset: input.store.getProviderPreset(providerPresetId!),
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
          webProgressEvents.push(progress);
          updateDirectWebEvidenceProgress(input.store, input.sourceMessage, pending, input.stream, progress);
        },
      });
    const systemPrompt = [
      buildDirectSystemPrompt(input.teammate, renderedMemory.prompt, input.continuationReason),
      responseLanguageInstruction(responseLanguagePreference),
      input.systemPromptAppend,
    ].filter((line): line is string => Boolean(line?.trim())).join("\n");
    const execution = resolveTeammateDirectExecutionContext({
      store: input.store,
      teammate: input.teammate,
      directThread: input.thread,
      sourceMessage: input.sourceMessage,
      replyMessage: pending,
      providerPresetId: providerPresetId!,
      workspace: input.workspace!,
      prompt: prependWebEvidenceContext(renderChannelContextView(privateChatView), webContext),
      systemPrompt,
      authorizationMode: input.authorizationMode,
      workspaceAccessMode: input.workspaceAccessMode,
      permissionPreset: input.permissionPreset,
      permissionConfirmation: input.permissionConfirmation,
      responseLanguage: responseLanguagePreference === "follow_user" ? undefined : responseLanguagePreference,
      requestedSkillId: input.requestedSkillId,
      skillOptimizationMode: input.skillOptimizationMode,
      continuationReason: input.continuationReason,
      toolsOverride: input.toolsOverride,
      idempotencyKeyOverride: input.idempotencyKeyOverride,
    });
    projection = createTeammateDirectRunProjection({
      store: input.store,
      pendingMessageId: pending.id,
      scope: {
        teammateId: input.teammate.id, directThreadId: input.thread.id,
        canonicalThreadId: execution.thread.id, turnId: execution.runRequest.turnId,
      },
      signal: input.signal,
      stream: input.stream,
      onRunLinked: ({ runId, workUnitId, attemptId }) => {
        input.onWorkUnitStarted?.({
          workUnitId,
          messageId: pending.id,
          teammateId: input.teammate.id,
          threadId: input.thread.id,
        });
        recordBufferedWebEvidence({
          store: input.store,
          workUnitId,
          attemptId,
          sourceMessage: input.sourceMessage,
          pending,
          webContext,
          progressEvents: webProgressEvents,
        });
      },
    });

    const startedRunId = await input.startRun(execution.runRequest, projection.sink);
    const runId = startedRunId ?? projection.runId();
    const current = input.store.getTeammateDirectMessage(pending.id);
    if (current?.status === "cancelled") {
      return current;
    }
    const settlement = runId
      ? settleTeammateDirectMessage(input.store, current ?? pending, {
          runId, sourceFence: projection.fence(), requireSourceFence: true,
        })
      : finishUndispatchedDirectMessage(input.store, current ?? pending, {
          body: `AI teammate is blocked: ${projection.error() || "Private execution failed."}`,
          status: "blocked", errorMessage: projection.error() || "Private execution failed.",
        });
    const reply = settlement.message;
    if (settlement.terminal && !input.signal?.aborted) {
      if (reply.status === "ready") input.stream?.onDone(reply);
      else if (["failed", "blocked", "cancelled"].includes(reply.status)) input.stream?.onBlocked(reply);
    }
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
    const current = input.store.getTeammateDirectMessage(pending.id);
    if (current?.status === "cancelled") {
      return current;
    }
    const message = error instanceof Error ? error.message : String(error);
    // A settled transport or Runner is not permission to replace a committed logical wait.
    if (current?.linkedRunId) {
      const settlement = settleTeammateDirectMessage(input.store, current, {
        runId: current.linkedRunId, sourceFence: projection?.fence(), requireSourceFence: true,
      });
      if (settlement.terminal && !input.signal?.aborted) {
        if (settlement.message.status === "ready") input.stream?.onDone(settlement.message);
        else input.stream?.onBlocked(settlement.message);
      }
      return settlement.message;
    }
    const settlement = finishUndispatchedDirectMessage(input.store, current ?? pending, {
      body: `AI teammate is blocked: ${message}`,
      status: "blocked",
      errorMessage: message,
    });
    if (settlement.terminal && !input.signal?.aborted) input.stream?.onBlocked(settlement.message);
    return settlement.message;
  }
}

function directExecutionBlockedReason(
  teammate: AiTeammate,
  providerPresetId: string | undefined,
  workspace: DirectWorkspaceReady | undefined,
): string | undefined {
  if (teammate.status !== "active") {
    return `Teammate status is ${teammate.status}.`;
  }
  if (!providerPresetId) {
    return teammate.modelBindingMode === "workspace_default"
      ? "No workspace default model is configured for this built-in teammate."
      : "No fixed model is selected for this teammate.";
  }
  if (!workspace) {
    return "Private workspace is not ready.";
  }
  return undefined;
}

function buildDirectSystemPrompt(
  teammate: AiTeammate,
  memoryPrompt: string | undefined,
  continuationReason: "queue_followup" | "interrupt_redirect" | undefined,
): string {
  return [
    teammate.systemPrompt ?? `You are ${teammate.displayName}, an AI teammate inside Ling Stack.`,
    ...teammate.appendSystemPrompt,
    "Reply concisely to the private conversation.",
    "Respond directly to the user's request. Do not start with a receipt acknowledgement or echo the user's message before the answer.",
    "This private chat uses its own isolated workspace context. Treat attachments, link previews, and workspace file references as explicit private-chat context only.",
    "Tool access is limited to the effective teammate, workspace, skill, MCP, permission, and approval policy supplied by Ling. Never claim or request authority beyond that policy.",
    "Do not claim to see channel history, attachments, web pages, or memory beyond the explicit Used memory and Ling web context sections unless the user pasted or attached that content in this chat.",
    "If Ling web context is included, you may use only those web_search/open_url results and must keep cited source URLs visible in the reply.",
    "If Ling web context is blocked, degraded, or has no usable source URLs, explain the limitation briefly in user-facing language and do not repeat provider, relay, or protocol diagnostics verbatim.",
    continuationReason === "queue_followup"
      ? "Treat the latest queued follow-up as an ordinary user message. Do not acknowledge receipt, queueing, or continuation mechanics. Respond directly to the request."
      : undefined,
    memoryPrompt,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function finishUndispatchedDirectMessage(
  store: RunStore,
  message: TeammateDirectMessage,
  input: {
    readonly body: string;
    readonly status: TeammateDirectMessage["status"];
    readonly errorMessage?: string | null;
    readonly linkedRunId?: string;
  },
): DirectMessageLifecycleSettlement {
  const updated = updateUndispatchedTeammateDirectMessage(store, message, { ...input, errorMessage: input.errorMessage ?? null });
  return { message: updated ?? store.getTeammateDirectMessage(message.id) ?? message,
    terminal: updated?.status === "blocked" };
}

function updateDirectWebEvidenceProgress(
  store: RunStore,
  sourceMessage: TeammateDirectMessage,
  pending: TeammateDirectMessage,
  stream: TeammateDirectReplyStream | undefined,
  progress: WebEvidenceProgressEvent,
): void {
  const updated = updateUndispatchedTeammateDirectMessage(
    store, pending,
    {
      body: renderWebEvidenceProgressPendingBody(progress, sourceMessage.body),
      status: "pending",
      errorMessage: null,
    },
  );
  if (updated) {
    stream?.onDelta(updated, "");
  }
}

function recordBufferedWebEvidence(input: {
  readonly store: RunStore;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly sourceMessage: TeammateDirectMessage;
  readonly pending: TeammateDirectMessage;
  readonly webContext: WebEvidenceContext;
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
