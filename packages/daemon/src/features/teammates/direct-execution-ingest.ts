import type {
  AppendConversationUserTurnResult,
  LingThread,
  RunStore,
  TeammateDirectMessage,
  TeammateDirectThread,
} from "@ling-stack/core";

/** Persist private input and its context assignment before any run can emit tools. */
export function ingestTeammateDirectExecutionSource(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly directThread: TeammateDirectThread;
  readonly message: TeammateDirectMessage;
  readonly title: string;
  readonly continuationReason?: "queue_followup" | "interrupt_redirect";
}, now: string): AppendConversationUserTurnResult {
  const { store, message, thread } = input;
  const revisions = store.listConversationMessageRevisions({ surface: "teammate_direct", messageId: message.id });
  const revision = revisions.at(-1);
  if (revision && (revision.ownerId !== message.teammateId || revision.laneId !== input.directThread.id
    || revision.body !== message.body
    || JSON.stringify(revision.attachmentIds) !== JSON.stringify(message.attachmentIds)
    || JSON.stringify(revision.linkPreviewIds) !== JSON.stringify(message.linkPreviewIds)
    || JSON.stringify(revision.fileRefs) !== JSON.stringify(message.fileRefs))) {
    throw new Error("Teammate direct execution source does not match its committed revision");
  }
  const itemId = revision && revision.revision > 1 ? `${message.id}:revision:${revision.id}` : message.id;
  const previousItem = revision && revision.revision > 1
    ? revisions.slice(0, -1).reverse().map((candidate) =>
      store.getConversationItem(candidate.revision > 1 ? `${message.id}:revision:${candidate.id}` : message.id))
      .find((candidate) => candidate !== undefined)
    : undefined;
  if (previousItem && (previousItem.threadId !== thread.id || previousItem.visibility !== "agent_private"
    || previousItem.visibilityOwnerId !== message.teammateId)) {
    throw new Error("Teammate direct canonical source scope mismatch");
  }
  const idempotencyKey = `teammate_direct_source:${itemId}`;
  const acceptedItem = store.getConversationItemByIdempotencyKey(thread.id, idempotencyKey);
  const acceptedTurn = acceptedItem?.turnId ? store.getLingTurn(acceptedItem.turnId) : undefined;
  if (acceptedItem && (!acceptedTurn || thread.kind !== "teammate_direct"
    || thread.teammateId !== message.teammateId || thread.channelId !== undefined
    || acceptedItem.id !== itemId || acceptedItem.threadId !== thread.id || acceptedItem.kind !== "user_message"
    || acceptedItem.channelId !== undefined || acceptedItem.visibility !== "agent_private"
    || acceptedItem.visibilityOwnerId !== message.teammateId
    || acceptedTurn.id !== acceptedItem.turnId || acceptedTurn.threadId !== thread.id
    || acceptedTurn.teammateId !== message.teammateId || acceptedTurn.channelId !== undefined
    || acceptedTurn.sourceItemId !== acceptedItem.id)) {
    throw new Error("Teammate direct canonical replay scope mismatch");
  }
  // Canonical history stores the source message, never the rendered model prompt.
  return store.appendConversationUserTurn({
    itemId,
    threadId: thread.id,
    teammateId: message.teammateId,
    turnKind: input.continuationReason === "queue_followup" ? "queued_followup"
      : input.continuationReason === "interrupt_redirect" ? "interrupt_redirect"
      : revision && revision.revision > 1 ? "manual_followup" : "initial_request",
    // The Host-derived title is an accepted snapshot; a teammate rename is not a new source.
    title: acceptedTurn?.title ?? input.title,
    userInstruction: message.body,
    actorType: message.authorType === "system" ? "system" : "local_user",
    actorId: message.authorId,
    payload: {
      body: message.body,
      format: "markdown",
      mentions: [],
      attachmentIds: message.attachmentIds,
      linkPreviewIds: message.linkPreviewIds,
      fileRefs: message.fileRefs.map((ref) => ({
        path: ref.path,
        ...(ref.label ? { label: ref.label } : {}),
        ...(ref.line !== undefined ? { line: ref.line } : {}),
        source: "explicit_text",
      })),
    },
    ...(previousItem ? { supersedesItemId: previousItem.id, sourceTurnId: previousItem.turnId } : {}),
    domainRefs: [{ type: "message", id: message.id }],
    idempotencyKey,
  }, now);
}
