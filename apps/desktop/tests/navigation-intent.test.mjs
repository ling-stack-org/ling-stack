import assert from "node:assert/strict";
import test from "node:test";
import { DesktopNavigationIntentStore } from "../dist/main/navigation-intent.js";

test("Desktop navigation intent remains pending until both renderer ACK and target selection", () => {
  const store = new DesktopNavigationIntentStore();
  const intent = store.requestOpenConversation("  conversation-1  ");

  assert.deepEqual(intent, {
    kind: "open_conversation",
    requestId: 1,
    conversationId: "conversation-1",
  });
  assert.deepEqual(store.getPendingIntent(), intent);
  assert.equal(store.acceptRendererSelection(undefined), false);
  assert.equal(store.acceptRendererSelection("conversation-other"), false);
  assert.deepEqual(store.acknowledge(intent.requestId), { accepted: true });
  assert.deepEqual(store.getPendingIntent(), intent, "ACK alone must not release the blank-selection guard");

  assert.equal(store.acceptRendererSelection("conversation-1"), true);
  assert.equal(store.getPendingIntent(), undefined);
});

test("Desktop navigation intent rejects stale completion after a newer Open task request", () => {
  const store = new DesktopNavigationIntentStore();
  const observed = [];
  const unsubscribe = store.onIntentChanged((intent) => observed.push(intent));
  const first = store.requestOpenConversation("conversation-1");
  const second = store.requestOpenConversation("conversation-2");

  assert.deepEqual(observed, [first, second]);
  assert.deepEqual(store.acknowledge(first.requestId), {
    accepted: false,
    reason: "stale_navigation_intent",
  });
  assert.equal(store.acceptRendererSelection(first.conversationId), false);
  assert.deepEqual(store.getPendingIntent(), second);

  assert.equal(store.acceptRendererSelection(second.conversationId), true);
  assert.deepEqual(store.getPendingIntent(), second, "selection alone must remain recoverable until ACK");
  assert.deepEqual(store.acknowledge(second.requestId), { accepted: true });
  assert.equal(store.getPendingIntent(), undefined);
  unsubscribe();
});

test("Desktop navigation intent discards failed opens and isolates broken listeners", () => {
  const store = new DesktopNavigationIntentStore();
  let healthyListenerCalls = 0;
  store.onIntentChanged(() => {
    throw new Error("broken listener");
  });
  store.onIntentChanged(() => {
    healthyListenerCalls += 1;
  });

  const first = store.requestOpenConversation("conversation-1");
  const second = store.requestOpenConversation("conversation-2");
  assert.equal(healthyListenerCalls, 2);
  assert.equal(store.discard(first.requestId), false);
  assert.equal(store.discard(second.requestId), true);
  assert.equal(store.getPendingIntent(), undefined);
  assert.equal(store.requestOpenConversation("   "), undefined);
});
