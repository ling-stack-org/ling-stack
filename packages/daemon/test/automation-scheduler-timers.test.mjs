import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as realSleep } from "node:timers/promises";
import { test } from "node:test";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-10-12T00:00:00.000Z");

test("native mock timer sanity preserves unref, clearTimeout, Date and controlled wall-clock jumps", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START_MS });
  let calls = 0;
  const cleared = setTimeout(() => { calls += 1; }, 20);
  assert.equal(typeof cleared.unref, "function");
  assert.equal(cleared.unref(), cleared);
  clearTimeout(cleared);
  t.mock.timers.tick(20);
  assert.equal(calls, 0);
  assert.equal(Date.now(), START_MS + 20);
  assert.equal(new Date().getTime(), Date.now());
  t.mock.timers.setTime(START_MS - 1000);
  assert.equal(Date.now(), START_MS - 1000);
  setTimeout(() => { calls += 1; }, 10);
  t.mock.timers.setTime(START_MS + 1000);
  assert.equal(calls, 0, "wall-clock change alone does not fake a timer delivery");
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test("legal HTTP 30-day interval does not overflow into an early real Node run", { timeout: 20_000 }, async (t) => {
  const ambient = await isolatedAmbient(t);
  const { createDaemonServer } = await import("../dist/index.js");
  const { prepareChannelCreateBody } = await import("./conversation-model-test-fixture.mjs");
  const { ensureGitRepoForChannelPost } = await import("./git-test-helpers.mjs");
  const runner = new RecordingRunner();
  const daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: ambient.cwd,
    channels: { terminalReports: false },
  }, { runner });
  ambient.onCleanup(() => daemon.stop());
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const query = `?cwd=${encodeURIComponent(ambient.cwd)}`;
  async function post(path, body) {
    const url = `${base}${path}${query}`;
    const prepared = await prepareChannelCreateBody(url, body);
    await ensureGitRepoForChannelPost(url, prepared);
    return await json(url, "POST", prepared);
  }
  const provider = (await post("/providers", {
    kind: "glm", displayName: "Timer fixture", providerId: "timer-fixture",
    model: "static-model", api: "google-generative-ai", capabilities: ["chat"],
    input: ["text"], authHeader: false, enabled: true,
  })).provider;
  const channel = (await post("/channels", {
    name: "Timer fixture", status: "active", boundPath: ambient.cwd,
    allowedTools: ["read", "grep", "find", "ls"], defaultProviderPresetId: provider.id,
  })).channel;
  const created = await post("/automations", {
    kind: "daily_brief", title: "Thirty-day timer", channelId: channel.id,
    trigger: scheduledTrigger(THIRTY_DAYS_MS),
  });
  const before = await json(`${base}/automations/scheduler${query}`);
  assert.ok(Date.parse(before.schedulers[0].items[0].nextRunAt) > Date.now() + MAX_TIMER_DELAY_MS);
  await realSleep(150);
  // Stop before assertions so the expected baseline failure cannot keep creating runs.
  const stopped = await post("/automations/scheduler/stop", {});
  const runs = await json(`${base}/automation-runs${query}&automationId=${encodeURIComponent(created.automation.id)}`);
  const detail = await json(`${base}/automations/${encodeURIComponent(created.automation.id)}${query}`);
  assert.equal(runner.runs.length, 0, "a legal 30-day interval must not execute within 150ms");
  assert.equal(runs.automationRuns.length, 0);
  assert.equal(stopped.scheduler.tickCount, 0);
  assert.equal(detail.automation.status, "enabled");
  assert.ok(Date.parse(detail.automation.nextRunAt) > Date.now() + MAX_TIMER_DELAY_MS);
});

