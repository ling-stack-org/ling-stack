import { createHash } from "node:crypto";
import { createLingTurnId, type AppendConversationAcceptedInput, type ConversationAttachment, type LingThread, type LingTurn, type LingTurnKind, type RunStore } from "@ling-stack/core";
import type { ChannelMessageFileRef } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "../runs/schemas.js";
import { readNormalConversationPreparedRequest } from "./normal-conversation-prepared-request.js";
import { readNormalConversationPreparedExecution } from "./normal-conversation-prepared-execution.js";
import { collectNormalConversationContextWithinSnapshot, readNormalConversationContext, readNormalConversationRunRequest, type NormalConversationContextSnapshot } from "./normal-conversation-context.js";

export interface PreparedNormalConversationInput {
  readonly turn: LingTurn;
  readonly attachments: readonly ConversationAttachment[];
  readonly context: NormalConversationContextSnapshot;
  readonly acceptedSnapshotId?: string;
  readonly idempotencyKey: string;
  readonly replayRequest?: RunRequest;
}

/** Atomically anchor, bind attachments, and persist frozen history before any await. */
export function prepareNormalConversationInput(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly message: string;
  readonly title: string;
  readonly attachmentIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly idempotencyKey?: string;
  readonly replacementSourceTurnId?: string;
  readonly sourceTurnId?: string;
  readonly turnKind?: LingTurnKind;
  readonly interventionId?: string;
  /** Host-owned origin, never read from the public conversation request body. */
  readonly actorType?: "local_user" | "system";
  readonly now: string;
}): PreparedNormalConversationInput {
  const { store, thread } = input;
  const idempotencyKey = `normal-conversation:${thread.id}:${input.idempotencyKey ?? createLingTurnId()}`;
  const existing = store.getConversationItemByIdempotencyKey(thread.id, idempotencyKey);
  const previousTurn = existing?.turnId ? store.getLingTurn(existing.turnId) : undefined;
  // Stable IDs let processes that both missed this read converge inside SQLite.
  const turnId = previousTurn?.id ?? `turn_normal_${createHash("sha256").update(idempotencyKey).digest("hex")}`;
  const attachments = [...new Set(input.attachmentIds)].map((attachmentId) => {
    const attachment = store.getConversationAttachment(attachmentId);
    if (!attachment) throw new HttpError(404, "conversation_attachment_not_found", `Conversation attachment not found: ${attachmentId}`);
    if (attachment.threadId && attachment.threadId !== thread.id) {
      throw new HttpError(409, "conversation_attachment_thread_mismatch", `Conversation attachment belongs to a different thread: ${attachmentId}`);
    }
    if (attachment.turnId && attachment.turnId !== turnId && attachment.turnId !== input.replacementSourceTurnId) {
      throw new HttpError(409, "conversation_attachment_already_used", `Conversation attachment was already used: ${attachmentId}`);
    }
    return attachment;
  });
  const userInstruction = input.message.trim() || "User attached files.";
  const appendInput: AppendConversationAcceptedInput = {
    threadId: thread.id,
    turnId,
    itemId: existing?.id ?? `conversation-user:${turnId}`,
    turnKind: previousTurn?.kind ?? input.turnKind ?? (input.replacementSourceTurnId || thread.metadata?.lastTurnId ? "manual_followup" : "initial_request"),
    title: input.title,
    userInstruction,
    sourceTurnId: input.sourceTurnId ?? input.replacementSourceTurnId,
    replacementSourceTurnId: input.replacementSourceTurnId,
    interventionId: input.interventionId,
    actorType: input.actorType ?? "local_user",
    payload: { body: userInstruction, format: "markdown", mentions: [], attachmentIds: attachments.map((attachment) => attachment.id),
      linkPreviewIds: [], fileRefs: input.fileRefs.map((ref) => ({ path: ref.path, source: ref.source ?? "explicit_text",
        ...(ref.label ? { label: ref.label } : {}), ...(ref.line !== undefined ? { line: ref.line } : {}) })) },
    domainRefs: [{ type: "turn", id: turnId }],
    idempotencyKey,
  };
  const legacyReplay = previousTurn && existing ? readReplay(store, thread.id, previousTurn.id, existing.id) : undefined;
  const stored = existing ? store.getConversationAcceptedInputSnapshot(existing.id) : undefined;
  if (legacyReplay && !stored) {
    if (legacyReplay.normalConversationAcceptedSnapshotId !== undefined || legacyReplay.normalConversationPreparedRequestRef !== undefined) {
      throw new Error("Accepted input snapshot required by Run is missing");
    }
    // Upgrade compatibility: preserve an existing Run, never manufacture past acceptance evidence.
    store.appendConversationUserTurn(appendInput, input.now);
    assertReplayKey(legacyReplay, idempotencyKey);
    return { turn: previousTurn!, attachments, context: legacyReplay.normalConversationContext!, idempotencyKey, replayRequest: legacyReplay };
  }
  const result = store.appendConversationUserTurnWithAcceptedSnapshot(appendInput, (source) => {
    const payload = collectNormalConversationContextWithinSnapshot({ store, threadId: thread.id, sourceItemId: source.item.id });
    return { projection: payload.projection, payload };
  }, input.now);
  const accepted = result.acceptedSnapshot;
  const context = readNormalConversationContext(accepted.payload);
  if (JSON.stringify(context.projection) !== JSON.stringify(accepted.projection) || context.hydration.source.itemId !== accepted.sourceItemId) {
    throw new Error("Accepted input snapshot payload source mismatch");
  }
  const turn = store.getLingTurn(result.turnId)!;
  const runReplay = readReplay(store, thread.id, turn.id, result.item.id);
  if (runReplay) {
    assertReplayKey(runReplay, idempotencyKey);
    if (runReplay.normalConversationContext?.fingerprint !== context.fingerprint ||
      (runReplay.normalConversationAcceptedSnapshotId !== undefined && runReplay.normalConversationAcceptedSnapshotId !== accepted.id)) {
      throw new Error("Accepted input snapshot and Run context mismatch");
    }
  }
  const requestReplay = readNormalConversationPreparedRequest(store, result.item.id, runReplay);
  if (runReplay) {
    if (store.getConversationPreparedInput(result.item.id, "execution") && !runReplay.normalConversationPreparedExecutionRef) {
      throw new Error("Prepared execution marker required by Run is missing");
    }
    if (runReplay.normalConversationPreparedExecutionRef) readNormalConversationPreparedExecution(store, runReplay);
  }
  const replayRequest = requestReplay ?? runReplay;
  if (replayRequest) assertReplayKey(replayRequest, idempotencyKey);
  return { turn, context, acceptedSnapshotId: accepted.id, idempotencyKey, replayRequest,
    attachments: attachments.map((attachment) => store.getConversationAttachment(attachment.id)!) };
}

function readReplay(store: RunStore, threadId: string, turnId: string, itemId: string): RunRequest | undefined {
  const links = store.listLingTurnRuns(turnId).filter((link) => link.role !== "validation");
  if (links.length > 1) throw new Error("Normal input replay has ambiguous Run ownership");
  if (!links[0]) return undefined;
  const run = store.getRun(links[0].runId);
  if (!run) throw new Error("Normal input replay Run is missing");
  return readNormalConversationRunRequest(run, { threadId, turnId, itemId });
}

function assertReplayKey(request: RunRequest, key: string): void {
  if (request.idempotencyKey !== key) throw new Error("Normal input replay Run idempotency mismatch");
}
