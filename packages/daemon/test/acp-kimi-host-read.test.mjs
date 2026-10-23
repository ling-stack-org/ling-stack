import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpJournaledLifecycle, acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";
import { KimiHostFiles } from "../dist/runtime/acp/kimi-host-files.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const now = "2026-09-09T06:00:00.000Z";
async function until(get) {
  for (let n = 0; n < 300; n++) { const value = get(); if (value) return value; await delay(5); }
  assert.fail("Expected lifecycle observation did not arrive");
}

test("host Write waits for its actual worker reply within the unchanged execution deadline", async t => {
  const originalSpawn = childProcess.spawn;
  let worker, resumeTimer;
  const observations = [];
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[0] === "/usr/bin/sandbox-exec" && args[1].some(value => value.endsWith("/host-text-write-worker.js"))) {
      assert.equal(worker, undefined);
      worker = child;
      observations.push({ phase: "worker_paused", at: performance.now() });
      assert.equal(child.kill("SIGSTOP"), true);
      resumeTimer = setTimeout(() => {
        observations.push({ phase: "worker_resumed", at: performance.now() });
        child.kill("SIGCONT");
      }, 2000);
    }
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    clearTimeout(resumeTimer);
    worker?.kill("SIGCONT");
  });
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  f.tool({ path: f.path, content: "Controlled worker delay\n" });
  f.writeRequest("Controlled worker delay\n");
  try { await f.waitForReply("write"); }
  finally { t.diagnostic(JSON.stringify(observations)); }
  assert.ok(worker, "the real sandbox worker must have entered the forced interleaving");
  assert.deepEqual(observations.map(value => value.phase), ["worker_paused", "worker_resumed"]);
  assert.ok(observations[1].at - observations[0].at >= 1950,
    "the actual worker was held beyond the old polling budget");
  assert.deepEqual(f.reply("write").result, {});
  assert.equal(await readFile(f.path, "utf8"), "Controlled worker delay\n");
  f.finish(); await f.handle.completed;
});

test("host reply observation fails immediately when its prompt loses ownership", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  const received = f.waitForReply("write");
  f.abort.abort();
  await assert.rejects(received, { code: "cancelled" });
  assert.equal(f.reply("write"), undefined);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
});

test("host reply observation rejects a terminal prompt without the requested reply", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  const received = f.waitForReply("write");
  f.send({ jsonrpc: "2.0", id: f.wire.find(value => value.method === "session/prompt").id,
    result: { stopReason: "end_turn" } });
  await assert.rejects(received, /Prompt completed without reply write/);
  assert.equal(f.reply("write"), undefined);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
});