for (const everyMs of [MAX_TIMER_DELAY_MS + 1, THIRTY_DAYS_MS]) {
  test(`scheduler segments ${everyMs}ms without firing before the original exact due slot`, async (t) => {
    const f = await schedulerFixture(t, everyMs);
    const due = new Date(START_MS + everyMs).toISOString();
    f.scheduler.start(f.cwd);
    assert.equal(f.timers.last().delay, MAX_TIMER_DELAY_MS);
    assert.equal(f.store.getAutomationDefinition(f.automation.id).nextRunAt, due);
    t.mock.timers.tick(MAX_TIMER_DELAY_MS);
    await f.scheduler.waitForIdle();
    assert.equal(f.runner.runs.length, 0);
    assert.equal(f.store.listAutomationRuns().length, 0);
    assert.equal(f.scheduler.list(f.cwd)[0].tickCount, 0);
    assert.equal(f.scheduler.list(f.cwd)[0].nextRunAt, due);
    assert.equal(f.timers.last().delay, everyMs - MAX_TIMER_DELAY_MS);
    if (everyMs - MAX_TIMER_DELAY_MS > 1) {
      t.mock.timers.tick(everyMs - MAX_TIMER_DELAY_MS - 1);
      await f.scheduler.waitForIdle();
      assert.equal(f.runner.runs.length, 0);
      assert.equal(f.store.listAutomationRuns().length, 0);
    }
    t.mock.timers.tick(1);
    await assertCompletedSlot(f, due);
  });
}

test("scheduler rechecks wall-clock rollback before dispatch and keeps bounded remaining segments", async (t) => {
  const f = await schedulerFixture(t, THIRTY_DAYS_MS);
  const due = new Date(START_MS + THIRTY_DAYS_MS).toISOString();
  f.scheduler.start(f.cwd);
  const first = f.timers.last();
  t.mock.timers.setTime(START_MS - 24 * 60 * 60 * 1000);
  // Deliver the actual registered callback at a controlled wake; never call fireAutomation directly.
  first.callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  assert.equal(f.scheduler.list(f.cwd)[0].nextRunAt, due);
  assert.equal(f.timers.last().delay, MAX_TIMER_DELAY_MS);
  assert.equal(f.timers.live().length, 1);
  t.mock.timers.setTime(Date.parse(due) - 1);
  f.timers.last().callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  assert.equal(f.timers.last().delay, 1);
  t.mock.timers.tick(1);
  await assertCompletedSlot(f, due);
});

for (const missedRunPolicy of ["skip", "run_one"]) {
  test(`running scheduler wall-clock forward dispatches only its pending slot without burst (${missedRunPolicy})`, async (t) => {
    const f = await schedulerFixture(t, THIRTY_DAYS_MS, missedRunPolicy);
    f.scheduler.start(f.cwd);
    const pending = f.timers.last();
    const due = new Date(START_MS + THIRTY_DAYS_MS).toISOString();
    t.mock.timers.setTime(START_MS + 4 * THIRTY_DAYS_MS);
    assert.equal(f.runner.runs.length, 0);
    pending.callback();
    await assertCompletedSlot(f, due);
    const next = f.store.getAutomationDefinition(f.automation.id).nextRunAt;
    assert.equal(next, new Date(START_MS + 5 * THIRTY_DAYS_MS).toISOString());
    pending.callback();
    await f.scheduler.waitForIdle();
    assert.equal(f.runner.runs.length, 1, "a delivered stale timer cannot replay its slot");
  });
}

for (const status of ["paused", "disabled", "archived"]) {
  test(`scheduler checks fresh SQLite ${status} state before a long segment can dispatch`, async (t) => {
    const f = await schedulerFixture(t, THIRTY_DAYS_MS);
    f.scheduler.start(f.cwd);
    const pending = f.timers.last();
    f.store.updateAutomationDefinition(f.automation.id, { status }, new Date().toISOString());
    t.mock.timers.setTime(START_MS + THIRTY_DAYS_MS);
    pending.callback();
    await f.scheduler.waitForIdle();
    assert.equal(f.runner.runs.length, 0);
    assert.equal(f.store.listAutomationRuns().length, 0);
    assert.equal(f.scheduler.list(f.cwd)[0].items.length, 0);
    assert.equal(f.timers.live().length, 0);
  });
}

