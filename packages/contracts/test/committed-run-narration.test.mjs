import assert from "node:assert/strict";
import test from "node:test";
import { isConversationItemV1 } from "../dist/index.js";

const now = "2026-09-08T06:00:00.000Z";
function fixture() {
  const source = { workspaceId: "workspace", threadId: "thread", turnId: "turn", runId: "run",
    workUnitId: "unit", attemptId: "attempt", participantId: "ling_agent" };
  return {
    schemaVersion: 1, id: "narration:run", workspaceId: source.workspaceId, threadId: source.threadId, turnId: source.turnId,
    sequence: 9, revision: 0, kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent",
    status: "committed", visibility: "thread_participants", createdAt: now, updatedAt: now, committedAt: now,
    domainRefs: [{ type: "run", id: source.runId }, { type: "conversation_item", id: "user-item" }],
    payload: { body: "Before tool.\n\nAfter tool.", format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: "narration",
      runNarration: { schemaVersion: 1, messageId: "conversation-assistant:turn", sourceItemId: "user-item", source,
        throughEventSequence: 8, throughEventId: "e8", segments: [
          { content: "Before tool.", firstEventId: "e2", lastEventId: "e3", startEventSequence: 2, endEventSequence: 3, completed: true },
          { content: "After tool.", firstEventId: "e6", lastEventId: "e7", startEventSequence: 6, endEventSequence: 7, completed: true },
        ] } },
  };
}

test("committed narration retains the logical reply id, immutable Run source and exact message boundaries", () => {
  assert.equal(isConversationItemV1(fixture()), true);
});

test("committed narration rejects malformed, overlapping, foreign or text-divergent evidence", () => {
  for (const mutate of [
    (item) => { item.payload.runNarration.schemaVersion = 2; },
    (item) => { item.payload.runNarration.source.threadId = "foreign"; },
    (item) => { item.payload.runNarration.source.turnId = "foreign"; },
    (item) => { item.payload.runNarration.source.workspaceId = "foreign"; },
    (item) => { item.payload.runNarration.source.participantId = "foreign"; },
    (item) => { item.payload.runNarration.source.extra = "untrusted"; },
    (item) => { item.payload.runNarration.segments[1].startEventSequence = 3; },
    (item) => { item.payload.runNarration.segments[1].endEventSequence = 9; },
    (item) => { item.payload.runNarration.segments[1].firstEventId = "e2"; },
    (item) => { item.payload.runNarration.segments[1].sourceRevision = 1; },
    (item) => { item.payload.runNarration.sourceItemId = item.id; },
    (item) => { item.payload.runNarration.segments = []; },
    (item) => { item.payload.body = "Different text"; },
    (item) => { item.payload.streaming = true; },
    (item) => { item.payload.deliveryStatus = "pending"; },
    (item) => { item.payload.presentationRole = "execution_summary"; },
    (item) => { item.domainRefs[0].id = "foreign-run"; },
    (item) => { item.domainRefs.push({ type: "run", id: "second-run" }); },
  ]) {
    const item = fixture(); mutate(item);
    assert.equal(isConversationItemV1(item), false, mutate.toString());
  }
});

test("failed and blocked committed narration may retain an incomplete final segment, never a successful completed claim", () => {
  const item = fixture();
  item.payload.runNarration.segments[1].completed = false;
  assert.equal(isConversationItemV1(item), false);
  item.payload.deliveryStatus = "failed";
  assert.equal(isConversationItemV1(item), true, "execution failure is distinct from canonical publication failure");
  item.status = "failed";
  delete item.committedAt;
  assert.equal(isConversationItemV1(item), false, "runNarration marks a successfully persisted record, not a failed write");
  item.payload.deliveryStatus = "blocked";
  item.status = "committed";
  item.committedAt = now;
  assert.equal(isConversationItemV1(item), true);
});
