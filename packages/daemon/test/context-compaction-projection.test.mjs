import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationContextCompactions } from "../dist/features/conversations/context-compaction-projection.js";
import { appendContextCompactionInvalidation } from "../dist/features/runs/execution-action-invalidation.js";

const thread = { id: "thread", workspaceId: "workspace" };
const run = { id: "run", threadId: thread.id, status: "running", teammateId: "ling" };
const anchor = { id: "assistant", workspaceId: thread.workspaceId, threadId: thread.id, turnId: "turn",
  kind: "assistant_message", sequence: 2, actorId: "ling", domainRefs: [{ type: "run", id: run.id }] };
const event = (seq, type, data = {}) => ({ id: `event-${seq}`, runId: run.id, seq, type,
  ts: "2026-10-23T00:00:00Z", data: { attemptId: "attempt", reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", ...data } });
const start = event(1, "context_compaction_start");
const end = (outcome, more = {}) => event(2, "context_compaction_end", { outcome, willRetry: false, ...more });

test("compaction start/end invalidate live projections without publishing context or tool actions", () => {
  const published = [];
  const store = { appendControlPlaneEvent: (input, ts) => ({ ...input, ts, seq: published.length + 1 }) };
  const hub = { publish: input => published.push(input) };
  for (const value of [start, end("sdk_installed", { rawContext: "PRIVATE" }), event(3, "assistant_thinking_delta")]) {
    appendContextCompactionInvalidation({ store, hub, cwd: "/preview", event: value });
  }
  assert.equal(published.length, 2);
  assert.ok(published.every(input => input.domain === "runs" && input.entityType === "context_compaction"));
  assert.equal(JSON.stringify(published).includes("PRIVATE"), false);
});
function project(events, overrides = {}) {
  return projectConversationContextCompactions({ thread, runs: [run], items: [anchor],
    runLinks: [{ runId: run.id, turnId: anchor.turnId }],
    store: { listEvents: (_, { afterSeq, limit }) => events.filter(e => e.seq > afterSeq).slice(0, limit) }, ...overrides });
}

test("compaction stays running until its own authoritative end, with stable replay identity", () => {
  const [pending] = project([start]);
  assert.equal(pending.status, "running");
  for (const [outcome, status] of [["sdk_installed", "succeeded"], ["failed", "failed"], ["aborted", "cancelled"]]) {
    const events = [start, end(outcome, { tokensBefore: 60000, estimatedTokensAfter: 12000, rawContext: "PRIVATE_CONTEXT" })];
    const [settled] = project(events);
    assert.equal(settled.id, pending.id);
    assert.ok(settled.revision > pending.revision);
    assert.equal(settled.status, status);
    assert.deepEqual(project(events), project(events));
    assert.equal(JSON.stringify(settled).includes("PRIVATE_CONTEXT"), false);
    assert.equal(settled.tokensBefore, 60000);
    assert.equal(settled.sourceRefs.some(ref => ref.kind === "run_event" && ref.id === "event-2"), true);
  }
});

test("orphan ends and another attempt cannot manufacture compaction success", () => {
  assert.deepEqual(project([end("sdk_installed")]), []);
  assert.equal(project([start, end("sdk_installed", { attemptId: "other" })])[0].status, "running");
  assert.equal(project([start, end("sdk_installed", { reason: "manual" })])[0].status, "running");
  const [terminal] = project([start], { runs: [{ ...run, status: "succeeded" }] });
  assert.equal(terminal.status, "blocked");
  assert.ok(project([start, end("sdk_installed")])[0].revision > terminal.revision);
  assert.equal(project([start, event(2, "run_cancelled")])[0].status, "blocked");
});

test("each compaction has its own identity; replaced and unfinished cycles stay unconfirmed", () => {
  const next = event(3, "context_compaction_start");
  const settled = event(4, "context_compaction_end", { outcome: "sdk_installed", willRetry: true });
  const rows = project([start, next, settled]);
  assert.deepEqual(rows.map(row => row.status), ["blocked", "succeeded"]);
  assert.notEqual(rows[0].id, rows[1].id);
});

test("compaction selects the earliest assistant anchor in the linked turn", () => {
  const earlierTurn = { ...anchor, id: "earlier-turn", turnId: "earlier-turn", sequence: 1 };
  const laterMessage = { ...anchor, id: "later-message", sequence: 3 };
  for (const events of [[start], [start, end("sdk_installed")]]) {
    const expected = project(events);
    for (const items of [[earlierTurn, anchor, laterMessage], [laterMessage, anchor, earlierTurn]]) {
      const rows = project(events, { items });
      assert.deepEqual(rows, expected);
      assert.equal(rows[0].anchorItemId, anchor.id);
      assert.equal(rows[0].turnId, anchor.turnId);
      assert.equal(rows[0].sourceRefs.some(ref => ref.kind === "conversation_item" && ref.id === earlierTurn.id), false);
    }
    assert.deepEqual(project(events, { items: [earlierTurn] }), []);
  }
});
test("projection respects thread, turn-link, anchor ownership and event pagination", () => {
  for (const overrides of [
    { items: [{ ...anchor, threadId: "other" }] },
    { items: [{ ...anchor, domainRefs: [...anchor.domainRefs, { type: "run", id: "other" }] }] },
    { runLinks: [{ runId: run.id, turnId: "other" }] },
    { runs: [{ ...run, threadId: "other" }] },
  ]) assert.deepEqual(project([start, end("sdk_installed")], overrides), []);
  const noise = Array.from({ length: 1000 }, (_, i) => event(i + 1, "assistant_thinking_delta", { text: "PRIVATE" }));
  const rows = project([...noise, event(1001, "context_compaction_start"),
    event(1002, "context_compaction_end", { outcome: "sdk_installed", willRetry: false })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "succeeded");
  assert.equal(JSON.stringify(rows).includes("PRIVATE"), false);
});