test("refresh replaces the schedule and rejects an already delivered predecessor callback", async (t) => {
  const f = await schedulerFixture(t, THIRTY_DAYS_MS);
  f.scheduler.start(f.cwd);
  const predecessor = f.timers.last();
  f.store.updateAutomationDefinition(f.automation.id, {
    trigger: scheduledTrigger(1000),
  }, new Date().toISOString());
  f.scheduler.refresh(f.cwd);
  const successor = f.timers.last();
  predecessor.callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  assert.equal(successor.cleared, false);
  assert.equal(f.scheduler.list(f.cwd)[0].nextRunAt, new Date(START_MS + 1000).toISOString());
  t.mock.timers.tick(1000);
  await assertCompletedSlot(f, new Date(START_MS + 1000).toISOString());
});

test("fresh SQLite schedule changes without refresh cannot execute an old due slot", async (t) => {
  const f = await schedulerFixture(t, 1000);
  f.scheduler.start(f.cwd);
  const predecessor = f.timers.last();
  f.store.updateAutomationDefinition(f.automation.id, {
    trigger: scheduledTrigger(THIRTY_DAYS_MS),
  }, new Date().toISOString());
  t.mock.timers.tick(1000);
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  const due = new Date(START_MS + 1000 + THIRTY_DAYS_MS).toISOString();
  assert.equal(f.store.getAutomationDefinition(f.automation.id).nextRunAt, due);
  assert.equal(f.timers.last().delay, MAX_TIMER_DELAY_MS);
  predecessor.callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
});

test("fresh SQLite due replacement rejects the predecessor and preserves the current due", async (t) => {
  const f = await schedulerFixture(t, 1000);
  f.scheduler.start(f.cwd);
  const oldDue = new Date(START_MS + 1000).toISOString();
  const nextDue = new Date(START_MS + 3000).toISOString();
  f.store.updateAutomationDefinition(f.automation.id, { nextRunAt: nextDue }, new Date().toISOString());
  t.mock.timers.tick(1000);
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  assert.notEqual(f.scheduler.list(f.cwd)[0].nextRunAt, oldDue);
  assert.equal(f.scheduler.list(f.cwd)[0].nextRunAt, nextDue);
  assert.equal(f.store.getAutomationDefinition(f.automation.id).nextRunAt, nextDue);
  t.mock.timers.tick(1999);
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  t.mock.timers.tick(1);
  await assertCompletedSlot(f, nextDue);
});

test("fresh SQLite due revocation rejects the predecessor until explicit refresh", async (t) => {
  const f = await schedulerFixture(t, 1000);
  f.scheduler.start(f.cwd);
  f.store.updateAutomationDefinition(f.automation.id, { nextRunAt: null }, new Date().toISOString());
  t.mock.timers.tick(1000);
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  assert.equal(f.store.listAutomationRuns().length, 0);
  assert.equal(f.scheduler.list(f.cwd)[0].nextRunAt, undefined);
  assert.equal(f.timers.live().length, 0);
  f.scheduler.refresh(f.cwd);
  t.mock.timers.tick(1000);
  await assertCompletedSlot(f, new Date(START_MS + 2000).toISOString());
});

for (const stopMethod of ["stop", "stopAll"]) {
  test(`${stopMethod} and same-cwd restart isolate predecessor callbacks from the successor`, async (t) => {
    const f = await schedulerFixture(t, THIRTY_DAYS_MS);
    const first = f.scheduler.start(f.cwd).scheduler;
    const predecessor = f.timers.last();
    if (stopMethod === "stopAll") f.scheduler.stopAll();
    else f.scheduler.stop(f.cwd);
    const next = f.scheduler.start(f.cwd).scheduler;
    assert.notEqual(first.id, next.id);
    const successor = f.timers.last();
    t.mock.timers.setTime(START_MS + THIRTY_DAYS_MS);
    predecessor.callback();
    await f.scheduler.waitForIdle();
    assert.equal(f.runner.runs.length, 0);
    assert.equal(successor.cleared, false);
    successor.callback();
    await assertCompletedSlot(f, new Date(START_MS + THIRTY_DAYS_MS).toISOString());
  });
}

