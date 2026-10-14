import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as realSleep } from "node:timers/promises";
import { test } from "node:test";

test("A16 a real poll released after stop cannot revive its background scheduler", { timeout: 15_000 }, async (t) => {
  const fixture = await createFixture(t);
  const gate = fixture.transport.holdNext("poll");
  const starting = fixture.track(fixture.scheduler.start(fixture.cwd, fixture.input));
  await waitFor(gate.entered, "the public start must enter its real poll request");

  const registered = fixture.scheduler.list(fixture.cwd);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].status, "running");
  const stopped = fixture.scheduler.stop(fixture.cwd, registered[0].id);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.nextPollAt, undefined);

  gate.release();
  const completedStart = await starting;
  const current = fixture.scheduler.list(fixture.cwd)[0];
  assert.equal(current.status, "stopped", "a late successful poll must not overwrite accepted stop");
  assert.equal(current.stoppedAt, stopped.stoppedAt);
  assert.equal(current.nextPollAt, undefined, "a stopped generation must not install another timer");
  assert.equal(completedStart.scheduler.status, "stopped");
  assert.equal(fixture.transport.calls.length, 1, "this empty poll has no subsequent remote stage");
});

test("A16 stopping old A again cannot remove the same-key successor B from deduplication", { timeout: 15_000 }, async (t) => {
  const fixture = await createFixture(t);
  const input = { ...fixture.input, runImmediately: false };
  const first = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(first.duplicate, false);
  const stopped = fixture.scheduler.stop(fixture.cwd, first.scheduler.id);
  assert.equal(stopped.status, "stopped");

  const successor = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(successor.duplicate, false);
  assert.notEqual(successor.scheduler.id, first.scheduler.id);
  assert.equal(successor.scheduler.status, "running");
  const stoppedAgain = fixture.scheduler.stop(fixture.cwd, first.scheduler.id);
  assert.equal(stoppedAgain.status, "stopped");

  const duplicate = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(duplicate.duplicate, true, "repeating stop(A) must not erase B's current key ownership");
  assert.equal(duplicate.scheduler.id, successor.scheduler.id);
  assert.equal(fixture.scheduler.list(fixture.cwd).filter(entry => entry.status === "running").length, 1);
  assert.equal(fixture.transport.calls.length, 0, "registration-only starts must not poll GitHub");
});

test("A17 real startup reconcile failure leaves a failed entry and permits a fresh normal retry", { timeout: 15_000 }, async (t) => {
  const fixture = await createFixture(t, { reconcileOnStartup: true, pollItems: [pullRequest()] });
  // Public Core polling creates the real workflow and scheduler state. Without
  // this producer, empty startup reconcile would never reach the fetch barrier.
  const seeded = await fixture.core.pollGitHubExternalWork({
    store: fixture.store,
    cwd: fixture.cwd,
    channelId: fixture.input.channelId,
    workflowDefinition: fixture.core.parseExternalWorkflowMarkdown(fixture.markdown),
    workflowDirectory: fixture.cwd,
    fetch: fixture.transport.fetch,
    executeHooks: false,
  });
  assert.equal(seeded.claimed, 1);
  assert.equal(seeded.schedulerStates[0].schedulerStatus, "ready");

  const failure = new Error("A17 isolated startup reconcile transport failure");
  const gate = fixture.transport.holdNext("item", failure);
  const input = { ...fixture.input, runImmediately: false };
  const starting = fixture.track(fixture.scheduler.start(fixture.cwd, input));
  await waitFor(gate.entered, "startup reconcile must read the previously polled remote item");
  const originalId = fixture.scheduler.list(fixture.cwd)[0].id;
  gate.release();
  await assert.rejects(starting, error => error === failure);

  const failed = fixture.scheduler.list(fixture.cwd).find(entry => entry.id === originalId);
  assert.equal(failed.status, "failed", "a rejected startup must not remain a timerless running duplicate");
  assert.equal(failed.nextPollAt, undefined);
  assert.match(failed.lastErrorMessage, /A17 isolated startup reconcile transport failure/);
  const retried = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(retried.duplicate, false);
  assert.notEqual(retried.scheduler.id, originalId);
  assert.equal(retried.scheduler.status, "running");
  assert.equal(retried.startupReconcile.checked, 1);
  assert.equal(typeof retried.scheduler.nextPollAt, "string");
  assert.equal(fixture.scheduler.list(fixture.cwd).filter(entry => entry.status === "running").length, 1);
  assert.deepEqual(fixture.transport.calls.map(call => call.path), [
    "/repos/fixture/background-lifecycle/pulls",
    "/repos/fixture/background-lifecycle/pulls/86279",
    "/repos/fixture/background-lifecycle/pulls/86279",
  ]);
});