async function setup(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-host-read-")));
  const path = join(cwd, "note.txt");
  await writeFile(path, options.content ?? "First\nSecond\nThird\n");
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Read fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Read", prompt: "Isolated file" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Read", objective: "Isolated file" }, now);
  const run = store.createRun({ id: "run_host_read", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_host_read", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: run.id, linkedRunId: run.id, runnerId: "kimi-acp", idempotencyKey: "read",
    createdByActor: "user", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: "kimi-acp", runtimeInstanceId: "fixture", now });
  const fence = toRuntimeAttemptFence(attempt);
  store.linkRunToWorkUnit(run.id, work.id, now);
  store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "system", now });
  for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now });
  store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now });
  const target = { engineId: "kimi-acp", expectedVersion: "fixture" }, configuration = { cwd };
  const reserved = store.reserveNativeExecution({ runId: run.id, generation: 1, fence, selection: {
    engineId: "kimi-acp", profileId: "fixture", profileRevision: 1, profileFingerprint: "a".repeat(64),
    configurationFingerprint: acpConfigurationFingerprint(target, configuration),
  } }, now);
  const key = { submissionId: reserved.submission.id, fence };
  const originalSettle = store.settleNativeHostOperation.bind(store);
  store.settleNativeHostOperation = (...args) => {
    const operation = originalSettle(...args);
    options.afterSettlement?.({ store, key, operation });
    return operation;
  };
  const originalClaim = store.claimNativeHostOperation.bind(store);
  store.claimNativeHostOperation = (...args) => {
    const operation = originalClaim(...args);
    options.afterClaim?.({ store, key, operation });
    return operation;
  };
  const abort = new AbortController(), output = new PassThrough(), wire = [], events = [], waits = [];
  const replyWaiters = new Map(), replyObservations = new Map();
  const send = (...messages) => output.write(messages.map(value => JSON.stringify(value)).join("\n") + "\n");
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "read-session", update: value } });
  const tool = (input = { path }, extra = {}) => update({ sessionUpdate: "tool_call", toolCallId: "1:read",
    title: "Display text is not identity", kind: options.fileTool && options.fileTool !== "Read" ? "edit" : "read",
    status: "in_progress", rawInput: input, ...extra });
  const request = (id = "read", params = {}) => send({ jsonrpc: "2.0", id, method: "fs/read_text_file",
    params: { sessionId: "read-session", path, ...params } });
  const permission = () => send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {
    sessionId: "read-session", toolCall: { toolCallId: "1:read", title: options.fileTool ?? "Read" }, options: [
      { optionId: "approve_once", kind: "allow_once", name: "Once" },
      { optionId: "approve_always", kind: "allow_always", name: "Session" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ] } });
  const input = new Writable({ write(bytes, _encoding, done) {
    const value = JSON.parse(bytes.toString()); wire.push(value);
    if (value.method === "initialize") result(value.id, { protocolVersion: 1,
      agentInfo: { name: "Kimi Code CLI", version: "fixture" }, agentCapabilities: {}, authMethods: [] });
    if (value.method === "session/new") result(value.id, { sessionId: "read-session" });
    if (options.replyWriteError && value.id === "write" && !value.method) { done(new Error("Fixture reply delivery failed")); return; }
    done();
  } });
  let files;
  const lifecycle = new AcpJournaledLifecycle({ store, key, target, configuration, now: () => now,
    output: { requireAssistantText: false }, secretRegistry: options.secretRegistry, onEvent: event => events.push(event),
    onApprovalWaitChanged: value => waits.push(value), approvalPollIntervalMs: 5,
    createActions: binding => new KimiActionPreparer({ cwd, sessionId: binding.sessionId,
      policy: { toolDecisions: { read: options.policy ?? "ask", write: options.policy ?? "ask", edit: options.policy ?? "ask" }, allowedWritePaths: [cwd] },
      ...options.actionOptions }, options.secretRegistry),
    createHostFiles: { readTextFile: context => {
      files = new KimiHostFiles(context);
      const observe = files.onReplyOutcome.bind(files);
      files.onReplyOutcome = observation => {
        observe(observation);
        replyObservations.set(observation.requestId, observation);
        replyWaiters.get(observation.requestId)?.(observation);
      };
      return files;
    },
      ...(options.fileTool ? { writeTextFile: () => files.writeTextFile } : {}) },
    client: { input, output, signal: abort.signal, requestTimeoutMs: 2000, turnTimeoutMs: 10000 } });
  t.after(async () => {
    try {
      if (options.closeError) assert.throws(() => lifecycle.close(), { code: options.closeError });
      else lifecycle.close();
    } finally {
      await lifecycle.closed;
      input.destroy(); output.destroy(); store.close(); await rm(cwd, { recursive: true, force: true });
    }
  });
  await lifecycle.open();
  const handle = await lifecycle.startPrompt([{ type: "text", text: "Read an isolated fixture file" }]);
  void handle.completed.catch(() => {});
  await until(() => wire.find(value => value.method === "session/prompt"));
  const approvals = () => store.synchronizeNativeApprovalWait(key, now).approvals;
  const waitForReply = async id => {
    const observed = replyObservations.get(id);
    if (observed) {
      assert.equal(observed.outcome, "written");
      return wire.find(value => value.id === id && !value.method);
    }
    assert.equal(replyWaiters.has(id), false);
    const received = new Promise(resolve => replyWaiters.set(id, resolve));
    try {
      // Observe the actual Host reply commit, not stdin bytes or a 300x5ms poll.
      // The real worker (5s) and prompt (10s) still own failure/cancellation.
      const observation = await Promise.race([received, handle.completed.then(() => {
        assert.fail(`Prompt completed without reply ${id}`);
      })]);
      assert.equal(observation.outcome, "written");
      return wire.find(value => value.id === id && !value.method);
    } finally { replyWaiters.delete(id); }
  };
  return { cwd, path, store, key, abort, lifecycle, handle, wire, events, waits, tool, request, permission, update, send,
    writeRequest: (content, id = "write", params = {}) => send({ jsonrpc: "2.0", id, method: "fs/write_text_file",
      params: { sessionId: "read-session", path, content, ...params } }),
    approvals, waitForReply, reply: id => wire.find(value => value.id === id && !value.method),
    finish: (status = "completed") => {
      update({ sessionUpdate: "tool_call_update", toolCallId: "1:read", status });
      result(wire.find(value => value.method === "session/prompt").id, { stopReason: "end_turn" });
    } };
}

test("Kimi host Write approves once before replacing a real file and records the completed effect", async t => {
  const f = await setup(t, { fileTool: "Write" });
  f.tool({ path: f.path, content: "Approved text\n" });
  f.writeRequest("Approved text\n");
  const saved = await Promise.race([until(() => f.approvals()[0]), f.handle.completed]);
  assert.equal(saved.approval.status, "pending");
  assert.equal(saved.approval.payload.type, "file_write");
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), "Approved text\n");
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
});