test("new registry restart rejects the old callback and runs the current schedule once", async (t) => {
  const f = await schedulerFixture(t, THIRTY_DAYS_MS);
  f.scheduler.start(f.cwd);
  const old = f.timers.last();
  f.scheduler.stopAll();
  const second = f.createScheduler();
  f.onCleanup(async () => { second.stopAll(); await second.waitForIdle(); });
  f.store.updateAutomationDefinition(f.automation.id, { trigger: scheduledTrigger(1000) }, new Date().toISOString());
  second.start(f.cwd);
  old.callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  t.mock.timers.tick(1000);
  await assertCompletedSlot({ ...f, scheduler: second }, new Date(START_MS + 1000).toISOString());
});

test("normal short interval still completes its real run and stop prevents any later callback", async (t) => {
  const f = await schedulerFixture(t, 1000);
  f.scheduler.start(f.cwd);
  t.mock.timers.tick(999);
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 0);
  t.mock.timers.tick(1);
  await assertCompletedSlot(f, new Date(START_MS + 1000).toISOString());
  const next = f.timers.last();
  f.scheduler.stop(f.cwd);
  t.mock.timers.tick(5000);
  next.callback();
  await f.scheduler.waitForIdle();
  assert.equal(f.runner.runs.length, 1);
  assert.equal(f.store.listAutomationRuns().length, 1);
});

test("scheduled execution errors remain readable and do not keep rearming an error definition", async (t) => {
  const f = await schedulerFixture(t, 1000);
  f.store.updateAutomationDefinition(f.automation.id, { executionPolicy: {} }, new Date().toISOString());
  f.scheduler.start(f.cwd);
  t.mock.timers.tick(1000);
  await f.scheduler.waitForIdle();
  const state = f.scheduler.list(f.cwd)[0];
  assert.equal(f.runner.runs.length, 0);
  assert.equal(state.tickCount, 1);
  assert.match(state.lastErrorMessage, /provider preset/i);
  assert.equal(f.store.getAutomationDefinition(f.automation.id).status, "error");
  assert.equal(f.timers.live().length, 0);
});

for (const admission of ["start", "refresh"]) {
  test(`actual SQLite due-write failure during ${admission} revokes timers and remains recoverable`, async (t) => {
    const f = await schedulerFixture(t, 1000);
    if (admission === "refresh") f.scheduler.start(f.cwd);
    const database = new DatabaseSync(f.databasePath);
    f.onCleanup(() => database.close());
    database.exec(`CREATE TRIGGER automation_timer_due_fault BEFORE UPDATE OF next_run_at
      ON automation_definitions WHEN NEW.next_run_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'timer_due_write_failed'); END;`);
    assert.throws(() => f.scheduler[admission](f.cwd), /timer_due_write_failed/);
    assert.equal(f.runner.runs.length, 0);
    assert.equal(f.timers.live().length, 0);
    const failed = f.scheduler.list(f.cwd)[0];
    assert.equal(failed.status, "error");
    assert.equal(failed.items.length, 0);
    assert.equal(failed.nextRunAt, undefined);
    assert.match(failed.lastErrorMessage, /timer_due_write_failed/);
    t.mock.timers.tick(1000);
    await f.scheduler.waitForIdle();
    assert.equal(f.runner.runs.length, 0);
    database.exec("DROP TRIGGER automation_timer_due_fault");
    const restored = f.scheduler.start(f.cwd);
    assert.equal(restored.duplicate, false, "failed start must not leave an unrecoverable running duplicate");
    assert.equal(restored.scheduler.status, "running");
    assert.equal(f.timers.live().length, 1);
    t.mock.timers.tick(1000);
    await assertCompletedSlot(f, new Date(START_MS + 2000).toISOString());
  });
}