for (const stage of ["poll", "reconcile"]) {
  for (const stopping of ["stop", "stopAll"]) {
    for (const outcome of ["success", "error"]) {
      test(`A16 ${stage} ${outcome} after ${stopping} preserves stopped A and current successor B`, { timeout: 15_000 }, async t => {
        const fixture = await createFixture(t, { pollItems: [pullRequest()] });
        const failure = outcome === "error" ? new Error(`isolated late ${stage} error`) : undefined;
        const gate = fixture.transport.holdNext(stage === "poll" ? "poll" : "item", failure);
        const starting = fixture.track(fixture.scheduler.start(fixture.cwd, fixture.input));
        await waitFor(gate.entered, `the real ${stage} must reach its transport gate`);
        const original = fixture.scheduler.list(fixture.cwd)[0];
        stopWith(fixture, stopping, original.id);
        const stopped = entryById(fixture, original.id);
        const successorInput = { ...fixture.input, runImmediately: false };
        const successor = await fixture.track(fixture.scheduler.start(fixture.cwd, successorInput));
        assert.equal(successor.duplicate, false);
        assert.notEqual(successor.scheduler.id, original.id);
        const successorSnapshot = structuredClone(successor.scheduler);

        gate.release();
        const returned = await starting;
        const settled = entryById(fixture, original.id);
        assert.equal(settled.status, "stopped");
        assert.equal(settled.stoppedAt, stopped.stoppedAt);
        assert.equal(settled.nextPollAt, undefined);
        assert.equal(settled.tickCount, 1, "the already admitted tick remains a known fact");
        assert.equal(typeof settled.lastPollAt, "string");
        assert.equal(returned.scheduler.status, "stopped");
        if (stage === "reconcile" || outcome === "success") {
          assert.equal(settled.lastPoll.claimed, 1, "a real poll result is retained even after stop");
        } else assert.equal(settled.lastPoll, undefined);
        if (stage === "reconcile" && outcome === "success") {
          assert.equal(settled.lastReconcile.checked, 1);
          assert.equal(typeof settled.lastReconcileAt, "string");
        } else assert.equal(settled.lastReconcile, undefined);
        if (failure) assert.equal(settled.lastErrorMessage, failure.message);
        else assert.equal(settled.lastErrorMessage, undefined);
        assert.equal(fixture.transport.calls.length, stage === "poll" ? 1 : 2,
          "a stopped poll must not start reconcile, and a stopped reconcile must not start another tick");
        assert.deepEqual(entryById(fixture, successor.scheduler.id), successorSnapshot,
          "the old tick's result/finalizer must not change B");
        const duplicate = await fixture.track(fixture.scheduler.start(fixture.cwd, successorInput));
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.scheduler.id, successor.scheduler.id);
      });
    }
  }
}

for (const stopping of ["stop", "stopAll"]) {
  for (const outcome of ["success", "error"]) {
    test(`A17 startup reconcile ${outcome} after ${stopping} cannot revive A or release B's key`, { timeout: 15_000 }, async t => {
      const fixture = await createFixture(t, { reconcileOnStartup: true, pollItems: [pullRequest()] });
      await seedExternalItem(fixture);
      const failure = outcome === "error" ? new Error("isolated late startup error") : undefined;
      const gate = fixture.transport.holdNext("item", failure);
      // Leave immediate polling enabled on A: a late startup success must not
      // advance to that next stage after stop has been accepted.
      const starting = fixture.track(fixture.scheduler.start(fixture.cwd, fixture.input));
      await waitFor(gate.entered, "the real startup reconcile must enter its item request");
      const originalId = fixture.scheduler.list(fixture.cwd)[0].id;
      const pendingDuplicate = await fixture.track(fixture.scheduler.start(fixture.cwd, fixture.input));
      assert.equal(pendingDuplicate.duplicate, true, "an in-flight startup still owns the existing deduplication key");
      assert.equal(pendingDuplicate.scheduler.id, originalId);
      stopWith(fixture, stopping, originalId);
      const stopped = entryById(fixture, originalId);
      const successorInput = { ...fixture.input, runImmediately: false };
      const successor = await fixture.track(fixture.scheduler.start(fixture.cwd, successorInput));
      assert.equal(successor.duplicate, false);
      assert.equal(successor.startupReconcile.checked, 1);
      const successorSnapshot = structuredClone(successor.scheduler);

      gate.release();
      if (failure) await assert.rejects(starting, error => error === failure);
      else {
        const completed = await starting;
        assert.equal(completed.scheduler.status, "stopped");
        assert.equal(completed.startupReconcile.checked, 1);
      }
      const settled = entryById(fixture, originalId);
      assert.equal(settled.status, "stopped");
      assert.equal(settled.stoppedAt, stopped.stoppedAt);
      assert.equal(settled.nextPollAt, undefined);
      assert.equal(settled.tickCount, 0, "startup is not an admitted poll tick");
      assert.equal(settled.lastPoll, undefined);
      if (failure) {
        assert.equal(settled.lastErrorCode, "background_startup_reconcile_failed");
        assert.equal(settled.lastErrorMessage, failure.message);
      } else assert.equal(settled.lastReconcile.checked, 1);
      assert.deepEqual(entryById(fixture, successor.scheduler.id), successorSnapshot);
      const duplicate = await fixture.track(fixture.scheduler.start(fixture.cwd, successorInput));
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.scheduler.id, successor.scheduler.id);
      assert.deepEqual(fixture.transport.calls.map(call => call.path), [
        "/repos/fixture/background-lifecycle/pulls",
        "/repos/fixture/background-lifecycle/pulls/86279",
        "/repos/fixture/background-lifecycle/pulls/86279",
      ], "A cannot begin its still-unentered immediate poll after late startup settlement");
    });
  }
}

