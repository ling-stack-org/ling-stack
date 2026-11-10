import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { decodePng, assertPixelsClose } from "./support/native-image-fixtures.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, projectRunEventsToConversationItems } from "../../core/dist/index.js";
import { CodexJournaledLifecycle, codexConfigurationFingerprint } from "../dist/runtime/adapters/codex/journaled-lifecycle.js";
import { codexPermissionResponse } from "../dist/runtime/adapters/codex/permission-preparation.js";
import { syncWorkUnitForRunEvent } from "../dist/features/runs/work-units.js";
import { syncLingThreadForRunEvent } from "../dist/features/runs/threads.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { handleGetArtifactContent, handleGetArtifactPreview } from "../dist/features/runs/routes.js";

const now = "2026-09-08T12:00:00.000Z";
const input = { input: [{ type: "text", text: "Owned protocol fixture", text_elements: [] }] };
const approvalData = { actionType: "bash", risk: "low", toolCallId: "item-2", title: "Owned approval",
  description: "Owned protocol fixture", payload: { type: "bash", command: "whois example.com", cwd: "/tmp", riskFlags: [] } };

async function setup(t, scenario = "normal", overrides = {}, policyOverrides = {}, approvalWait, output) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-codex-journal-"));
  const registry = new RunStoreRegistry(createSqliteRunStore);
  const store = registry.getStore(cwd);
  let child;
  let closed;
  const abort = new AbortController();
  t.after(async () => { abort.abort(); if (child) { child.kill(); await closed; } store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Native test", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Native test", prompt: "Test" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Native test", objective: "Test" }, now);
  const run = store.createRun({ id: "run_native", cwd, taskId: task.id, threadId: thread.id, channelId: channel.id,
    providerName: "native", providerModel: "fixture-model", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_native", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: run.id, linkedRunId: run.id, runnerId: "codex-app-server", idempotencyKey: "native-first",
    createdByActor: "user", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: "codex-app-server", runtimeInstanceId: "runtime_native", now });
  store.linkRunToWorkUnit(run.id, work.id, now);
  const configuration = { cwd, model: "fixture-model", modelProvider: "fixture-provider", approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false } };
  const fence = toRuntimeAttemptFence(attempt);
  if (approvalWait) {
    store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "system", now });
    for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now });
    store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now });
    store.updateLingThread(thread.id, { status: "running", activeRunId: run.id, lastRunId: run.id }, now);
  }
  const reservation = store.reserveNativeExecution({ runId: run.id, generation: 1, fence,
    selection: { engineId: "codex-app-server", profileId: "profile_test", profileRevision: 1,
      profileFingerprint: "a".repeat(64), modelId: configuration.model, configurationFingerprint: codexConfigurationFingerprint(configuration) } }, now);
  child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/codex-live-peer.mjs", import.meta.url))], {
    env: { LING_CODEX_PEER_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  closed = once(child, "close");
  child.stderr.resume();
  const requests = [];
  child.on("message", message => requests.push(message));
  const options = { store, key: { submissionId: reservation.submission.id, fence }, configuration, now: approvalWait?.now ?? (() => now),
    ...(approvalWait ? { approvalWait } : {}),
    ...(output ? { output } : {}),
    approvalPolicy: { policy: { toolDecisions: { bash: "ask", write: "ask", edit: "ask" }, allowedWritePaths: [cwd] }, ...policyOverrides },
    client: { input: child.stdin, output: child.stdout, signal: abort.signal, codexHome: "/tmp/ling-codex-live-home",
      requestTimeoutMs: 1500, onEvent: async () => {}, onRequest: async () => ({ decision: "decline" }), ...overrides } };
  const lifecycle = new CodexJournaledLifecycle(options);
  return { cwd, store, registry, reservation, fence, lifecycle, requests, abort, options, child };
}

for (const large of [false, true]) test(`owned native PNG reaches conversation and verified HTTP endpoints (large=${large})`, { timeout: 8000 }, async t => {
  const output = [];
  const f = await setup(t, large ? "image-output-large" : "image-output", {}, {}, undefined, { requireAssistantText: true, onEvent: event => output.push(event) });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  const [artifact] = f.store.listArtifacts("run_native");
  assert.ok(artifact);
  assert.deepEqual(f.store.listEvents("run_native").map(event => event.id), output.map(event => event.id));
  assert.deepEqual(output.map(event => event.data.nativeOutput.sequence), output.map((_, index) => index + 1));
  assert.equal(output.filter(event => event.type === "artifact_created").length, 1);
  const run = f.store.getRun("run_native");
  const projection = projectRunEventsToConversationItems({ run, events: output,
    turn: { id: "turn-projection", threadId: run.threadId, workspaceId: DEFAULT_WORKSPACE_ID, updatedAt: now } });
  assert.equal(projection.find(item => item.kind === "artifact_ref").payload.artifactId, artifact.id);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    (url.pathname.endsWith("preview") ? handleGetArtifactPreview : handleGetArtifactContent)(response, url, f.registry, artifact.id);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const artifactUrl = endpoint => `${base}/${endpoint}?cwd=${encodeURIComponent(f.cwd)}`;
  const response = await fetch(artifactUrl("content"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const content = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(content, await readFile(artifact.path));
  const decoded = decodePng(content);
  assert.equal(decoded.width, large ? 768 : 3);
  assert.equal(decoded.height, large ? 512 : 2);
  if (large) assert.ok(content.length > 1024 * 1024);
  assertPixelsClose(decoded.data.subarray(0, 4), [224, 59, 82, 255], 1, "sRGB reference");
  assert.equal((await (await fetch(artifactUrl("preview"))).json()).kind, "image");
  await writeFile(artifact.path, "modified-owned-file");
  assert.equal((await fetch(artifactUrl("content"))).status, 404);
  const outside = join(f.cwd, "untrusted.txt");
  await writeFile(outside, "outside-secret");
  await unlink(artifact.path);
  await symlink(outside, artifact.path);
  for (const endpoint of ["content", "preview"]) {
    const rejected = await fetch(artifactUrl(endpoint));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.text()).includes("outside-secret"), false);
  }
});

