import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { AutomationRunMutationResponse, LingAppServerDurableNotice,
  NativeWorkIntakeReceipt, TaskMutationResponse } from "@ling-stack/contracts";
import { WebSocket } from "ws";
import { LingAppServerClient, type LingAppServerNotification, type LingAppServerSocket } from "@ling-stack/api-client";
import { createSqliteRunStore, resolveStoragePaths, type RunStore } from "@ling-stack/core";
import { createDaemonServer, type DaemonServer } from "../dist/index.js";
import type { NativeWorkIntakeConfig } from "../dist/server/app-server-native-intake-config.js";
import { ensureGitRepo } from "./git-test-helpers.mjs";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

const budget = { maxConcurrent: 1, maxStartsPerWindow: 1, windowMs: 60_000 };

test("channel intake recovers one original Task, bounds starts and rejects a revoked reservation", { timeout: 40_000 }, async t => {
  const fixture = await setup(t);
  const seed = fixture.openStore();
  const provider = fixture.preset(seed);
  const now = new Date().toISOString();
  const channel = (name: string) => seed.createChannel({
    name, boundPath: fixture.cwd, allowedTools: ["read", "write"], defaultProviderPresetId: provider.id,
  }, now);
  const ordinary = channel("Ordinary channel");
  const automatic = channel("Automatic intake");
  const revoked = channel("Revoked intake");
  const suggestion = channel("Suggestions");
  const concurrent = channel("Concurrency limited");
  const quiet = channel("Quiet hours");
  seed.updateProviderPreset(provider.id, { enabled: false }, now);
  seed.close();

  const policies: NativeWorkIntakeConfig[] = [
    { workspaceRoot: fixture.cwd, sourceKind: "channel_task", sourceScope: automatic.id, mode: "auto_start", budget },
    { workspaceRoot: fixture.cwd, sourceKind: "channel_task", sourceScope: revoked.id, mode: "auto_start", budget },
    { workspaceRoot: fixture.cwd, sourceKind: "channel_task", sourceScope: suggestion.id, mode: "suggest", priority: "high" },
    { workspaceRoot: fixture.cwd, sourceKind: "channel_task", sourceScope: concurrent.id, mode: "auto_start", budget: { ...budget, maxStartsPerWindow: 5 } },
    { workspaceRoot: fixture.cwd, sourceKind: "channel_task", sourceScope: quiet.id, mode: "auto_start", budget,
      quietHours: quietHourWindow() },
  ];
  const task = (channelId: string, title: string, idempotencyKey?: string) =>
    fixture.json<TaskMutationResponse>("/tasks", { channelId, title, prompt: title, idempotencyKey });
  await fixture.start(policies);
  assert.equal((await task(ordinary.id, "Owner continues as usual")).intakeReceipt, undefined);
  const suggested = await task(suggestion.id, "Manually triage this specific task");
  assert.equal(suggested.intakeReceipt?.outcome, "suggested");
  assert.equal(fixture.owned().getWorkItem(suggested.intakeReceipt.workItemId!)?.priority, "high");

  const db = new DatabaseSync(fixture.owned().paths.databasePath);
  try {
    db.exec(`CREATE TRIGGER reject_native_intake BEFORE INSERT ON app_server_state
      WHEN NEW.kind = 'native_intake_receipt' BEGIN SELECT RAISE(ABORT, 'fixture intake rollback'); END`);
    const failed = await fixture.request("/tasks", { channelId: automatic.id, title: "Uncommitted task", prompt: "Uncommitted task" });
    assert.equal(failed.status, 400);
    assert.equal(fixture.owned().listTasks({ channelId: automatic.id }).length, 0);
    assert.equal(fixture.owned().listWorkItems({ channelId: automatic.id }).length, 0);
    assert.equal((await fixture.receipts("channel_task", automatic.id)).length, 0);
  } finally {
    db.exec("DROP TRIGGER reject_native_intake");
    db.close();
  }

  const automaticBody = { channelId: automatic.id, title: "Scope the durable task", prompt: "Scope the durable task", idempotencyKey: "durable" };
  const [first, replay] = await Promise.all([
    fixture.json<TaskMutationResponse>("/tasks", automaticBody),
    fixture.json<TaskMutationResponse>("/tasks", automaticBody),
  ]);
  assert.equal(first.intakeReceipt?.outcome, "accepted");
  assert.equal(replay.intakeReceipt?.receiptId, first.intakeReceipt.receiptId);
  assert.equal(first.task.id, replay.task.id);
  const conflict = await fixture.request("/tasks", { ...automaticBody, prompt: "Changed description" });
  assert.equal(conflict.status, 409);
  const quota = await task(automatic.id, "Too many starts");
  assert.equal(quota.intakeReceipt?.reasonCode, "start_budget_exhausted");
  const pendingConcurrent = await task(concurrent.id, "Scope one concurrent task");
  assert.equal(pendingConcurrent.intakeReceipt?.outcome, "accepted");
  assert.equal((await task(concurrent.id, "Concurrency must suppress this task")).intakeReceipt?.reasonCode, "concurrency_limit");
  const quietTask = await task(quiet.id, "Quiet hours must suppress this task");
  assert.equal(quietTask.intakeReceipt?.reasonCode, "quiet_hours");
  const pendingRevocation = await task(revoked.id, "Scope the revoked task");
  assert.equal(pendingRevocation.intakeReceipt?.dispatch?.status, "pending");
  assert.equal(fixture.dispatches().length, 0);

  await fixture.stop();
  const recovered = fixture.openStore();
  recovered.updateProviderPreset(provider.id, { enabled: true }, new Date().toISOString());
  recovered.close();
  await fixture.start(policies.map(policy => {
    if (policy.sourceScope === revoked.id) return { ...policy, enabled: false };
    if (policy.sourceScope === quiet.id) return { ...policy, quietHours: undefined };
    return policy;
  }));
  const completed = await until(async () => {
    const item = fixture.owned().getWorkItem(first.intakeReceipt!.workItemId!);
    const current = (await fixture.receipts("channel_task", automatic.id)).find(receipt => receipt.receiptId === first.intakeReceipt?.receiptId);
    assert.notEqual(current?.dispatch?.status, "held", JSON.stringify({ dispatch: current?.dispatch, execution: item?.linkedExecution }));
    return item?.linkedExecution?.status === "done" ? item : undefined;
  });
  assert.equal(completed.linkedExecution?.id, first.task.id);
  assert.ok(completed.linkedExecution?.runId);
  const stopped = await until(async () =>
    (await fixture.receipts("channel_task", revoked.id)).find(receipt => receipt.dispatch?.status === "held"));
  assert.equal(stopped.receiptId, pendingRevocation.intakeReceipt.receiptId);
  assert.equal(stopped.dispatch?.reasonCode, "native_intake_authority_changed");
  const disabled = await task(revoked.id, "Policy is disabled");
  assert.equal(disabled.intakeReceipt?.outcome, "paused");
  assert.equal(fixture.owned().getTask(pendingRevocation.task.id)?.currentRunId, undefined);

  const client = await fixture.connect();
  const reconsider = { receiptId: quietTask.intakeReceipt!.receiptId, idempotencyKey: "quiet-ended" };
  const retry = await client.retryNativeWorkIntake(reconsider);
  assert.equal(retry.receipt.outcome, "accepted");
  assert.equal(retry.receipt.previousReceiptId, quietTask.intakeReceipt?.receiptId);
  assert.equal(retry.receipt.executionId, quietTask.task.id);
  assert.equal((await fixture.json<typeof retry>("/work-items/intake", reconsider)).receipt.receiptId, retry.receipt.receiptId);
  assert.equal((await fixture.request("/work-items/intake", { ...reconsider, idempotencyKey: "other" })).status, 409);
  await until(() => fixture.owned().getTask(quietTask.task.id)?.status === "done" ? true : undefined);
  await until(() => fixture.owned().getTask(pendingConcurrent.task.id)?.status === "done" ? true : undefined);

  const { workItemId } = suggested.intakeReceipt;
  assert.ok(workItemId);
  const notices: LingAppServerNotification[] = [];
  client.onNotification(notice => notices.push(notice));
  const snapshot = await client.readWorkItemSnapshot(suggested.intakeReceipt.workspaceId, workItemId);
  await client.subscribe({ workItemId, cursor: snapshot.cursor });
  const scope = { sourceKind: "channel_task" as const, sourceScope: suggestion.id };
  assert.deepEqual((await client.listNativeWorkIntake(scope)).receipts, [suggested.intakeReceipt]);
  fixture.owned().updateTask(suggested.task.id, { currentRunId: completed.linkedExecution.runId }, new Date().toISOString());
  await assert.rejects(client.acceptNativeWorkIntake({ receiptId: suggested.intakeReceipt.receiptId }),
    { code: "native_intake_dispatch_reconciliation_required" });
  assert.equal((await client.listNativeWorkIntake(scope)).receipts[0]?.dispatch, undefined);
  fixture.owned().updateTask(suggested.task.id, { currentRunId: null }, new Date().toISOString());
  const acceptedSuggestion = await client.acceptNativeWorkIntake({ receiptId: suggested.intakeReceipt.receiptId });
  assert.equal(acceptedSuggestion.receipt.dispatch?.status, "pending");
  assert.equal(acceptedSuggestion.receipt.executionId, suggested.task.id);
  await until(() => fixture.owned().getTask(suggested.task.id)?.status === "done" ? true : undefined);
  const admitted = await client.acceptNativeWorkIntake({ receiptId: suggested.intakeReceipt.receiptId });
  assert.equal(admitted.receipt.dispatch?.runId, fixture.owned().getTask(suggested.task.id)?.currentRunId);
  const notice = await until(() => notices.find(notice => {
    if (notice.method !== "workItem/intake/updated") return false;
    const params = notice.params as LingAppServerDurableNotice<{ receiptId: string; status: string }>;
    return params.payload.receiptId === admitted.receipt.receiptId && params.payload.status === "admitted";
  }));
  assert.equal((notice.params as LingAppServerDurableNotice).subject.workItemId, workItemId);
  assert.equal(fixture.dispatches().length, 4);
  const automaticInput = fixture.dispatches().find((request: unknown) => JSON.stringify(request).includes("Scope the durable task"));
  assert.ok(automaticInput);
  assert.doesNotMatch(JSON.stringify(automaticInput.tools), /"name":"(?:write|edit|bash)"/u);
  assert.equal(fixture.owned().getTask(quota.task.id)?.status, "todo");
  assert.equal((await fixture.receipts("channel_task", quiet.id)).find(receipt =>
    receipt.receiptId === quietTask.intakeReceipt?.receiptId)?.reasonCode, "quiet_hours");
  await fixture.stop();
  await fixture.start(policies.filter(policy => policy.sourceScope !== quiet.id));
  const restartedClient = await fixture.connect();
  const retained = await restartedClient.retryNativeWorkIntake(reconsider);
  assert.equal(retained.receipt.receiptId, retry.receipt.receiptId);
  assert.equal(retained.receipt.dispatch?.status, "admitted");
  assert.equal(fixture.dispatches().length, 4);
});

