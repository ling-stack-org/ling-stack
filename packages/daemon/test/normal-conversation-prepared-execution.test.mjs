import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { saveNormalConversationPreparedRequest } from "../dist/features/conversations/normal-conversation-prepared-request.js";
import { restoreNormalConversationExecutionOptions } from "../dist/features/conversations/normal-conversation-prepared-execution.js";
import { handleConversationStream } from "../dist/features/conversations/routes.js";
import { handleLingThreadItem } from "../dist/features/runs/thread-routes.js";

async function fixture(t, { unsupported = false, actorType = "local_user" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-execution-"));
  const registry = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  const active = new ActiveRunRegistry();
  const f = { cwd, registry, supervisor, active, errors: [], calls: [], preparations: [], controls: {} };
  const store = registry.getStore(cwd);
  f.store = store;
  t.after(async () => { supervisor.releaseAll(); registry.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  f.preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "N03 fixture", providerId: "n03-fixture", model: "fixture",
    api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true }, now);
  store.recordProviderCheckResult(f.preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Prepared", objective: "Prepared" }, now);
  f.acceptedArgs = { store, thread, actorType, message: "CURRENT_USER", title: "Current", attachmentIds: [], fileRefs: [], idempotencyKey: "current", now };
  const accepted = prepareNormalConversationInput(f.acceptedArgs);
  f.request = saveNormalConversationPreparedRequest(store, { cwd, workspaceCwd: cwd, threadId: thread.id, turnId: accepted.turn.id,
    task: { id: "prepared-task", title: "Current", prompt: "CURRENT_USER" }, teammateId: "ling_agent", createdByActor: actorType === "system" ? "system" : "local-user",
    idempotencyKey: accepted.idempotencyKey, tools: ["read"], providerPresetId: f.preset.id,
    normalConversationContext: accepted.context, normalConversationAcceptedSnapshotId: accepted.acceptedSnapshotId, contextProjection: accepted.context.projection }, now);
  f.sourceId = accepted.turn.sourceItemId;
  class FixtureRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      const snapshot = await super.prepareTaskInput(options);
      f.preparations.push(snapshot);
      await f.controls.afterPrepare?.();
      return snapshot;
    }
    async runTask(options) {
      // A local receiver, not a model run: prove the real SDK assembly matches at dispatch.
      const actual = await super.prepareTaskInput(options);
      assert.equal(actual.fingerprint, options.preparedInput?.fingerprint, "Daemon must send the persisted SDK snapshot");
      f.calls.push(options);
      await f.controls.onRun?.(options);
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Fixture complete" }] };
    }
  }
  f.adapter = unsupported ? { runTask: () => assert.fail("unsupported preparation must not execute") } : new FixtureRunner();
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: f.adapter }]);
  f.dispatch = () => executeRunRequest(f.request, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => f.errors.push(body) },
    f.runners, registry, active, supervisor, { resolve: () => ({ configured: false }) }, {});
  return f;
}

test("Daemon persists final SDK input before a WorkUnit/Run and consumes it", async (t) => {
  const f = await fixture(t);
  const create = f.store.createWorkUnit.bind(f.store);
  let observed;
  f.store.createWorkUnit = (...args) => {
    observed = f.store.getConversationPreparedInput(f.sourceId, "execution");
    assert.ok(observed, "execution evidence must precede all dispatch records");
    assert.equal(f.store.listRuns().length, 0);
    return create(...args);
  };
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify(f.errors));
  assert.equal(f.preparations.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].preparedInput, observed.payload.preparedInput);
  assert.deepEqual(f.store.getRun(runId).requestSnapshot.normalConversationPreparedExecutionRef,
    { id: observed.id, fingerprint: observed.fingerprint });
});

