import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, getBuiltinAutomationTemplate, resolveRuntimePaths } from "@ling-stack/core";
import { handleAutomationDraftItem } from "../dist/features/automations/routes.js";

test("A08 HTTP confirmations on two SQLite connections that both read ready before body EOF create one definition and thread", { timeout: 10_000 }, async () => {
  const fixture = await createFixture({ separateConnections: true });
  try {
    const first = fixture.withheldConfirm();
    const second = fixture.withheldConfirm();
    await fixture.waitForReadyReads(2);
    first.release();
    const firstResult = await first.result;
    second.release();
    const secondResult = await second.result;
    assert.equal(firstResult.status, 201);
    assert.deepEqual({
      secondStatus: secondResult.status,
      definitions: fixture.definitionCount(),
      threads: fixture.threadCount(),
      sameAutomation: secondResult.body.automation.id === firstResult.body.automation.id,
      sameThread: secondResult.body.thread.id === firstResult.body.thread.id,
    }, { secondStatus: 200, definitions: 1, threads: 1, sameAutomation: true, sameThread: true });
    assert.equal(secondResult.body.automation.id, firstResult.body.automation.id);
    assert.equal(secondResult.body.thread.id, firstResult.body.thread.id);
    assert.equal(fixture.store.getAutomationDraft(fixture.draft.id).confirmedAutomationId, firstResult.body.automation.id);
    assert.equal(fixture.definitionCount(), 1);
    assert.equal(fixture.threadCount(), 1);
    assert.equal(fixture.store.getLingThread(firstResult.body.thread.id).kind, "automation");
    const repeated = await fixture.confirm();
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.automation.id, firstResult.body.automation.id);
    assert.equal(fixture.definitionCount(), 1);
    assert.equal(fixture.threadCount(), 1);
  } finally {
    await fixture.close();
  }
});

test("A08 HTTP stale ready snapshot cannot resurrect a discarded draft", { timeout: 10_000 }, async () => {
  const fixture = await createFixture();
  try {
    const pending = fixture.withheldConfirm();
    await fixture.waitForReadyReads(1);
    fixture.store.discardAutomationDraft(fixture.draft.id, "2026-10-12T00:01:00.000Z");
    pending.release();
    const result = await pending.result;
    assert.equal(result.status, 409);
    assert.equal(fixture.store.getAutomationDraft(fixture.draft.id).status, "discarded");
    assert.equal(fixture.definitionCount(), 0);
    assert.equal(fixture.threadCount(), 0);
    assert.equal(fixture.refreshes.length, 0);
  } finally {
    await fixture.close();
  }
});

test("A08 HTTP confirmation rejects edits after the user saw the draft, even with the same timestamp", { timeout: 10_000 }, async () => {
  const fixture = await createFixture();
  try {
    const pending = fixture.withheldConfirm();
    await fixture.waitForReadyReads(1);
    fixture.store.updateAutomationDraft(fixture.draft.id, { title: "Updated before confirmation" }, fixture.draft.updatedAt);
    pending.release();
    const result = await pending.result;
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "automation_draft_changed");
    assert.equal(fixture.definitionCount(), 0);
    assert.equal(fixture.threadCount(), 0);
    assert.equal(fixture.store.getAutomationDraft(fixture.draft.id).title, "Updated before confirmation");
    const retried = await fixture.confirm();
    assert.equal(retried.status, 201);
    assert.equal(retried.body.automation.title, "Updated before confirmation");
    assert.equal(retried.body.thread.title, "Updated before confirmation");
  } finally {
    await fixture.close();
  }
});

for (const failureStage of ["definition_insert", "draft_confirm", "draft_claim_conflict"]) {
  test(`A08 SQLite ${failureStage} failure rolls back definition, thread and draft and permits one retry`, { timeout: 10_000 }, async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(resolveRuntimePaths(fixture.cwd).databasePath);
    try {
      if (failureStage === "draft_claim_conflict") {
        database.exec("CREATE TRIGGER a08_reject_confirmation AFTER INSERT ON automation_definitions BEGIN UPDATE automation_drafts SET status = 'discarded'; END;");
      } else {
        const operation = failureStage === "definition_insert"
          ? "BEFORE INSERT ON automation_definitions"
          : "BEFORE UPDATE OF status ON automation_drafts WHEN NEW.status = 'confirmed'";
        database.exec(`CREATE TRIGGER a08_reject_confirmation ${operation} BEGIN SELECT RAISE(ABORT, 'A08 isolated persistence failure'); END;`);
      }
      const failed = await fixture.confirm();
      assert.equal(failed.status, 400);
      assert.equal(fixture.store.getAutomationDraft(fixture.draft.id).status, "ready_for_confirmation");
      assert.equal(fixture.definitionCount(), 0, "no definition may survive a failed joint confirmation");
      assert.equal(fixture.threadCount(), 0, "no automation thread may survive a failed joint confirmation");
      assert.equal(fixture.refreshes.length, 0);
      database.exec("DROP TRIGGER a08_reject_confirmation");
      const retried = await fixture.confirm();
      assert.equal(retried.status, 201);
      assert.equal(retried.body.draft.confirmedAutomationId, retried.body.automation.id);
      assert.equal(fixture.definitionCount(), 1);
      assert.equal(fixture.threadCount(), 1);
      const duplicate = await fixture.confirm();
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.automation.id, retried.body.automation.id);
      assert.equal(fixture.definitionCount(), 1);
      assert.equal(fixture.threadCount(), 1);
    } finally {
      database.close();
      await fixture.close();
    }
  });
}

