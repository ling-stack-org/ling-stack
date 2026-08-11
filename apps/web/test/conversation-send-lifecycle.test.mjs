import assert from "node:assert/strict";
import test from "node:test";
import { ConversationSendLifecycleStore } from "../src/shared/conversation/conversation-send-lifecycle.ts";

function target(runId, createdAt = "2026-08-05T00:00:00.000Z") {
  return {
    runId,
    sourceRunId: runId,
    workUnitId: `wu_${runId}`,
    channelId: "channel_engineering",
    status: "running",
    createdAt,
    updatedAt: createdAt,
  };
}

test("send lifecycle restores input only when failure happens before message acceptance", () => {
  const store = new ConversationSendLifecycleStore("channel:one");
  const beforeAccept = store.begin("channel:one");
  assert.deepEqual(store.fail(beforeAccept), { accepted: false, restoreInput: true });
  assert.equal(store.snapshot().phase, "failed_before_accept");

  const afterAccept = store.begin("channel:one");
  assert.equal(store.accept(afterAccept), true);
  assert.deepEqual(store.fail(afterAccept), { accepted: true, restoreInput: false });
  assert.equal(store.snapshot().phase, "settled");
});

test("reply linkage unlocks guidance before the response stream settles", () => {
  const store = new ConversationSendLifecycleStore("channel:one");
  const operation = store.begin("channel:one");
  store.accept(operation);
  assert.equal(store.link(operation, target("run_1")), true);
  assert.equal(store.snapshot().phase, "reply_linked");
  assert.deepEqual(store.snapshot().activeReplies.map((reply) => reply.runId), ["run_1"]);

  assert.deepEqual(store.fail(operation), { accepted: true, restoreInput: false });
  assert.equal(store.snapshot().phase, "settled");
  assert.deepEqual(store.snapshot().activeReplies, []);
  assert.equal(store.settle(operation), false);
});

test("concurrent submissions keep independent acceptance and reply linkage", () => {
  const store = new ConversationSendLifecycleStore("channel:one");
  const first = store.begin("channel:one");
  const second = store.begin("channel:one");

  assert.equal(first.hasPendingPredecessor, false);
  assert.equal(second.hasPendingPredecessor, true);

  assert.equal(store.accept(first), true);
  assert.equal(store.link(first, target("run_1", "2026-08-05T00:00:00.000Z")), true);
  assert.equal(store.accept(second), true);
  assert.equal(store.link(second, target("run_2", "2026-08-05T00:00:01.000Z")), true);
  assert.deepEqual(store.snapshot().activeReplies.map((reply) => reply.runId), ["run_1", "run_2"]);

  assert.equal(store.settle(first), true);
  assert.deepEqual(store.snapshot().activeReplies.map((reply) => reply.runId), ["run_2"]);
  assert.equal(store.settle(second), true);
  assert.deepEqual(store.snapshot().activeReplies, []);
});

test("owner reset rejects stale, duplicate, and out-of-order stream events", () => {
  const store = new ConversationSendLifecycleStore("channel:one");
  const first = store.begin("channel:one");
  const current = store.begin("channel:one");

  assert.equal(store.accept(first), true);
  assert.equal(store.link(current, target("run_out_of_order")), false);
  assert.equal(store.accept(current), true);
  assert.equal(store.link(current, target("run_1")), true);
  assert.equal(store.link(current, { ...target("run_1"), updatedAt: "2026-08-05T00:00:01.000Z" }), true);
  assert.deepEqual(store.snapshot().activeReplies.map((reply) => reply.runId), ["run_1"]);

  store.reset("channel:two");
  assert.equal(store.link(first, target("run_stale_first_owner")), false);
  assert.equal(store.link(current, target("run_stale_owner")), false);
  assert.equal(store.snapshot().ownerKey, "channel:two");
  assert.deepEqual(store.snapshot().activeReplies, []);
});