test("Kimi append shares one approval across its read and exact writeback", async t => {
  const f = await setup(t, { fileTool: "Write" });
  f.tool({ path: f.path, mode: "append", content: "Appended\n" }); f.request();
  const saved = await Promise.race([until(() => f.approvals()[0]), f.handle.completed]);
  assert.equal(saved.approval.payload.type, "file_write");
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  const original = (await until(() => f.reply("read"))).result.content;
  assert.equal(original, "First\nSecond\nThird\n");
  f.writeRequest(original + "Appended\n");
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\nAppended\n");
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
});

for (const nativePermission of [false, true]) test(`Kimi append preserves one exact approval across live secret registration (native=${nativePermission})`, async t => {
  const initial = "synthetic-append-initial-token", rotated = "synthetic-append-rotated-token";
  const secretRegistry = new NativeSecretRegistry([initial]);
  const f = await setup(t, { fileTool: "Write", secretRegistry });
  const suffix = `\n${initial}\n`;
  f.tool({ path: f.path, mode: "append", content: suffix });
  if (nativePermission) f.permission(); else f.request();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(JSON.stringify(saved).includes(initial), false);
  const expiry = saved.approval.expiresAt;
  secretRegistry.register([rotated]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  if (nativePermission) { await until(() => f.reply("permission")); f.request(); }
  const read = await until(() => f.reply("read"));
  assert.ok(read.result, JSON.stringify(read.error));
  const original = read.result.content;
  secretRegistry.register(["another-synthetic-refresh-token"]);
  f.writeRequest(original + suffix);
  const written = await f.waitForReply("write");
  assert.deepEqual(written.result, {});
  assert.equal(await readFile(f.path, "utf8"), original + suffix);
  assert.equal(f.approvals().length, 1);
  assert.equal(f.approvals()[0].approval.id, saved.approval.id);
  assert.equal(f.approvals()[0].approval.expiresAt, expiry);
  f.finish(); await f.handle.completed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeApprovalCorrelation(saved.approval.id).replyStatus, "written");
    assert.equal(JSON.stringify(reopened.listApprovalRequests({ runId: "run_host_read" })).includes(initial), false);
  } finally { reopened.close(); }
});

test("Kimi Edit preserves exact replacement bytes across live secret registration", async t => {
  const initial = "synthetic-edit-initial-token";
  const secretRegistry = new NativeSecretRegistry([initial]);
  const f = await setup(t, { fileTool: "Edit", secretRegistry });
  f.tool({ path: f.path, old_string: "Second", new_string: initial }); f.permission();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(JSON.stringify(saved).includes(initial), false);
  secretRegistry.register(["synthetic-edit-next-token"]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  await until(() => f.reply("permission")); f.request();
  const read = await until(() => f.reply("read"));
  assert.equal(read.result.content, "First\nSecond\nThird\n");
  secretRegistry.register(["synthetic-edit-final-token"]);
  const content = `First\n${initial}\nThird\n`;
  f.writeRequest(content);
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), content);
  assert.equal(f.approvals().length, 1);
  f.finish(); await f.handle.completed;
});

for (const outcome of ["written", "not_written", "unknown"]) test(`Kimi append retains both reply observations when write delivery is ${outcome}`, async t => {
  let actionId, abort;
  const f = await setup(t, { fileTool: "Write", replyWriteError: outcome === "unknown",
    afterSettlement: ({ operation }) => {
      actionId = operation.actionId;
      if (operation.step === 1 && outcome === "not_written") abort.abort();
    } });
  abort = f.abort;
  f.tool({ path: f.path, mode: "append", content: "Appended\n" }); f.request();
  const saved = await until(() => f.approvals()[0]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  const original = (await until(() => f.reply("read"))).result.content;
  f.writeRequest(original + "Appended\n");
  if (outcome === "written") {
    await f.waitForReply("write");
    f.finish(); await f.handle.completed;
  } else {
    await assert.rejects(f.handle.completed);
    await f.lifecycle.closed;
  }
  assert.equal(await readFile(f.path, "utf8"), original + "Appended\n");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(reopened.listNativeHostOperations(actionId).map(item => [item.status, item.replyStatus, item.replyObservedAt]),
      [["succeeded", "written", now], ["succeeded", outcome, now]]);
    assert.equal(reopened.getNativeApprovalCorrelation(saved.approval.id).replyStatus, "written");
  } finally { reopened.close(); }
});

test("Kimi Edit writes the approved literal replacement with native CRLF semantics", async t => {
  const f = await setup(t, { fileTool: "Edit", content: "first\r\nold\r\nlast\r\n" });
  f.tool({ path: f.path, old_string: "old", new_string: "new\nline" }); f.request();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(saved.approval.payload.type, "file_edit");
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  assert.equal((await until(() => f.reply("read"))).result.content, "first\r\nold\r\nlast\r\n");
  f.writeRequest("first\r\nnew\r\nline\r\nlast\r\n");
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), "first\r\nnew\r\nline\r\nlast\r\n");
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
});