test("system accepted input reaches the same Pi execution boundary without losing its origin", async (t) => {
  const f = await fixture(t, { actorType: "system" });
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify(f.errors));
  const run = f.store.getRun(runId);
  const execution = f.store.getConversationPreparedInput(f.sourceId, "execution");
  assert.equal(run.requestSnapshot.createdByActor, "system");
  assert.equal(f.store.getLingTurnForRun(runId).createdByActor, "system");
  assert.equal(f.store.getConversationItem(f.sourceId).actorType, "system");
  assert.equal(run.requestSnapshot.normalConversationPreparedExecutionRef.id, execution.id);
  assert.deepEqual(f.calls[0].preparedInput, execution.payload.preparedInput);
});
test("normal fork-run reaches a separate accepted/request/SDK execution chain with frozen parent narrative", async t => {
  const f = await fixture(t);
  const parentRunId = await f.dispatch();
  assert.ok(parentRunId, JSON.stringify(f.errors));
  const parent = f.store.getRun(parentRunId);
  f.store.appendEvent(parentRunId, "message_end", { role: "assistant", text: "FROZEN_PARENT_NARRATIVE" });
  const parentExecution = f.store.getConversationPreparedInput(f.sourceId, "execution");
  class Response extends EventEmitter {
    statusCode = 200; body = "";
    writeHead(status) { this.statusCode = status; } setHeader() {} end(chunk = "") { this.body += chunk; }
  }
  const response = new Response(), request = Readable.from([JSON.stringify({ idempotencyKey: "sdk-fork", instruction: "CHILD_TASK" })]);
  request.method = "POST"; request.headers = {};
  await handleLingThreadItem(request, response, new URL(`http://fixture/threads/fork-run?cwd=${encodeURIComponent(f.cwd)}`),
    f.registry, { kind: "fork-run", threadId: parent.threadId }, { maxBodyBytes: 100_000, startForkRun: async prepared => {
      f.request = prepared; return f.dispatch();
    } });
  assert.equal(response.statusCode, 202, response.body + JSON.stringify(f.errors));
  const child = f.store.getRun(JSON.parse(response.body).runId);
  const source = f.store.getLingTurnForRun(child.id).sourceItemId;
  const accepted = f.store.getConversationAcceptedInputSnapshot(source);
  const execution = f.store.getConversationPreparedInput(source, "execution");
  assert.notEqual(child.threadId, parent.threadId);
  assert.equal(accepted.threadId, child.threadId);
  assert.notEqual(execution.id, parentExecution.id);
  assert.equal(execution.parentSnapshotId, child.requestSnapshot.normalConversationPreparedRequestRef.id);
  assert.equal(execution.id, child.requestSnapshot.normalConversationPreparedExecutionRef.id);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].preparedInput, execution.payload.preparedInput);
  assert.ok(f.calls[1].task.prompt.includes("FROZEN_PARENT_NARRATIVE"));
  assert.equal(f.calls[1].task.prompt.split("CHILD_TASK").length - 1, 1);
  assert.deepEqual(f.store.getConversationPreparedInput(f.sourceId, "execution"), parentExecution);
});

test("no-Run restart reuses execution Memory/SDK input without re-selection", async (t) => {
  const f = await fixture(t);
  f.store.createMemoryObject({ id: "memory-one", scopeType: "workspace", ownerId: "workspace_default", title: "CURRENT_USER", body: "MEMORY_ONE" }, new Date().toISOString());
  const create = f.store.createWorkUnit.bind(f.store);
  f.store.createWorkUnit = () => { throw new Error("STOP_AFTER_PREPARATION"); };
  await f.dispatch();
  const first = f.store.getConversationPreparedInput(f.sourceId, "execution");
  assert.ok(first, JSON.stringify(f.errors));
  assert.match(first.payload.preparedInput.systemPrompt, /MEMORY_ONE/);
  assert.equal(f.store.listRuns().length, 0);
  f.store.createWorkUnit = create;
  f.supervisor.releaseAll(); f.registry.closeAll(); f.store = f.registry.getStore(f.cwd);
  f.store.recallMemory = () => assert.fail("no-Run replay must not recall Memory again");
  f.adapter.prepareTaskInput = () => assert.fail("no-Run replay must not prepare SDK input again");
  f.errors.length = 0;
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify(f.errors));
  assert.deepEqual(f.calls[0].preparedInput, first.payload.preparedInput);
  assert.deepEqual(f.store.listUsedMemoryEvents({ runId })[0].memoryIds, ["memory-one"]);
});

for (const change of ["disabled", "endpoint", "not-ready"]) {
  test(`prepared replay rechecks current provider: ${change}`, async (t) => {
    const f = await fixture(t);
    const create = f.store.createWorkUnit.bind(f.store);
    f.store.createWorkUnit = () => { throw new Error("STOP_AFTER_PREPARATION"); };
    await f.dispatch();
    assert.ok(f.store.getConversationPreparedInput(f.sourceId, "execution"));
    f.store.createWorkUnit = create;
    if (change === "disabled") f.store.updateProviderPreset(f.preset.id, { enabled: false }, new Date().toISOString());
    if (change === "endpoint") f.store.updateProviderPreset(f.preset.id, { baseUrl: "https://changed.invalid/v1" }, new Date().toISOString());
    if (change === "not-ready") f.store.recordProviderCheckResult(f.preset.id, { ok: false, code: "failed", message: "Synthetic failure", checkedAt: new Date().toISOString() });
    f.errors.length = 0;
    assert.equal(await f.dispatch(), undefined);
    assert.equal(f.calls.length, 0); assert.equal(f.store.listRuns().length, 0);
    assert.ok(f.errors.length > 0);
  });
}

