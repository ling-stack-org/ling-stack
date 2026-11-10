import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  memoryCandidateGovernanceNotificationInput,
  parseCompanionReplyText,
  validateCompanionAction,
  validateCompanionEmotion,
  type AiTeammate,
  type CompanionEvent,
  type CompanionMessageResponse,
  type CompanionMessagesResponse,
  type CompanionProfile,
  type CompanionReply,
  type CompanionState,
  type MemoryObject,
  type RunStore,
  type TeammateDirectMessage,
  type TeammateDirectThread,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import type { ActiveDirectReplyRegistry } from "../teammates/direct-reply-active-registry.js";
import type { TeammateDirectReplyStream } from "../teammates/direct-execution-projection.js";
import { parseCompanionMessageRequest } from "./schemas.js";

export interface CompanionWorkUnitHandle {
  readonly workUnitId: string;
  readonly messageId: string;
  readonly teammateId: string;
  readonly threadId: string;
}

export interface CreateCompanionReplyInput {
  readonly store: RunStore;
  readonly companion: CompanionProfile;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly systemPromptAppend: string;
  readonly signal?: AbortSignal;
  readonly replyMessageId?: string;
  readonly disableWebEvidence?: boolean;
  readonly onWorkUnitStarted?: (handle: CompanionWorkUnitHandle) => void;
  readonly stream?: TeammateDirectReplyStream;
}

export type CreateCompanionReply = (input: CreateCompanionReplyInput) => Promise<TeammateDirectMessage>;

const companionMessageInFlight = new Map<string, Promise<CompanionMessageResponse>>();

