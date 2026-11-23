import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { AutomationRunMutationResponse, NativeWorkIntakeReceipt, TaskMutationResponse } from "@ling-stack/contracts";
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
  await fixture.start(policies.map(policy => {
    if (policy.sourceScope === revoked.id) return { ...policy, enabled: false };
    if (policy.sourceScope === quiet.id) return { ...policy, quietHours: undefined };
    return policy;
  }));
  const completed = await until(() => {
    const item = fixture.owned().getWorkItem(first.intakeReceipt!.workItemId!);
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

  const reconsider = { receiptId: quietTask.intakeReceipt!.receiptId, idempotencyKey: "quiet-ended" };
  const retry = await fixture.json<{ receipt: NativeWorkIntakeReceipt }>("/work-items/intake", reconsider);
  assert.equal(retry.receipt.outcome, "accepted");
  assert.equal(retry.receipt.previousReceiptId, quietTask.intakeReceipt?.receiptId);
  assert.equal(retry.receipt.executionId, quietTask.task.id);
  assert.equal((await fixture.json<typeof retry>("/work-items/intake", reconsider)).receipt.receiptId, retry.receipt.receiptId);
  assert.equal((await fixture.request("/work-items/intake", { ...reconsider, idempotencyKey: "other" })).status, 409);
  await until(() => fixture.owned().getTask(quietTask.task.id)?.status === "done" ? true : undefined);
  await until(() => fixture.owned().getTask(pendingConcurrent.task.id)?.status === "done" ? true : undefined);

  const manual = await fixture.request(`/tasks/${suggested.task.id}/run`, { providerPresetId: provider.id, skipProviderPreflight: true });
  assert.ok(manual.ok, await manual.clone().text());
  await manual.text();
  assert.equal(fixture.owned().getTask(suggested.task.id)?.status, "done");
  assert.equal(fixture.dispatches().length, 4);
  const automaticInput = fixture.dispatches().find((request: unknown) => JSON.stringify(request).includes("Scope the durable task"));
  assert.ok(automaticInput);
  assert.doesNotMatch(JSON.stringify(automaticInput.tools), /"name":"(?:write|edit|bash)"/u);
  assert.equal(fixture.owned().getTask(quota.task.id)?.status, "todo");
  assert.equal((await fixture.receipts("channel_task", quiet.id)).find(receipt =>
    receipt.receiptId === quietTask.intakeReceipt?.receiptId)?.reasonCode, "quiet_hours");
});

test("scheduler suggestions and signed events reuse their original AutomationRun across restart", { timeout: 40_000 }, async t => {
  const fixture = await setup(t);
  const seed = fixture.openStore();
  const preset = fixture.preset(seed);
  const now = new Date().toISOString();
  const makeAutomation = (title: string, due?: string) => {
    const thread = seed.createLingThread({ kind: "automation", title, objective: title }, now);
    return seed.createAutomationDefinition({
      threadId: thread.id, title, kind: "custom_prompt",
      trigger: due ? { type: "schedule", timezone: "UTC", missedRunPolicy: "run_one",
        schedule: { cadence: "daily", timeOfDay: "00:00" } } : { type: "manual" },
      target: { scope: "workspace", workspaceId: thread.workspaceId }, executionPolicy: { providerPresetId: preset.id, allowedTools: ["read"] },
      promptTemplate: { templateVersion: 1, promptMarkdown: title, contextSelectors: [] },
      outputPolicy: { artifactFormat: "markdown", destinations: [{ type: "automation_thread" }] },
      nextRunAt: due,
    }, now);
  };
  const due = new Date(Date.now() - 100).toISOString();
  const scheduled = makeAutomation("Summarize the scheduled event", due);
  const eventDriven = makeAutomation("Summarize the signed event");
  seed.putAutomationEventSource({ id: "intake-events", label: "Native test events", adapter: "business", enabled: true,
    secretRefs: ["env:INTAKE_TEST_KEY"], rules: [{ automationId: eventDriven.id, types: ["issue.opened"] }] }, undefined, now);
  seed.close();
  const policies: NativeWorkIntakeConfig[] = [
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: scheduled.id, mode: "suggest" },
    { workspaceRoot: fixture.cwd, sourceKind: "automation_run", sourceScope: eventDriven.id, mode: "auto_start", budget },
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
  const [first, replay] = await Promise.all([accept(), accept()]);
  assert.equal(first.automationRun.id, suggestion.executionId);
  assert.equal(replay.automationRun.id, suggestion.executionId);
  assert.equal(first.intakeReceipt?.dispatch?.status, "pending");
  await fixture.stop();

  await fixture.start(policies);
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
  assert.equal(fixture.dispatches().length, 2);
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
    dispatches: () => provider.requests.filter((request: unknown) => /Scope the durable task|Scope the revoked task|Manually triage this specific task|Summarize the scheduled event|Signed event payload|Scope one concurrent task|Quiet hours must suppress this task|Too many starts|Concurrency must suppress this task|Policy is disabled|Uncommitted task/u.test(JSON.stringify(request))),
    owned: () => { assert.ok(store); return store; },
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
