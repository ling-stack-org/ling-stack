import type { ConversationContextCompactionRecord, ConversationItemV1, LingThread, LingTurnRun } from "@ling-stack/contracts";
import type { RunEventEnvelope, RunSession, RunStore } from "@ling-stack/core";

/** Reconstruct lifecycle from durable events without creating execution actions or reading raw context. */
export function projectConversationContextCompactions(input: {
  readonly store: Pick<RunStore, "listEvents">;
  readonly thread: LingThread;
  readonly runLinks: readonly LingTurnRun[];
  readonly runs: readonly RunSession[];
  readonly items: readonly ConversationItemV1[];
}): readonly ConversationContextCompactionRecord[] {
  const links = new Map(input.runLinks.map(link => [link.runId, link]));
  const anchors = new Map<string, ConversationItemV1>();
  for (const item of [...input.items].sort((a, b) => a.sequence - b.sequence)) {
    if (item.kind !== "assistant_message" || item.workspaceId !== input.thread.workspaceId
      || item.threadId !== input.thread.id || !item.turnId) continue;
    const refs = item.domainRefs.filter(ref => ref.type === "run");
    // Scope to the linked turn before retaining its earliest assistant message.
    if (refs.length !== 1 || links.get(refs[0]!.id)?.turnId !== item.turnId
      || anchors.has(refs[0]!.id)) continue;
    anchors.set(refs[0]!.id, item);
  }
  const output: ConversationContextCompactionRecord[] = [];
  for (const run of input.runs) {
    const anchor = anchors.get(run.id);
    const link = links.get(run.id);
    if (!anchor?.turnId || !link || link.turnId !== anchor.turnId
      || run.threadId !== input.thread.id) continue;
    let pending: ConversationContextCompactionRecord | undefined;
    const settle = (status: ConversationContextCompactionRecord["status"], event: RunEventEnvelope): void => {
      if (!pending) return;
      output.push({ ...pending, status, revision: event.seq * 2,
        sourceRefs: [...pending.sourceRefs, { kind: "run_event", id: event.id }] });
      pending = undefined;
    };
    for (const event of readEvents(input.store, run.id)) {
      if (event.type === "context_compaction_start") {
        // A new start cannot prove the previous compaction succeeded.
        settle("blocked", event);
        const participantId = run.teammateId ?? anchor.actorId;
        const attemptId = event.data.attemptId;
        pending = {
          id: `run-compaction:${event.id}`, revision: event.seq * 2,
          workspaceId: input.thread.workspaceId, threadId: input.thread.id,
          turnId: anchor.turnId, runId: run.id, attemptId, participantId,
          workUnitId: run.workUnitId, workflowStepId: run.workflowStepId,
          anchorItemId: anchor.id, eventId: event.id, eventSequence: event.seq,
          status: "running", reason: event.data.reason, summary: "",
          sourceRefs: [
            { kind: "conversation_item", id: anchor.id }, { kind: "run", id: run.id },
            { kind: "run_event", id: event.id },
            ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
            ...(participantId ? [{ kind: "participant", id: participantId }] : []),
          ],
        };
      } else if (event.type === "context_compaction_end" && pending
        && event.data.attemptId === pending.attemptId && event.data.reason === pending.reason) {
        pending = { ...pending,
          tokensBefore: tokenCount(event.data.tokensBefore),
          estimatedTokensAfter: tokenCount(event.data.estimatedTokensAfter) };
        settle(event.data.outcome === "sdk_installed" ? "succeeded"
          : event.data.outcome === "aborted" ? "cancelled" : "failed", event);
      } else if (["run_end", "run_error", "run_cancelled"].includes(event.type)) {
        settle("blocked", event);
      }
    }
    if (pending) {
      // Missing end evidence stays explicit after a restart or terminal Run.
      output.push(["succeeded", "failed", "cancelled"].includes(run.status)
        ? { ...pending, status: "blocked", revision: pending.revision + 1 } : pending);
    }
  }
  return output;
}

function readEvents(store: Pick<RunStore, "listEvents">, runId: string): readonly RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(runId, { afterSeq, limit: 1_000 });
    if (!page.length) return events;
    const next = page.at(-1)!.seq;
    if (!Number.isSafeInteger(next) || next <= afterSeq) throw new Error(`Compaction event cursor did not advance: ${runId}`);
    events.push(...page.filter(event => event.runId === runId));
    afterSeq = next;
    if (page.length < 1_000) return events;
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