test("Kimi append creates a missing file after an authorized not-found baseline without another approval", async t => {
  const f = await setup(t, { fileTool: "Write" });
  await rm(f.path);
  f.tool({ path: f.path, content: "New text\n", mode: "append" }); f.request();
  const saved = await until(() => f.approvals()[0]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  assert.equal((await until(() => f.reply("read"))).error?.code, -32002);
  f.writeRequest("New text\n");
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), "New text\n");
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
});

for (const scenario of ["overwrite", "append", "edit"]) test(`${scenario} refuses an unapproved writeback without changing the file`, async t => {
  const f = await setup(t, { fileTool: scenario === "edit" ? "Edit" : "Write", policy: "allow" });
  const input = scenario === "edit" ? { old_string: "First", new_string: "Approved" }
    : { content: "Approved", ...(scenario === "append" ? { mode: "append" } : {}) };
  f.tool({ path: f.path, ...input });
  if (scenario !== "overwrite") { f.request(); await until(() => f.reply("read")); }
  f.writeRequest("Unauthorized replacement");
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
  assert.equal(f.approvals().length, 0);
});

for (const content of ["", "\ufeffExact\r\nUnicode 中文\n"]) test(`overwrite creates a new text file (${Buffer.byteLength(content)} bytes)`, async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  await rm(f.path);
  f.tool({ path: f.path, content }); f.writeRequest(content);
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), content);
  f.finish(); await f.handle.completed;
});

for (const denial of ["policy", "user", "plan"]) test(`${denial} denial never changes a host Write target`, async t => {
  const f = await setup(t, { fileTool: "Write", policy: denial === "policy" ? "deny" : denial === "plan" ? "allow" : "ask",
    actionOptions: denial === "plan" ? { effectivePolicySnapshot: { conversationMode: "plan" } } : {} });
  f.tool({ path: f.path, content: "Changed" }); f.writeRequest("Changed");
  if (denial === "user") {
    const saved = await until(() => f.approvals()[0]);
    f.store.denyApprovalRequest(saved.approval.id, {}, now);
  }
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
  assert.equal(f.approvals().length, denial === "user" ? 1 : 0);
});

test("append reuses a written native permission decision through both host requests", async t => {
  const f = await setup(t, { fileTool: "Write" });
  f.tool({ path: f.path, content: "Suffix", mode: "append" }); f.permission();
  const saved = await until(() => f.approvals()[0]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  await until(() => f.reply("permission"));
  f.request(); await until(() => f.reply("read"));
  f.writeRequest("First\nSecond\nThird\nSuffix");
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\nSuffix");
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
});

for (const mixed of [false, true]) test(`host Write reuses its exact native approval while the saved preview stays redacted (mixed=${mixed})`, async t => {
  const f = await setup(t, { fileTool: "Write" });
  const content = "Authorization: Bearer DEMO_TOKEN\n" + (mixed ? "sk-DEMO_TOKEN_123\n" : "");
  f.tool({ path: f.path, content }); f.permission();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(JSON.stringify(saved.approval.payload).includes("DEMO_TOKEN"), false);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  await until(() => f.reply("permission"));
  f.writeRequest(content);
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), content);
  assert.equal(f.approvals().length, 1);
  assert.equal(JSON.stringify(f.approvals()[0].approval.payload).includes("DEMO_TOKEN"), false);
  f.finish(); await f.handle.completed;
});

for (const change of ["content", "absent", "input"]) test(`append rejects a changed ${change} baseline before writing`, async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  if (change === "absent") await rm(f.path);
  f.tool({ path: f.path, content: "Suffix", mode: "append" }); f.request();
  const baseline = await until(() => f.reply("read"));
  if (change === "input") {
    f.tool({ path: f.path, content: "Other", mode: "append" }, { sessionUpdate: "tool_call_update" });
    f.tool({ path: f.path, content: "Suffix", mode: "append" }, { sessionUpdate: "tool_call_update" });
  } else await writeFile(f.path, "Changed by the user");
  f.writeRequest((baseline.result?.content ?? "") + "Suffix");
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), change === "input" ? "First\nSecond\nThird\n" : "Changed by the user");
});

