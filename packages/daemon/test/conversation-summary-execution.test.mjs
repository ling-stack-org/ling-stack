import assert from "node:assert/strict";
import test from "node:test";
import { ConversationSummaryExecutionRegistry } from "../dist/features/channels/context-processing/conversation-summary-execution.js";
import { executeConversationSummaryPlan } from "../dist/features/channels/context-processing/conversation-summary-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixture({ database = "/synthetic/summary.sqlite", thread = "thread", segment = "segment" } = {}) {
  const calls = { commits: 0, checkpoints: 0 };
  const plan = {
    trigger: "hard",
    projection: { metadata: {
      threadId: thread, segmentId: segment, turnId: "turn", projectionVersion: "test-v1",
      contextViewId: "view", contextViewCreatedAt: "2026-09-07T00:00:00.000Z", visibilityFingerprint: "public",
    } },
    sourceItems: [{ id: "source", turnId: "turn", sequence: 1, actorType: "user", kind: "user_message", payload: { body: "Synthetic decision" } }],
    sourceFence: [], sourceRefs: [{ type: "conversation_item", id: "source" }], activeWorkRefs: [],
    coveredFromSequence: 1, coveredThroughSequence: 1, chunkTokenBudget: 1024, summaryTokenBudget: 512,
  };
  const draft = { decisions: ["Use the accepted decision"], constraints: [], openQuestions: [] };
  const commit = { status: "committed", summary: { id: "summary", ...draft, sourceRefs: plan.sourceRefs, activeWorkRefs: [] } };
  const checkpoint = { id: "checkpoint" };
  const store = {
    paths: { databasePath: database },
    commitConversationContextSummary() { calls.commits++; return commit; },
    getLatestWorkspaceProvenanceWatermark() { return 0; },
    createCompactionCheckpoint() { calls.checkpoints++; return checkpoint; },
  };
  return { plan, store, draft, commit, checkpoint, calls };
}

test("summary flight preserves unavailable and completed outcomes without public serialization", async () => {
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry();
  const unavailable = await registry.executeOnce(f.store, f.plan, undefined);
  assert.deepEqual(unavailable, { status: "generator_unavailable", plan: f.plan });
  assert.equal(registry.get(f.store, f.plan), undefined);
  const completed = await registry.executeOnce(f.store, f.plan, async () => f.draft);
  assert.equal(completed.status, "completed");
  assert.equal(completed.commit, f.commit);
  assert.equal(completed.checkpoint, f.checkpoint);
  assert.deepEqual(f.calls, { commits: 1, checkpoints: 1 });
});

test("summary flight preserves generator failures for every caller", async () => {
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry();
  const error = new Error("synthetic generator failure");
  const result = await registry.executeOnce(f.store, f.plan, async () => { throw error; });
  assert.equal(result.status, "generation_failed");
  assert.equal(result.error, error);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
});

test("an AbortError label without an aborted signal remains a generator failure", async () => {
  const f = fixture();
  const error = new DOMException("synthetic provider error", "AbortError");
  const result = await new ConversationSummaryExecutionRegistry().executeOnce(f.store, f.plan, async () => { throw error; });
  assert.equal(result.status, "generation_failed");
  assert.equal(result.error, error);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
});

test("pre-cancelled work never calls the available generator or any commit boundary", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  let generated = 0;
  const result = await executeConversationSummaryPlan({ store: f.store, plan: f.plan, signal: controller.signal,
    generate: async () => { generated++; return f.draft; } });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error, controller.signal.reason);
  assert.equal(generated, 0);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
});

test("cancellation between chunks stops later generation and does not commit a partial summary", async () => {
  const f = fixture();
  const controller = new AbortController();
  const items = [1, 2].map((sequence) => ({ ...f.plan.sourceItems[0], id: "source-" + sequence, sequence,
    payload: { body: "x".repeat(5_000) } }));
  let generated = 0;
  const result = await executeConversationSummaryPlan({ store: f.store, plan: { ...f.plan, sourceItems: items },
    signal: controller.signal, generate: async () => { generated++; controller.abort(); return f.draft; } });
  assert.equal(result.status, "cancelled");
  assert.equal(generated, 1);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
});

test("unexpected commit failure is a distinct execution failure, not a missing result", async () => {
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry();
  const error = new Error("synthetic database failure");
  f.store.commitConversationContextSummary = () => { throw error; };
  const result = await registry.executeOnce(f.store, f.plan, async () => f.draft);
  assert.equal(result.status, "execution_failed");
  assert.equal(result.error, error);
  assert.equal(result.plan, f.plan);
  assert.equal(registry.get(f.store, f.plan), undefined);
});