export async function handleCompanionMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  companionId: string,
  createReply: CreateCompanionReply,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const companion = requireCompanion(store, companionId);
    const teammate = requireCompanionTeammate(store, companion);
    const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());

    if (request.method === "GET") {
      const page = store.listTeammateDirectMessagesPage({
        teammateId: teammate.id,
        threadId: thread.id,
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      const result: CompanionMessagesResponse = {
        cwd,
        companion,
        thread,
        messages: page.messages,
        state: store.getCompanionState(companion.id)!,
        hasMore: page.hasMore,
        ...(page.nextBeforeMessageId ? { nextBeforeMessageId: page.nextBeforeMessageId } : {}),
      };
      writeJson(response, 200, result);
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for companion messages` });
      return;
    }

    const input = parseCompanionMessageRequest(await readJsonBody(request, config.maxBodyBytes));
    const messageId = input.idempotencyKey ? companionMessageId(companion.id, input.idempotencyKey) : undefined;
    if (messageId) {
      const pending = companionMessageInFlight.get(messageId);
      if (pending) {
        writeJson(response, 200, await pending);
        return;
      }
      const existing = store.getTeammateDirectMessage(messageId);
      if (existing) {
        const cached = readCachedCompanionMessage(store, companion, thread, messageId, cwd);
        if (cached) {
          writeJson(response, 200, cached);
          return;
        }
        throw new HttpError(409, "companion_message_in_progress", "The idempotent Companion message is still processing.");
      }
    }
    const run = processCompanionMessage({
      cwd,
      store,
      companion,
      teammate,
      thread,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      createReply,
    });
    if (messageId) companionMessageInFlight.set(messageId, run);
    try {
      const result = await run;
      writeJson(response, messageId ? 200 : 201, result);
    } finally {
      if (messageId && companionMessageInFlight.get(messageId) === run) companionMessageInFlight.delete(messageId);
    }
  } catch (error) {
    writeCompanionDialogueError(response, error);
  }
}

export async function handleCompanionMessageStream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  companionId: string,
  createReply: CreateCompanionReply,
  activeDirectReplies?: ActiveDirectReplyRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  let started: ReturnType<typeof beginCompanionMessage> | undefined;
  let closed = false;
  let terminalSent = false;
  let registeredWorkUnitId: string | undefined;
  let idempotentResult: {
    readonly promise: Promise<CompanionMessageResponse>;
    readonly resolve: (value: CompanionMessageResponse) => void;
    readonly reject: (reason?: unknown) => void;
  } | undefined;
  const abortController = new AbortController();
  response.on("close", () => {
    closed = true;
    abortController.abort();
  });

  try {
    const store = storeRegistry.getStore(cwd);
    const companion = requireCompanion(store, companionId);
    const teammate = requireCompanionTeammate(store, companion);
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for companion message stream` });
      return;
    }
    const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    const input = parseCompanionMessageRequest(await readJsonBody(request, config.maxBodyBytes));
    const messageId = input.idempotencyKey ? companionMessageId(companion.id, input.idempotencyKey) : undefined;
    if (messageId) {
      const pending = companionMessageInFlight.get(messageId);
      if (pending) {
        try {
          const cachedResult = await pending;
          writeSseHead(response);
          writeSse(response, "accepted", cachedResult);
          writeSse(response, "done", cachedResult);
          response.end();
        } catch (error) {
          writeCompanionDialogueError(response, error);
        }
        return;
      }
      const existing = store.getTeammateDirectMessage(messageId);
      if (existing) {
        const cached = readCachedCompanionMessage(store, companion, thread, messageId, cwd);
        if (!cached) {
          throw new HttpError(409, "companion_message_in_progress", "The idempotent Companion message is still processing.");
        }
        writeSseHead(response);
        writeSse(response, "accepted", cached);
        writeSse(response, "done", cached);
        response.end();
        return;
      }
    }
    started = beginCompanionMessage(store, companion, teammate, thread, input.body, input.idempotencyKey);
    if (messageId) {
      let resolveResult!: (value: CompanionMessageResponse) => void;
      let rejectResult!: (reason?: unknown) => void;
      const promise = new Promise<CompanionMessageResponse>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      void promise.catch(() => undefined);
      idempotentResult = { promise, resolve: resolveResult, reject: rejectResult };
      companionMessageInFlight.set(messageId, promise);
    }
    writeSseHead(response);
    const safeWriteSse = (event: string, data: unknown): void => {
      if (!closed && !response.destroyed) {
        writeSse(response, event, data);
      }
    };
    safeWriteSse("accepted", {
      companion: store.getCompanion(companion.id) ?? companion,
      message: started.message,
      state: started.state,
    });

    let streamedText = "";
    const stream: TeammateDirectReplyStream = {
      onReady: (aiReply) => safeWriteSse("ready", {
        companion: store.getCompanion(companion.id) ?? companion,
        message: started?.message,
        aiReply,
        state: store.getCompanionState(companion.id),
      }),
      onRunLinked: (aiReply) => safeWriteSse("run_linked", {
        messageId: aiReply.id,
        linkedRunId: aiReply.linkedRunId,
      }),
      onDelta: (aiReply, delta) => {
        const parsed = parseCompanionReplyText(aiReply.body);
        const displayText = projectCompanionStreamText(aiReply.body, parsed);
        const visibleDelta = displayText.startsWith(streamedText)
          ? displayText.slice(streamedText.length)
          : delta;
        streamedText = displayText;
        safeWriteSse("delta", { messageId: aiReply.id, delta: visibleDelta, body: displayText });
      },
      onDone: (aiReply) => {
        if (!started || terminalSent) return;
        terminalSent = true;
        const finalized = finalizeCompanionReply(store, companion, started.message, aiReply);
        const result: CompanionMessageResponse = {
          cwd,
          companion: store.getCompanion(companion.id) ?? companion,
          thread,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
        };
        idempotentResult?.resolve(result);
        safeWriteSse("done", {
          companion: store.getCompanion(companion.id) ?? companion,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
        });
      },
      onBlocked: (aiReply) => {
        if (!started || terminalSent) return;
        terminalSent = true;
        const finalized = finalizeCompanionReply(store, companion, started.message, aiReply);
        const result: CompanionMessageResponse = {
          cwd,
          companion: store.getCompanion(companion.id) ?? companion,
          thread,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
        };
        idempotentResult?.resolve(result);
        safeWriteSse(aiReply.status === "failed" ? "error" : "blocked", {
          companion: store.getCompanion(companion.id) ?? companion,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
          error: aiReply.errorMessage,
        });
      },
    };

    try {
      const aiReply = await createReply({
        store,
        companion,
        teammate,
        thread,
        sourceMessage: started.message,
        systemPromptAppend: buildCompanionPrompt(companion, started.state),
        ...(messageId ? { replyMessageId: companionReplyId(companion.id, input.idempotencyKey!) } : {}),
        signal: abortController.signal,
        onWorkUnitStarted: (handle) => {
          registeredWorkUnitId = handle.workUnitId;
          activeDirectReplies?.register({ ...handle, abortController });
        },
        stream,
      });
      if (!terminalSent) {
        terminalSent = true;
        const finalized = finalizeCompanionReply(store, companion, started.message, aiReply);
        const result: CompanionMessageResponse = {
          cwd,
          companion: store.getCompanion(companion.id) ?? companion,
          thread,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
        };
        idempotentResult?.resolve(result);
        safeWriteSse("done", {
          companion: store.getCompanion(companion.id) ?? companion,
          message: started.message,
          aiReply: finalized.aiReply,
          companionReply: finalized.companionReply,
          state: finalized.state,
        });
      }
    } catch (error) {
      if (!terminalSent && started) {
        terminalSent = true;
        recordCompanionError(store, companion.id, error, started.message.id);
        idempotentResult?.reject(error);
        safeWriteSse("error", {
          message: started.message,
          error: error instanceof Error ? error.message : String(error),
          state: store.getCompanionState(companion.id),
        });
      }
    } finally {
      if (registeredWorkUnitId) activeDirectReplies?.delete(registeredWorkUnitId);
      if (messageId && companionMessageInFlight.get(messageId) === idempotentResult?.promise) {
        companionMessageInFlight.delete(messageId);
      }
      if (!closed && !response.destroyed) response.end();
    }
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeCompanionDialogueError(response, error);
  }
}