test("async refresh rearm SQLite failure is recoverable without rewriting completed execution facts", { timeout: 15_000 }, async (t) => {
  const runner = new RecordingRunner(true);
  const f = await schedulerFixture(t, 1000, "skip", runner);
  let database;
  try {
    f.scheduler.start(f.cwd);
    t.mock.timers.tick(1000);
    await boundedWait(runner.firstRunEntered, "scheduled RecordingRunner did not enter");
    assert.equal(runner.runs.length, 1);
    const timerRegistrations = f.timers.count();
    const refreshed = f.scheduler.refresh(f.cwd);
    assert.equal(refreshed.items.length, 1);
    assert.equal(refreshed.items[0].nextRunAt, undefined);
    // The real executing Run has its own hard-timeout timer. Refresh must not
    // register another automation timer; do not mistake that Run timer for one.
    assert.equal(f.timers.count(), timerRegistrations);
    assert.equal(runner.runs.length, 1, "refresh must not dispatch another run while the original is gated");
    database = new DatabaseSync(f.databasePath);
    database.exec(`CREATE TRIGGER automation_timer_due_fault BEFORE UPDATE OF next_run_at
      ON automation_definitions WHEN NEW.next_run_at IS NOT NULL AND NEW.next_run_at IS NOT OLD.next_run_at
      BEGIN SELECT RAISE(ABORT, 'timer_due_write_failed'); END;`);
    runner.releaseFirstRun();
    await boundedWait(f.scheduler.waitForIdle(), "async refresh rearm did not settle");
    const completed = f.store.listAutomationRuns();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "succeeded");
    assert.equal(f.store.getRun(completed[0].runId).status, "succeeded");
    const failed = f.scheduler.list(f.cwd)[0];
    const startDuplicate = failed.status === "running" ? f.scheduler.start(f.cwd).duplicate : null;
    // Capture the actual rejected-contract shape before assertions for RED evidence.
    t.diagnostic(JSON.stringify({ schedulerStatus: failed.status, nextRunAt: failed.nextRunAt ?? null,
      itemDue: failed.items[0]?.nextRunAt ?? null, liveTimers: f.timers.live().length,
      startDuplicate, automationRunStatus: completed[0].status }));
    assert.equal(failed.status, "error", "a rejected async due write must not leave false running");
    assert.match(failed.lastErrorMessage, /timer_due_write_failed/);
    assert.equal(f.timers.live().length, 0);
    // Recovery can only be attempted after removing the persistent DB refusal.
    database.exec("DROP TRIGGER automation_timer_due_fault");
    const recovered = f.scheduler.start(f.cwd);
    assert.equal(recovered.duplicate, false);
    assert.equal(recovered.scheduler.status, "running");
    assert.equal(f.timers.live().length, 1);
    t.mock.timers.tick(1000);
    await boundedWait(f.scheduler.waitForIdle(), "recovered schedule did not complete");
    const runs = f.store.listAutomationRuns();
    assert.equal(runner.runs.length, 2);
    assert.equal(runs.length, 2);
    assert.equal(runs.every((run) => run.status === "succeeded" && f.store.getRun(run.runId).status === "succeeded"), true);
    assert.equal(f.store.getAutomationRun(completed[0].id).status, "succeeded");
  } finally {
    runner.releaseFirstRun();
    f.scheduler.stopAll();
    try {
      await boundedWait(f.scheduler.waitForIdle(), "cleanup did not settle gated run");
    } finally {
      database?.close();
    }
  }
});