test("checkpoint failure preserves the committed summary without claiming recovery succeeded", async () => {
  const f = fixture();
  const error = new Error("synthetic checkpoint failure");
  f.store.createCompactionCheckpoint = () => { throw error; };
  const result = await new ConversationSummaryExecutionRegistry().executeOnce(f.store, f.plan, async () => f.draft);
  assert.equal(result.status, "checkpoint_failed");
  assert.equal(result.error, error);
  assert.equal(result.commit, f.commit);
  assert.equal(result.checkpoint, undefined);
});

test("source fence discard remains distinguishable from a committed summary", async () => {
  const f = fixture();
  const discarded = { status: "discarded_stale", reason: "source_items_changed" };
  f.store.commitConversationContextSummary = () => discarded;
  const result = await new ConversationSummaryExecutionRegistry().executeOnce(f.store, f.plan, async () => f.draft);
  assert.equal(result.status, "source_conflict");
  assert.equal(result.commit, discarded);
  assert.equal(result.checkpoint, undefined);
  assert.equal(f.calls.checkpoints, 0);
});

test("same scope waiters share execution and cleanup permits a later retry", async () => {
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry();
  const ready = deferred();
  const finish = deferred();
  let generations = 0;
  const first = registry.executeOnce(f.store, f.plan, async () => {
    generations++; ready.resolve(); await finish.promise; return f.draft;
  });
  await ready.promise;
  assert.equal(registry.get(f.store, f.plan), first);
  assert.equal(registry.executeOnce(f.store, f.plan, async () => { throw new Error("duplicate generation"); }), first);
  finish.resolve();
  assert.equal((await first).status, "completed");
  assert.equal(generations, 1);
  assert.equal(registry.get(f.store, f.plan), undefined);
  const retry = registry.executeOnce(f.store, f.plan, undefined);
  assert.notEqual(retry, first);
  assert.equal((await retry).status, "generator_unavailable");
});

test("registry registers ownership before invoking a reentrant generator", async () => {
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry();
  let reentrant;
  const first = registry.executeOnce(f.store, f.plan, async () => {
    reentrant = registry.executeOnce(f.store, f.plan, undefined);
    return f.draft;
  });
  await first;
  assert.equal(reentrant, first);
});

test("database/thread/segment tuples cannot collide through embedded delimiters", async () => {
  const registry = new ConversationSummaryExecutionRegistry();
  const scopes = [
    fixture({ database: "/synthetic/a:b", thread: "c", segment: "d" }),
    fixture({ database: "/synthetic/a", thread: "b:c", segment: "d" }),
    fixture({ database: "/synthetic/a", thread: "b", segment: "c:d" }),
    fixture({ database: "/synthetic/a", thread: "b", segment: "other" }),
  ];
  const flights = scopes.map((f) => registry.executeOnce(f.store, f.plan, async () => f.draft));
  assert.equal(new Set(flights).size, scopes.length);
  assert.ok((await Promise.all(flights)).every((result) => result.status === "completed"));
  assert.ok(scopes.every((f) => f.calls.commits === 1));
});

test("timeout aborts generation but cannot release ownership or commit a late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry(10);
  const ready = deferred();
  const finish = deferred();
  let signal;
  const first = registry.executeOnce(f.store, f.plan, async (input) => {
    signal = input.signal; ready.resolve(); await finish.promise; return f.draft;
  });
  await ready.promise;
  t.mock.timers.tick(10);
  assert.equal(signal.aborted, true);
  assert.match(signal.reason.message, /timed out/);
  assert.equal(registry.get(f.store, f.plan), first);
  assert.equal(registry.executeOnce(f.store, f.plan, undefined), first);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
  finish.resolve();
  const result = await first;
  assert.equal(result.status, "cancelled");
  assert.equal(result.error, signal.reason);
  assert.deepEqual(f.calls, { commits: 0, checkpoints: 0 });
  assert.equal(registry.get(f.store, f.plan), undefined);
});

test("settled execution cancels its timer and cannot abort the next flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const registry = new ConversationSummaryExecutionRegistry(10);
  let firstSignal;
  await registry.executeOnce(f.store, f.plan, async ({ signal }) => { firstSignal = signal; return f.draft; });
  t.mock.timers.tick(5);
  const ready = deferred();
  const finish = deferred();
  let secondSignal;
  const second = registry.executeOnce(f.store, f.plan, async ({ signal }) => {
    secondSignal = signal; ready.resolve(); await finish.promise; return f.draft;
  });
  await ready.promise;
  t.mock.timers.tick(5);
  assert.equal(firstSignal.aborted, false);
  assert.equal(secondSignal.aborted, false);
  finish.resolve();
  assert.equal((await second).status, "completed");
});

test("invalid timer budgets fail before scheduling work", () => {
  for (const timeout of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new ConversationSummaryExecutionRegistry(timeout), RangeError);
  }
});