function beginCompanionMessage(
  store: RunStore,
  companion: CompanionProfile,
  teammate: AiTeammate,
  thread: TeammateDirectThread,
  body: string,
  idempotencyKey?: string,
): { readonly message: TeammateDirectMessage; readonly state: CompanionState } {
  if (!body.trim()) throw new Error("body must not be empty");
  if (companion.status === "disabled") {
    throw new HttpError(409, "companion_disabled", "Disabled companions cannot receive messages.");
  }
  const now = new Date().toISOString();
  const message = store.createTeammateDirectMessage({
    ...(idempotencyKey ? { id: companionMessageId(companion.id, idempotencyKey) } : {}),
    threadId: thread.id,
    teammateId: teammate.id,
    authorType: "local-user",
    authorId: "local-user",
    body,
  }, now);
  store.recordCompanionEvent({
    companionId: companion.id,
    type: "message",
    payload: { direction: "user", messageId: message.id, body, ...(idempotencyKey ? { idempotencyKey } : {}) },
  }, now);
  const state = store.recordCompanionInteraction({
    companionId: companion.id,
    type: "presence_changed",
    phase: "thinking",
    payload: { source: "user_message", messageId: message.id },
  }, now).state;
  return { message, state };
}

async function processCompanionMessage(input: {
  readonly cwd: string;
  readonly store: RunStore;
  readonly companion: CompanionProfile;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly body: string;
  readonly idempotencyKey?: string;
  readonly createReply: CreateCompanionReply;
}): Promise<CompanionMessageResponse> {
  const started = beginCompanionMessage(
    input.store,
    input.companion,
    input.teammate,
    input.thread,
    input.body,
    input.idempotencyKey,
  );
  try {
    const aiReply = await input.createReply({
      store: input.store,
      companion: input.companion,
      teammate: input.teammate,
      thread: input.thread,
      sourceMessage: started.message,
      systemPromptAppend: buildCompanionPrompt(input.companion, started.state),
      ...(input.idempotencyKey ? { replyMessageId: companionReplyId(input.companion.id, input.idempotencyKey) } : {}),
    });
    const finalized = finalizeCompanionReply(input.store, input.companion, started.message, aiReply);
    return {
      cwd: input.cwd,
      companion: input.store.getCompanion(input.companion.id) ?? input.companion,
      thread: input.thread,
      message: started.message,
      aiReply: finalized.aiReply,
      companionReply: finalized.companionReply,
      state: finalized.state,
    };
  } catch (error) {
    recordCompanionError(input.store, input.companion.id, error, started.message.id);
    throw error;
  }
}

