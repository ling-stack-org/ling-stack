import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A28_DIRECT_PAUSE_CASE";
const TEAMMATE = "teammate_builtin_engineer";
const NARRATION = "A28 owned private narration before the requested confirmation.";
const FINAL = "A28 actual synthetic completion; no model or external tool was called.";
const FAILURE = "A28_SYNTHETIC_RUNNER_FAILURE";
const cases = {
  "real-index-approval-shutdown": approvalShutdown,
  "real-index-closed-sse-approval-shutdown": f => approvalShutdown(f, true),
  "ordinary-success": f => ordinaryTerminal(f, "success"),
  "ordinary-failure": f => ordinaryTerminal(f, "failure"),
  "ordinary-empty": f => ordinaryTerminal(f, "empty"),
  "ordinary-user-cancel": ordinaryCancellation,
};
const selected = process.env[caseEnv];
if (selected) assert.ok(Object.hasOwn(cases, selected), "only an enumerated owned-child case may execute");
for (const [label, exercise] of Object.entries(cases)) {
  if (!selected || selected === label) {
    test(`A28 private logical pause ${label}`, { timeout: 60_000 }, t => ownedCase(t, label, exercise));
  }
}

/** Never import the daemon, SDK or Core in the parent process with the user's environment. */
async function ownedCase(t, label, exercise) {
  if (selected) {
    const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, cwd]) {
      assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
      assert.equal((await stat(path)).isDirectory(), true);
    }
    assert.equal(dirname(home), dirname(cwd));
    assert.ok(basename(dirname(cwd)).startsWith(`ling-a28-${label}-`));
    assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
    const homeHook = t.mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    let origin, fixture;
    const blockedFetches = [];
    globalThis.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!origin || url.origin !== origin) {
        blockedFetches.push(`${url.origin}${url.pathname}`);
        throw new Error("A28 forbids all non-owned HTTP requests");
      }
      return originalFetch.call(this, input, init);
    };
    try {
      const core = await import("../../core/dist/index.js");
      const { createDaemonServer } = await import("../dist/index.js");
      const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
      fixture = await createFixture({ t, core, createDaemonServer, prepareFixtureTaskInput, cwd,
        setOrigin: value => { origin = value; } });
      await fixture.start();
      console.log(`A28 entered owned real-daemon case: ${label}`);
      await exercise(fixture);
      assert.deepEqual(blockedFetches, [], "Provider, web evidence and other unowned requests must not run");
    } finally {
      await fixture?.stop();
      globalThis.fetch = originalFetch;
      homeHook.mock.restore();
      syncBuiltinESMExports();
    }
    return;
  }
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryRoot, `ling-a28-${label}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: label },
      stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    console.log(`A28 ${label} owned child exit: ${JSON.stringify(exit)}`);
    assert.ok(stdout.includes(`A28 entered owned real-daemon case: ${label}`), "a load error is not behavioral RED");
    assert.equal(exit.signal, null, "the fixture must drain rather than be killed at its timeout");
    assert.equal(exit.code, 0, `the real ${label} integration contract must hold`);
  } finally {
    assert.equal(dirname(root), temporaryRoot);
    assert.ok(basename(root).startsWith(`ling-a28-${label}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/** Host facts remain real; the Runner supplies deterministic narration and approval intent only. */
