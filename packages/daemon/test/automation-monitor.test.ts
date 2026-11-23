import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  getBuiltinAutomationTemplate,
  type AutomationTrigger,
} from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { handleAutomationDraftItem } from "../dist/features/automations/routes.js";
import { AutomationSchedulerRegistry } from "../dist/features/automations/scheduler.js";
import { ComputerUseProjectionRegistry } from "../dist/features/computer-use/registry.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { createDefaultMcpBroker } from "../dist/features/mcp/broker.js";
import { NotificationHub } from "../dist/features/notifications/hub.js";
import { createDefaultRunnerRegistry, type RunnerAdapter } from "../dist/index.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const start = Date.parse("2026-10-12T00:00:00.000Z");
const interval = 1000;
type AutomationMonitorTrigger = Extract<AutomationTrigger, { type: "monitor" }>;

test("A to B to A monitor observations create three distinct findings and unchanged polls do not notify", async t => {
  const f = await fixture(t);
  const monitor = f.createMonitor();
  f.scheduler.start(f.cwd);
  await f.poll();
  const first = f.store.getAutomationMonitorSnapshot(monitor.id);
  assert.ok(first);

  const work = f.createStaleWork();
  await f.poll();
  const changed = f.store.getAutomationMonitorSnapshot(monitor.id);
  assert.deepEqual(changed?.snapshot.ids, [work.id]);
  assert.notEqual(changed?.fingerprint, first.fingerprint);

  assert.equal(f.store.transitionWorkUnitStatus({
    workUnitId: work.id, expectedStatus: "stale", event: "reconcile_failed", actor: "system", now: f.now(),
  }).ok, true);
  await f.poll();
  assert.equal(f.store.getAutomationMonitorSnapshot(monitor.id)?.fingerprint, first.fingerprint);

  const runs = f.store.listAutomationRuns({ automationId: monitor.id });
  assert.equal(runs.length, 3);
  assert.equal(new Set(runs.map(run => run.runId)).size, 3);
  assert.ok(runs.every(run => run.runId && run.outputArtifactIds.length > 0));
  assert.deepEqual(f.findings().map(notice => notice.runId).sort(), runs.map(run => run.runId).sort());

  await f.poll();
  assert.equal(f.runnerCalls.length, 3);
  assert.equal(f.findings().length, 3);
  assert.equal(f.item(monitor.id)?.lastMonitorOutcome, "unchanged");
});

test("an admitted Run is reused when the same poll slot retries after a snapshot write failure", async t => {
  const f = await fixture(t);
  const monitor = f.createMonitor();
  const persist = f.store.recordAutomationMonitorSnapshot.bind(f.store);
  const writer = t.mock.method(f.store, "recordAutomationMonitorSnapshot", persist);
  writer.mock.mockImplementationOnce(() => { throw new Error("Snapshot write interrupted"); });
  f.scheduler.start(f.cwd);
  await f.poll();
  const [admitted] = f.store.listAutomationRuns({ automationId: monitor.id });
  assert.ok(admitted?.runId);
  assert.equal(f.store.getAutomationMonitorSnapshot(monitor.id), undefined);
  assert.equal(f.findings().length, 0);

  f.scheduler.stop(f.cwd);
  t.mock.timers.setTime(start);
  f.scheduler.start(f.cwd);
  await f.poll();
  assert.equal(f.runnerCalls.length, 1);
  assert.equal(f.item(monitor.id)?.lastAutomationRunId, admitted.id);
  assert.deepEqual(f.findings().map(notice => notice.runId), [admitted.runId]);
  assert.ok(f.store.getAutomationMonitorSnapshot(monitor.id));
});

test("monitor retries after failed admission and does not consume the finding against an unrelated active Run", async t => {
  const f = await fixture(t);
  const monitor = f.createMonitor();
  f.store.updateAutomationDefinition(monitor.id, {
    executionPolicy: { ...monitor.executionPolicy, providerPresetId: "missing-monitor-provider" },
  }, f.now());
  f.scheduler.start(f.cwd);
  await f.poll();
  const [failed] = f.store.listAutomationRuns({ automationId: monitor.id });
  assert.equal(failed?.status, "failed");
  assert.equal(failed.runId, undefined);
  assert.equal(f.store.getAutomationMonitorSnapshot(monitor.id), undefined);

  const channel = f.store.createChannel({ name: "Manual checks", boundPath: f.cwd }, f.now());
  const task = f.store.createTask({ channelId: channel.id, title: "Manual monitor check", prompt: "Inspect current state." }, f.now());
  const manualRun = f.store.createRun({
    id: "manual-run", cwd: f.cwd, taskId: task.id, channelId: channel.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: {}, createdAt: f.now(),
  });
  const manual = f.store.createAutomationRun({
    automationId: monitor.id, threadId: monitor.threadId, triggerType: "manual",
    status: "running", idempotencyKey: "manual-monitor-run", runId: manualRun.id,
  }, f.now());
  f.store.updateAutomationDefinition(monitor.id, { executionPolicy: monitor.executionPolicy }, f.now());
  await f.poll();
  assert.equal(f.item(monitor.id)?.lastAutomationRunId, undefined);
  assert.equal(f.store.getAutomationMonitorSnapshot(monitor.id), undefined);
  assert.equal(f.findings().length, 0);

  f.store.updateAutomationRun(manual.id, { status: "succeeded", completedAt: f.now() }, f.now());
  await f.poll();
  const [admitted] = f.store.listAutomationRuns({ automationId: monitor.id });
  assert.equal(admitted?.triggerType, "monitor");
  assert.ok(admitted.runId);
  assert.notEqual(admitted.runId, manual.runId);
  assert.equal(f.runnerCalls.length, 1);
  assert.equal(f.item(monitor.id)?.lastErrorMessage, undefined);
  assert.deepEqual(f.findings().map(notice => notice.runId), [admitted.runId]);
  assert.ok(f.store.getAutomationMonitorSnapshot(monitor.id));
});

