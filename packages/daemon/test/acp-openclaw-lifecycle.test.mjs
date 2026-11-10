import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpJournaledLifecycle, acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";

const now = "2026-09-10T08:00:00.000Z";
const target = { engineId: "openclaw-acp", expectedVersion: "owned-peer-1", agentId: "fixture" };
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-openclaw-lifecycle-")), stores = [], cleanups = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  t.after(async () => {
    try { for (const cleanup of cleanups.toReversed()) await cleanup(); }
    finally { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); }
  });
  const store = open();
  const channel = store.createChannel({ name: "Routing", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Routing", prompt: "Synthetic" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Routing", objective: "Synthetic" }, now);
  let number = 0;
  const reserve = (database = store, options = {}) => {
    const id = `openclaw_${++number}`;
    database.createRun({ id, cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
      providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    const work = database.createWorkUnit({ id: `work_${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, idempotencyKey: id, createdByActor: "user", request: {}, runnerId: target.engineId, now });
    const attempt = database.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1,
      runtimeInstanceId: "owned", runnerId: target.engineId, now });
    database.linkRunToWorkUnit(id, work.id, now);
    const fence = toRuntimeAttemptFence(attempt);
    database.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now });
    for (const event of ["claim", "runner_started"]) database.transitionWorkUnitStatus({ ...fence, event, actor: "system", now });
    database.updateWorkUnitAttemptStatus({ ...fence, status: "started", now });
    database.updateLingThread(thread.id, { status: "running", activeRunId: id, lastRunId: id }, now);
    const entry = database.reserveNativeExecution({ runId: id, fence, generation: 1, selection: {
      engineId: target.engineId, profileId: "fixture", profileRevision: 1, profileFingerprint: "a".repeat(64),
      configurationFingerprint: acpConfigurationFingerprint(target, { cwd }), ...options.selection,
    } }, now);
    return { ...entry, key: { submissionId: entry.submission.id, fence } };
  };
  return { cwd, store, open, reserve, cleanups };
}

function peer(t, f, entry, store = f.store, overrides = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
    env: { LING_ACP_PEER_ENGINE: "openclaw-acp", LING_ACP_PEER_OUTPUT: "rich" }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close"), wire = [], events = [];
  child.on("message", value => wire.push(value)); child.stderr.resume();
  const lifecycle = new AcpJournaledLifecycle({ store, key: entry.key, target, configuration: { cwd: f.cwd },
    createActions: () => ({ receive() {}, clear() {}, prepare() { throw Error("No effects in the output-only fixture"); } }),
    output: { requireAssistantText: true }, now: () => now, onEvent: event => events.push(event),
    client: { input: child.stdin, output: child.stdout, signal: new AbortController().signal, requestTimeoutMs: 1500, turnTimeoutMs: 3000 },
    ...overrides,
  });
  f.cleanups.push(async () => {
    try { lifecycle.close(); await lifecycle.closed; }
    catch (error) { if (!overrides.expectedCloseError || error.code !== overrides.expectedCloseError) throw error; }
    finally { child.kill(); await exited; }
  });
  return { lifecycle, wire, events, async close() { lifecycle.close(); await lifecycle.closed; assert.equal((await exited)[0], 0); } };
}

test("OpenClaw owned peers retain the remote key through no-send reopen and accepted-history load", { timeout: 10000 }, async t => {
  const f = await fixture(t), first = f.reserve(), a = peer(t, f, first);
  await a.lifecycle.open(); await a.close();
  const route = f.store.getNativeExecutionBinding(first.binding.id).openclawSession;
  assert.equal(route.acceptedAt, undefined);
  assert.equal(f.store.getNativeSubmission(first.key.submissionId).status, "not_submitted");
  assert.deepEqual(a.wire.find(value => value.method === "session/new").params._meta,
    { sessionKey: route.sessionKey, resetSession: false, requireExistingSession: false });
  let count = 0;
  for (const requireExistingSession of [false, true]) {
    const store = f.open(), next = f.reserve(store), p = peer(t, f, next, store);
    await p.lifecycle.open();
    await (await p.lifecycle.startPrompt([{ type: "text", text: "Owned output-only fixture" }])).completed;
    await p.close();
    const request = p.wire.find(value => value.method === "session/load");
    assert.deepEqual(request.params, { sessionId: "owned-session", cwd: f.cwd, mcpServers: [],
      _meta: { sessionKey: route.sessionKey, resetSession: false, requireExistingSession } });
    assert.deepEqual(p.wire.filter(value => value.method).map(value => value.method), ["initialize", "session/load", "session/prompt"]);
    assert.equal(store.getNativeSubmission(next.key.submissionId).status, "completed");
    assert.equal(f.open().getNativeExecutionBinding(next.binding.id).openclawSession.acceptedAt, now);
    assert.ok(p.events.some(event => event.type === "message_end")); count++;
  }
  assert.equal(count, 2);
});

test("OpenClaw obsolete ownership cannot send initialize or session routing", { timeout: 6000 }, async t => {
  const f = await fixture(t), entry = f.reserve(), p = peer(t, f, entry, f.store, { expectedCloseError: "native_owner_mismatch" });
  f.store.createWorkUnitAttempt({ workUnitId: entry.key.fence.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: target.engineId, now });
  await assert.rejects(p.lifecycle.open(), { code: "native_owner_mismatch" });
  assert.deepEqual(p.wire, []);
  assert.equal(f.store.getNativeExecutionBinding(entry.binding.id).openclawSession, undefined);
});
