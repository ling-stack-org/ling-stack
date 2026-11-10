import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CodexLiveClient } from "../dist/runtime/adapters/codex/live-client.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const configuration = { cwd: "/tmp/ling-codex-live-workspace", model: "fixture-model", modelProvider: "fixture-provider",
  approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false },
  baseInstructions: "Owned base context", developerInstructions: "Owned skill and memory context" };
const input = { input: [{ type: "text", text: "A controlled protocol fixture", text_elements: [] }] };

function setup(t, options = {}, scenario = "normal") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/codex-live-peer.mjs", import.meta.url))], {
    env: { LING_CODEX_PEER_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  const requests = [];
  child.on("message", message => requests.push(message));
  child.stderr.resume();
  const controller = new AbortController();
  const events = [];
  const client = new CodexLiveClient({ input: child.stdin, output: child.stdout, signal: controller.signal,
    codexHome: "/tmp/ling-codex-live-home", requestTimeoutMs: 1500,
    onThreadAccepted: async () => {}, onTurnAccepted: async () => {},
    onEvent: async message => { events.push(message); }, onRequest: async () => ({ decision: "decline" }), ...options });
  t.after(async () => { controller.abort(); child.kill(); await closed; });
  return { child, client, requests, events, controller };
}

test("owned stdio peer streams events and approvals only after host binding is accepted", { timeout: 5000 }, async t => {
  const commit = deferred();
  const committing = deferred();
  const decision = deferred();
  const requested = deferred();
  const p = setup(t, { onTurnAccepted: async binding => { committing.resolve(binding); await commit.promise; },
    onRequest: async request => { requested.resolve(request); return decision.promise; } });
  await p.client.initialize();
  const thread = await p.client.openThread(configuration);
  assert.equal(thread.threadId, "thread-1");
  const pending = p.client.startTurn(input);
  const binding = await committing.promise;
  assert.equal(binding.turnId, "turn-1");
  assert.equal(p.events.length, 0);
  commit.resolve();
  const handle = await pending;
  assert.equal((await requested.promise).params.threadId, "thread-1");
  await tick();
  assert.ok(p.events.some(event => event.params.delta === "live before approval"));
  decision.resolve({ decision: "decline" });
  assert.equal((await handle.completed).status, "completed");
  assert.ok(p.events.some(event => event.params.delta === "after decision"));
  const wire = p.requests.find(message => message.method === "thread/start").params;
  assert.equal(wire.baseInstructions, configuration.baseInstructions);
  assert.equal(wire.developerInstructions, configuration.developerInstructions);
  const turn = p.requests.find(message => message.method === "turn/start").params;
  assert.equal(turn.model, configuration.model);
  assert.deepEqual(turn.sandboxPolicy, configuration.sandbox);
  assert.equal(turn.approvalsReviewer, "user");
});

for (const scenario of ["wrong-cwd", "wrong-model", "wrong-provider", "wrong-policy", "wrong-sandbox", "wrong-thread"]) {
  test(`thread resume rejects ${scenario} before any turn is sent`, { timeout: 5000 }, async t => {
    let committed = false;
    const p = setup(t, { onThreadAccepted: async () => { committed = true; } }, scenario);
    await p.client.initialize();
    await assert.rejects(p.client.openThread(configuration, "thread-1"), { code: "binding_mismatch" });
    assert.equal(committed, false);
    assert.equal(p.requests.some(message => message.method === "turn/start"), false);
  });
}

test("thread acceptance binds only the local environment selected by the public response", { timeout: 5000 }, async t => {
  let saved;
  const p = setup(t, { onThreadAccepted: async binding => { saved = binding; } }, "local-environment");
  await p.client.initialize();
  const binding = await p.client.openThread(configuration);
  assert.deepEqual(binding.localEnvironment, { environmentId: "local", cwd: configuration.cwd,
    runtimeWorkspaceRoots: [configuration.cwd] });
  saved.localEnvironment.runtimeWorkspaceRoots.push("/tmp/injected");
  assert.deepEqual(binding.localEnvironment.runtimeWorkspaceRoots, [configuration.cwd]);
});

for (const detail of ["id", "cwd", "cwd-alias", "roots", "roots-alias", "shape", "duplicate", "null"]) {
  test(`untrusted thread environment ${detail} cannot be accepted or submit a turn`, { timeout: 5000 }, async t => {
    let committed = false;
    const p = setup(t, { onThreadAccepted: async () => { committed = true; } }, `wrong-environment-${detail}`);
    await p.client.initialize();
    await assert.rejects(p.client.openThread(configuration), { code: "binding_mismatch" });
    assert.equal(committed, false);
    assert.equal(p.requests.some(message => message.method === "turn/start"), false);
  });
}

test("lost turn response is an uncertain submission and cannot be retried on this client", { timeout: 5000 }, async t => {
  const p = setup(t, {}, "lost-response");
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(p.client.startTurn(input), error => error.code === "submission_uncertain" && error.outcome === "unknown");
  await assert.rejects(p.client.startTurn(input));
  assert.equal(p.requests.filter(message => message.method === "turn/start").length, 1);
});