test("A08 HTTP scheduler refresh failure preserves committed facts and a scheduled retry repairs missing registration only", { timeout: 10_000 }, async () => {
  const fixture = await createFixture({ scheduled: true });
  try {
    fixture.schedulerControl.failRefreshCount = 1;
    const first = await fixture.confirm();
    assert.deepEqual({ status: first.status, pending: first.body.schedulerRefreshPending,
      durableStatus: fixture.store.getAutomationDraft(fixture.draft.id).status,
      definitions: fixture.definitionCount(), threads: fixture.threadCount() },
    { status: 201, pending: true, durableStatus: "confirmed", definitions: 1, threads: 1 });
    assert.equal(first.body.schedulerMessage, "Automation confirmation is saved. Scheduler registration is pending; retry confirmation to recover.");
    assert.doesNotMatch(JSON.stringify(first.body), /private-scheduler-secret/);
    assert.equal(first.body.draft.status, "confirmed");
    assert.equal(fixture.definitionCount(), 1);
    assert.equal(fixture.threadCount(), 1);
    assert.equal(fixture.schedulerStates.length, 0);
    const recovered = await fixture.confirm();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.automation.id, first.body.automation.id);
    assert.equal(recovered.body.schedulerRefreshPending, undefined);
    assert.equal(fixture.refreshes.length, 2);
    const scheduledFor = fixture.schedulerStates[0].items[0].nextRunAt;
    const repeated = await fixture.confirm();
    assert.equal(repeated.status, 200);
    assert.equal(fixture.refreshes.length, 2, "a normal retry cannot reset all scheduler timers");
    assert.equal(fixture.schedulerStates[0].items[0].nextRunAt, scheduledFor);
    // A running item without its next slot is also registered, not a missing timer.
    fixture.schedulerStates[0].items[0].nextRunAt = undefined;
    await fixture.confirm();
    assert.equal(fixture.refreshes.length, 2);
    assert.equal(fixture.definitionCount(), 1);
    assert.equal(fixture.threadCount(), 1);
  } finally {
    await fixture.close();
  }
});

async function createFixture({ separateConnections = false, scheduled = false } = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a08-confirmation-http-"));
  const store = createSqliteRunStore(cwd);
  const template = getBuiltinAutomationTemplate("daily_brief");
  const channel = store.createChannel({ name: "A08 isolated channel", boundPath: cwd }, "2026-10-12T00:00:00.000Z");
  const draft = store.createAutomationDraft({
    source: "manual",
    channelId: channel.id,
    title: "A08 confirmation draft",
    kind: "custom_prompt",
    trigger: scheduled ? { type: "schedule", timezone: "UTC", schedule: { cadence: "interval", everyMs: 60_000 }, missedRunPolicy: "skip" } : { type: "manual" },
    target: { scope: "channel", workspaceId: DEFAULT_WORKSPACE_ID, channelId: channel.id, cwd },
    promptTemplate: template.defaultPromptTemplate,
    executionPolicy: template.defaultExecutionPolicy,
    outputPolicy: template.defaultOutputPolicy,
  }, "2026-10-12T00:00:00.000Z");
  assert.equal(draft.status, "ready_for_confirmation");
  const peerStore = separateConnections ? createSqliteRunStore(cwd) : undefined;
  let readyReadCount = 0;
  const waiters = [];
  const refreshes = [];
  const schedulerStates = [];
  const schedulerControl = { failRefreshCount: 0 };
  const requests = new Set();
  function observeStore(connection) { return new Proxy(connection, {
    get(target, property) {
      if (property === "getAutomationDraft") {
        return (id) => {
          const result = target.getAutomationDraft(id);
          if (id === draft.id && result?.status === "ready_for_confirmation") {
            readyReadCount += 1;
            for (const waiter of waiters) if (readyReadCount >= waiter.count) waiter.resolve();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }); }
  const observedStores = [observeStore(store), ...(peerStore ? [observeStore(peerStore)] : [])];
  let connectionIndex = 0;
  const server = createServer((request, response) => {
    void handleAutomationDraftItem(request, response, { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 },
      { getStore: () => observedStores[connectionIndex++ % observedStores.length] }, {
        list: () => schedulerStates,
        refresh(path) {
          refreshes.push(path);
          if (schedulerControl.failRefreshCount > 0) {
            schedulerControl.failRefreshCount -= 1;
            throw new Error("private-scheduler-secret");
          }
          schedulerStates.splice(0, schedulerStates.length, { status: "running", items: store.listAutomationDefinitions({ status: "enabled", scheduledOnly: true }).map((automation) => ({
            automationId: automation.id, nextRunAt: "2026-10-12T00:02:00.000Z",
          })) });
        },
      }, { kind: "confirm", draftId: draft.id });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/automation-drafts/${encodeURIComponent(draft.id)}/confirm?cwd=${encodeURIComponent(cwd)}`;
  function withheldConfirm() {
    let request;
    const result = new Promise((resolve, reject) => {
      request = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": "2", connection: "close" } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          requests.delete(request);
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("A08 isolated HTTP request timed out")));
      requests.add(request);
      request.flushHeaders();
    });
    // Cleanup may destroy an unreleased request after an assertion failure.
    void result.catch(() => {});
    return { result, release: () => request.end("{}") };
  }
  return {
    cwd, store, draft, refreshes, schedulerStates, schedulerControl, withheldConfirm,
    async confirm() { const pending = withheldConfirm(); pending.release(); return pending.result; },
    waitForReadyReads(count) {
      if (readyReadCount >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`A08 expected ${count} real ready reads; observed ${readyReadCount}`)), 3000);
        waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    definitionCount: () => store.listAutomationDefinitions({ includeArchived: true, limit: 500 }).length,
    threadCount: () => store.listLingThreads({ kind: "automation", includeArchived: true, limit: 500 }).length,
    async close() {
      for (const request of requests) request.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      peerStore?.close();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