async function createFixture({ t, core, createDaemonServer, prepareFixtureTaskInput, cwd, setOrigin }) {
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
  await writeFile(join(cwd, "owned-note.txt"), "A28 isolated fixture, not a user file.\n", { flag: "wx" });
  let daemon, store, provider, serial = 0, mode = "success";
  const entered = deferred(), approvalCommitted = deferred(), responseClosed = deferred();
  const calls = [], responseFacts = { closed: false, writesAfterClose: 0, frames: [] };
  const runner = {
    prepareTaskInput: options => prepareFixtureTaskInput(options),
    async runTask(options) {
      calls.push(options);
      entered.resolve(options);
      assert.equal(options.onUserInputRequest, undefined,
        "default private HTTP execution is not an opt-in required-user-input fixture");
      if (mode === "failure") throw new Error(FAILURE);
      if (mode === "empty") return { taskId: options.task.id, events: [], messages: [] };
      if (mode === "cancel") {
        await aborted(options.signal);
        options.signal.throwIfAborted();
        assert.fail("a cancelled Runner must not report success");
      }
      if (mode === "approval") {
        options.onEvent?.({ type: "assistant_text_delta", text: NARRATION });
        await options.onApprovalRequired({ toolCallId: "a28-owned-read", toolName: "read", cwd: options.cwd,
          task: options.task, input: { path: "owned-note.txt" } });
        options.signal.throwIfAborted();
        assert.fail("the shutdown fixture must not execute beyond its unanswered approval");
      }
      options.onEvent?.({ type: "assistant_text_delta", text: FINAL });
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: FINAL }] };
    },
  };
  const f = {
    core, cwd, databasePath, calls, entered, approvalCommitted, responseClosed, responseFacts,
    get store() { return store; },
    get provider() { return provider; },
    setMode(value) { mode = value; },
    async start() {
      assert.equal(daemon, undefined);
      store = undefined;
      daemon = createDaemonServer({
        host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
        channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
        cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
      }, {
        runner, secretResolver,
        externalSecretStore: { ...secretResolver,
          setSecret() { throw new Error("A28 forbids external secret writes"); },
          deleteSecret() { throw new Error("A28 forbids external secret deletes"); } },
        chromeBrowserNativeMessagingEnabled: false,
        storeFactory(storeCwd) {
          assert.equal(resolve(storeCwd), cwd, "only the owned workspace may open");
          assert.equal(store, undefined, "one live SQLite Store per daemon generation");
          store = core.createSqliteRunStore(storeCwd);
          assert.equal(store.paths.databasePath, databasePath);
          if (!provider) {
            const now = new Date().toISOString();
            provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "A28 synthetic only",
              providerId: "a28-fixture", model: "a28-fixture", api: "openai-completions", authHeader: false,
              baseUrl: "https://fixture.invalid/v1", capabilities: ["chat"], input: ["text"], enabled: true,
              contextWindow: 128_000, maxTokens: 4096 }, now);
            store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check",
              message: "A28 synthetic fixture only; no Provider request", checkedAt: now });
            assert.ok(store.updateAiTeammate(TEAMMATE, { providerPresetId: provider.id,
              allowedTools: ["read"], approvalProfile: { mode: "standard", requiredForTools: ["read"] } }, now));
            const direct = store.getOrCreateTeammateDirectThread(TEAMMATE, now);
            store.updateTeammateDirectThreadWorkspace(direct.id, { mode: "local", status: "ready", executionPath: cwd,
              createdAt: now, checkedAt: now, updatedAt: now }, now);
            store.updateApprovalPolicy({ toolDecisions: { read: "ask" } }, now);
          }
          const appendExecutionEvent = store.appendExecutionEvent;
          t.mock.method(store, "appendExecutionEvent", function (...args) {
            const result = Reflect.apply(appendExecutionEvent, this, args);
            if (result.type === "approval_requested") approvalCommitted.resolve(result);
            return result;
          });
          return store;
        },
      });
      daemon.server.prependListener("request", (request, response) => {
        if (!request.url?.startsWith(`/teammates/${TEAMMATE}/direct-messages/stream?`)) return;
        responseFacts.closed = false;
        response.on("close", () => { responseFacts.closed = true; responseClosed.resolve(); });
        const write = response.write;
        response.write = function (...args) {
          if (responseFacts.closed || response.destroyed) responseFacts.writesAfterClose++;
          responseFacts.frames.push(String(args[0]));
          return Reflect.apply(write, this, args);
        };
      });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      f.origin = `http://127.0.0.1:${address.port}`;
      setOrigin(f.origin);
      assert.ok(store);
    },
    async stop() {
      if (!daemon) return;
      const closing = daemon;
      daemon = undefined;
      // This must remain the real index.ts lifecycle, not a synthetic AbortController reason.
      await closing.stop();
    },
    request(path, method = "GET", body) {
      const url = new URL(path, f.origin);
      url.searchParams.set("cwd", cwd);
      return fetch(url, { method, ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), signal: AbortSignal.timeout(15_000) });
    },
    async beginStream() {
      const response = await f.request(`/teammates/${TEAMMATE}/direct-messages/stream`, "POST", {
        body: `A28 private fixture request ${++serial}`, providerPresetId: provider.id,
        requestAiReply: true, permissionPreset: "read_only",
      });
      assert.equal(response.status, 200);
      return consumeSse(response);
    },
    async getMessages() {
      const response = await f.request(`/teammates/${TEAMMATE}/direct-messages`);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    },
    reopen(read) {
      const reopened = core.createSqliteRunStore(cwd);
      try { return read(reopened); } finally { reopened.close(); }
    },
    sql(read) {
      const db = new DatabaseSync(databasePath);
      try { return read(db); } finally { db.close(); }
    },
  };
  return f;
}

