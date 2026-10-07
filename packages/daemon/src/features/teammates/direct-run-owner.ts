import type { LingTurn, RunSession, RunStore, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";

export interface TeammateDirectScope {
  readonly teammateId: string;
  readonly directThreadId: string;
}

interface TeammateDirectRunScope {
  readonly teammateId: string;
  readonly directThreadId?: string;
  readonly canonicalThreadId?: string;
  readonly turnId?: string;
  readonly replyMessageId?: string;
}

export type TeammateDirectRunOwnerStore = Pick<RunStore,
  "getRun" | "getLingThread" | "getLingTurnForRun" | "listLingTurnRuns" | "listTeammateDirectThreads">;

/** Optional legacy author IDs are allowed; an explicit foreign author never is. */
export function isTeammateDirectMessageInScope(message: TeammateDirectMessage, scope: TeammateDirectScope): boolean {
  return message.teammateId === scope.teammateId && message.threadId === scope.directThreadId &&
    (message.authorType !== "ai-teammate" || message.authorId === undefined || message.authorId === scope.teammateId);
}

/** Reject a relabelled history/source before any linked entity or prompt is read. */
export function assertTeammateDirectMessageScope(input: {
  readonly teammate: { readonly id: string };
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
  readonly sourceMessage?: TeammateDirectMessage;
}): void {
  const scope = { teammateId: input.teammate.id, directThreadId: input.thread.id };
  if (input.thread.teammateId !== scope.teammateId ||
    input.messages.some((message) => !isTeammateDirectMessageInScope(message, scope)) ||
    (input.sourceMessage && (!isTeammateDirectMessageInScope(input.sourceMessage, scope) ||
      !["local-user", "system"].includes(input.sourceMessage.authorType)))) {
    throw new Error("Teammate direct message scope mismatch (owner or author)");
  }
}

/**
 * Resolve durable private ownership without creating a Thread or source anchor.
 * RunSession deliberately has no turnId: the Turn–Run link is the authority.
 * Callers may read Run facts only after this check succeeds.
 */
export function resolveTeammateDirectRunOwner(
  store: TeammateDirectRunOwnerStore,
  runId: string,
  scope: TeammateDirectRunScope,
): { readonly run: RunSession; readonly turn: LingTurn } | undefined {
  const run = store.getRun(runId);
  if (!run || run.id !== runId || run.teammateId !== scope.teammateId || !run.threadId || run.channelId !== undefined || run.workflowStepId !== undefined ||
    (scope.canonicalThreadId && run.threadId !== scope.canonicalThreadId)) return undefined;
  const thread = store.getLingThread(run.threadId);
  if (!thread || thread.id !== run.threadId || thread.kind !== "teammate_direct" ||
    thread.teammateId !== scope.teammateId || thread.channelId !== undefined) return undefined;
  const turn = store.getLingTurnForRun(runId);
  if (!turn || turn.threadId !== thread.id || turn.teammateId !== scope.teammateId || turn.channelId !== undefined || turn.workflowStepId !== undefined ||
    (scope.turnId && turn.id !== scope.turnId)) return undefined;
  if (!store.listLingTurnRuns(turn.id).some((link) => link.runId === run.id && link.turnId === turn.id)) return undefined;
  if (scope.directThreadId && !store.listTeammateDirectThreads({ teammateId: scope.teammateId })
    .some((direct) => direct.id === scope.directThreadId && direct.teammateId === scope.teammateId)) return undefined;
  const request = run.requestSnapshot;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    for (const [key, expected] of [["teammateId", scope.teammateId], ["threadId", thread.id], ["turnId", turn.id], ["linkedMessageId", scope.replyMessageId]] as const) {
      if (expected !== undefined && key in request && Reflect.get(request, key) !== undefined && Reflect.get(request, key) !== expected) return undefined;
    }
  }
  return { run, turn };
}

/** One validated Run set is shared by private narration, media and transcript readers. */
export function collectTeammateDirectRunIds(
  store: TeammateDirectRunOwnerStore,
  messages: readonly TeammateDirectMessage[],
  scope: TeammateDirectScope,
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (isTeammateDirectMessageInScope(message, scope) && message.linkedRunId &&
      resolveTeammateDirectRunOwner(store, message.linkedRunId, {
        ...scope, ...(message.authorType === "ai-teammate" ? { replyMessageId: message.id } : {}),
      })) ids.add(message.linkedRunId);
  }
  return [...ids];
}