test("doctor status-count conditions start a Run only once a matching status is present", async t => {
  const f = await fixture(t);
  const monitor = f.createMonitor({
    source: { kind: "doctor_summary" }, condition: { kind: "status_matches", statuses: ["stale"] },
  });
  f.scheduler.start(f.cwd);
  await f.poll();
  assert.equal(f.item(monitor.id)?.lastMonitorOutcome, "condition_not_met");
  assert.equal(f.runnerCalls.length, 0);

  f.createStaleWork();
  await f.poll();
  assert.equal(f.runnerCalls.length, 1);
  assert.equal(f.item(monitor.id)?.lastMonitorOutcome, "changed");
  assert.deepEqual(f.store.getAutomationMonitorSnapshot(monitor.id)?.snapshot.statusCounts, { stale: 1 });
});

test("startup and refresh retain older timers when newer manual definitions fill the list limit", async t => {
  const f = await fixture(t);
  const monitor = f.createMonitor();
  const schedule = f.store.createAutomationDefinition({
    ...f.definition, trigger: { type: "schedule", timezone: "UTC",
      schedule: { cadence: "interval", everyMs: 60_000 }, missedRunPolicy: "skip" },
  }, f.now());
  t.mock.timers.tick(1);
  for (let index = 0; index < 500; index += 1) {
    f.store.createAutomationDefinition({ ...f.definition, trigger: { type: "manual" }, title: `Manual ${index}` }, f.now());
  }
  assert.ok(!f.store.listAutomationDefinitions({ status: "enabled", limit: 500 })
    .some(item => item.id === monitor.id || item.id === schedule.id));
  for (const state of [f.scheduler.start(f.cwd).scheduler, f.scheduler.refresh(f.cwd)]) {
    assert.deepEqual(state.items.map(item => item.automationId).sort(), [monitor.id, schedule.id].sort());
    assert.ok(state.items.every(item => item.nextRunAt));
  }
});

test("restarting one workspace after stopAll restores its persisted coordination deadline", async t => {
  const f = await fixture(t);
  const { workItem } = f.store.createWorkItem({
    sourceType: "manual", sourceId: "coordination-restart", title: "Restore coordination deadline",
  }, f.now());
  const automation = f.store.createAutomationDefinition({
    ...f.definition,
    kind: "daily_brief",
    title: "Coordination restart",
    status: "enabled",
    automationMode: "cron",
    trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "interval", everyMs: 60_000 }, missedRunPolicy: "skip" },
  }, f.now());
  const due = new Date(Date.now() - 1).toISOString();
  f.store.updateAutomationDefinition(automation.id, { nextRunAt: due }, f.now());
  const configured = f.store.configureAutomationCoordination({
    automationId: automation.id, workItemId: workItem.id, kind: "checkpoint", durationMs: interval,
    expectedRevision: 0, enabled: true,
  }, f.now());
  const current = f.store.getAutomationDefinition(automation.id);
  assert.ok(current);
  const admitted = f.store.admitScheduledCoordination({
    automationId: automation.id, expectedDefinitionRevision: current.updatedAt,
    expectedPolicyRevision: configured.revision, triggerType: "schedule", scheduledFor: due,
    idempotencyKey: "coordination-restart-occurrence",
  }, f.now(), f.cwd);
  assert.ok(admitted.round);
  const nextRunAt = new Date(Date.now() + 60_000).toISOString();
  f.store.updateAutomationDefinition(automation.id, { nextRunAt }, f.now());

  f.scheduler.stopAll();
  f.scheduler.start(f.cwd);
  const round = f.store.readScheduledCoordinationRound(admitted.round.recordId);
  assert.ok(round);
  assert.equal(round.closedRecordId, undefined);
  t.mock.timers.tick(interval);
  await f.scheduler.waitForIdle();
  assert.ok(f.store.readScheduledCoordinationRound(admitted.round.recordId)?.closedRecordId);
});