export function finalizeCompanionReply(
  store: RunStore,
  companion: CompanionProfile,
  sourceMessage: TeammateDirectMessage,
  aiReply: TeammateDirectMessage,
): { readonly aiReply: TeammateDirectMessage; readonly companionReply?: CompanionReply; readonly state: CompanionState } {
  const parsed = parseCompanionReplyText(aiReply.body);
  const displayBody = parsed.metadataPresent && parsed.metadataError ? aiReply.body : (parsed.displayText || aiReply.body);
  const updated = displayBody !== aiReply.body
    ? store.updateTeammateDirectMessageRuntime(aiReply.id, { body: displayBody }, new Date().toISOString())
    : undefined;
  const finalAiReply = updated ?? aiReply;
  const now = new Date().toISOString();
  store.recordCompanionEvent({
    companionId: companion.id,
    type: "message",
    payload: {
      direction: "assistant",
      messageId: finalAiReply.id,
      body: displayBody,
      status: finalAiReply.status,
      sourceMessageId: sourceMessage.id,
    },
  }, now);

  if (parsed.metadataError) {
    store.recordCompanionEvent({
      companionId: companion.id,
      type: "error",
      payload: { code: "invalid_companion_metadata", message: parsed.metadataError, messageId: finalAiReply.id },
    }, now);
  }

  if (finalAiReply.status !== "ready") {
    recordCompanionError(store, companion.id, finalAiReply.errorMessage ?? "Companion reply failed.", finalAiReply.id);
    return { aiReply: finalAiReply, companionReply: parsed.reply, state: store.getCompanionState(companion.id)! };
  }

  store.recordCompanionInteraction({
    companionId: companion.id,
    type: "presence_changed",
    phase: "speaking",
    payload: { source: "assistant_message", messageId: finalAiReply.id },
  }, now);

  let validatedEmotion = parsed.reply.emotion;
  if (validatedEmotion) {
    try {
      validateCompanionEmotion(companion.manifest, validatedEmotion.id);
      store.recordCompanionInteraction({
        companionId: companion.id,
        type: "emotion_changed",
        emotionId: validatedEmotion.id,
        emotionIntensity: validatedEmotion.intensity,
        payload: { source: "model", messageId: finalAiReply.id },
      }, now);
    } catch (error) {
      recordCompanionError(store, companion.id, error, finalAiReply.id);
      validatedEmotion = undefined;
    }
  }

  const validatedActions: NonNullable<CompanionReply["actionRequests"]>[number][] = [];
  for (const action of parsed.reply.actionRequests ?? []) {
    try {
      validateCompanionAction(companion.manifest, action.actionId);
      validatedActions.push(action);
      store.recordCompanionInteraction({
        companionId: companion.id,
        type: "action_requested",
        actionId: action.actionId,
        payload: {
          source: "model",
          messageId: finalAiReply.id,
          ...(action.arguments ? { arguments: action.arguments } : {}),
        },
      }, now);
    } catch (error) {
      recordCompanionError(store, companion.id, error, finalAiReply.id);
    }
  }

  for (const candidate of parsed.reply.memoryCandidates ?? []) {
    const memory = createCompanionMemoryCandidate(store, companion, finalAiReply, candidate, now);
    store.recordCompanionEvent({
      companionId: companion.id,
      type: "memory_candidate",
      payload: {
        memoryId: memory.id,
        summary: candidate.summary,
        ...(candidate.reason ? { reason: candidate.reason } : {}),
        sourceMessageId: finalAiReply.id,
      },
    }, now);
  }

  return {
    aiReply: finalAiReply,
    companionReply: {
      text: displayBody,
      ...(validatedEmotion ? { emotion: validatedEmotion } : {}),
      ...(validatedActions.length ? { actionRequests: validatedActions } : {}),
      ...(parsed.reply.memoryCandidates?.length ? { memoryCandidates: parsed.reply.memoryCandidates } : {}),
    },
    state: store.getCompanionState(companion.id)!,
  };
}