test("A16 stop and stopAll preserve the first stoppedAt across controlled clock advancement and wrong cwd", { timeout: 15_000 }, async t => {
  const fixture = await createFixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T01:00:00.000Z") });
  const started = await fixture.track(fixture.scheduler.start(fixture.cwd, { ...fixture.input, runImmediately: false }));
  const before = structuredClone(started.scheduler);
  assert.equal(fixture.scheduler.stop(join(fixture.cwd, "not-this-workspace"), started.scheduler.id), undefined);
  assert.deepEqual(entryById(fixture, started.scheduler.id), before, "wrong cwd cannot stop the current owner");
  assert.equal(fixture.scheduler.stop(fixture.cwd, "unknown-id"), undefined);
  const first = fixture.scheduler.stop(fixture.cwd, started.scheduler.id);
  t.mock.timers.tick(5_000);
  const second = fixture.scheduler.stop(fixture.cwd, started.scheduler.id);
  assert.equal(second.stoppedAt, first.stoppedAt);
  t.mock.timers.tick(5_000);
  fixture.scheduler.stopAll();
  assert.equal(entryById(fixture, started.scheduler.id).stoppedAt, first.stoppedAt);
  assert.equal(fixture.transport.calls.length, 0);
});

for (const stopping of ["stop", "stopAll"]) {
  for (const outcome of ["success", "error"]) {
    test(`A16 timer-admitted ${outcome} cannot rearm after ${stopping}`, { timeout: 15_000 }, async t => {
      const fixture = await createFixture(t);
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-15T02:00:00.000Z") });
      const failure = outcome === "error" ? new Error("isolated timer poll error") : undefined;
      const gate = fixture.transport.holdNext("poll", failure);
      const started = await fixture.track(fixture.scheduler.start(fixture.cwd, { ...fixture.input, runImmediately: false }));
      assert.equal(started.scheduler.tickCount, 0);
      assert.equal(fixture.transport.calls.length, 0);
      t.mock.timers.tick(60_000);
      await waitFor(gate.entered, "the actual registered timer must admit its real poll");
      stopWith(fixture, stopping, started.scheduler.id);
      const stopped = entryById(fixture, started.scheduler.id);
      gate.release();
      await waitUntil(() => entryById(fixture, started.scheduler.id).tickCount === 1,
        "the admitted timer tick must settle before checking for rearm");
      await nextTurn();
      assert.equal(entryById(fixture, started.scheduler.id).status, "stopped");
      assert.equal(entryById(fixture, started.scheduler.id).stoppedAt, stopped.stoppedAt);
      assert.equal(entryById(fixture, started.scheduler.id).nextPollAt, undefined);
      if (failure) assert.equal(entryById(fixture, started.scheduler.id).lastErrorMessage, failure.message);
      t.mock.timers.tick(180_000);
      await nextTurn();
      assert.equal(fixture.transport.calls.length, 1, "advancing three more intervals must not find a late rearmed timer");
      assert.equal(entryById(fixture, started.scheduler.id).tickCount, 1);
    });
  }
}