async function approvalShutdown(f, closeStreamFirst = false) {
  f.setMode("approval");
  const stream = await f.beginStream();
  const linked = await stream.linked.promise;
  const approvalEvent = await Promise.race([f.approvalCommitted.promise, stream.done.then(result => {
    throw new Error(`A28 stream ended before a durable approval: ${result.text}`);
  })]);
  const runId = linked.data.linkedRunId;
  assert.equal(approvalEvent.runId, runId);
  const before = snapshot(f.store, runId, linked.data.messageId);
  assert.equal(before.run.status, "waiting_for_approval");
  assert.equal(before.approval.status, "pending");
  assert.equal(before.checkpoint.status, "pending");
  assert.equal(before.message.status, "pending");
  assert.equal(before.message.body, NARRATION);
  console.log(`A28 actual committed pre-shutdown approval: ${JSON.stringify({ runId,
    approvalId: before.approval.id, checkpointRevision: before.checkpoint.revision,
    turnId: before.turn.id, workUnitId: before.work.id, attemptId: before.attempt.id })}`);

  if (closeStreamFirst) {
    await stream.cancel();
    await f.responseClosed.promise;
    assert.equal(f.responseFacts.closed, true, "the real HTTP response must close before shutdown settlement");
  }
  await f.stop();
  const streamResult = await stream.done;
  // Observe the real commit after reopening SQLite, not a manually assigned status/error string.
  const after = f.reopen(store => snapshot(store, runId, before.message.id));
  assert.equal(after.run.status, "waiting_for_approval");
  assert.equal(after.approval.id, before.approval.id);
  assert.equal(after.approval.status, "pending");
  assert.equal(after.approval.resolvedBy, undefined);
  assert.equal(after.checkpoint.status, "pending");
  assert.equal(after.checkpoint.revision, before.checkpoint.revision + 1);
  assert.equal(after.checkpoint.resumeBasis.runId, runId);
  assert.equal(after.checkpoint.resumeBasis.toolCallId, "a28-owned-read");
  assert.equal(after.attempt.status, "lost");
  assert.equal(after.attempt.errorCode, "runtime_suspend");
  assert.equal(after.work.status, "waiting_for_approval");
  assert.equal(after.turn.id, before.turn.id);
  assert.equal(after.turn.teammateId, TEAMMATE);
  assert.equal(after.turn.threadId, before.turn.threadId);
  assert.equal(after.message.id, before.message.id);
  assert.equal(after.message.threadId, before.message.threadId);
  assert.equal(after.message.teammateId, TEAMMATE);
  assert.equal(after.message.linkedRunId, runId);
  assert.equal(after.events.some(event => ["run_error", "run_cancelled", "approval_cancelled"].includes(event.type)), false);
  console.log(`A28 actual index runtime_suspend facts: ${JSON.stringify({ runStatus: after.run.status,
    attemptStatus: after.attempt.status, attemptErrorCode: after.attempt.errorCode,
    checkpointRevision: after.checkpoint.revision, messageStatus: after.message.status,
    messageError: after.message.errorMessage, streamError: streamResult.error?.message })}`);

  const row = f.sql(db => db.prepare("SELECT id, thread_id, teammate_id, body, status, error_message, linked_run_id FROM teammate_direct_messages WHERE id = ?").get(before.message.id));
  assert.equal(row.status, "pending", "physical Runner shutdown with a committed logical wait is not a failed private reply");
  assert.equal(row.error_message, null);
  assert.equal(row.body, NARRATION);
  assert.equal(row.linked_run_id, runId);
  assert.doesNotMatch(JSON.stringify(after.message), /Private execution failed\./u);
  assert.equal(f.responseFacts.writesAfterClose, 0);
  assert.equal(streamResult.events.some(event => ["done", "error", "blocked"].includes(event.event)), false,
    "suspension cannot emit either terminal success or terminal error over a private stream");

  const lateOptions = f.calls[0];
  assert.doesNotThrow(() => lateOptions.onEvent({ type: "assistant_text_delta", text: "A28_LATE_OLD_CALLBACK" }));
  assert.deepEqual(f.reopen(store => snapshot(store, runId, before.message.id)), after,
    "the stopped old callback must not mutate durable pause facts or its private message");
  await f.start();
  const projected = await f.getMessages();
  const message = projected.messages.find(item => item.id === before.message.id);
  assert.equal(message?.status, "pending", "the actual GET payload consumed by the UI must preserve waiting");
  assert.equal(message.errorMessage, undefined);
  assert.equal(message.body, NARRATION);
  assert.equal(projected.timeline.turns.find(turn => turn.id === before.turn.id)?.teammateId, TEAMMATE);
  assert.equal(projected.timeline.approvals.find(approval => approval.id === before.approval.id)?.status, "pending");
  assert.equal(f.calls.length, 1, "reopening a waiting private conversation must not dispatch a fresh model Run");
}