function createCompanionMemoryCandidate(
  store: RunStore,
  companion: CompanionProfile,
  sourceMessage: TeammateDirectMessage,
  candidate: NonNullable<CompanionReply["memoryCandidates"]>[number],
  now: string,
): MemoryObject {
  const id = `memory_companion_${stableHash(`${sourceMessage.id}:${candidate.summary}`)}`;
  const existing = store.getMemoryObject(id);
  if (existing) return existing;
  const memory = store.createMemoryObject({
    id,
    workspaceId: companion.workspaceId,
    scopeType: "teammate",
    ownerId: companion.teammateId,
    title: `Companion candidate: ${candidate.summary.slice(0, 96)}`,
    body: [candidate.summary, candidate.reason ? `Reason: ${candidate.reason}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join("\n"),
    tags: ["companion", "candidate"],
    sourceRefs: [{ type: "message", id: sourceMessage.id, label: "Companion reply" }],
    reviewState: "candidate",
    enabled: false,
    sensitivity: "private",
    verifyBeforeUse: true,
    createdBy: "system",
  }, now);
  const thread = store.getOrCreateTeammateDirectThread(companion.teammateId, now);
  const notification = memoryCandidateGovernanceNotificationInput(memory, {
    kind: "teammate_direct",
    teammateId: companion.teammateId,
    threadId: thread.id,
  });
  if (notification) store.upsertGovernanceNotification(notification, now);
  return memory;
}

export function buildCompanionPrompt(companion: CompanionProfile, state: CompanionState): string {
  const emotions = companion.manifest.emotions.slice(0, 32).map((entry) => `${entry.id} (${entry.label})`).join(", ");
  const actions = companion.manifest.actions.slice(0, 32).map((entry) => `${entry.id} (${entry.label})`).join(", ");
  return [
    "You are responding as a Ling Companion. Keep the natural-language reply useful and concise.",
    `Companion name: ${companion.displayName}`,
    `Companion description: ${companion.description || "(none)"}`,
    `Current state: phase=${state.phase}, emotion=${state.emotionId}, intensity=${state.emotionIntensity}, energy=${state.energy}`,
    `Declared emotions: ${emotions}`,
    `Declared actions: ${actions}`,
    "Only request declared emotion and action ids. Action requests are semantic UI events; never ask Ling to execute a command through them.",
    "Return ordinary natural-language text. If structured metadata is useful, append exactly one line in this form after the text:",
    'LING_COMPANION_META: {"emotion":{"id":"...","intensity":0.5},"actionRequests":[{"actionId":"..."}],"memoryCandidates":[{"summary":"..."}]}',
    "Do not put secrets, provider settings, permissions, or executable instructions in companion metadata.",
  ].join("\n");
}

export function readCachedCompanionMessage(
  store: RunStore,
  companion: CompanionProfile,
  thread: TeammateDirectThread,
  messageId: string,
  cwd: string,
): CompanionMessageResponse | undefined {
  const message = store.getTeammateDirectMessage(messageId);
  if (!message) return undefined;
  const events = listAllCompanionEvents(store, companion.id);
  const assistantEvent = events.find((event) => (
    event.type === "message"
    && event.payload.direction === "assistant"
    && event.payload.sourceMessageId === messageId
  ));
  const aiReplyId = assistantEvent && typeof assistantEvent.payload.messageId === "string"
    ? assistantEvent.payload.messageId
    : undefined;
  const aiReply = aiReplyId ? store.getTeammateDirectMessage(aiReplyId) : undefined;
  if (!aiReply) return undefined;
  const parsed = companionReplyFromEvents(aiReply, events);
  return {
    cwd,
    companion: store.getCompanion(companion.id) ?? companion,
    thread,
    message,
    aiReply,
    companionReply: parsed,
    state: store.getCompanionState(companion.id)!,
  };
}

/**
 * Read the complete append-only event history in cursor order for durable
 * idempotency lookups. The page size keeps each SQLite read bounded while the
 * cursor prevents an old idempotency key from disappearing behind a recent
 * event limit.
 */
export function listAllCompanionEvents(store: RunStore, companionId: string): readonly CompanionEvent[] {
  const events: CompanionEvent[] = [];
  let beforeCreatedAt: string | undefined;
  let beforeEventId: string | undefined;
  while (true) {
    const page = store.listCompanionEventsPage({
      companionId,
      limit: 500,
      ...(beforeCreatedAt ? { beforeCreatedAt } : {}),
      ...(beforeEventId ? { beforeEventId } : {}),
    });
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (!page.nextBeforeCreatedAt || !page.nextBeforeEventId) {
      throw new Error("Companion event page is missing its continuation cursor");
    }
    beforeCreatedAt = page.nextBeforeCreatedAt;
    beforeEventId = page.nextBeforeEventId;
  }
}

function companionReplyFromEvents(
  aiReply: TeammateDirectMessage,
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
): CompanionReply {
  const emotionEvent = events.find((event) => event.type === "emotion_changed" && event.payload.messageId === aiReply.id);
  const actionRequests = events
    .filter((event) => event.type === "action_requested" && event.payload.messageId === aiReply.id)
    .flatMap((event) => {
      const actionId = event.payload.actionId;
      if (typeof actionId !== "string") return [];
      const args = event.payload.arguments;
      return [{ actionId, ...(args && typeof args === "object" && !Array.isArray(args) ? { arguments: args as Record<string, unknown> } : {}) }];
    });
  const memoryCandidates = events
    .filter((event) => event.type === "memory_candidate" && event.payload.sourceMessageId === aiReply.id)
    .flatMap((event) => {
      const summary = event.payload.summary;
      if (typeof summary !== "string") return [];
      const reason = event.payload.reason;
      return [{ summary, ...(typeof reason === "string" ? { reason } : {}) }];
    });
  const emotionId = emotionEvent?.payload.emotionId;
  const intensity = emotionEvent?.payload.intensity;
  return {
    text: aiReply.body,
    ...(typeof emotionId === "string" && typeof intensity === "number" ? { emotion: { id: emotionId, intensity } } : {}),
    ...(actionRequests.length ? { actionRequests } : {}),
    ...(memoryCandidates.length ? { memoryCandidates } : {}),
  };
}

function companionMessageId(companionId: string, idempotencyKey: string): string {
  return `companion_msg_${stableHash(`${companionId}:${idempotencyKey}`)}`;
}

function companionReplyId(companionId: string, idempotencyKey: string): string {
  return `companion_reply_${stableHash(`${companionId}:${idempotencyKey}`)}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

function projectCompanionStreamText(value: string, parsed: ReturnType<typeof parseCompanionReplyText>): string {
  const markerIndex = value.lastIndexOf("LING_COMPANION_META:");
  if (markerIndex >= 0) {
    return value.slice(0, markerIndex).trimEnd();
  }
  return parsed.displayText || value;
}

function requireCompanion(store: RunStore, companionId: string): CompanionProfile {
  const companion = store.getCompanion(companionId);
  if (!companion) throw new HttpError(404, "companion_not_found", `Companion not found: ${companionId}`);
  return companion;
}

function requireCompanionTeammate(store: RunStore, companion: CompanionProfile): AiTeammate {
  const teammate = store.getAiTeammate(companion.teammateId);
  if (!teammate) {
    throw new HttpError(409, "companion_teammate_missing", `Bound AI teammate not found: ${companion.teammateId}`);
  }
  return teammate;
}

function recordCompanionError(store: RunStore, companionId: string, error: unknown, sourceMessageId?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  try {
    store.recordCompanionInteraction({
      companionId,
      type: "error",
      phase: "error",
      payload: { message, ...(sourceMessageId ? { sourceMessageId } : {}) },
    }, now);
  } catch {
    try {
      store.recordCompanionEvent({ companionId, type: "error", payload: { message, ...(sourceMessageId ? { sourceMessageId } : {}) } }, now);
    } catch {
      // Preserve the original dialogue error if the companion store is unavailable.
    }
  }
}

function writeCompanionDialogueError(response: ServerResponse, error: unknown): void {
  writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}