test("confirming a monitor draft again repairs a failed scheduler registration without replacing the timer", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const { threadId: _threadId, ...definition } = f.definition;
  const draft = f.store.createAutomationDraft({ ...definition, source: "manual", trigger: f.trigger }, f.now());
  const refresh = f.scheduler.refresh.bind(f.scheduler);
  const mocked = t.mock.method(f.scheduler, "refresh", (cwd: string) => refresh(cwd));
  mocked.mock.mockImplementationOnce(() => { throw new Error("Scheduler unavailable"); });
  const server = createServer((request, response) => {
    void handleAutomationDraftItem(request, response, f.config, f.stores, f.scheduler, { kind: "confirm", draftId: draft.id });
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/automation-drafts/${draft.id}/confirm?cwd=${encodeURIComponent(f.cwd)}`;
  const confirm = async () => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const body = await response.json() as { automation: { id: string }; schedulerRefreshPending?: boolean };
    return { status: response.status, ...body };
  };

  const first = await confirm();
  assert.equal(first.status, 201);
  assert.equal(first.schedulerRefreshPending, true);
  assert.equal(f.item(first.automation.id), undefined);

  const recovered = await confirm();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.automation.id, first.automation.id);
  assert.equal(recovered.schedulerRefreshPending, undefined);
  const nextRunAt = f.item(first.automation.id)?.nextRunAt;
  assert.ok(nextRunAt);

  assert.equal((await confirm()).status, 200);
  assert.equal(mocked.mock.callCount(), 2);
  assert.equal(f.item(first.automation.id)?.nextRunAt, nextRunAt);
  assert.equal(f.store.listAutomationDefinitions().length, 1);
});

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-automation-monitor-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "user");
  const now = () => new Date().toISOString();
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const store = stores.getStore(cwd);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, channels: { terminalReports: false } });
  const supervisor = new RuntimeSupervisor(config);
  const notifications = new NotificationHub();
  const runnerCalls: string[] = [];
  const runner: RunnerAdapter = { async runTask(options) {
    runnerCalls.push(options.task.id);
    options.onEvent?.({ type: "run_start", taskId: options.task.id, cwd: options.cwd,
      provider: options.provider.provider, model: options.provider.model });
    options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: 1 });
    return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Monitor report" }] };
  } };
  const scheduler = new AutomationSchedulerRegistry(
    createDefaultRunnerRegistry(runner, config), stores, new ActiveRunRegistry(), supervisor,
    { status: ref => ({ ref, kind: "env", configured: false }), resolve: ref => ({ ref, configured: false }) },
    createDefaultMcpBroker(), new ComputerUseProjectionRegistry(), new ControlPlaneEventHub(),
    undefined, undefined, notifications,
  );
  t.after(async () => {
    try {
      scheduler.stopAll();
      await scheduler.waitForIdle();
      supervisor.releaseAll();
      stores.closeAll();
    } finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const provider = store.createProviderPreset({
    kind: "glm", displayName: "Monitor fixture", providerId: "monitor-fixture", model: "static-model",
    api: "google-generative-ai", capabilities: ["chat"], authHeader: false, enabled: true,
  }, now());
  const thread = store.createLingThread({ kind: "automation", title: "Monitor", objective: "Monitor facts." }, now());
  const template = getBuiltinAutomationTemplate("daily_brief");
  assert.ok(template);
  const definition = {
    threadId: thread.id, title: "Monitor", kind: "project_monitor",
    target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
    promptTemplate: { ...template.defaultPromptTemplate, contextSelectors: [] },
    executionPolicy: { ...template.defaultExecutionPolicy, providerPresetId: provider.id, allowedTools: [] },
    outputPolicy: template.defaultOutputPolicy,
  } as const;
  const trigger: AutomationMonitorTrigger = {
    type: "monitor", pollIntervalMs: interval, source: { kind: "runtime_stuck_work" },
    condition: { kind: "any_change" }, unchangedPolicy: "skip",
  };
  return {
    config, cwd, now, definition, trigger, stores, store, runnerCalls, scheduler,
    createMonitor: (overrides: Partial<AutomationMonitorTrigger> = {}) =>
      store.createAutomationDefinition({ ...definition, trigger: { ...trigger, ...overrides } }, now()),
    createStaleWork: () => store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "observed-work",
      idempotencyKey: "observed-work", status: "stale", createdByActor: "system", request: {}, now: now(),
    }),
    poll: async () => { t.mock.timers.tick(interval); await scheduler.waitForIdle(); },
    item: (id: string) => scheduler.list(cwd)[0]?.items.find(item => item.automationId === id),
    findings: () => notifications.list().notifications.filter(notice => notice.kind === "automation_monitor_finding"),
  };
}