test("shutdown during SDK preparation writes neither execution snapshot nor Run", async (t) => {
  const f = await fixture(t);
  f.controls.afterPrepare = () => f.active.suspendAll("daemon_restart");
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.store.getConversationPreparedInput(f.sourceId, "execution"), undefined);
  assert.equal(f.store.listRuns().length, 0); assert.equal(f.calls.length, 0);
});

test("unsupported adapter cannot create fake prepared input evidence", async (t) => {
  const f = await fixture(t, { unsupported: true });
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.errors[0]?.error, "runner_input_preparation_unavailable");
  assert.equal(f.store.getConversationPreparedInput(f.sourceId, "execution"), undefined);
  assert.equal(f.store.listRuns().length, 0);
});

test("a real conversation route ends its SSE with blocked when preparation fails before Run creation", async (t) => {
  const f = await fixture(t, { unsupported: true });
  class Response extends EventEmitter {
    body = ""; statusCode = 200; writableEnded = false; headersSent = false;
    writeHead(status) { this.statusCode = status; this.headersSent = true; }
    setHeader() {}
    flushHeaders() {}
    write(value) { this.body += value; }
    end(value = "") { this.body += value; this.writableEnded = true; }
  }
  const response = new Response();
  const request = Readable.from([JSON.stringify({ threadId: f.request.threadId, message: "CURRENT_USER",
    providerPresetId: f.preset.id, idempotencyKey: "stream-unsupported" })]);
  request.method = "POST"; request.url = `/api/conversations/stream?cwd=${encodeURIComponent(f.cwd)}`; request.headers = { host: "fixture" };
  await handleConversationStream(request, response, { host: "fixture", port: 1, maxBodyBytes: 100_000 }, f.registry, f.runners,
    (runRequest, sink) => executeRunRequest(runRequest, sink, f.runners, f.registry, f.active, f.supervisor,
      { resolve: () => ({ configured: false }) }, {}));
  assert.match(response.body, /event: error/);
  assert.equal(response.writableEnded, true, "prepare error must not leave the client waiting indefinitely");
  assert.equal(response.body.match(/event: blocked/g)?.length, 1);
  assert.equal(response.body.includes("event: done"), false);
  assert.equal(f.store.listRuns().length, 0);
});

test("concurrent SDK preparations consume only the persisted winner and create one Run", async (t) => {
  const f = await fixture(t);
  let release, firstReady;
  const pending = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { firstReady = resolve; });
  let winningThread;
  f.controls.afterPrepare = async () => { if (f.preparations.length === 1) { firstReady(); await pending; } };
  const first = f.dispatch();
  try {
    await Promise.race([ready, first.then(() => assert.fail("first preparation ended before the fixture barrier"))]);
    f.store.createMemoryObject({ id: "winner-memory", scopeType: "workspace", ownerId: "workspace_default", title: "CURRENT_USER", body: "WINNING_MEMORY" }, new Date().toISOString());
    const second = await f.dispatch();
    assert.ok(second, JSON.stringify(f.errors));
    winningThread = f.store.getLingThread(f.request.threadId);
  } finally { release(); }
  await first;
  const saved = f.store.getConversationPreparedInput(f.sourceId, "execution");
  assert.equal(f.preparations.length, 2);
  assert.notEqual(f.preparations[0].fingerprint, f.preparations[1].fingerprint);
  assert.equal(saved.payload.preparedInput.fingerprint, f.preparations[1].fingerprint);
  assert.equal(f.calls.length, 1); assert.equal(f.store.listRuns().length, 1);
  assert.equal(f.store.getLingThread(f.request.threadId).status, winningThread.status,
    "the losing duplicate must not mark the winning thread failed");
});

test("policy changed while SDK preparation awaited is used by the real Host approval handler", async (t) => {
  const f = await fixture(t);
  f.controls.afterPrepare = () => f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, new Date().toISOString());
  let decision;
  f.controls.onRun = async (options) => { decision = await options.onApprovalRequired({ toolCallId: "denied-read", toolName: "read",
    input: { path: "never-read.txt" }, task: options.task, cwd: f.cwd, defaultApproval: "allow" }); };
  assert.ok(await f.dispatch(), JSON.stringify(f.errors));
  assert.equal(decision?.approved, false);
});

