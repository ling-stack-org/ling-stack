import assert from "node:assert/strict";
import test from "node:test";
import { subscribeWithInitialRead } from "../dist/shared/initial-state-subscription.js";

test("live subscription value wins over a deferred initial read", async () => {
  const initial = deferred();
  const values = [];
  let liveListener;
  const unsubscribe = subscribeWithInitialRead({
    read: () => initial.promise,
    subscribe: (listener) => {
      liveListener = listener;
      return () => {
        liveListener = undefined;
      };
    },
    onValue: (value) => values.push(value),
  });

  liveListener("new-live-value");
  initial.resolve("stale-initial-value");
  await Promise.resolve();

  assert.deepEqual(values, ["new-live-value"]);
  unsubscribe();
  assert.equal(liveListener, undefined);
});

test("a pushed Desktop navigation intent suppresses the stale initial intent", async () => {
  const initial = deferred();
  const values = [];
  let liveListener;
  const unsubscribe = subscribeWithInitialRead({
    read: () => initial.promise,
    subscribe: (listener) => {
      liveListener = listener;
      return () => undefined;
    },
    onValue: (value) => values.push(value),
  });
  const stale = { kind: "open_conversation", requestId: 1, conversationId: "conversation-old" };
  const current = { kind: "open_conversation", requestId: 2, conversationId: "conversation-current" };

  liveListener(current);
  initial.resolve(stale);
  await Promise.resolve();

  assert.deepEqual(values, [current]);
  unsubscribe();
});

test("initial read applies when no live value arrives and is ignored after unsubscribe", async () => {
  const first = deferred();
  const firstValues = [];
  const unsubscribeFirst = subscribeWithInitialRead({
    read: () => first.promise,
    subscribe: () => () => undefined,
    onValue: (value) => firstValues.push(value),
  });
  first.resolve("initial-value");
  await Promise.resolve();
  assert.deepEqual(firstValues, ["initial-value"]);
  unsubscribeFirst();

  const second = deferred();
  const secondValues = [];
  const unsubscribeSecond = subscribeWithInitialRead({
    read: () => second.promise,
    subscribe: () => () => undefined,
    onValue: (value) => secondValues.push(value),
  });
  unsubscribeSecond();
  second.resolve("late-value");
  await Promise.resolve();
  assert.deepEqual(secondValues, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