for (const fileTool of ["Write", "Edit"]) test(`${fileTool} preserves a concurrent edit during write destination capture`, async t => {
  const f = await setup(t, { fileTool, policy: "allow" });
  f.tool(fileTool === "Write" ? { path: f.path, content: "Suffix", mode: "append" }
    : { path: f.path, old_string: "First", new_string: "Changed" });
  f.request(); await until(() => f.reply("read"));
  const lstat = fs.lstatSync;
  let replaced = false;
  // Model another process updating the file immediately after a metadata observation.
  const instrument = t.mock.method(fs, "lstatSync", (...args) => {
    const result = lstat(...args);
    if (!replaced && args[0] === f.path && args[1]?.bigint) {
      replaced = true;
      writeFileSync(f.path, "Concurrent user edit");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    f.writeRequest(fileTool === "Write" ? "First\nSecond\nThird\nSuffix" : "Changed\nSecond\nThird\n");
    const reply = await f.waitForReply("write");
    assert.equal(replaced, true);
    assert.ok(reply.error, "A stale read must not authorize replacement of the concurrent edit");
    assert.equal(await readFile(f.path, "utf8"), "Concurrent user edit");
  } finally { instrument.mock.restore(); syncBuiltinESMExports(); }
});

test("a replay cannot append twice after the original write succeeded", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow" });
  f.tool({ path: f.path, content: "Suffix", mode: "append" }); f.request();
  await until(() => f.reply("read"));
  f.writeRequest("First\nSecond\nThird\nSuffix"); await f.waitForReply("write");
  f.writeRequest("First\nSecond\nThird\nSuffixSuffix", "replay");
  assert.ok((await until(() => f.reply("replay"))).error);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\nSuffix");
});

test("a target swapped after the write claim is not overwritten", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow", afterClaim: ({ operation }) => {
    if (operation.method === "fs/write_text_file") writeFileSync(f.path, "Replacement content");
  } });
  f.tool({ path: f.path, content: "Approved" }); f.writeRequest("Approved");
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), "Replacement content");
});

test("a pending write worker does not block cancellation or publish a late success reply", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow",
    afterClaim: () => setImmediate(() => f.abort.abort()) });
  f.tool({ path: f.path, content: "Approved" }); f.writeRequest("Approved");
  await assert.rejects(f.handle.completed);
  await f.lifecycle.closed;
  assert.equal(f.reply("write")?.result, undefined);
});

test("native disabled tools cannot use a shared callback even when the broad host policy allows them", async t => {
  const f = await setup(t, { fileTool: "Write", policy: "allow", actionOptions: { nativeTools: ["Read"] } });
  f.tool({ path: f.path, content: "Changed" }); f.writeRequest("Changed");
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
  assert.equal(f.approvals().length, 0);
});

for (const kind of ["replacement", "cancelling"]) test(`completed Write remains durable when ${kind} prevents its reply`, async t => {
  let settled;
  const f = await setup(t, { fileTool: "Write", policy: "allow", closeError: kind === "replacement" ? "native_owner_mismatch" : undefined,
    afterSettlement: ({ store, key, operation }) => {
      settled = operation;
      if (kind === "replacement") store.createWorkUnitAttempt({ workUnitId: key.fence.workUnitId, attemptNumber: 2,
        runnerId: "kimi-acp", runtimeInstanceId: "replacement", now });
      else store.updateWorkUnitAttemptStatus({ ...key.fence, status: "cancelling", now });
    } });
  f.tool({ path: f.path, content: "Completed write" }); f.writeRequest("Completed write");
  const outcome = await f.waitForReply("write").catch(error => ({ error }));
  assert.ok(outcome.error);
  assert.equal(f.reply("write")?.result, undefined);
  assert.equal(await readFile(f.path, "utf8"), "Completed write");
  assert.equal(settled.status, "succeeded");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.listNativeHostOperations(settled.actionId)[0].status, "succeeded");
    const action = reopened.getNativeHostAction(settled.actionId);
    assert.throws(() => reopened.claimNativeHostOperation({ actionId: action.id, fence: f.key.fence, step: 0,
      requestId: "replay", actionFingerprint: action.actionFingerprint, policyFingerprint: action.policyFingerprint,
      operationFingerprint: "e".repeat(64) }, now));
  } finally { reopened.close(); }
});