test("an invalid terminal image preserves native completion but never publishes corrupt output", { timeout: 5000 }, async t => {
  const f = await setup(t, "image-terminal-invalid", {}, {}, undefined, { requireAssistantText: true, onEvent: () => {} });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
  assert.deepEqual(f.store.listArtifacts("run_native"), []);
  assert.equal(f.store.listEvents("run_native").some(event => ["tool_end", "message_end", "artifact_created"].includes(event.type)), false);
});

async function peerReply(f, id) {
  const signal = AbortSignal.timeout(1000);
  while (!f.requests.some(message => message.id === id)) await once(f.child, "message", { signal });
  return f.requests.find(message => message.id === id);
}

test("native output reaches durable run events and existing conversation projection before completion", { timeout: 5000 }, async t => {
  const output = [];
  const live = Promise.withResolvers();
  const f = await setup(t, "hold", {}, {}, undefined, { requireAssistantText: true, onEvent: event => {
    output.push(event);
    if (event.type === "assistant_text_delta") live.resolve();
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await live.promise;
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "accepted");
  assert.ok(f.store.listEvents("run_native").some(event => event.type === "assistant_text_delta"));
  await handle.interrupt();
  await handle.completed;
  const events = f.store.listEvents("run_native");
  assert.deepEqual(events.map(event => event.id), output.map(event => event.id));
  assert.equal(events.find(event => event.type === "message_end").data.text, "live before approval");
  const run = f.store.getRun("run_native");
  const projection = projectRunEventsToConversationItems({ run, events,
    turn: { id: "turn-projection", threadId: run.threadId, workspaceId: DEFAULT_WORKSPACE_ID, updatedAt: now } });
  assert.equal(projection.find(item => item.kind === "assistant_message").payload.body, "live before approval");
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "cancelled");
});

test("owned native tool and text events retain identity through persisted projection", { timeout: 5000 }, async t => {
  const output = [];
  const f = await setup(t, "output-events", {}, {}, undefined, { requireAssistantText: true, extraSecrets: ["owned secret"],
    onEvent: event => output.push(event) });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await handle.completed;
  const events = f.store.listEvents("run_native");
  const final = events.filter(event => event.type === "message_end");
  assert.equal(final.length, 1);
  assert.equal(final[0].data.text, "answer [REDACTED] done ");
  assert.equal(events.filter(event => event.type === "tool_start").length, 1);
  assert.equal(events.find(event => event.type === "tool_end").data.toolCallId, "tool-output-1");
  assert.equal(events.find(event => event.type === "tool_end").data.result.content[0].text, "owned output ");
  assert.equal(events.filter(event => event.type === "assistant_thinking_delta").map(event => event.data.text).join(""), "first step\nsecond [REDACTED] step");
  assert.equal(JSON.stringify(output).includes("owned secret"), false);
  assert.deepEqual(events.map(event => event.id), output.map(event => event.id));
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
});

test("known native completion stays recorded when the output consumer rejects", { timeout: 5000 }, async t => {
  const f = await setup(t, "output-events", {}, {}, undefined, { requireAssistantText: true, onEvent: event => {
    if (event.type === "message_end") throw new Error("owned_output_sink_failure");
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
  assert.equal(f.store.listEvents("run_native").filter(event => event.type === "message_end").length, 1);
});

test("owned native rich content persists translated resources and tool evidence without private metadata", { timeout: 5000 }, async t => {
  const output = [];
  const f = await setup(t, "rich-output", {}, {}, undefined, { requireAssistantText: false, onEvent: event => output.push(event) });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  const events = f.store.listEvents("run_native");
  assert.deepEqual(events.map(event => event.id), output.map(event => event.id));
  const results = events.filter(event => event.type === "tool_end").map(event => event.data);
  assert.deepEqual(results.map(result => result.toolName), ["lookup", "mcp:owned/read", "web_search", "view_image", "clock.sleep", "codex.spawnAgent"]);
  assert.deepEqual(results[0].result.content[0], { type: "text", text: "rich output" });
  assert.equal(results[1].result.content[0].type, "resource_link");
  assert.equal(results[2].result.query, "Ling");
  assert.equal(results[5].result.agentsStates.child.status, "errored");
  assert.equal(events.filter(event => event.type === "progress" && event.data.nativeKind === "subagent_activity").length, 1);
  assert.equal(events.find(event => event.type === "progress" && event.data.nativeKind === "function_output").data.opaqueContentCount, 1);
  assert.equal(JSON.stringify(events).includes("private fixture metadata"), false);
  assert.equal(events.filter(event => event.type === "artifact_created").length, 2);
  assert.equal(f.store.listArtifacts("run_native").length, 2);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
});

test("empty native chat completion is not reported as successful output", { timeout: 5000 }, async t => {
  const f = await setup(t, "empty-output", {}, {}, undefined, { requireAssistantText: true, onEvent: () => {} });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
  assert.equal(f.store.listEvents("run_native").some(event => event.type === "message_end"), false);
});

for (const scenario of ["local-environment", "file-local-environment"]) test(`accepted ${scenario} reaches the durable native one-time approval path`, { timeout: 5000 }, async t => {
  let f;
  const events = [];
  f = await setup(t, scenario, {}, {}, { pollIntervalMs: 10, onEvent: event => {
    events.push(event.type);
    if (event.type === "approval_requested") f.store.approveApprovalRequest(event.data.approvalId, {}, now);
  } });
  await f.lifecycle.open();
  assert.equal((await (await f.lifecycle.startTurn(input)).completed).status, "completed");
  assert.deepEqual(events, ["approval_requested", "approval_approved"]);
  assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: "accept" });
  const [approval] = f.store.listApprovalRequests();
  assert.equal(approval.status, "approved");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

for (const scenario of ["local-environment-foreign-request", "local-environment-expanded-command"]) {
  test(`local environment does not authorize ${scenario}`, { timeout: 5000 }, async t => {
    const events = [];
    const f = await setup(t, scenario, {}, {}, { pollIntervalMs: 10, onEvent: event => events.push(event.type) });
    await f.lifecycle.open();
    await (await f.lifecycle.startTurn(input)).completed;
    assert.deepEqual(events, []);
    assert.deepEqual(f.store.listApprovalRequests(), []);
    assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: "cancel" });
  });
}

test("normalized output and native approvals share ordered durable events while human waiting continues", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const streamed = Promise.withResolvers();
  const f = await setup(t, "normal", {}, {}, { pollIntervalMs: 10, onEvent: event => {
    if (event.type === "approval_requested") requested.resolve(event.data.approvalId);
  } }, { requireAssistantText: true, onEvent: event => {
    if (event.type === "assistant_text_delta" && event.data.text.includes("human")) streamed.resolve();
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  const approvalId = await requested.promise;
  f.child.send({ kind: "stream-during-approval" });
  await streamed.promise;
  assert.equal(f.store.getRun("run_native").status, "waiting_for_approval");
  f.store.approveApprovalRequest(approvalId, {}, now);
  await handle.completed;
  const events = f.store.listEvents("run_native");
  assert.equal(events.filter(event => event.type === "approval_approved").length, 1);
  assert.equal(events.filter(event => event.type === "message_end").length, 1);
  const native = events.filter(event => event.data.nativeOutput);
  assert.deepEqual(native.map(event => event.data.nativeOutput.sequence), native.map((_, index) => index + 1));
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
});

test("replaced Attempt cannot publish late normalized output", { timeout: 5000 }, async t => {
  const live = Promise.withResolvers();
  const f = await setup(t, "hold", {}, {}, undefined, { requireAssistantText: true, onEvent: event => {
    if (event.type === "assistant_text_delta") live.resolve();
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await live.promise;
  const before = f.store.listEvents("run_native");
  f.store.createWorkUnitAttempt({ workUnitId: f.fence.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "codex-app-server", now });
  f.child.send({ kind: "stream-during-approval" });
  await assert.rejects(handle.completed);
  assert.deepEqual(f.store.listEvents("run_native"), before);
});

test("native approval waiter streams during a decision and continues after an explicit denial", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const streamed = Promise.withResolvers();
  let f;
  const events = [];
  const waits = [];
  f = await setup(t, "normal", { onEvent: async event => {
    if (event.params?.delta === "stream while human waits") streamed.resolve();
  } }, {}, { pollIntervalMs: 10, onWaitChanged: value => waits.push(value), onEvent: event => {
    events.push(event);
    if (event.type === "approval_requested") requested.resolve(event.data.approvalId);
    // Exercise the existing event consumers, not a separate native-only UI projection.
    syncWorkUnitForRunEvent(f.store, f.fence.workUnitId, f.fence.attemptId, event.type, event);
    syncLingThreadForRunEvent(f.store, f.store.getRun("run_native"), event.type, event);
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  const approvalId = await requested.promise;
  assert.equal(f.store.getRun("run_native").status, "waiting_for_approval");
  f.child.send({ kind: "stream-during-approval" });
  await streamed.promise;
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  f.store.denyApprovalRequest(approvalId, {}, now);
  assert.equal((await handle.completed).status, "completed");
  assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: "decline" });
  assert.equal(f.store.getRun("run_native").status, "running");
  assert.equal(f.store.getWorkUnit(f.fence.workUnitId).status, "running");
  assert.equal(f.store.getLingThread(f.reservation.binding.threadId).status, "running");
  assert.deepEqual(waits, [true, false]);
  assert.deepEqual(events.map(event => event.type), ["approval_requested", "approval_denied"]);
});

test("native waiter preserves exact explicit turn consent and streams each saved event once", { timeout: 5000 }, async t => {
  let f;
  const events = [];
  f = await setup(t, "permissions", {}, {}, { pollIntervalMs: 10, onEvent: event => {
    events.push(event);
    if (event.type === "approval_requested") f.store.approveApprovalRequest(event.data.approvalId,
      { decisionKind: "approve_permission_scope" }, now);
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.deepEqual((await peerReply(f, "approval-1")).result, { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.equal(events.find(event => event.type === "approval_approved").data.decisionKind, "approve_permission_scope");
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
});

test("native waiter uses stored expiry and does not grant or send a late decision", { timeout: 5000 }, async t => {
  let clock = now;
  let approvalId;
  const waits = [];
  const f = await setup(t, "normal", {}, {}, { pollIntervalMs: 10, now: () => clock,
    onWaitChanged: value => waits.push(value), onEvent: event => {
      if (event.type === "approval_requested") { approvalId = event.data.approvalId; clock = "2026-09-08T12:05:00.000Z"; }
    } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.equal(f.store.getApprovalRequest(approvalId).status, "expired");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  assert.deepEqual(waits, [true, false]);
});

test("native resolution cancels the waiter and retires its displayed request without a reply", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const waitEnded = Promise.withResolvers();
  const waits = [];
  const f = await setup(t, "normal", {}, {}, { pollIntervalMs: 10, onWaitChanged: value => {
    waits.push(value);
    if (!value) waitEnded.resolve();
  },
    onEvent: event => {
      if (event.type === "approval_requested") requested.resolve(event.data.approvalId);
      if (event.type === "approval_cancelled") cancelled.resolve();
    } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  const id = await requested.promise;
  f.child.send({ kind: "resolve-approval" });
  await cancelled.promise;
  await waitEnded.promise;
  assert.equal(f.store.getApprovalRequest(id).status, "cancelled");
  assert.equal(f.store.getRun("run_native").status, "running");
  assert.deepEqual(waits, [true, false]);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  await handle.interrupt();
  await handle.completed;
});

test("two native requests hold one wait budget until both decisions arrive", { timeout: 5000 }, async t => {
  const bothRequested = Promise.withResolvers();
  const ids = [];
  const waits = [];
  let f;
  f = await setup(t, "two-approvals", {}, {}, { pollIntervalMs: 10,
    onWaitChanged: waiting => waits.push(waiting), onEvent: event => {
      syncWorkUnitForRunEvent(f.store, f.fence.workUnitId, f.fence.attemptId, event.type, event);
      syncLingThreadForRunEvent(f.store, f.store.getRun("run_native"), event.type, event);
      if (event.type === "approval_requested") ids.push(event.data.approvalId);
      if (ids.length === 2) bothRequested.resolve();
    } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await bothRequested.promise;
  const first = ids.find(id => f.store.getNativeApprovalCorrelation(id).requestId === "approval-1");
  const second = ids.find(id => id !== first);
  f.store.approveApprovalRequest(first, {}, now);
  await peerReply(f, "approval-1");
  assert.deepEqual(waits, [true]);
  assert.equal(f.store.getRun("run_native").status, "waiting_for_approval");
  f.store.denyApprovalRequest(second, {}, now);
  await handle.completed;
  assert.deepEqual((await peerReply(f, "approval-extra")).result, { decision: "decline" });
  assert.deepEqual(waits, [true, false]);
  assert.equal(f.store.getRun("run_native").status, "running");
});

test("native cancellation while waiting sends no response and publishes no late event", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const ended = Promise.withResolvers();
  const events = [];
  const f = await setup(t, "normal", {}, {}, { pollIntervalMs: 1000,
    onWaitChanged: waiting => { if (!waiting) ended.resolve(); }, onEvent: event => {
      events.push(event);
      if (event.type === "approval_requested") requested.resolve(event.data.approvalId);
    } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  const id = await requested.promise;
  f.abort.abort();
  await assert.rejects(handle.completed);
  await ended.promise;
  assert.equal(f.store.getApprovalRequest(id).status, "cancelled");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  assert.deepEqual(events.map(event => event.type), ["approval_requested"]);
});

test("waiting on a replacement Attempt cannot publish a grant or resume the replacement", { timeout: 5000 }, async t => {
  let f;
  const events = [];
  f = await setup(t, "normal", {}, {}, { pollIntervalMs: 10, onEvent: event => {
    events.push(event);
    if (event.type === "approval_requested") {
      f.store.approveApprovalRequest(event.data.approvalId, {}, now);
      f.store.createWorkUnitAttempt({ workUnitId: f.fence.workUnitId, attemptNumber: 2,
        runnerId: "codex-app-server", runtimeInstanceId: "replacement", now });
    }
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.deepEqual(events.map(event => event.type), ["approval_requested"]);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  const work = f.store.getWorkUnit(f.fence.workUnitId);
  assert.equal(f.store.getWorkUnitAttempt(work.activeAttemptId).status, "created");
});

test("a human approval wait pauses the native turn timeout budget", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const f = await setup(t, "normal", { turnTimeoutMs: 250 }, {}, { pollIntervalMs: 10, onEvent: event => {
    if (event.type === "approval_requested") requested.resolve(event.data.approvalId);
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  const id = await requested.promise;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.store.getApprovalRequest(id).status, "pending");
  f.store.approveApprovalRequest(id, {}, now);
  assert.equal((await handle.completed).status, "completed");
});

test("native approval waiting preserves the separate application user-input handler", { timeout: 5000 }, async t => {
  let asked = false;
  const result = { answers: { q1: { answers: ["Continue"] } } };
  const f = await setup(t, "user-input", { onRequest: async request => {
    assert.equal(request.method, "item/tool/requestUserInput");
    asked = true;
    return result;
  } }, {}, { onEvent: () => { throw new Error("A question is not an approval"); } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.equal(asked, true);
  assert.deepEqual((await peerReply(f, "approval-1")).result, result);
  assert.deepEqual(f.store.listApprovalRequests(), []);
});

test("journal prepares the approval from native command data without a caller-authored payload", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval, prepared) => {
    assert.equal(prepared.kind, "action");
    assert.equal(prepared.policyDecision.decision, "ask");
    approval = createApproval();
    assert.deepEqual(approval.payload, { type: "bash", cwd: f.cwd, command: "whois example.com", riskFlags: [] });
    f.store.approveApprovalRequest(approval.id, {}, now);
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
  assert.equal(f.requests.find(message => message.method === "initialize").params.capabilities.experimentalApi, true);
});

test("journal rejects a caller-supplied replacement command before persistence", { timeout: 5000 }, async t => {
  let attempted = false;
  const f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval) => {
    attempted = true;
    createApproval(approvalData);
    return { decision: "decline" };
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.equal(attempted, true);
  assert.deepEqual(f.store.listApprovalRequests(), []);
});

test("journal prepares file approval before a blocked application observer drains", { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers();
  let f;
  let approval;
  let observedFile = false;
  f = await setup(t, "file", {
    onEvent: async event => {
      if (event.method === "item/agentMessage/delta") await gate.promise;
      if (event.method === "item/started") observedFile = true;
    },
    onRequest: async (_request, _signal, createApproval) => {
      assert.equal(observedFile, false);
      approval = createApproval();
      assert.deepEqual(approval.payload.touchedPaths, ["owned-fixture.txt"]);
      assert.match(approval.payload.diffPreview, /-before\n\+after/);
      f.store.approveApprovalRequest(approval.id, {}, now);
      gate.resolve();
      return { decision: "accept" };
    },
  });
  t.after(() => gate.resolve());
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.equal(observedFile, true);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

for (const scenario of ["wrapped-plan", "native-no-accept", "file-move-outside"]) {
  test(`journal policy prevents an approved record granting ${scenario}`, { timeout: 5000 }, async t => {
    let f;
    let approval;
    f = await setup(t, scenario, { onRequest: async (_request, _signal, createApproval, prepared) => {
      assert.equal(prepared.kind, "action");
      assert.equal(prepared.policyDecision.decision, "deny");
      approval = createApproval();
      f.store.approveApprovalRequest(approval.id, {}, now);
      return { decision: "accept" };
    } }, scenario === "wrapped-plan" ? { effectivePolicySnapshot: { conversationMode: "plan" } } : {});
    await f.lifecycle.open();
    await assert.rejects((await f.lifecycle.startTurn(input)).completed);
    assert.ok(approval);
    assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  });
}

for (const scenario of ["file-missing", "file-completed", "command-permissions"]) {
  test(`journal refuses once mapping for ${scenario}`, { timeout: 5000 }, async t => {
    const f = await setup(t, scenario, { onRequest: async (_request, _signal, createApproval, prepared) => {
      assert.equal(prepared.kind, "unsupported");
      assert.throws(() => createApproval());
      return { decision: "decline" };
    } });
    await f.lifecycle.open();
    await (await f.lifecycle.startTurn(input)).completed;
    assert.deepEqual(f.store.listApprovalRequests(), []);
  });
}

test("native client persists session and turn before dispatching events and releases only on terminal", { timeout: 5000 }, async t => {
  let f;
  const observations = [];
  f = await setup(t, "normal", { onEvent: async event => {
    observations.push({ method: event.method, state: f.store.getNativeSubmission(f.reservation.submission.id).status });
  } });
  await f.lifecycle.open();
  assert.equal(f.store.getNativeExecutionBinding(f.reservation.binding.id).nativeSessionId, "thread-1");
  const handle = await f.lifecycle.startTurn(input);
  assert.equal((await handle.completed).status, "completed");
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).nativeTurnId, "turn-1");
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "completed");
  assert.ok(observations.some(event => event.method === "turn/started" && event.state === "accepted"));
  assert.ok(observations.some(event => event.method === "turn/completed" && event.state === "completed"));
  await assert.rejects(f.lifecycle.startTurn(input));
});

test("lost native response leaves a durable unknown submission, never a second turn", { timeout: 5000 }, async t => {
  const f = await setup(t, "lost-response");
  await f.lifecycle.open();
  await assert.rejects(f.lifecycle.startTurn(input), { outcome: "unknown" });
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "unknown");
  await assert.rejects(f.lifecycle.startTurn(input));
  assert.equal(f.requests.filter(message => message.method === "turn/start").length, 1);
});

test("failed thread validation releases only an unsent reservation", { timeout: 5000 }, async t => {
  const f = await setup(t, "wrong-cwd");
  await assert.rejects(f.lifecycle.open(), { code: "binding_mismatch" });
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "not_submitted");
  assert.equal(f.requests.some(message => message.method === "turn/start"), false);
});

test("database rejection of the send permit prevents native submission", { timeout: 5000 }, async t => {
  const f = await setup(t, "hold");
  await f.lifecycle.open();
  f.store.createWorkUnitAttempt({ workUnitId: f.fence.workUnitId, attemptNumber: 2, runnerId: "codex-app-server", runtimeInstanceId: "new_runtime", now });
  await assert.rejects(f.lifecycle.startTurn(input));
  assert.equal(f.requests.some(message => message.method === "turn/start"), false);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "reserved");
});

test("accepted turn interrupted during cancellation persists native terminal evidence", { timeout: 5000 }, async t => {
  const f = await setup(t, "hold");
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  f.store.updateWorkUnitAttemptStatus({ ...f.fence, status: "cancelling", now });
  await handle.interrupt();
  assert.equal((await handle.completed).status, "interrupted");
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "cancelled");
});

test("journaled lifecycle cannot reopen an existing send claim or change its configuration", { timeout: 5000 }, async t => {
  const f = await setup(t, "hold");
  assert.throws(() => new CodexJournaledLifecycle({ ...f.options, configuration: { ...f.options.configuration, model: "injected" } }), { code: "binding_mismatch" });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  assert.throws(() => new CodexJournaledLifecycle(f.options), { code: "invalid_state" });
  await handle.interrupt();
  await handle.completed;
});

for (const decision of ["approve", "deny"]) test(`journaled ${decision} sends the exact stored decision and persists delivery before terminal`, { timeout: 5000 }, async t => {
  let f;
  let approval;
  const observed = [];
  f = await setup(t, "normal", {
    onRequest: async (_request, _signal, createApproval) => {
      approval = createApproval();
      f.store[decision === "approve" ? "approveApprovalRequest" : "denyApprovalRequest"](approval.id, {}, now);
      assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
      return { decision: decision === "approve" ? "accept" : "decline" };
    },
    onReplyOutcome: observation => {
      observed.push({ ...observation, stored: f.store.getNativeApprovalCorrelation(approval.id).replyStatus });
    },
  });
  // stdout completion and IPC evidence use independent pipes; await each owned channel.
  const replyReceived = new Promise(resolve => {
    const listener = message => { if (message.id === "approval-1") { f.child.off("message", listener); resolve(message); } };
    f.child.on("message", listener);
    t.after(() => f.child.off("message", listener));
  });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await handle.completed;
  assert.equal(f.store.getApprovalRequest(approval.id).status, decision === "approve" ? "approved" : "denied");
  assert.deepEqual(observed, [{ requestId: "approval-1", method: "item/commandExecution/requestApproval", outcome: "written", stored: "written" }]);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).resolvedAt, now);
  assert.deepEqual((await replyReceived).result,
    { decision: decision === "approve" ? "accept" : "decline" });
  assert.throws(() => f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: f.fence }, now));
});

test("native resolution retires the pending Ling approval without waiting for its UI callback", { timeout: 5000 }, async t => {
  let f;
  let approval;
  const created = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const resolved = Promise.withResolvers();
  f = await setup(t, "normal", {
    onRequest: async (_request, _signal, createApproval) => {
      approval = createApproval();
      created.resolve();
      return answer.promise;
    },
    onEvent: async event => { if (event.method === "serverRequest/resolved") resolved.resolve(); },
  });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await Promise.race([created.promise, handle.completed]);
  assert.ok(approval, "scoped approval creation must run");
  f.child.send({ kind: "resolve-approval" });
  await resolved.promise;
  assert.equal(f.store.getApprovalRequest(approval.id).status, "cancelled");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
  answer.resolve({ decision: "accept" });
  await handle.interrupt();
  await handle.completed;
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("a native grant without a registered Ling decision cannot leave the process", { timeout: 5000 }, async t => {
  const f = await setup(t, "normal", { onRequest: async () => ({ decision: "accept" }) });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await assert.rejects(handle.completed);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  assert.equal(f.store.getNativeSubmission(f.reservation.submission.id).status, "unknown");
});

for (const reply of [{ decision: "accept" }, { decision: "acceptForSession" }, { decision: "decline", extra: "not-on-the-wire" }]) {
  test(`mismatched or expanded reply is rejected: ${JSON.stringify(reply)}`, { timeout: 5000 }, async t => {
    let f;
    let approval;
    f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval) => {
      approval = createApproval();
      f.store.denyApprovalRequest(approval.id, {}, now);
      return reply;
    } });
    await f.lifecycle.open();
    const handle = await f.lifecycle.startTurn(input);
    await assert.rejects(handle.completed);
    assert.ok(approval);
    assert.equal(f.store.getApprovalRequest(approval.id).status, "denied");
    assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
    assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  });
}

test("expired approval is never written even if the user decision was saved", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval({ expiresAt: now });
    f.store.approveApprovalRequest(approval.id, {}, now);
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await assert.rejects(handle.completed);
  assert.ok(approval);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("Attempt replacement after the user decides cannot grant from an old native callback", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, {}, now);
    f.store.createWorkUnitAttempt({ workUnitId: f.fence.workUnitId, attemptNumber: 2,
      runnerId: "codex-app-server", runtimeInstanceId: "replacement", now });
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await assert.rejects(handle.completed);
  assert.ok(approval);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
});

test("in-flight approval cancellation stays unknown in SQLite after the write callback settles", { timeout: 5000 }, async t => {
  let f;
  let approval;
  let complete;
  const invoked = Promise.withResolvers();
  const proxy = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(String(chunk));
    if (message.id === "approval-1") { complete = callback; invoked.resolve(); }
    else f.child.stdin.write(chunk, callback);
  } });
  t.after(() => proxy.destroy());
  f = await setup(t, "normal", { input: proxy, onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, {}, now);
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await Promise.race([invoked.promise, handle.completed]);
  assert.ok(approval);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "claimed");
  f.abort.abort();
  await assert.rejects(handle.completed);
  assert.equal(f.store.getApprovalRequest(approval.id).status, "approved");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "unknown");
  complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "unknown");
});

test("file reply uses canonical item context, without inventing paths from the native callback", { timeout: 5000 }, async t => {
  let f;
  let approval;
  const payload = { type: "file_edit", path: "owned-fixture.txt", touchedPaths: ["owned-fixture.txt"],
    diffPreview: "update: owned-fixture.txt\n-before\n+after" };
  f = await setup(t, "file", { onRequest: async (request, _signal, createApproval) => {
    assert.equal(request.method, "item/fileChange/requestApproval");
    assert.equal(request.params.changes, undefined);
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, {}, now);
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await handle.completed;
  assert.deepEqual(f.store.getApprovalRequest(approval.id).payload, payload);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

const originalPatch = [{ path: "owned-fixture.txt", kind: { type: "update", move_path: null }, diff: "-before\n+after" }];
const changedPatch = [{ path: "changed-fixture.txt", kind: { type: "add" }, diff: "+new\n" }];

test("native streaming patch input uses the finalized item, not partial preview text", { timeout: 5000 }, async t => {
  let f;
  let saved;
  f = await setup(t, "file-stream", { onRequest: async (_request, _signal, createApproval) => {
    saved = createApproval();
    f.store.approveApprovalRequest(saved.id, {}, now);
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.deepEqual(saved.payload.touchedPaths, ["owned-fixture.txt"]);
  assert.equal(saved.payload.diffPreview, "update: owned-fixture.txt\n-before\n+after");
  assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: "accept" });
});

test("streaming-only file preview has no approval-ready context", { timeout: 5000 }, async t => {
  let received = false;
  const f = await setup(t, "file-preview-only", { onRequest: async (_request, _signal, createApproval, prepared) => {
    received = true;
    assert.deepEqual(prepared, { kind: "unsupported", reason: "missing_file_context" });
    assert.throws(() => createApproval(), { code: "handler_failed" });
    return { decision: "decline" };
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.equal(received, true);
  assert.deepEqual(f.store.listApprovalRequests(), []);
  assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: "decline" });
});

for (const variant of ["changed", "restored", "duplicate", "denied", "delayed-create"]) {
  test(`receipt-time patch update fences ${variant} approval despite a slow event observer`, { timeout: 5000 }, async t => {
    const received = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let updates = 0;
    let f;
    let saved;
    f = await setup(t, "file", {
      onEvent: async event => { if (event.method === "turn/started") await release.promise; },
      onNotificationReceived: event => {
        if (event.method === "item/fileChange/patchUpdated") updates++;
        if (event.method === "item/started" && updates === (variant === "restored" ? 2 : 1)) received.resolve();
      },
      onRequest: async (_request, _signal, createApproval) => {
        if (variant !== "delayed-create") saved = createApproval();
        f.child.send({ kind: "patch-update", changes: variant === "duplicate" ? originalPatch : changedPatch,
          finalize: variant !== "restored" });
        if (variant === "restored") f.child.send({ kind: "patch-update", changes: originalPatch, finalize: true });
        await received.promise;
        if (variant === "delayed-create") {
          assert.throws(() => createApproval(), { code: "handler_failed" });
          release.resolve();
          return { decision: "decline" };
        }
        f.store[variant === "denied" ? "denyApprovalRequest" : "approveApprovalRequest"](saved.id, {}, now);
        release.resolve();
        return { decision: variant === "denied" ? "decline" : "accept" };
      },
    });
    await f.lifecycle.open();
    const handle = await f.lifecycle.startTurn(input);
    if (variant === "changed" || variant === "restored") {
      await assert.rejects(handle.completed);
      assert.equal(f.store.getNativeApprovalCorrelation(saved.id).replyStatus, "not_written");
      assert.equal(f.requests.some(message => message.id === "approval-1"), false);
    } else {
      await handle.completed;
      assert.deepEqual((await peerReply(f, "approval-1")).result, { decision: variant === "duplicate" ? "accept" : "decline" });
      if (saved) assert.equal(f.store.getNativeApprovalCorrelation(saved.id).replyStatus, "written");
      else assert.deepEqual(f.store.listApprovalRequests(), []);
    }
    if (saved) assert.equal(f.store.getApprovalRequest(saved.id).payload.diffPreview, "update: owned-fixture.txt\n-before\n+after");
  });
}

test("a patch update received behind an occupied native write queue blocks an already approved grant", { timeout: 5000 }, async t => {
  const blocked = Promise.withResolvers();
  const approved = Promise.withResolvers();
  const updated = Promise.withResolvers();
  let releaseWrite;
  let f;
  let saved;
  const proxy = new Writable({ write(chunk, _encoding, callback) {
    const value = JSON.parse(String(chunk));
    if (value.id === "approval-blocker") {
      releaseWrite = callback;
      f.child.stdin.write(chunk, error => { assert.ifError(error); blocked.resolve(); });
    } else f.child.stdin.write(chunk, callback);
  } });
  t.after(() => { releaseWrite?.(); proxy.destroy(); });
  f = await setup(t, "file-queued", { input: proxy,
    onNotificationReceived: event => { if (event.method === "item/fileChange/patchUpdated") updated.resolve(); },
    onRequest: async (request, _signal, createApproval) => {
      if (request.id === "approval-blocker") return { decision: "decline" };
      await blocked.promise;
      saved = createApproval();
      f.store.approveApprovalRequest(saved.id, {}, now);
      approved.resolve();
      return { decision: "accept" };
    },
  });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await approved.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getNativeApprovalCorrelation(saved.id).replyStatus, "pending");
  f.child.send({ kind: "patch-update", changes: changedPatch });
  await updated.promise;
  releaseWrite();
  releaseWrite = undefined;
  await assert.rejects(handle.completed);
  assert.equal(f.store.getNativeApprovalCorrelation(saved.id).replyStatus, "not_written");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("a session-wide file grant is not represented as a one-time Ling approval", { timeout: 5000 }, async t => {
  let attempted = false;
  const f = await setup(t, "file-session", { onRequest: async (_request, _signal, createApproval) => {
    attempted = true;
    createApproval();
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await assert.rejects(handle.completed);
  assert.equal(attempted, true);
  assert.deepEqual(f.store.listApprovalRequests(), []);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("caller mutation of the exposed prepared action cannot change persisted command or policy", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "wrapped-plan", { onRequest: async (request, _signal, createApproval, prepared) => {
    request.params.command = "whois example.com";
    prepared.approval.payload.command = "whois example.com";
    prepared.policyDecision.decision = "ask";
    approval = createApproval();
    assert.equal(approval.payload.command, "/bin/zsh -lc 'touch owned-fixture.txt'");
    f.store.approveApprovalRequest(approval.id, {}, now);
    return { decision: "accept" };
  } }, { effectivePolicySnapshot: { conversationMode: "plan" } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.ok(approval);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("file symlink replacement after the saved user decision cannot leave as a native grant", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "file", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, {}, now);
    await symlink(join(f.cwd, ".ling-stack"), join(f.cwd, "owned-fixture.txt"), "dir");
    return { decision: "accept" };
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.ok(approval);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("a caller delaying approval creation cannot persist an obsolete file proposal", { timeout: 5000 }, async t => {
  let f;
  f = await setup(t, "file", { onRequest: async (_request, _signal, createApproval) => {
    await symlink(join(f.cwd, ".ling-stack"), join(f.cwd, "owned-fixture.txt"), "dir");
    assert.throws(() => createApproval());
    return { decision: "decline" };
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.deepEqual(f.store.listApprovalRequests(), []);
});

for (const grant of [false, true]) test(`unregistered turn permissions only allow an empty denial (grant=${grant})`, { timeout: 5000 }, async t => {
  const f = await setup(t, "permissions", { onRequest: async () => ({
    permissions: grant ? { network: { enabled: true } } : {}, scope: "turn",
  }) });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  if (grant) await assert.rejects(handle.completed);
  else assert.equal((await handle.completed).status, "completed");
  assert.deepEqual(f.store.listApprovalRequests(), []);
  if (grant) assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("explicit native scope consent produces exactly one journaled turn permission reply", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions", { onRequest: async (request, _signal, createApproval, prepared) => {
    assert.equal(prepared.kind, "action");
    assert.equal(prepared.policyDecision.decision, "ask");
    approval = createApproval();
    assert.deepEqual(approval.availableDecisions, ["approve_permission_scope", "deny"]);
    assert.throws(() => f.store.approveApprovalRequest(approval.id, {}, now), { code: "approval_decision_unavailable" });
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    request.params.permissions.network.enabled = false;
    prepared.approval.payload.resources.length = 0;
    return codexPermissionResponse(approval.payload, true);
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
  await peerReply(f, "approval-1");
  const replies = f.requests.filter(message => message.id === "approval-1");
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].result, { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.equal(f.store.getApprovalRequest(approval.id).decisionKind, "approve_permission_scope");
});

for (const altered of [
  { permissions: { network: { enabled: true } }, scope: "session" },
  { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/"] } }, scope: "turn" },
  { permissions: { network: { enabled: true } }, scope: "turn", strictAutoReview: true },
  { permissions: {}, scope: "turn" },
]) test(`native scope reply cannot replace saved resource identity: ${JSON.stringify(altered)}`, { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    return altered;
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.ok(approval);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
});

for (const decision of ["deny", "pending"]) test(`native ${decision} permission is never granted`, { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    if (decision === "deny") f.store.denyApprovalRequest(approval.id, {}, now);
    return codexPermissionResponse(approval.payload, false);
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  if (decision === "deny") {
    await handle.completed;
    assert.deepEqual((await peerReply(f, "approval-1")).result, { permissions: {}, scope: "turn" });
    assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
  } else {
    await assert.rejects(handle.completed);
    assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  }
  assert.ok(approval);
});

test("an approved native scope cannot bypass a Plan Mode policy denial", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions", { onRequest: async (_request, _signal, createApproval, prepared) => {
    assert.equal(prepared.policyDecision.decision, "deny");
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    return codexPermissionResponse(approval.payload, true);
  } }, { effectivePolicySnapshot: { conversationMode: "plan" } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.ok(approval);
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

test("file permission reply preserves native deny entries, paths and scan depth", { timeout: 5000 }, async t => {
  let f;
  let approval;
  let expected;
  f = await setup(t, "permissions-files", { onRequest: async (request, _signal, createApproval, prepared) => {
    assert.equal(prepared.policyDecision.decision, "ask");
    expected = { permissions: { fileSystem: structuredClone(request.params.permissions.fileSystem) }, scope: "turn" };
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    return codexPermissionResponse(approval.payload, true);
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startTurn(input)).completed;
  assert.deepEqual((await peerReply(f, "approval-1")).result, expected);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

test("file permission reply cannot silently drop a stored deny entry", { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions-files", { onRequest: async (_request, _signal, createApproval) => {
    approval = createApproval();
    f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    const result = codexPermissionResponse(approval.payload, true);
    result.permissions.fileSystem.entries = result.permissions.fileSystem.entries.filter(entry => entry.access !== "deny");
    return result;
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startTurn(input)).completed);
  assert.ok(approval);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
  assert.equal(f.requests.some(message => message.id === "approval-1"), false);
});

for (const phase of ["create", "reply"]) test(`permission write path is rechecked at ${phase}`, { timeout: 5000 }, async t => {
  let f;
  let approval;
  f = await setup(t, "permissions-files", { onRequest: async (_request, _signal, createApproval) => {
    if (phase === "reply") {
      approval = createApproval();
      f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, now);
    }
    await symlink(join(f.cwd, ".ling-stack"), join(f.cwd, "owned-fixture.txt"), "dir");
    if (phase === "create") {
      assert.throws(() => createApproval());
      return { permissions: {}, scope: "turn" };
    }
    return codexPermissionResponse(approval.payload, true);
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  if (phase === "reply") {
    await assert.rejects(handle.completed);
    assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
    assert.equal(f.requests.some(message => message.id === "approval-1"), false);
  } else {
    await handle.completed;
    assert.deepEqual(f.store.listApprovalRequests(), []);
  }
});

test("retained request callbacks cannot create new approvals after returning a response", { timeout: 5000 }, async t => {
  let createLater;
  const f = await setup(t, "normal", { onRequest: async (_request, _signal, createApproval) => {
    createLater = createApproval;
    return { decision: "decline" };
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startTurn(input);
  await handle.completed;
  assert.throws(() => createLater(), { code: "invalid_state" });
  assert.deepEqual(f.store.listApprovalRequests(), []);
});
