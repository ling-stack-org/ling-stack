import { ConversationNarrationAccumulator, redactSecrets, type NormalConversationForkSource, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { collectNormalConversationContextWithinSnapshot } from "./normal-conversation-context.js";
import type { NormalContextEntry, NormalContextRunEventWatermark } from "./normal-conversation-context-hydrator.js";
import { groupNormalForkHistory, selectNormalForkHistory, usedForkWatermarks, validateNormalForkContextPayload, type NormalForkContextPayload } from "./normal-conversation-fork-history.js";
import { assertNormalContextCaptureByteBudget } from "./normal-conversation-context-budget.js";

const MAX_FORK_TEXT = 32_768;

/** Caller owns the Core fork transaction and its read-only capture window. */
export function captureNormalConversationForkContext(store: RunStore, source: NormalConversationForkSource) {
  const history = collectNormalConversationContextWithinSnapshot({ store, threadId: source.thread.id, sourceItemId: source.item.id });
  const anchor: NormalContextEntry[] = [{ origin: "canonical_item", turnId: source.turn.id,
    role: source.item.actorType === "system" ? "context" : "user", text: source.item.payload.body,
    sourceRefs: [{ kind: "conversation_item", id: source.item.id, sequence: source.item.sequence, revision: source.item.revision }] }];
  const marks: NormalContextRunEventWatermark[] = [];
  if (source.run) {
    const run = source.run;
    const replies = store.listConversationItemsForTurn({ turnId: source.turn.id }).filter(item => item.kind === "assistant_message" &&
      (item.payload.runNarration || item.payload.presentationRole === "narration") && item.domainRefs.some(ref => ref.type === "run" && ref.id === run.id));
    if (replies.length) {
      // A hidden/conflicting canonical answer is not permission to resurrect event text.
      if (replies.length !== 1) throw new Error("Normal fork selected narration is ambiguous");
      const item = replies[0]!;
      if (item.kind !== "assistant_message" || item.workspaceId !== source.thread.workspaceId || item.threadId !== source.thread.id ||
        item.status !== "committed" || item.actorType !== "ling_agent" || (item.actorId && item.actorId !== "ling_agent") ||
        item.channelId || item.visibility !== "thread_participants" || item.visibilityOwnerId ||
        item.domainRefs.filter(ref => ref.type === "run").length !== 1 || item.payload.streaming) throw new Error("Normal fork selected narration is unavailable");
      const narration = item.payload.runNarration;
      const refs = [{ kind: "conversation_item" as const, id: item.id, sequence: item.sequence, revision: item.revision },
        { kind: "run" as const, id: run.id }];
      if (narration) {
        const through = store.listEvents(run.id, { afterSeq: narration.throughEventSequence - 1, limit: 1 })[0];
        if (narration.source.threadId !== source.thread.id || narration.source.turnId !== source.turn.id ||
          narration.source.workspaceId !== source.thread.workspaceId || narration.source.runId !== run.id ||
          narration.source.participantId !== "ling_agent" || narration.sourceItemId !== source.item.id ||
          through?.id !== narration.throughEventId || through.seq !== narration.throughEventSequence) {
          throw new Error("Normal fork selected canonical narration boundary mismatch");
        }
        marks.push({ runId: run.id, throughEventId: narration.throughEventId, throughEventSequence: narration.throughEventSequence });
        for (const segment of narration.segments) anchor.push({ origin: "canonical_item", turnId: source.turn.id, role: "assistant",
          text: segment.content, sourceRefs: [...refs,
            { kind: "run_event", id: segment.firstEventId, runId: run.id, sequence: segment.startEventSequence },
            { kind: "run_event", id: segment.lastEventId, runId: run.id, sequence: segment.endEventSequence }] });
      } else {
        anchor.push({ origin: "canonical_item", turnId: source.turn.id, role: "assistant", text: item.payload.body, sourceRefs: refs });
      }
    } else {
      const fold = new ConversationNarrationAccumulator({ runId: run.id });
      let afterSeq = 0, count = 0;
      for (;;) {
        const page = store.listEvents(run.id, { afterSeq, limit: 1_000 });
        count += page.length;
        if (count > 50_000) throw new Error("Normal fork selected narration exceeds the event budget");
        page.forEach(event => fold.append(event));
        const last = page.at(-1);
        if (last) {
          if (last.seq <= afterSeq) throw new Error("Normal fork event cursor did not advance");
          afterSeq = last.seq;
          marks[0] = { runId: run.id, throughEventId: last.id, throughEventSequence: last.seq };
        }
        if (page.length < 1_000) break;
      }
      const narration = fold.snapshot();
      if (run.status === "succeeded" && narration.narrationSegments.some(segment => !segment.completed)) {
        throw new Error("Normal fork selected narration is incomplete");
      }
      for (const segment of narration.narrationSegments) if (segment.content.trim()) anchor.push({ origin: "run_narration",
        turnId: source.turn.id, runId: run.id, role: "assistant", text: segment.content, completed: segment.completed,
        sourceRefs: [{ kind: "turn", id: source.turn.id, updatedAt: source.turn.updatedAt }, { kind: "run", id: run.id },
          { kind: "run_event", id: segment.firstEventId, runId: run.id, sequence: segment.startEventSequence },
          { kind: "run_event", id: segment.lastEventId, runId: run.id, sequence: segment.endEventSequence }] });
    }
  }
  const redacted = redactSecrets(anchor) as NormalContextEntry[];
  const anchorSize = redacted.reduce((sum, entry) => sum + entry.text.length, 0);
  if (anchorSize > MAX_FORK_TEXT) throw new HttpError(409, "normal_fork_anchor_budget_exceeded",
    "The selected turn exceeds the frozen fork context budget; its text was not truncated.");
  const selected = selectNormalForkHistory([...(history.forkHistory?.groups ?? []),
    ...groupNormalForkHistory(source.thread.id, history.hydration.entries)], MAX_FORK_TEXT - anchorSize);
  const groups = [...selected.groups, ...groupNormalForkHistory(source.thread.id, redacted)];
  const payload: NormalForkContextPayload = { schemaVersion: 1,
    source: { threadId: source.thread.id, turnId: source.turn.id, itemId: source.item.id, itemRevision: source.item.revision,
      throughItemSequence: source.item.sequence, ...(source.run ? { runId: source.run.id } : {}) },
    groups, omittedGroups: [...new Set([...(history.forkHistory?.omittedGroups ?? []), ...selected.omittedGroups,
      ...history.hydration.diagnostics.filter(diagnostic => diagnostic.code === "budget_exceeded")
        .map(diagnostic => JSON.stringify([source.thread.id, diagnostic.turnId ? "turn" : "projection_budget", diagnostic.turnId ?? history.projection.projectionVersion]))])],
    runEventWatermarks: usedForkWatermarks(groups, [...(history.forkHistory?.runEventWatermarks ?? []), ...history.hydration.runEventWatermarks, ...marks]) };
  const captured = { projection: history.projection, payload: validateNormalForkContextPayload(payload) };
  assertNormalContextCaptureByteBudget(captured);
  return captured;
}