for (const replacement of ["directory", "symlink"]) test(`a new file cannot escape through a post-claim ${replacement} replacement`, async t => {
  let change;
  const f = await setup(t, { fileTool: "Write", policy: "allow", afterClaim: () => change() });
  const parent = join(f.cwd, "target"), outside = await realpath(await mkdtemp(join(tmpdir(), "ling-write-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(parent); await mkdir(join(f.cwd, "replacement"));
  const path = join(parent, "new.txt");
  change = () => {
    renameSync(parent, join(f.cwd, "original-parent"));
    if (replacement === "symlink") symlinkSync(outside, parent);
    else renameSync(join(f.cwd, "replacement"), parent);
  };
  f.tool({ path, content: "Approved" }); f.writeRequest("Approved", "write", { path });
  const outcome = await f.waitForReply("write").catch(error => ({ error }));
  assert.ok(outcome.error);
  for (const target of [path, join(outside, "new.txt"), join(f.cwd, "original-parent", "new.txt")]) {
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
});

for (const input of [{ old_string: "First", new_string: "$&$1", replace_all: true },
  { old_string: "First", new_string: "Literal", replace_all: false }]) test(`Edit preserves literal strings and unique/all semantics (${input.replace_all})`, async t => {
  const content = input.replace_all ? "First\r\nFirst\n" : "First\nLast";
  const expected = input.replace_all ? "$&$1\r\n$&$1\n" : "Literal\nLast";
  const f = await setup(t, { fileTool: "Edit", policy: "allow", content });
  f.tool({ path: f.path, ...input }); f.request(); await until(() => f.reply("read"));
  f.writeRequest(expected);
  assert.deepEqual((await f.waitForReply("write")).result, {});
  assert.equal(await readFile(f.path, "utf8"), expected);
  f.finish(); await f.handle.completed;
});

test("Edit rejects an oversized replacement before allocating it without losing the session", async t => {
  const content = "a".repeat(1024 * 1024);
  const f = await setup(t, { fileTool: "Edit", policy: "allow", content });
  f.tool({ path: f.path, old_string: "a", new_string: "z".repeat(1024), replace_all: true });
  f.request(); await until(() => f.reply("read"));
  f.writeRequest("not the permitted transformation");
  const reply = await Promise.race([f.waitForReply("write"), f.handle.completed.catch(error => ({ error }))]);
  assert.equal(reply.id, "write", "Oversized text is a denied operation, not a failed protocol session");
  assert.ok(reply.error);
  assert.equal(await readFile(f.path, "utf8"), content);
  f.finish("failed"); await f.handle.completed;
});

for (const old_string of ["First", "Absent"]) test(`Edit rejects ${old_string === "First" ? "ambiguous" : "missing"} matches`, async t => {
  const f = await setup(t, { fileTool: "Edit", policy: "allow", content: "First\nFirst" });
  f.tool({ path: f.path, old_string, new_string: "Changed" }); f.request(); await until(() => f.reply("read"));
  f.writeRequest("Changed\nFirst");
  assert.ok((await f.waitForReply("write")).error);
  assert.equal(await readFile(f.path, "utf8"), "First\nFirst");
});

test("Kimi host Read asks once, returns actual file text and durably records the read before its reply", async t => {
  const f = await setup(t);
  assert.deepEqual(f.wire[0].params.clientCapabilities.fs, { readTextFile: true, writeTextFile: false });
  f.tool(); f.request();
  const record = await Promise.race([until(() => f.approvals()[0]), f.handle.completed]);
  assert.equal(record.approval.status, "pending");
  assert.equal(record.approval.payload.input.readScope, "whole_file");
  assert.equal(record.correlation.method, "fs/read_text_file");
  assert.equal(f.reply("read"), undefined);
  assert.equal(await readFile(f.path, "utf8"), "First\nSecond\nThird\n");
  f.store.approveApprovalRequest(record.approval.id, {}, now);
  assert.deepEqual((await until(() => f.reply("read"))).result, { content: "First\nSecond\nThird\n" });
  assert.equal(f.approvals().length, 1);
  assert.equal(f.store.getNativeApprovalCorrelation(record.approval.id).replyStatus, "written");
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
});

test("Kimi reuses the exact written native Read approval without asking twice", async t => {
  const f = await setup(t);
  f.tool({ path: f.path, line_offset: -2, n_lines: 1 }); f.permission();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(saved.approval.payload.input.readScope, "whole_file");
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  await until(() => f.reply("permission"));
  f.request();
  assert.deepEqual((await until(() => f.reply("read"))).result, { content: "First\nSecond\nThird\n" });
  assert.equal(f.approvals().length, 1);
  assert.deepEqual(f.waits, [true, false], "reuse must not briefly pretend to wait for another user decision");
  f.finish(); await f.handle.completed;
});

test("changing a native Read input and restoring it cannot reuse the older written approval", async t => {
  const f = await setup(t);
  f.tool(); f.permission();
  const saved = await until(() => f.approvals()[0]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  await until(() => f.reply("permission"));
  for (const input of [{ path: f.path, n_lines: 1 }, { path: f.path }]) {
    f.tool(input, { sessionUpdate: "tool_call_update" });
  }
  f.request();
  const reply = await until(() => f.reply("read"));
  assert.ok(reply.error, "an old same-path approval cannot approve a new revision");
  assert.equal(reply.result, undefined);
  assert.equal(f.approvals().length, 1);
});

for (const policy of ["allow", "deny"]) test(`host Read respects ${policy} without creating a needless approval`, async t => {
  const f = await setup(t, { policy });
  f.tool(); f.request();
  const reply = await until(() => f.reply("read"));
  assert.equal(Boolean(reply.error), policy === "deny");
  assert.equal(reply.result?.content, policy === "allow" ? "First\nSecond\nThird\n" : undefined);
  assert.equal(f.approvals().length, 0);
  assert.deepEqual(f.waits, []);
  f.finish(policy === "deny" ? "failed" : "completed"); await f.handle.completed;
});

test("profile-required approval overrides read allow; denying it discloses no file text", async t => {
  const f = await setup(t, { policy: "allow", actionOptions: { approvalProfile: { requiredForTools: ["read"] } } });
  f.tool(); f.request();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(f.reply("read"), undefined);
  f.store.denyApprovalRequest(saved.approval.id, {}, now);
  const reply = await until(() => f.reply("read"));
  assert.ok(reply.error); assert.equal(reply.result, undefined);
  assert.deepEqual(f.waits, [true, false]);
  f.finish("failed"); await f.handle.completed;
});

test("two simultaneous Read tools for one path cannot share an ambiguous approval", async t => {
  const f = await setup(t, { policy: "allow" });
  f.tool(); f.tool({ path: f.path }, { toolCallId: "2:read" }); f.request();
  assert.ok((await until(() => f.reply("read"))).error);
  assert.equal(f.approvals().length, 0);
});

test("host Read never infers executable input from a title or pending/incomplete tool", async t => {
  const f = await setup(t, { policy: "allow" });
  f.tool({ path: f.path }, { status: "pending", title: "Read" }); f.request();
  assert.ok((await until(() => f.reply("read"))).error);
  assert.equal(f.approvals().length, 0);
});

test("host Read cannot reinterpret unexpected ACP ranges as the pinned whole-text request", async t => {
  const f = await setup(t, { policy: "allow" });
  f.tool(); f.request("read", { line: 1, limit: 1 });
  assert.ok((await until(() => f.reply("read"))).error);
  assert.equal(f.approvals().length, 0);
});

test("a second RPC cannot replay one already consumed tool action", async t => {
  const f = await setup(t, { policy: "allow" });
  f.tool(); f.request();
  assert.equal((await until(() => f.reply("read"))).result.content, "First\nSecond\nThird\n");
  f.request("replay");
  const replay = await until(() => f.reply("replay"));
  assert.ok(replay.error); assert.equal(replay.result, undefined);
});

test("symlink substitution while approval is pending cannot disclose the replacement file", async t => {
  const f = await setup(t);
  f.tool(); f.request();
  const saved = await until(() => f.approvals()[0]);
  const other = join(f.cwd, "other.txt"); await writeFile(other, "Different private text");
  await rename(f.path, join(f.cwd, "original.txt")); await symlink(other, f.path);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  const reply = await until(() => f.reply("read"));
  assert.ok(reply.error); assert.equal(reply.result, undefined);
});

test("hardlinked files are refused even when read policy allows the path", async t => {
  const f = await setup(t, { policy: "allow" });
  await link(f.path, join(f.cwd, "alias.txt"));
  f.tool(); f.request();
  assert.ok((await until(() => f.reply("read"))).error);
  assert.equal(f.approvals().length, 0);
});

for (const [name, content] of [["UTF-16", Buffer.from([0xff, 0xfe, 65, 0])],
  ["invalid UTF-8", Buffer.from([0xc0, 0xaf])], ["binary", Buffer.from([65, 0, 66])],
  ["oversized", Buffer.alloc(4 * 1024 * 1024 + 1, 65)]]) test(`host Read rejects ${name} without a successful content reply`, async t => {
  const f = await setup(t, { policy: "allow", content });
  f.tool(); f.request();
  const reply = await until(() => f.reply("read"));
  assert.ok(reply.error); assert.equal(reply.result, undefined);
  assert.deepEqual(await readFile(f.path), content);
});

for (const content of ["", "\ufeff中文\r\nSecond\r\n", "A".repeat(4 * 1024 * 1024)]) test(`host Read preserves exact UTF-8 text (${Buffer.byteLength(content)} bytes)`, async t => {
  const f = await setup(t, { policy: "allow", content });
  f.tool(); f.request();
  assert.equal((await until(() => f.reply("read"))).result.content, content);
  f.finish(); await f.handle.completed;
});

test("cancelling while waiting for approval leaves no successful host read reply", async t => {
  const f = await setup(t);
  f.tool(); f.request();
  await until(() => f.approvals()[0]);
  f.abort.abort();
  await assert.rejects(f.handle.completed);
  await f.lifecycle.closed;
  assert.equal(f.reply("read")?.result, undefined);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "unknown");
  assert.deepEqual(f.waits, [true, false]);
});

test("legacy whole-path approvals without explicit whole-file scope do not authorize host disclosure", async t => {
  const f = await setup(t);
  f.tool();
  await until(() => f.store.getNativeSubmission(f.key.submissionId).status === "accepted");
  const saved = f.store.createNativeApproval({ ...f.key, requestId: "legacy", method: "session/request_permission",
    approval: { toolCallId: "1:read", actionType: "read", risk: "low", title: "Approve read",
      payload: { type: "tool_call", toolName: "read", cwd: f.cwd, input: { path: f.path } },
      expiresAt: "2026-09-09T06:05:00.000Z" } }, now).approval;
  f.store.approveApprovalRequest(saved.id, {}, now);
  f.store.claimNativeApprovalReply({ approvalId: saved.id, fence: f.key.fence }, now);
  f.store.settleNativeApprovalReply({ approvalId: saved.id, fence: f.key.fence, outcome: "written" }, now);
  f.request();
  const reply = await until(() => f.reply("read"));
  assert.ok(reply.error); assert.equal(reply.result, undefined);
  assert.equal(f.approvals().length, 1, "Do not create a replacement approval for another native owner");
});

test("native approval and host request arriving together share one wait and one decision", async t => {
  const f = await setup(t);
  f.tool(); f.permission(); f.request();
  const saved = await until(() => f.approvals()[0]);
  await until(() => f.waits.length);
  assert.equal(f.approvals().length, 1);
  assert.equal(f.reply("read"), undefined);
  f.store.approveApprovalRequest(saved.approval.id, {}, now);
  assert.equal((await until(() => f.reply("read"))).result.content, "First\nSecond\nThird\n");
  assert.ok(f.wire.indexOf(f.reply("permission")) < f.wire.indexOf(f.reply("read")));
  assert.deepEqual(f.waits, [true, false]);
  f.finish(); await f.handle.completed;
});

test("Plan Mode permits a policy-allowed host Read without enabling file mutation", async t => {
  const f = await setup(t, { policy: "allow", actionOptions: { effectivePolicySnapshot: { conversationMode: "plan" } } });
  f.tool(); f.request();
  assert.equal((await until(() => f.reply("read"))).result.content, "First\nSecond\nThird\n");
  assert.equal(f.approvals().length, 0);
  assert.equal(f.wire[0].params.clientCapabilities.fs.writeTextFile, false);
  f.finish(); await f.handle.completed;
});

for (const kind of ["replacement", "cancelling"]) test(`policy-allowed Read revalidates ${kind} ownership after the effect and before disclosure`, async t => {
  let settled;
  const f = await setup(t, { policy: "allow", closeError: kind === "replacement" ? "native_owner_mismatch" : undefined,
    afterSettlement: ({ store, key, operation }) => {
      settled = operation;
      if (kind === "replacement") store.createWorkUnitAttempt({ workUnitId: key.fence.workUnitId, attemptNumber: 2,
        runnerId: "kimi-acp", runtimeInstanceId: "replacement", now });
      else store.updateWorkUnitAttemptStatus({ ...key.fence, status: "cancelling", now });
    } });
  f.tool(); f.request();
  const outcome = await Promise.race([until(() => f.reply("read")), f.handle.completed.catch(error => ({ error }))]);
  assert.ok(outcome.error, "Lost owner must not receive file text");
  assert.equal(f.reply("read")?.result, undefined);
  assert.equal(settled.status, "succeeded", "A failed disclosure cannot erase the completed read");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.listNativeHostOperations(settled.actionId)[0].status, "succeeded");
    const action = reopened.getNativeHostAction(settled.actionId);
    assert.throws(() => reopened.claimNativeHostOperation({ actionId: action.id, fence: f.key.fence, step: 0,
      requestId: "replay", actionFingerprint: action.actionFingerprint, policyFingerprint: action.policyFingerprint,
      operationFingerprint: "e".repeat(64) }, now));
  } finally { reopened.close(); }
});

test("replacing a parent directory after the effect claim cannot read the external replacement", async t => {
  let change;
  const outcomes = [];
  const f = await setup(t, { policy: "allow", afterClaim: () => change(),
    afterSettlement: ({ operation }) => outcomes.push(operation.status) });
  const parent = join(f.cwd, "source"), outside = await realpath(await mkdtemp(join(tmpdir(), "ling-host-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(parent); await writeFile(join(parent, "note.txt"), "Authorized text");
  await writeFile(join(outside, "note.txt"), "External text must not be read");
  change = () => { renameSync(parent, join(f.cwd, "moved")); symlinkSync(outside, parent); };
  f.tool({ path: join(parent, "note.txt") }); f.request("read", { path: join(parent, "note.txt") });
  const outcome = await Promise.race([until(() => f.reply("read")), f.handle.completed.catch(error => ({ error }))]);
  assert.ok(outcome.error);
  assert.deepEqual(outcomes, ["failed"], "Do not read the outside file and merely suppress its later disclosure");
});