test("async refreshed predecessor completion cannot revoke a restarted successor entry or timer", { timeout: 15_000 }, async (t) => {
  const runner = new RecordingRunner(true);
  const f = await schedulerFixture(t, 1000, "skip", runner);
  let database;
  try {
    f.scheduler.start(f.cwd);
    t.mock.timers.tick(1000);
    await boundedWait(runner.firstRunEntered, "scheduled predecessor did not enter");
    f.scheduler.refresh(f.cwd);
    f.scheduler.stop(f.cwd);
    const successor = f.scheduler.start(f.cwd).scheduler;
    const successorTimer = f.timers.last();
    database = new DatabaseSync(f.databasePath);
    database.exec(`CREATE TRIGGER automation_timer_due_fault BEFORE UPDATE OF next_run_at
      ON automation_definitions WHEN NEW.next_run_at IS NOT NULL AND NEW.next_run_at IS NOT OLD.next_run_at
      BEGIN SELECT RAISE(ABORT, 'timer_due_write_failed'); END;`);
    runner.releaseFirstRun();
    await boundedWait(f.scheduler.waitForIdle(), "predecessor completion did not settle");
    const current = f.scheduler.list(f.cwd)[0];
    assert.equal(current.id, successor.id);
    assert.equal(current.status, "running");
    assert.equal(current.lastErrorMessage, undefined);
    assert.equal(successorTimer.cleared, false);
    assert.equal(f.timers.live().length, 1);
    assert.equal(runner.runs.length, 1);
    const firstRun = f.store.listAutomationRuns()[0];
    assert.equal(firstRun.status, "succeeded");
    assert.equal(f.store.getRun(firstRun.runId).status, "succeeded");
    database.exec("DROP TRIGGER automation_timer_due_fault");
    // Only deliver the successor after its predecessor has truly completed;
    // this test does not assert a new overlapping-execution contract.
    t.mock.timers.tick(1000);
    await boundedWait(f.scheduler.waitForIdle(), "successor due did not settle");
    assert.equal(runner.runs.length, 2);
    assert.equal(f.store.listAutomationRuns().filter((run) => run.status === "succeeded").length, 2);
  } finally {
    runner.releaseFirstRun();
    f.scheduler.stopAll();
    try {
      await boundedWait(f.scheduler.waitForIdle(), "cleanup did not settle predecessor");
    } finally {
      database?.close();
    }
  }
});

async function assertCompletedSlot(f, scheduledFor) {
  await f.scheduler.waitForIdle();
  const runs = f.store.listAutomationRuns();
  assert.equal(f.runner.runs.length, 1, JSON.stringify(f.scheduler.list(f.cwd)));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduledFor, scheduledFor);
  assert.equal(runs[0].idempotencyKey, `automation:${f.automation.id}:schedule:${scheduledFor}`);
  assert.equal(runs[0].status, "succeeded");
  assert.equal(f.store.getRun(runs[0].runId).status, "succeeded");
  assert.equal(f.scheduler.list(f.cwd)[0].tickCount, 1);
}

