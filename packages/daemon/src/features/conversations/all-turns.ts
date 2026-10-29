import type { LingTurn, RunStore } from "@ling-stack/core";

/** Walk the exact (updatedAt,id) cursor; the store caps individual reads at 500. */
export function listAllConversationTurns(store: RunStore, threadId: string): LingTurn[] {
  const turns: LingTurn[] = [];
  let beforeTurnId: string | undefined;
  for (;;) {
    const page = store.listLingTurns({ threadId, limit: 500, ...(beforeTurnId ? { beforeTurnId } : {}) });
    turns.push(...page);
    if (page.length < 500) break;
    const nextId = page.at(-1)?.id;
    if (!nextId || nextId === beforeTurnId) throw new Error(`Conversation turn cursor did not advance: ${threadId}`);
    beforeTurnId = nextId;
  }
  return turns;
}
