import { createHash, randomUUID } from "node:crypto";
import type { LingThread, LingTurn, RunSession, RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord, readOptionalString } from "../../shared/validation.js";
import type { RunRequest } from "../runs/schemas.js";
import { captureNormalConversationForkContext } from "./normal-conversation-fork-capture.js";
import { prepareNormalConversationInput } from "./normal-conversation-input.js";
import { renderNormalConversationRunPrompt } from "./normal-conversation-context.js";
import { saveNormalConversationPreparedRequest } from "./normal-conversation-prepared-request.js";

interface NormalFork {
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly created: boolean;
}

/** The first request freezes its anchor. Omitted anchors are never re-resolved on replay. */
export function createNormalConversationThreadFork(input: {
  readonly store: RunStore; readonly sourceThread: LingThread; readonly body: unknown; readonly now: string;
  readonly resolveAnchor: () => { readonly sourceTurn?: LingTurn; readonly sourceRun?: RunSession };
}): NormalFork {
  const { store, sourceThread, body } = input;
  const value = isRecord(body) ? body : {};
  const key = readOptionalString(value, "idempotencyKey")?.trim();
  const childThreadId = key ? `thread_normal_fork_${createHash("sha256").update(JSON.stringify([sourceThread.id, key])).digest("hex")}`
    : `thread_normal_fork_${randomUUID()}`;
  try {
    const existing = store.getLingThread(childThreadId);
    if (existing) {
      const seed = store.getNormalConversationForkSeed(childThreadId);
      const turnId = readOptionalString(value, "turnId")?.trim(), runId = readOptionalString(value, "sourceRunId")?.trim();
      if (!seed || seed.threadId !== sourceThread.id || (turnId && turnId !== seed.turnId) || (runId && runId !== seed.sourceRunId)) {
        throw new HttpError(409, "fork_idempotency_conflict", "The fork key already belongs to a different source.");
      }
      return { childThread: existing, sourceTurn: store.getLingTurn(seed.turnId),
        sourceRun: seed.sourceRunId ? store.getRun(seed.sourceRunId) : undefined, created: false };
    }
    const anchor = input.resolveAnchor();
    if (!anchor.sourceTurn) throw new HttpError(409, "fork_context_unavailable", "Normal fork requires a terminal canonical source turn.");
    const result = store.createNormalConversationFork({ childThreadId, parentThreadId: sourceThread.id, parentTurnId: anchor.sourceTurn.id,
      sourceRunId: anchor.sourceRun?.id, title: readOptionalString(value, "title")?.trim() || `Fork: ${sourceThread.title}`,
      objective: readOptionalString(value, "objective")?.trim() || `Forked from ${anchor.sourceTurn.title} (${sourceThread.id}).` },
    source => captureNormalConversationForkContext(store, source), input.now);
    return { childThread: result.thread, sourceTurn: anchor.sourceTurn, sourceRun: anchor.sourceRun, created: result.created };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "normal_fork_context_invalid", "The normal fork source or frozen context is unavailable or invalid.");
  }
}

/** Normal fork-run uses the same canonical acceptance and first-winner preparation as ordinary input. */
export function prepareNormalConversationForkRun(input: {
  readonly store: RunStore; readonly fork: NormalFork; readonly instruction: string; readonly operationKey: string; readonly now: string;
  readonly buildRequest: (childTurn: LingTurn) => RunRequest;
}): { readonly childTurn: LingTurn; readonly runRequest: RunRequest } {
  const { store, fork } = input;
  try {
    const prepared = prepareNormalConversationInput({ store, thread: fork.childThread, message: input.instruction,
      title: input.instruction.split(/\r?\n/)[0]!.slice(0, 96), attachmentIds: [], fileRefs: [],
      idempotencyKey: input.operationKey, turnKind: "initial_request", now: input.now });
    if (prepared.replayRequest) return { childTurn: prepared.turn, runRequest: prepared.replayRequest };
    const base = input.buildRequest(prepared.turn);
    const runRequest = saveNormalConversationPreparedRequest(store, { ...base, teammateId: "ling_agent", createdByActor: "local-user",
      parentRunId: fork.sourceRun?.id, sourceMessageId: prepared.turn.sourceItemId, idempotencyKey: prepared.idempotencyKey,
      normalConversationContext: prepared.context, normalConversationAcceptedSnapshotId: prepared.acceptedSnapshotId,
      contextProjection: prepared.context.projection,
      // A historical permission receipt is not authority for this new child execution.
      permissionConfirmation: undefined,
      task: { ...base.task, prompt: renderNormalConversationRunPrompt(prepared.context, input.instruction) } }, input.now);
    return { childTurn: prepared.turn, runRequest };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "normal_fork_input_conflict", "The normal fork input or prepared request is unavailable or conflicts with its first accepted value.");
  }
}