for (const stage of ["poll", "reconcile"]) {
  test(`A16 an ordinary current-owner ${stage} error remains scheduled and a later real tick clears the error`, { timeout: 15_000 }, async t => {
    const fixture = await createFixture(t, { pollItems: stage === "poll" ? [] : [pullRequest()] });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-15T03:00:00.000Z") });
    const failure = new Error(`isolated recoverable ${stage} failure`);
    const firstGate = fixture.transport.holdNext(stage === "poll" ? "poll" : "item", failure);
    const started = await fixture.track(fixture.scheduler.start(fixture.cwd, { ...fixture.input, runImmediately: false }));
    t.mock.timers.tick(60_000);
    await waitFor(firstGate.entered, `first real timer ${stage}`);
    firstGate.release();
    await waitUntil(() => {
      const entry = entryById(fixture, started.scheduler.id);
      return entry.tickCount === 1 && typeof entry.nextPollAt === "string";
    }, `an ordinary ${stage} error must still schedule the next timer`);
    const failedTick = entryById(fixture, started.scheduler.id);
    assert.equal(failedTick.status, "running");
    assert.equal(failedTick.lastErrorMessage, failure.message);
    const secondGate = fixture.transport.holdNext("poll");
    t.mock.timers.tick(60_000);
    await waitFor(secondGate.entered, "the registered retry timer's real poll");
    secondGate.release();
    await waitUntil(() => entryById(fixture, started.scheduler.id).tickCount === 2,
      "the recovery tick must complete");
    await nextTurn();
    const recovered = entryById(fixture, started.scheduler.id);
    assert.equal(recovered.status, "running");
    assert.equal(recovered.lastErrorCode, undefined);
    assert.equal(recovered.lastErrorMessage, undefined);
    assert.equal(recovered.lastPoll.candidates, stage === "poll" ? 0 : 1);
    assert.equal(recovered.lastReconcile.checked, stage === "poll" ? 0 : 1);
    assert.equal(typeof recovered.nextPollAt, "string");
    assert.equal(fixture.transport.calls.length, stage === "poll" ? 2 : 4);
  });
}

test("A17 normal startup is visible, deduplicates without another remote stage and keeps wrong-cwd isolation", { timeout: 15_000 }, async t => {
  const fixture = await createFixture(t, { reconcileOnStartup: true, pollItems: [pullRequest()] });
  await seedExternalItem(fixture);
  const input = { ...fixture.input, runImmediately: false };
  const first = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(first.duplicate, false);
  assert.equal(first.startupReconcile.checked, 1);
  assert.equal(first.scheduler.lastReconcile.checked, 1);
  assert.equal(first.scheduler.tickCount, 0);
  assert.equal(typeof first.scheduler.nextPollAt, "string");
  const duplicate = await fixture.track(fixture.scheduler.start(fixture.cwd, input));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.scheduler.id, first.scheduler.id);
  assert.equal(duplicate.startupReconcile, undefined);
  assert.deepEqual(fixture.scheduler.list(join(fixture.cwd, "another-workspace")), []);
  assert.equal(fixture.transport.calls.length, 2, "seed and first startup only, without a duplicate reconcile/poll");
});