async function schedulerFixture(t, everyMs, missedRunPolicy = "skip", recordingRunner) {
  const ambient = await isolatedAmbient(t);
  const [core, schedulers, storesModule, supervisors, runsModule, runnersModule, configModule, previewsModule, eventsModule] = await Promise.all([
    import("@ling-stack/core"), import("../dist/features/automations/scheduler.js"),
    import("../dist/runtime/store-registry.js"), import("../dist/runtime/supervisor.js"),
    import("../dist/runtime/active-runs.js"), import("../dist/index.js"), import("../dist/config.js"),
    import("../dist/features/computer-use/registry.js"), import("../dist/features/control-plane/events.js"),
  ]);
  const stores = new storesModule.RunStoreRegistry(core.createSqliteRunStore, { trustedWorkspaceRoots: [ambient.cwd] });
  const config = configModule.resolveConfig({ defaultWorkspaceCwd: ambient.cwd, channels: { terminalReports: false } });
  const supervisor = new supervisors.RuntimeSupervisor(config);
  const store = stores.getStore(ambient.cwd);
  const runner = recordingRunner ?? new RecordingRunner();
  const runnerRegistry = runnersModule.createDefaultRunnerRegistry(runner, config);
  const activeRuns = new runsModule.ActiveRunRegistry();
  const previews = new previewsModule.ComputerUseProjectionRegistry();
  const events = new eventsModule.ControlPlaneEventHub();
  const createScheduler = () => new schedulers.AutomationSchedulerRegistry(
    runnerRegistry, stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {}, previews, events,
  );
  const scheduler = createScheduler();
  // Store startup/recovery runs on real time; only this direct registry's scheduling
  // and isolated execution chain use mock time, not an entire loopback Daemon.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START_MS });
  const timers = observeTimers(t);
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({
    kind: "glm", displayName: "Timer fixture", providerId: "timer-fixture", model: "static-model",
    api: "google-generative-ai", capabilities: ["chat"], authHeader: false, enabled: true,
  }, now);
  const thread = store.createLingThread({ kind: "automation", title: "Timer fixture", objective: "Record one timer slot." }, now);
  const template = core.getBuiltinAutomationTemplate("daily_brief");
  const automation = store.createAutomationDefinition({
    threadId: thread.id, title: "Timer fixture", kind: "daily_brief", status: "enabled",
    trigger: scheduledTrigger(everyMs, missedRunPolicy),
    target: { scope: "workspace", workspaceId: core.DEFAULT_WORKSPACE_ID, cwd: ambient.cwd },
    promptTemplate: { ...template.defaultPromptTemplate, contextSelectors: [] },
    executionPolicy: { ...template.defaultExecutionPolicy, providerPresetId: provider.id, allowedTools: [] },
    outputPolicy: template.defaultOutputPolicy,
  }, now);
  ambient.onCleanup(async () => {
    runner.releaseFirstRun?.();
    scheduler.stopAll();
    await scheduler.waitForIdle();
    supervisor.releaseAll();
    stores.closeAll();
  });
  return { cwd: ambient.cwd, store, runner, automation, scheduler, timers, createScheduler,
    databasePath: core.resolveRuntimePaths(ambient.cwd).databasePath, onCleanup: ambient.onCleanup };
}

function observeTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const records = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const record = { callback: undefined, delay, cleared: false, fired: false, handle: undefined };
    record.callback = () => { record.fired = true; callback(...args); };
    record.handle = originalSetTimeout(record.callback, delay);
    records.push(record);
    return record.handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    const record = records.find((candidate) => candidate.handle === handle);
    if (record) record.cleared = true;
    originalClearTimeout(handle);
  });
  return {
    last: () => records.at(-1),
    count: () => records.length,
    live: () => records.filter((record) => !record.cleared && !record.fired),
  };
}

function scheduledTrigger(everyMs, missedRunPolicy = "skip") {
  return { type: "schedule", timezone: "UTC", schedule: { cadence: "interval", everyMs }, missedRunPolicy };
}

async function isolatedAmbient(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-automation-timers-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const previous = {
    LING_STACK_HOME: process.env.LING_STACK_HOME,
    LING_STACK_DEFAULT_WORKSPACE_CWD: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD,
  };
  process.env.LING_STACK_HOME = join(root, "user");
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, onCleanup: (cleanup) => cleanups.push(cleanup) };
}

class RecordingRunner {
  runs = [];
  constructor(gateFirstRun = false) {
    if (gateFirstRun) {
      this.firstRunEntered = new Promise((resolve) => { this.onFirstRunEntered = resolve; });
      this.firstRunGate = new Promise((resolve) => { this.releaseFirstRun = resolve; });
    }
  }
  async runTask(options) {
    this.runs.push({ cwd: options.cwd, task: options.task, tools: options.tools });
    options.onEvent?.({ type: "run_start", taskId: options.task.id, cwd: options.cwd,
      provider: options.provider.provider, model: options.provider.model });
    if (this.firstRunGate && this.runs.length === 1) {
      this.onFirstRunEntered();
      await this.firstRunGate;
    }
    options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: 1 });
    return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Automation timer report" }] };
  }
}

async function boundedWait(promise, message) {
  const controller = new AbortController();
  const deadline = realSleep(5000, undefined, { signal: controller.signal }).then(() => assert.fail(message));
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    controller.abort();
  }
}

async function json(url, method = "GET", body) {
  const response = await fetch(url, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.ok, true, `${response.status}: ${response.ok ? "" : await response.text()}`);
  return await response.json();
}