for (const timing of ["during-preparation", "replay"]) {
  test(`revoked Memory cannot enter a prepared model request: ${timing}`, async (t) => {
    const f = await fixture(t);
    f.store.createMemoryObject({ id: "revocable", scopeType: "workspace", ownerId: "workspace_default", title: "CURRENT_USER", body: "REVOKED_MEMORY" }, new Date().toISOString());
    const revoke = () => f.store.updateMemoryObject("revocable", { enabled: false }, new Date().toISOString());
    if (timing === "during-preparation") f.controls.afterPrepare = revoke;
    else {
      const create = f.store.createWorkUnit.bind(f.store);
      f.store.createWorkUnit = () => { throw new Error("STOP_AFTER_PREPARATION"); };
      await f.dispatch(); f.store.createWorkUnit = create;
      assert.ok(f.store.getConversationPreparedInput(f.sourceId, "execution"));
      revoke(); f.errors.length = 0;
    }
    assert.equal(await f.dispatch(), undefined);
    assert.equal(f.errors.at(-1)?.error, "prepared_memory_unavailable");
    assert.equal(f.calls.length, 0); assert.equal(f.store.listRuns().length, 0);
  });
}

for (const corruption of ["missing", "wrong"]) {
  test(`existing Run cannot hide a ${corruption} execution reference behind a valid snapshot`, async (t) => {
    const f = await fixture(t);
    const id = await f.dispatch();
    assert.ok(id, JSON.stringify(f.errors));
    const get = f.store.getRun.bind(f.store);
    f.store.getRun = (runId) => {
      const run = get(runId);
      return runId !== id ? run : { ...run, requestSnapshot: { ...run.requestSnapshot,
        normalConversationPreparedExecutionRef: corruption === "missing" ? undefined : { id: "wrong", fingerprint: "wrong" } } };
    };
    assert.throws(() => prepareNormalConversationInput(f.acceptedArgs), /prepared execution/i);
  });
}

test("MCP replay pins schema/membership while respecting current approval and risk", () => {
  const tool = { registeredName: "fixture_mcp", serverId: "fixture", rawName: "read", displayName: "Read", description: "Read fixture",
    inputSchema: { type: "object", properties: {} }, sideEffectLevel: "read", defaultApproval: "allow" };
  const provider = { provider: "fixture", model: "fixture", baseUrl: "https://fixture.invalid" };
  const payload = { input: { provider, mcpTools: [tool] }, toolHydrationEnabled: false };
  const live = { ...tool, defaultApproval: "deny", sideEffectLevel: "external_write" };
  const current = { provider: { ...provider, apiKey: "rotated-fixture" }, mcpTools: [live, { ...live, registeredName: "new-tool" }] };
  const restored = restoreNormalConversationExecutionOptions(payload, current);
  assert.deepEqual(restored.mcpTools, [live]);
  assert.equal(restored.provider.apiKey, "rotated-fixture");
  for (const mcpTools of [[], [{ ...live, inputSchema: { type: "string" } }]]) {
    assert.throws(() => restoreNormalConversationExecutionOptions(payload, { ...current, mcpTools }), /revoked|schema changed/);
  }
});

test("prepared runtime capabilities allow Host additions but reject required capability revocation", () => {
  const provider = { provider: "fixture", model: "fixture", baseUrl: "https://fixture.invalid" };
  const frozenFeatures = { requestPermissions: false, unifiedExec: false, shellSnapshot: false };
  const payload = { input: { provider, runtimeToolFeatures: frozenFeatures }, toolHydrationEnabled: false };
  const current = { provider, runtimeToolFeatures: { requestPermissions: true, unifiedExec: true, shellSnapshot: true } };
  assert.deepEqual(
    restoreNormalConversationExecutionOptions(payload, current).runtimeToolFeatures,
    frozenFeatures,
    "new Host capabilities must not enter frozen model input",
  );

  for (const feature of ["requestPermissions", "unifiedExec", "shellSnapshot"]) {
    const required = { ...frozenFeatures, [feature]: true };
    const revoked = { ...current.runtimeToolFeatures, [feature]: false };
    assert.throws(
      () => restoreNormalConversationExecutionOptions(
        { ...payload, input: { ...payload.input, runtimeToolFeatures: required } },
        { ...current, runtimeToolFeatures: revoked },
      ),
      /runtime tool capabilities changed/i,
    );
  }
});