/** Own every runtime path, SQLite handle, await gate and resulting start promise. */
async function createFixture(t, { reconcileOnStartup = false, pollItems = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ling-external-background-lifecycle-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const previous = {
    LING_STACK_HOME: process.env.LING_STACK_HOME,
    LING_STACK_DEFAULT_WORKSPACE_CWD: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD,
  };
  process.env.LING_STACK_HOME = join(root, "user");
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const transport = createTransport(pollItems);
  const pending = [];
  let storeRegistry;
  let scheduler;
  t.after(async () => {
    try {
      // Stop first, then collect already admitted operations, then stop again:
      // even the expected old-code RED cannot retain a revived timer/SQLite IO.
      scheduler?.stopAll();
      transport.releaseAll();
      await Promise.all(pending);
      // Timer ticks are admitted through the registered callback, not start's
      // promise. After stop prevents new stages, let the released Core await
      // and its finally/then complete before closing this fixture's SQLite.
      await nextTurn();
      scheduler?.stopAll();
    } finally {
      try { storeRegistry?.closeAll(); }
      finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  const core = await import("../../core/dist/index.js");
  const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
  const { ExternalWorkBackgroundSchedulerRegistry } = await import("../dist/features/external-work/background-scheduler.js");
  storeRegistry = new RunStoreRegistry(storeCwd => {
    assert.equal(storeCwd, cwd, "the scheduler must only open its owned workspace");
    return core.createSqliteRunStore(storeCwd);
  });
  const store = storeRegistry.getStore(cwd);
  const channel = store.createChannel({ name: "A16/A17 isolated background", boundPath: cwd, defaultTeammateId: "engineer" }, new Date().toISOString());
  const markdown = workflowMarkdown(reconcileOnStartup);
  await writeFile(join(cwd, "WORKFLOW.md"), markdown, "utf8");
  const secretResolver = {
    resolve() { assert.fail("this credential-free fixture must not resolve a secret"); },
    status() { assert.fail("this credential-free fixture must not inspect a secret"); },
  };
  scheduler = new ExternalWorkBackgroundSchedulerRegistry(storeRegistry, secretResolver, transport.fetch);
  return {
    cwd, core, store, scheduler, markdown, transport,
    input: { channelId: channel.id, workflowPath: "WORKFLOW.md", executeHooks: false },
    track(promise) {
      // Install a rejection observer before a deliberately withheld fetch can
      // fail. Callers still assert the original promise's real result/error.
      pending.push(promise.then(() => undefined, () => undefined));
      return promise;
    },
  };
}

/** Intercept only this registry's fetch dependency; never replace global fetch. */
function createTransport(pollItems) {
  const calls = [];
  const next = new Map();
  const gates = [];
  return {
    calls,
    holdNext(kind, failure) {
      assert.equal(next.has(kind), false, "one request owns each pending gate");
      let enter;
      let release;
      const entered = new Promise(resolve => { enter = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      const gate = { entered, released, enter, release, failure };
      next.set(kind, gate);
      gates.push(gate);
      return gate;
    },
    releaseAll() { for (const gate of gates) gate.release(); },
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://api.github.com");
      assert.equal(init.method ?? "GET", "GET", "no external mutation is permitted in this fixture");
      const kind = parsed.pathname === "/repos/fixture/background-lifecycle/pulls" ? "poll"
        : parsed.pathname === "/repos/fixture/background-lifecycle/pulls/86279" ? "item" : undefined;
      assert.ok(kind, `Unexpected isolated GitHub path: ${parsed.pathname}`);
      calls.push({ path: parsed.pathname, query: parsed.search });
      const gate = next.get(kind);
      if (gate) {
        next.delete(kind);
        gate.enter();
        await gate.released;
        if (gate.failure) throw gate.failure;
      }
      const body = kind === "poll" ? pollItems : pullRequest();
      return { ok: true, status: 200, statusText: "OK", async json() { return body; }, async text() { return JSON.stringify(body); } };
    },
  };
}

async function waitFor(promise, message) {
  const controller = new AbortController();
  const deadline = realSleep(5_000, undefined, { signal: controller.signal }).then(() => assert.fail(message));
  try { return await Promise.race([promise, deadline]); }
  finally { controller.abort(); }
}

async function waitUntil(read, message) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (read()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function entryById(fixture, id) {
  const entry = fixture.scheduler.list(fixture.cwd).find(item => item.id === id);
  assert.ok(entry, `Expected registered scheduler ${id}`);
  return entry;
}

function stopWith(fixture, stopping, id) {
  if (stopping === "stopAll") fixture.scheduler.stopAll();
  else assert.equal(fixture.scheduler.stop(fixture.cwd, id).status, "stopped");
  assert.equal(entryById(fixture, id).status, "stopped");
}

async function seedExternalItem(fixture) {
  const seeded = await fixture.track(fixture.core.pollGitHubExternalWork({
    store: fixture.store,
    cwd: fixture.cwd,
    channelId: fixture.input.channelId,
    workflowDefinition: fixture.core.parseExternalWorkflowMarkdown(fixture.markdown),
    workflowDirectory: fixture.cwd,
    fetch: fixture.transport.fetch,
    executeHooks: false,
  }));
  assert.equal(seeded.claimed, 1);
  assert.equal(seeded.schedulerStates[0].schedulerStatus, "ready");
}

function workflowMarkdown(reconcileOnStartup) {
  return `---\nsource:\n  kind: github\n  repository: fixture/background-lifecycle\n  events:\n    - pull_request.opened\nscheduler:\n  pollIntervalMs: 60000\n  reconcileOnStartup: ${reconcileOnStartup}\nagent:\n  teammateId: engineer\n---\n\nReview {{ item.identifier }}.\n\nTitle: {{ item.title }}\n`;
}

function pullRequest() {
  return {
    id: 1001, number: 86279, title: "Isolated scheduler lifecycle fixture", body: "No real GitHub operation.",
    html_url: "https://github.com/fixture/background-lifecycle/pull/86279", state: "open", labels: [],
    updated_at: "2026-10-15T00:00:00.000Z", user: { login: "fixture" },
    base: { ref: "main", sha: "fixture-base" }, head: { ref: "isolated-scheduler", sha: "fixture-head" },
  };
}