async function ordinaryTerminal(f, mode) {
  f.setMode(mode);
  const stream = await f.beginStream();
  const result = await stream.done;
  assert.equal(result.error, undefined);
  const terminal = result.events.findLast(event => ["done", "error", "blocked"].includes(event.event));
  assert.ok(terminal?.data.aiReply, JSON.stringify(result));
  const reply = terminal.data.aiReply;
  const run = f.store.getRun(reply.linkedRunId);
  assert.ok(run);
  assert.equal(f.calls.length, 1);
  if (mode === "success") {
    assert.equal(run.status, "succeeded");
    assert.equal(reply.status, "ready");
    assert.equal(reply.body, FINAL);
    assert.equal(terminal.event, "done");
  } else if (mode === "failure") {
    assert.equal(run.status, "failed");
    assert.equal(reply.status, "failed");
    assert.match(reply.errorMessage, new RegExp(FAILURE));
    assert.equal(terminal.event, "error");
  } else {
    assert.equal(run.status, "succeeded", "a real empty result is not a recoverable pause");
    assert.equal(reply.status, "failed");
    assert.ok(reply.errorMessage?.length > 0);
    assert.notEqual(reply.errorMessage, "Private execution failed.");
    assert.equal(terminal.event, "error");
  }
  const stored = f.store.getTeammateDirectMessage(reply.id);
  assert.equal(stored.status, reply.status);
  assert.equal(stored.body, reply.body);
  assert.equal(stored.linkedRunId, run.id);
  assert.equal(f.responseFacts.writesAfterClose, 0);
}

async function ordinaryCancellation(f) {
  f.setMode("cancel");
  const stream = await f.beginStream();
  const linked = await stream.linked.promise;
  await f.entered.promise;
  const run = f.store.getRun(linked.data.linkedRunId);
  const response = await f.request(`/teammate-direct-replies/${encodeURIComponent(run.workUnitId)}/cancel`, "POST", {});
  const cancellation = await response.json();
  assert.equal(response.status, 200, JSON.stringify(cancellation));
  const result = await stream.done;
  assert.equal(result.error, undefined);
  assert.equal(f.store.getRun(run.id).status, "cancelled");
  const stored = f.store.getTeammateDirectMessage(linked.data.messageId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.linkedRunId, run.id);
  assert.equal(result.events.some(event => event.event === "done"), false);
  assert.doesNotMatch(JSON.stringify(stored), /Private execution failed\./u);
}

function snapshot(store, runId, messageId) {
  const run = store.getRun(runId);
  assert.ok(run);
  const work = store.getWorkUnit(run.workUnitId);
  const approval = store.listApprovalRequests({ runId, status: "pending", limit: 10 })[0];
  assert.ok(approval, "the barrier must follow an actual persisted pending approval");
  return { run, work, approval, checkpoint: store.getApprovalCheckpointForApproval(approval.id),
    attempt: store.getWorkUnitAttempt(work.activeAttemptId), turn: store.getLingTurnForRun(runId),
    message: store.getTeammateDirectMessage(messageId), events: store.listEvents(runId, { limit: 1000 }) };
}

/** A stream ending before run_linked is a fixture error, never an indefinitely pending barrier. */
function consumeSse(response) {
  const linked = deferred();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const done = (async () => {
    let text = "", error;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        text += decoder.decode(part.value, { stream: true });
        const event = parseSse(text).find(item => item.event === "run_linked");
        if (event) linked.resolve(event);
      }
      text += decoder.decode();
    } catch (failure) { error = failure; }
    finally { reader.releaseLock(); }
    const events = parseSse(text);
    if (!events.some(event => event.event === "run_linked")) linked.reject(new Error(`A28 stream never linked a Run: ${text}`));
    return { text, events, error };
  })();
  // Terminal-only cases still observe and settle this rejection without leaking an unhandled Promise.
  linked.promise.catch(() => undefined);
  return { done, linked, cancel: () => reader.cancel() };
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/u).flatMap(frame => {
    const event = /^event: (.+)$/mu.exec(frame)?.[1];
    const data = /^data: (.+)$/mu.exec(frame)?.[1];
    if (!event || !data) return [];
    try { return [{ event, data: JSON.parse(data) }]; } catch { return []; }
  });
}

function aborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolveAbort => signal.addEventListener("abort", resolveAbort, { once: true }));
}

function deferred() {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