test("host commit failure never releases stream or approval work", { timeout: 5000 }, async t => {
  let approvals = 0;
  const p = setup(t, { onTurnAccepted: async () => { throw new Error("database private path"); },
    onRequest: async () => { approvals++; return { decision: "accept" }; } });
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(p.client.startTurn(input), { code: "host_commit_failed", outcome: "accepted" });
  await tick();
  assert.equal(p.events.length, 0);
  assert.equal(approvals, 0);
});

test("request preflight failure blocks native approval handling", { timeout: 5000 }, async t => {
  let approvals = 0;
  const p = setup(t, {
    beforeRequest: async () => { throw new Error("credential changed"); },
    onRequest: async () => { approvals++; return { decision: "accept" }; },
  });
  await p.client.initialize();
  await p.client.openThread(configuration);
  const handle = await p.client.startTurn(input);
  await assert.rejects(handle.completed, { code: "host_commit_failed", outcome: "accepted" });
  await tick();
  assert.equal(approvals, 0);
  assert.equal(p.requests.some(message => message.id === "approval-1"), false);
});

test("cancel while host commit is pending cannot return a usable turn", { timeout: 5000 }, async t => {
  const commit = deferred();
  const entering = deferred();
  const p = setup(t, { onTurnAccepted: async () => { entering.resolve(); await commit.promise; } });
  await p.client.initialize();
  await p.client.openThread(configuration);
  const pending = p.client.startTurn(input);
  const rejection = assert.rejects(pending);
  await entering.promise;
  p.controller.abort();
  await rejection;
  commit.resolve();
  await tick();
  assert.equal(p.events.length, 0);
});

test("interrupt targets the accepted turn and suppresses late approval", { timeout: 5000 }, async t => {
  const decision = deferred();
  const requested = deferred();
  let signal;
  const p = setup(t, { onRequest: async (_request, nativeSignal) => { signal = nativeSignal; requested.resolve(); return decision.promise; } });
  await p.client.initialize();
  await p.client.openThread(configuration);
  const handle = await p.client.startTurn(input);
  await requested.promise;
  await handle.interrupt();
  assert.equal((await handle.completed).status, "interrupted");
  assert.equal(signal.aborted, true);
  decision.resolve({ decision: "accept" });
  await tick();
  assert.equal(p.requests.some(message => !message.method && message.id === "approval-1"), false);
});

test("native resolution cancels the matching pending decision", { timeout: 5000 }, async t => {
  const p = setup(t, { onRequest: async (_request, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }) }, "resolved");
  await p.client.initialize();
  await p.client.openThread(configuration);
  const handle = await p.client.startTurn(input);
  assert.equal((await handle.completed).status, "completed");
  assert.equal(p.requests.some(message => !message.method && message.id === "approval-1"), false);
});

for (const scenario of ["cross-thread", "reroute"]) test(`rejects ${scenario} events`, { timeout: 5000 }, async t => {
  const p = setup(t, {}, scenario);
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(async () => { const handle = await p.client.startTurn(input); await handle.completed; });
});

test("ordinary turns continue on the same binding, concurrent and injected overrides are rejected", { timeout: 5000 }, async t => {
  const p = setup(t, {}, "hold");
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(p.client.startTurn({ ...input, model: "injected" }), { code: "invalid_input" });
  const first = await p.client.startTurn(input);
  await assert.rejects(p.client.startTurn(input), { code: "invalid_state" });
  await first.interrupt();
  await first.completed;
  const second = await p.client.startTurn(input);
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.turnId, first.turnId);
  await second.interrupt();
  await second.completed;
  assert.equal(p.requests.filter(message => message.method === "thread/start").length, 1);
});

test("duplicate buffered turn response cannot trigger a late host acceptance callback", { timeout: 5000 }, async t => {
  let commits = 0;
  const p = setup(t, { onTurnAccepted: async () => { commits++; } }, "duplicate-response");
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(p.client.startTurn(input));
  await tick();
  assert.equal(commits, 0);
});

test("thread host commit has a bounded deadline and aborts its callback", { timeout: 1000 }, async t => {
  let signal;
  const p = setup(t, { hostTimeoutMs: 10, onThreadAccepted: async (_binding, hostSignal) => {
    signal = hostSignal;
    await deferred().promise;
  } });
  await p.client.initialize();
  await assert.rejects(p.client.openThread(configuration), { code: "host_commit_failed" });
  assert.equal(signal.aborted, true);
});

test("a failed durable send reservation prevents any native turn request", { timeout: 5000 }, async t => {
  const p = setup(t, { onTurnSubmitting: async () => { throw new Error("reservation rejected"); } });
  await p.client.initialize();
  await p.client.openThread(configuration);
  await assert.rejects(p.client.startTurn(input), { code: "host_commit_failed", outcome: "not_submitted" });
  assert.equal(p.requests.some(message => message.method === "turn/start"), false);
});

test("cancellation during the durable pre-send callback is proven not submitted", { timeout: 5000 }, async t => {
  const entering = deferred();
  const pendingCommit = deferred();
  const p = setup(t, { onTurnSubmitting: async () => { entering.resolve(); await pendingCommit.promise; } });
  await p.client.initialize();
  await p.client.openThread(configuration);
  const pending = p.client.startTurn(input);
  const rejected = assert.rejects(pending, { outcome: "not_submitted" });
  await entering.promise;
  p.controller.abort();
  await rejected;
  pendingCommit.resolve();
  await tick();
  assert.equal(p.requests.some(message => message.method === "turn/start"), false);
});
