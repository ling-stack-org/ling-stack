import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";
import { createChangeSummaryObserver, isChangeSummaryTurnActive } from "../src/shared/conversation/change-summary/change-summary-observer.ts";

const summary: ThreadWorkspaceChangeSummaryResponse = { cwd: "/workspace", threadId: "thread", turn: { id: "turn", status: "succeeded" } };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("bursts are coalesced and an invalidation during a read receives one trailing read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0; const pending: ((value: ThreadWorkspaceChangeSummaryResponse) => void)[] = [];
  const published: (ThreadWorkspaceChangeSummaryResponse | undefined)[] = [];
  const observer = createChangeSummaryObserver({ active: false, read: () => { reads += 1; return new Promise((resolve) => pending.push(resolve)); }, publish: (value) => published.push(value) });
  t.after(() => observer.dispose());
  observer.refresh(); observer.invalidate(); observer.invalidate(); observer.refresh();
  assert.equal(reads, 1);
  pending.shift()!(summary); await flush();
  assert.deepEqual(published, [summary]);
  t.mock.timers.tick(250); assert.equal(reads, 2);
  pending.shift()!(summary); await flush();
  t.mock.timers.tick(10_000); assert.equal(reads, 2, "a terminal idle observation must stop polling");
  observer.invalidate(); observer.invalidate(); t.mock.timers.tick(250); assert.equal(reads, 3);
});

test("active Turn polling stops when its response becomes terminal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const observer = createChangeSummaryObserver({ active: false, read: async () => ({ ...summary, turn: { id: "turn", status: ++reads === 1 ? "running" : "succeeded" } }), publish() {} });
  t.after(() => observer.dispose());
  observer.refresh(); await flush(); t.mock.timers.tick(1500); await flush();
  assert.equal(reads, 2);
  t.mock.timers.tick(10_000); assert.equal(reads, 2);
  assert.equal(isChangeSummaryTurnActive("waiting_for_approval"), true);
  assert.equal(isChangeSummaryTurnActive("cancelled"), false);
});

test("failed reads retry with backoff while inactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const pendingRejects: ((reason?: unknown) => void)[] = [];
  const published: (ThreadWorkspaceChangeSummaryResponse | undefined)[] = [];
  const observer = createChangeSummaryObserver({
    active: false,
    pollMs: 100,
    read: () => {
      reads += 1;
      return new Promise<ThreadWorkspaceChangeSummaryResponse>((_, reject) => pendingRejects.push(reject));
    },
    publish: (value) => published.push(value),
  });
  t.after(() => observer.dispose());

  observer.refresh();
  pendingRejects.shift()!(new Error("offline"));
  await flush();
  assert.deepEqual(published, [undefined]);
  t.mock.timers.tick(100);
  assert.equal(reads, 2);

  pendingRejects.shift()!(new Error("offline"));
  await flush();
  t.mock.timers.tick(199);
  assert.equal(reads, 2);
  t.mock.timers.tick(1);
  assert.equal(reads, 3);
});

test("pausing drops in-flight results, performs no reads and refreshes on resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: ((value: ThreadWorkspaceChangeSummaryResponse) => void)[] = [];
  const published: (ThreadWorkspaceChangeSummaryResponse | undefined)[] = [];
  const observer = createChangeSummaryObserver({ active: true, read: () => new Promise((resolve) => pending.push(resolve)), publish: (value) => published.push(value) });
  t.after(() => observer.dispose());
  observer.refresh(); observer.setPaused(true); pending.shift()!(summary); await flush();
  observer.invalidate(); t.mock.timers.tick(10_000); assert.equal(pending.length, 0); assert.deepEqual(published, []);
  observer.setPaused(false); assert.equal(pending.length, 1);
  pending.shift()!(summary); await flush(); assert.deepEqual(published, [summary]);
  observer.dispose(); t.mock.timers.tick(10_000); assert.equal(pending.length, 0);
});

test("disposed observations cannot publish a late success or failure", async () => {
  for (const fail of [false, true]) {
    let finish!: () => void; let published = 0;
    const observer = createChangeSummaryObserver({ active: false, read: () => new Promise((resolve, reject) => {
      finish = () => fail ? reject(new Error("offline")) : resolve(summary);
    }), publish: () => { published += 1; } });
    observer.refresh(); observer.dispose(); finish(); await flush();
    assert.equal(published, 0);
  }
});