test("scheduler suggestions and signed events reuse their original AutomationRun across restart", { timeout: 40_000 }, async t => {
  const fixture = await setup(t);
  const seed = fixture.openStore();
  const preset = fixture.preset(seed);
  const now = new Date().toISOString();
  const makeAutomation = (title: string, kind: "schedule" | "monitor" | "event", due?: string) => {
    const thread = seed.createLingThread({ kind: "automation", title, objective: title }, now);
    return seed.createAutomationDefinition({
      threadId: thread.id, title, kind: "custom_prompt",
      trigger: kind === "schedule" ? { type: "schedule", timezone: "UTC", missedRunPolicy: "run_one",
        schedule: { cadence: "daily", timeOfDay: "00:00" } } : kind === "monitor"
        ? { type: "monitor", pollIntervalMs: 1000, source: { kind: "runtime_stuck_work" },
          condition: { kind: "any_change" }, unchangedPolicy: "skip" }
        : { type: "manual" },
      target: { scope: "workspace", workspaceId: thread.workspaceId }, executionPolicy: { providerPresetId: preset.id, allowedTools: ["read"] },
      promptTemplate: { templateVersion: 1, promptMarkdown: title, contextSelectors: [] },
      outputPolicy: { artifactFormat: "markdown", destinations: [{ type: "automation_thread" }] },
      nextRunAt: due,
    }, now);
  };
  const due = new Date(Date.now() - 100).toISOString();
  const scheduled = makeAutomation("Summarize the scheduled event", "schedule", due);
  const retargeted = makeAutomation("Prepare the shift report", "schedule", due);
  const eventDriven = makeAutomation("Summarize the signed event", "event");
  const monitor = makeAutomation("Summarize the monitor observation", "monitor");
  const quietMonitor = makeAutomation("Quiet monitor observation", "monitor");
  seed.putAutomationEventSource({ id: "intake-events", label: "Native test events", adapter: "business", enabled: true,
    secretRefs: ["env:INTAKE_TEST_KEY"], rules: [{ automationId: eventDriven.id, types: ["issue.opened"] }] }, undefined, now);
  seed.close();
  const policies: NativeWorkIntakeConfig[] = [
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: scheduled.id, mode: "suggest" },
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: retargeted.id, mode: "suggest" },
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: eventDriven.id, mode: "auto_start", budget },
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: monitor.id, mode: "auto_start", budget },
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: quietMonitor.id, mode: "auto_start", budget,
      quietHours: quietHourWindow() },
  ];
  await fixture.start(policies);
  await fixture.json("/automations/scheduler/start", {});
  const suggestion = await until(async () => (await fixture.receipts("automation_run", scheduled.id))[0]);
  assert.equal(suggestion.outcome, "suggested");
  assert.equal(fixture.owned().getAutomationRun(suggestion.executionId)?.scheduledFor, due);
  assert.equal(fixture.owned().getAutomationRun(suggestion.executionId)?.runId, undefined);
  assert.equal(fixture.dispatches().length, 0);
  assert.equal((await fixture.request(`/automations/${scheduled.id}/run`, { triggerType: "schedule", scheduledFor: due })).status, 409);
  const approval = { intakeReceiptId: suggestion.receiptId };
  assert.equal((await fixture.request(`/automations/${eventDriven.id}/run`, approval)).status, 404);
  const accept = () => fixture.json<AutomationRunMutationResponse>(`/automations/${scheduled.id}/run`, approval);
  const client = await fixture.connect();
  const previousIntake = await until(async () => (await fixture.receipts("automation_run", retargeted.id))[0]);
  assert.equal(previousIntake.outcome, "suggested");
  const { workItem } = await client.createWorkItem({ sourceId: "shift-review", title: "Review the shift handoff" });
  await client.setCoordinationSchedule({ automationId: retargeted.id, workItemId: workItem.workItemId,
    kind: "checkpoint", enabled: true, expectedRevision: 0, durationMs: 10_000 });
  const retargetedApproval = { intakeReceiptId: previousIntake.receiptId };
  const staleRoute = await fixture.request(`/automations/${retargeted.id}/run`, retargetedApproval);
  assert.equal(staleRoute.status, 409);
  assert.equal((await staleRoute.json() as { error: string }).error, "native_intake_source_changed");
  await assert.rejects(client.acceptNativeWorkIntake({ receiptId: previousIntake.receiptId }), { code: "native_intake_source_changed" });
  assert.deepEqual(fixture.owned().listAutomationRuns({ automationId: retargeted.id }).map(run => run.id), [previousIntake.executionId]);
  assert.equal(fixture.owned().listOpenScheduledCoordinationRounds().length, 0);
  assert.deepEqual((await fixture.receipts("automation_run", retargeted.id))[0], previousIntake);
  const [first, replay] = await Promise.all([accept(), client.acceptNativeWorkIntake({ receiptId: suggestion.receiptId })]);
  assert.equal(first.automationRun.id, suggestion.executionId);
  assert.equal(replay.receipt.executionId, suggestion.executionId);
  assert.equal(first.intakeReceipt?.dispatch?.status, "pending");
  await fixture.stop();

  await fixture.start(policies);
  await fixture.json("/automations/scheduler/start", {});
  const finished = await until(() => {
    const run = fixture.owned().getAutomationRun(suggestion.executionId);
    return run?.status === "succeeded" ? run : undefined;
  });
  assert.ok(finished.runId);
  assert.equal(fixture.owned().listAutomationRuns({ automationId: scheduled.id }).length, 1);
  assert.equal((await accept()).automationRun.runId, finished.runId);

  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ issue: "Signed event payload" });
  const signature = `sha256=${createHmac("sha256", fixture.signingKey).update(`${timestamp}.fixture-intake.issue.opened.${body}`).digest("hex")}`;
  const sendEvent = () => fixture.request("/automation-event-sources/intake-events/events", JSON.parse(body), {
    "x-ling-event-id": "fixture-intake", "x-ling-event-type": "issue.opened",
    "x-ling-event-timestamp": timestamp, "x-ling-signature-256": signature,
  });
  assert.equal((await sendEvent()).status, 202);
  assert.equal((await sendEvent()).status, 200);
  const event = await until(async () =>
    (await fixture.receipts("automation_run", eventDriven.id)).find(receipt => receipt.dispatch?.status === "admitted"));
  assert.equal(event.outcome, "accepted");
  const linked = await until(() => {
    const run = fixture.owned().getAutomationRun(event.executionId);
    return run?.status === "succeeded" ? run : undefined;
  });
  assert.equal(event.dispatch?.runId, linked.runId);
  assert.equal(fixture.owned().listAutomationRuns({ automationId: eventDriven.id }).length, 1);
  assert.equal(fixture.dispatches().filter((request: unknown) => JSON.stringify(request).includes("Signed event payload")).length, 1);
  const monitored = await until(async () =>
    (await fixture.receipts("automation_run", monitor.id)).find(receipt => receipt.dispatch?.status === "admitted"));
  assert.equal(fixture.owned().getAutomationRun(monitored.executionId)?.triggerType, "monitor");
  await until(() => fixture.owned().getAutomationRun(monitored.executionId)?.status === "succeeded" ? true : undefined);
  assert.equal(fixture.owned().listAutomationRuns({ automationId: monitor.id }).length, 1);
  const monitoredInputs = fixture.dispatches().filter((request: unknown) => JSON.stringify(request).includes("Summarize the monitor observation"));
  assert.equal(monitoredInputs.length, 1);
  assert.match(JSON.stringify(monitoredInputs[0]), /Monitor snapshot/u);
  const suppressed = await until(async () => (await fixture.receipts("automation_run", quietMonitor.id))[0]);
  assert.equal(suppressed.outcome, "suppressed");
  assert.equal(suppressed.reasonCode, "quiet_hours");
  const schedulerState = () => fixture.json<{ schedulers: { items: { automationId: string; lastRunAt?: string }[] }[] }>("/automations/scheduler");
  await until(async () => (await schedulerState()).schedulers[0]?.items.find(item =>
    item.automationId === quietMonitor.id && item.lastRunAt && item.lastRunAt > suppressed.evaluatedAt));
  assert.deepEqual(await fixture.receipts("automation_run", quietMonitor.id), [suppressed]);
  assert.equal(fixture.owned().getAutomationMonitorSnapshot(quietMonitor.id), undefined);
  assert.equal(fixture.dispatches().length, 3);

  await fixture.stop();
  await fixture.start(policies.map(policy => policy.sourceScope === quietMonitor.id ? { ...policy, quietHours: undefined } : policy));
  await fixture.json("/automations/scheduler/start", {});
  const retriedQuiet = await until(async () => (await fixture.receipts("automation_run", quietMonitor.id))
    .find(receipt => receipt.dispatch?.status === "admitted"));
  assert.equal(retriedQuiet.previousReceiptId, suppressed.receiptId);
  assert.equal(retriedQuiet.sourceEventId, suppressed.sourceEventId);
  assert.equal(retriedQuiet.executionId, suppressed.executionId);
  assert.ok(fixture.owned().getAutomationRun(retriedQuiet.executionId)?.runId);
  await until(() => fixture.owned().getAutomationRun(retriedQuiet.executionId)?.status === "succeeded" ? true : undefined);
  assert.deepEqual(fixture.owned().listAutomationRuns({ automationId: quietMonitor.id }).map(run => run.id), [suppressed.executionId]);
  assert.ok(fixture.owned().getAutomationMonitorSnapshot(quietMonitor.id));
});

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-native-intake-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await ensureGitRepo(cwd);
  const auth = randomUUID();
  const signingKey = randomUUID();
  const provider = await startLoopbackPiProvider(() => ({ text: "Scoped and verified." }));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  const openStore = () => createSqliteRunStore(cwd, resolveStoragePaths(cwd, {
    homeDir: root, env: {}, workspaceStateLocation: "repo-local",
  }).workspace);
  let daemon: DaemonServer | undefined;
  let store: RunStore | undefined;
  let base: string;
  const stop = async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
  };
  t.after(async () => {
    await stop();
    await provider.close();
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown, headers?: Record<string, string>) => {
    const url = new URL(path, base); url.searchParams.set("cwd", cwd);
    return fetch(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...headers } });
  };
  const json = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await request(path, body);
    assert.ok(response.ok, await response.clone().text());
    return await response.json() as T;
  };
  return {
    cwd, signingKey, openStore, stop, request, json,
    dispatches: () => provider.requests.filter((request: unknown) => /Scope the durable task|Scope the revoked task|Manually triage this specific task|Summarize the scheduled event|Signed event payload|Scope one concurrent task|Quiet hours must suppress this task|Too many starts|Concurrency must suppress this task|Policy is disabled|Uncommitted task|Summarize the monitor observation/u.test(JSON.stringify(request))),
    owned: () => { assert.ok(store); return store; },
    connect: async () => {
      const url = new URL("/app-server/rpc", base);
      url.protocol = "ws:";
      url.searchParams.set("cwd", cwd);
      const client = new LingAppServerClient({ url: url.href, autoReconnect: false,
        clientInfo: { name: "Native intake acceptance", version: "1" },
        createSocket: address => new WebSocket(address, { headers: { Authorization: `Bearer ${auth}` } }) as unknown as LingAppServerSocket });
      t.after(() => client.close());
      await client.connect();
      return client;
    },
    receipts: async (kind: NativeWorkIntakeReceipt["sourceKind"], scope: string) => (await json<{ receipts: NativeWorkIntakeReceipt[] }>(
      `/work-items/intake?sourceKind=${kind}&sourceScope=${encodeURIComponent(scope)}`,
    )).receipts,
    preset: (owner: RunStore) => owner.createProviderPreset({
      kind: "glm", displayName: "Native intake fixture", providerId: "intake-fixture", model: "static-tools",
      api: "openai-completions", baseUrl: provider.baseUrl, authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true,
    }, new Date().toISOString()),
    start: async (policies: readonly NativeWorkIntakeConfig[]) => {
      daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken: auth, defaultWorkspaceCwd: cwd, appServerNativeIntake: policies,
        channels: { terminalReports: false, teamObserverBus: false } }, {
        storeFactory: () => { store = openStore(); return store; }, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
        secretResolver: { status: ref => ({ ref, kind: "env", configured: ref === "env:INTAKE_TEST_KEY" }),
          resolve: ref => ({ ref, kind: "env", configured: ref === "env:INTAKE_TEST_KEY", value: ref === "env:INTAKE_TEST_KEY" ? signingKey : undefined }) },
      });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      base = `http://127.0.0.1:${address.port}`;
    },
  };
}

function quietHourWindow() {
  const now = Date.now();
  const clock = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 16);
  return { timeZone: "UTC", start: clock(now - 15 * 60_000), end: clock(now + 15 * 60_000) };
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error("Expected intake operation did not settle within 12 seconds.");
}
