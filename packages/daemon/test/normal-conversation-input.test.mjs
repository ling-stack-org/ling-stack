import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createSqliteRunStore, redactSecrets } from "@ling-stack/core";
import { buildConversationDetail, handleConversationStream, startConversationReplacementRun } from "../dist/features/conversations/routes.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { editConversationMessage } from "../dist/features/conversations/message-edits.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { buildRunInterventionContinuationRequest } from "../dist/features/runs/run-intervention-continuation-request.js";
import { handleLingThreadItem } from "../dist/features/runs/thread-routes.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { saveNormalConversationPreparedRequest } from "../dist/features/conversations/normal-conversation-prepared-request.js";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimePaths } from "@ling-stack/core";
import { persistConversationAttachment } from "../dist/features/channels/attachments.js";

const payload = (body) => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });
const registry = createRunnerRegistry([{ id: "pi", displayName: "Fixture", status: "enabled", adapter: {} }]);

async function fixture(t, { sourceRequest = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-input-test-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "History", objective: "History" }, "2026-09-01T00:00:00.000Z");
  const old = f.store.appendConversationUserTurn({ threadId: f.thread.id, turnId: "old", itemId: "conversation-user:old", title: "EARLY_USER",
    userInstruction: "EARLY_USER", payload: payload("EARLY_USER"), idempotencyKey: "old" }, "2026-09-01T00:01:00.000Z");
  f.store.createRun({ id: "old-run", cwd, taskId: "old-task", threadId: f.thread.id, turnId: old.turnId, teammateId: "ling_agent",
    providerName: "openai", providerModel: "fixture", taskSnapshot: { id: "old-task", title: "History", prompt: "EARLY_USER" },
    providerSnapshot: { provider: "openai", model: "fixture" }, requestSnapshot: sourceRequest, createdAt: new Date().toISOString() });
  f.store.appendEvent("old-run", "message_end", { role: "assistant", text: "EARLY_ASSISTANT" });
  return f;
}

class Response extends EventEmitter {
  statusCode = 200;
  destroyed = false;
  body = "";
  writeHead(status) { this.statusCode = status; }
  setHeader() {}
  flushHeaders() {}
  write(chunk) { this.body += chunk; }
  end(chunk = "") { this.body += chunk; }
}

async function dispatch(f, input, startRun, summarizer) {
  const request = Readable.from([JSON.stringify({ threadId: f.thread.id, message: "CURRENT_USER", providerPresetId: "fixture", idempotencyKey: "current", ...input })]);
  request.method = "POST";
  request.url = `/api/conversations/stream?cwd=${encodeURIComponent(f.cwd)}`;
  request.headers = { host: "fixture" };
  const response = new Response();
  await handleConversationStream(request, response, { host: "fixture", port: 1, maxBodyBytes: 100_000 }, { getStore: () => f.store }, registry, startRun, summarizer);
  return response;
}

function persist(f, request, id = "current-run") {
  return f.store.createRun({ id, cwd: f.cwd, taskId: request.task.id, threadId: request.threadId, turnId: request.turnId,
    teammateId: request.teammateId, providerName: "openai", providerModel: "fixture", taskSnapshot: request.task,
    providerSnapshot: { provider: "openai", model: "fixture" }, requestSnapshot: request, createdAt: new Date().toISOString() });
}

test("route atomically anchors input and freezes history before asynchronous configuration preparation", async (t) => {
  const f = await fixture(t);
  let observed;
  const append = f.store.appendConversationUserTurnWithAcceptedSnapshot.bind(f.store);
  f.store.appendConversationUserTurnWithAcceptedSnapshot = (...args) => {
    const result = append(...args);
    queueMicrotask(() => f.store.appendEvent("old-run", "message_end", { role: "assistant", text: "LATE_AFTER_AWAIT" }));
    return result;
  };
  const response = await dispatch(f, {}, async (request) => { observed = request; return "unused"; });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(observed?.normalConversationContext, "normal input must carry the frozen context");
  assert.ok(observed.normalConversationAcceptedSnapshotId);
  assert.ok(f.store.getEffectiveTurnContextAssignment(observed.turnId));
  assert.ok(observed.task.prompt.includes("EARLY_ASSISTANT"));
  assert.equal(observed.task.prompt.includes("LATE_AFTER_AWAIT"), false);
  assert.equal(observed.task.prompt.split("CURRENT_USER").length - 1, 1);
  assert.equal(JSON.stringify(observed.appendSystemPrompt).includes("EARLY_USER"), false);
});

test("prepared normal conversation preserves typed composer file-ref provenance", async (t) => {
  const f = await fixture(t);
  const fileRefs = [{ path: join(f.cwd, "qa-demo/package.json"), label: "package.json", source: "composer" }];
  let observed;
  const response = await dispatch(f, { fileRefs }, async (request) => { observed = request; });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(observed?.conversationFileRefs, fileRefs);
  assert.ok(observed?.normalConversationPreparedRequestRef?.fingerprint);
});

test("normal conversation freezes an explicit reasoning summary selection", async (t) => {
  const f = await fixture(t);
  f.store.updateWorkspaceSettings({ defaultReasoningSummary: "concise" }, new Date().toISOString());
  let observed;
  const response = await dispatch(f, { reasoningSummary: "none" }, async (request) => { observed = request; });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(observed?.reasoningSummary, "none");
  assert.ok(observed?.normalConversationPreparedRequestRef?.fingerprint);
});

test("idempotent route replay reuses the exact persisted Run input after database reopen", async (t) => {
  const f = await fixture(t);
  let first;
  await dispatch(f, { message: "CURRENT_USER sk-test-not-a-real-secret-123456" }, async (request) => { first = request; persist(f, request); return "current-run"; });
  assert.ok(first?.normalConversationContext);
  assert.deepEqual(redactSecrets(first.normalConversationContext), first.normalConversationContext);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  f.store.appendEvent("old-run", "message_end", { role: "assistant", text: "AFTER_REOPEN" });
  f.store.readSnapshot = () => { throw new Error("same Run must not recapture history"); };
  let replay;
  const response = await dispatch(f, { message: "CURRENT_USER sk-test-not-a-real-secret-123456" }, async (request) => { replay = request; return "current-run"; });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(replay.normalConversationContext, first.normalConversationContext);
  assert.deepEqual(replay.task, first.task);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id, limit: 50 }).length, 2);
  assert.equal(f.store.listConversationItemsForTurn({ turnId: replay.turnId }).filter((item) => item.kind === "user_message").length, 1);
  assert.equal(replay.task.prompt.includes("sk-test-not-a-real-secret"), false);
  assert.equal(replay.task.prompt.includes("AFTER_REOPEN"), false);
});

test("invalid attachments and replay body drift create no partial input", async (t) => {
  const f = await fixture(t);
  const invalid = await dispatch(f, { attachmentIds: ["missing"] }, async () => assert.fail("must not dispatch"));
  assert.equal(invalid.statusCode, 404);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id, limit: 50 }).length, 1);
  await dispatch(f, {}, async (request) => { persist(f, request); return "current-run"; });
  const drift = await dispatch(f, { message: "CHANGED_INPUT" }, async () => assert.fail("must not dispatch"));
  assert.ok(drift.statusCode >= 400);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id, limit: 50 }).length, 2);
});

test("no-Run retry after reopen reuses the prepared request without reading configuration", async (t) => {
  const f = await fixture(t);
  let first;
  f.store.updateWorkspaceSettings({ lingConversationTone: "friendly", defaultReasoningSummary: "detailed" }, new Date().toISOString());
  await dispatch(f, { tools: ["read"] }, async (request) => { first = request; throw new Error("STOP_BEFORE_RUN"); });
  assert.ok(first);
  assert.equal(f.store.listLingTurnRuns(first.turnId).length, 0);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  f.store.updateWorkspaceSettings({ lingConversationTone: "pragmatic", defaultReasoningSummary: "none" }, new Date().toISOString());
  f.store.getWorkspaceSettings = () => assert.fail("prepared replay must not prepare configuration again");
  let replay;
  const response = await dispatch(f, { tools: ["bash"], providerPresetId: "changed" }, async (request) => { replay = request; });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(replay, first);
  assert.equal(replay.lingConversationTone, "friendly");
  assert.equal(replay.reasoningSummary, "detailed");
  assert.deepEqual(replay.tools, ["read"]);
  assert.ok(replay.normalConversationPreparedRequestRef?.fingerprint);
});

test("concurrent route preparations dispatch only the winning request payload", async (t) => {
  const f = await fixture(t);
  const requests = [];
  const responses = await Promise.all(["read", "bash"].map((tool) => dispatch(f, { tools: [tool] }, async (request) => { requests.push(request); })));
  assert.ok(responses.every((response) => response.statusCode === 200), responses.map((response) => response.body).join("\n"));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(f.store.listLingTurnRuns(requests[0].turnId).length, 0);
});

for (const materializationFails of [false, true]) {
  test(`no-Run replay never repeats completed attachment preparation (failed=${materializationFails})`, async (t) => {
    const f = await fixture(t);
    const attachment = persistConversationAttachment(f.store, { threadId: f.thread.id, fileName: "fixture.png", contentType: "image/png",
      contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=" });
    let calls = 0;
    let first;
    const summarize = async () => { calls += 1; if (materializationFails) throw new Error("TEMPORARY_VISION_FAILURE"); return { contentText: "FIRST_VISION_RESULT" }; };
    await dispatch(f, { attachmentIds: [attachment.id] }, async (request) => { first = request; throw new Error("NO_RUN"); }, summarize);
    assert.ok(first);
    assert.equal(calls, 1);
    f.store.close(); f.store = createSqliteRunStore(f.cwd);
    let replay;
    const response = await dispatch(f, { attachmentIds: [attachment.id] }, async (request) => { replay = request; },
      async () => { calls += 1; return { contentText: "DRIFTED_VISION_RESULT" }; });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(calls, 1);
    assert.deepEqual(replay, first);
    assert.equal(first.task.prompt.includes("FIRST_VISION_RESULT"), !materializationFails);
    assert.equal(replay.task.prompt.includes("DRIFTED_VISION_RESULT"), false);
  });
}

test("local continuation freezes request options even if no Run was created", async (t) => {
  const f = await fixture(t, { sourceRequest: { providerPresetId: "fixture", tools: ["read"] } });
  const sourceRun = f.store.getRun("old-run");
  const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "GUIDANCE",
    requestedBy: "local-user", idempotencyKey: "no-run" }, new Date().toISOString());
  const first = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.throws(() => buildRunInterventionContinuationRequest(f.store, { ...sourceRun,
    requestSnapshot: { providerPresetId: "changed", tools: ["bash"] } }, intervention), /continuation.*source/);
  const replay = buildRunInterventionContinuationRequest(f.store, f.store.getRun(sourceRun.id), f.store.getRunIntervention(intervention.id));
  assert.deepEqual(replay, first);
  assert.ok(first.normalConversationPreparedRequestRef?.id);
});

test("same Run replay rejects missing durable context instead of hydrating new history", async (t) => {
  const f = await fixture(t);
  await dispatch(f, {}, async (request) => { const { normalConversationContext, ...withoutContext } = request; persist(f, withoutContext); return "current-run"; });
  const response = await dispatch(f, {}, async () => assert.fail("must not dispatch"));
  assert.ok(response.statusCode >= 400, response.body);
  assert.match(response.body, /context snapshot/i);
});

test("same Run replay validates lineage and returns request preparation without resolved provider metadata", async (t) => {
  const f = await fixture(t);
  let first;
  await dispatch(f, {}, async (request) => { first = request; persist(f, { ...request,
    provider: { provider: "openai", model: "fixture", apiKey: "example-credential" },
    permissionMode: "balanced", runtimeSettings: { fixture: true }, effectivePolicySnapshot: { mode: "balanced" } }); });
  let replay;
  const response = await dispatch(f, {}, async (request) => { replay = request; });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(replay, first);
  assert.equal(replay.provider, undefined);
});

for (const corruption of ["missing-row", "wrong-ref", "prompt", "tools"]) {
  test(`Run/prepared ${corruption} divergence cannot be repaired by the other evidence`, async (t) => {
    const f = await fixture(t);
    let first;
    await dispatch(f, {}, async (request) => {
      first = request;
      persist(f, { ...request,
        ...(corruption === "wrong-ref" ? { normalConversationPreparedRequestRef: { id: "wrong", fingerprint: "wrong" } } : {}),
        ...(corruption === "prompt" ? { task: { ...request.task, prompt: "DIFFERENT_VALID_RUN_PROMPT" } } : {}),
        ...(corruption === "tools" ? { tools: ["bash"] } : {}),
      });
    });
    if (corruption === "missing-row") {
      const db = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
      try { db.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(first.normalConversationPreparedRequestRef.id); }
      finally { db.close(); }
    }
    const response = await dispatch(f, {}, async () => assert.fail("must not dispatch divergent evidence"));
    assert.ok(response.statusCode >= 400, response.body);
    assert.match(response.body, /prepared request/i);
  });
}

test("replacement no-Run retry reuses its committed revision and prepared options", async (t) => {
  const f = await fixture(t);
  const requests = [];
  const edit = { surface: "normal_conversation", ownerId: f.thread.id, messageId: "conversation-user:old",
    expectedRevision: 1, body: "EDITED", idempotencyKey: "stable-edit",
    fileRefs: [{ path: join(f.cwd, "edited.ts"), label: "Edited file", line: 3 }] };
  const dependencies = { activeRuns: new ActiveRunRegistry(), startReplacement: async ({ revision }) => {
    const result = await startConversationReplacementRun({ store: f.store, workspaceCwd: f.cwd, thread: f.thread,
      message: revision.body, messageId: revision.messageId, revisionId: revision.id, attachmentIds: revision.attachmentIds,
      providerPresetId: requests.length === 0 ? "fixture" : "drift", runnerRegistry: registry, previousRun: f.store.getRun("old-run"),
      startRun: async (request, sink) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("NO_RUN_YET");
        sink.writeReady({ runId: "replacement-run" }); return "replacement-run";
      } });
    return { replacementTurnId: result.turn.id };
  } };
  await editConversationMessage(f.store, edit, dependencies);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  f.store.getWorkspaceSettings = () => assert.fail("replacement must not reprepare configuration");
  await editConversationMessage(f.store, edit, dependencies);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0].conversationFileRefs, edit.fileRefs);
  assert.ok(requests[0].task.prompt.includes(edit.fileRefs[0].path));
  assert.equal(f.store.getConversationItem(f.store.getLingTurn(requests[0].turnId).sourceItemId).payload.fileRefs[0].path, edit.fileRefs[0].path);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id }).length, 2);
});

test("Daemon prepared DTO rejects unknown fields, secrets and invalid scope before writing", async (t) => {
  const f = await fixture(t);
  let template;
  await dispatch(f, {}, async (request) => { template = request; });
  for (const invalid of [ { onEvent() {} }, { opaqueRuntimeState: {} }, { appendSystemPrompt: ["Bearer example-not-real"] },
    { teammateId: "other-agent" }, { tools: ["unknown-tool"] }, { conversationFileRefs: [{ path: "/tmp/example", line: -1 }] },
    { conversationFileRefs: [{ path: "/tmp/example", source: "forged" }] },
    { normalConversationContext: { ...template.normalConversationContext, fingerprint: "incorrect" } } ]) {
    const accepted = prepareNormalConversationInput({ store: f.store, thread: f.thread, message: "ANOTHER", title: "Another",
      attachmentIds: [], fileRefs: [], idempotencyKey: `invalid-${Object.keys(invalid)[0]}`, now: new Date().toISOString() });
    const { normalConversationPreparedRequestRef, ...base } = template;
    const request = { ...base, threadId: f.thread.id, turnId: accepted.turn.id, idempotencyKey: accepted.idempotencyKey,
      normalConversationContext: accepted.context, contextProjection: accepted.context.projection,
      normalConversationAcceptedSnapshotId: accepted.acceptedSnapshotId, ...invalid };
    assert.throws(() => saveNormalConversationPreparedRequest(f.store, request, new Date().toISOString()));
    assert.equal(f.store.getConversationPreparedInput(accepted.turn.sourceItemId, "request"), undefined);
    assert.equal(f.store.listLingTurnRuns(accepted.turn.id).length, 0);
  }
});

test("inline continuation retains non-secret configuration while preparation excludes credentials", async (t) => {
  const f = await fixture(t);
  const sourceRun = f.store.getRun("old-run");
  const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "INLINE",
    requestedBy: "local-user", idempotencyKey: "inline" }, new Date().toISOString());
  const first = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
  assert.deepEqual(first.provider, { provider: "openai", model: "fixture" });
  const saved = f.store.getConversationPreparedInput(first.sourceMessageId, "request");
  assert.equal(saved.payload.inlineProviderSourceRunId, sourceRun.id);
  assert.equal(Object.hasOwn(saved.payload.request.provider, "apiKey"), false);
  assert.equal(Object.hasOwn(saved.payload.request.provider, "headers"), false);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(buildRunInterventionContinuationRequest(f.store, f.store.getRun("old-run"), intervention), first);
});

test("redacted inline credentials cannot become authentication or poison preparation evidence", async (t) => {
  const f = await fixture(t);
  const source = persist(f, { threadId: f.thread.id, turnId: "old", teammateId: "ling_agent", task: { id: "inline", title: "Inline", prompt: "Inline" },
    provider: { provider: "openai", model: "fixture", apiKey: "fixture-not-a-real-key", headers: { Authorization: "Bearer fixture-value" } } }, "inline-source");
  const intervention = f.store.createRunIntervention({ sourceRunId: source.id, mode: "queue_followup", instruction: "INLINE",
    requestedBy: "local-user", idempotencyKey: "unavailable" }, new Date().toISOString());
  assert.throws(() => buildRunInterventionContinuationRequest(f.store, source, intervention), /reusable inline credentials/);
  const input = f.store.listLingTurns({ threadId: f.thread.id }).find((turn) => turn.interventionId === intervention.id);
  assert.ok(input?.sourceItemId);
  assert.equal(f.store.getConversationPreparedInput(input.sourceItemId, "request"), undefined);
});

test("manual no-Run resume reuses task identity and prepared context after reopen", async (t) => {
  const f = await fixture(t);
  await dispatch(f, {}, async (request) => { persist(f, request); });
  const now = new Date().toISOString();
  assert.equal(f.store.transitionRunStatus({ runId: "current-run", event: "runner_started", actor: "runner", now }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: "current-run", event: "runner_succeeded", actor: "runner", now }).ok, true);
  f.store.reconcileLingTurnStatus(f.store.getLingTurnForRun("current-run").id, now);
  const dispatched = [];
  const resume = async () => {
    const request = Readable.from([JSON.stringify({ sourceRunId: "current-run", instruction: "MANUAL", idempotencyKey: "stable-resume" })]);
    request.method = "POST";
    const response = new Response();
    await handleLingThreadItem(request, response, new URL(`http://fixture/threads/resume?cwd=${encodeURIComponent(f.cwd)}`),
      { getStore: () => f.store }, { kind: "resume", threadId: f.thread.id },
      { maxBodyBytes: 100_000, startResumeRun: async (value) => { dispatched.push(value); return "not-created"; } });
    assert.equal(response.statusCode, 202, response.body);
  };
  await resume();
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  await resume();
  assert.equal(dispatched.length, 2);
  assert.deepEqual(dispatched[1], dispatched[0]);
  assert.ok(dispatched[0].normalConversationAcceptedSnapshotId);
  assert.ok(dispatched[0].normalConversationPreparedRequestRef);
  assert.equal(f.store.listLingTurnRuns(dispatched[0].turnId).length, 0);
});

test("replacement creates its own canonical input and excludes superseded source history", async (t) => {
  const f = await fixture(t);
  let request;
  let result;
  await editConversationMessage(f.store, { surface: "normal_conversation", ownerId: f.thread.id, messageId: "conversation-user:old",
    expectedRevision: 1, body: "REPLACEMENT_USER", idempotencyKey: "replacement-edit" }, {
    activeRuns: new ActiveRunRegistry(), startReplacement: async ({ revision }) => {
      result = await startConversationReplacementRun({ store: f.store, workspaceCwd: f.cwd, thread: f.thread,
        message: "REPLACEMENT_USER", messageId: "conversation-user:old", revisionId: revision.id, attachmentIds: [], providerPresetId: "fixture", runnerRegistry: registry,
        previousRun: f.store.getRun("old-run"), startRun: async (value, sink) => { request = value; sink.writeReady({ runId: "replacement-run" }); return "replacement-run"; } });
      return { replacementTurnId: result.turn.id, replacementRunId: result.runId };
    },
  });
  assert.notEqual(result.turn.sourceItemId, "conversation-user:old");
  assert.equal(f.store.getConversationItem(result.turn.sourceItemId).turnId, result.turn.id);
  assert.ok(f.store.getEffectiveTurnContextAssignment(result.turn.id));
  assert.equal(request.normalConversationContext.hydration.source.turnId, result.turn.id);
  assert.equal(request.task.prompt.split("REPLACEMENT_USER").length - 1, 1);
  assert.equal(request.task.prompt.includes("EARLY_ASSISTANT"), false);
});

test("external Run parsing cannot inject an internal normal context snapshot", () => {
  const parsed = parseRunRequest({ cwd: "/fixture", task: { id: "task", title: "Test", prompt: "User" }, providerPresetId: "fixture",
    normalConversationContext: { schemaVersion: 1, renderedHistory: "INJECTED" }, normalConversationAcceptedSnapshotId: "INJECTED",
    normalConversationPreparedRequestRef: { id: "INJECTED", fingerprint: "INJECTED" } });
  assert.equal(parsed.normalConversationContext, undefined);
  assert.equal(parsed.normalConversationAcceptedSnapshotId, undefined);
  assert.equal(parsed.normalConversationPreparedRequestRef, undefined);
});

test("first request without a threadId has stable scoped identity and replays only one input", async (t) => {
  const f = await fixture(t);
  let first;
  await dispatch(f, { threadId: undefined, idempotencyKey: "PRIVATE_CLIENT_KEY" }, async (request) => { first = request; persist(f, request); return "current-run"; });
  let second;
  const response = await dispatch(f, { threadId: undefined, idempotencyKey: "PRIVATE_CLIENT_KEY" }, async (request) => { second = request; return "current-run"; });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.turnId, first.turnId);
  assert.equal(second.threadId.includes("PRIVATE_CLIENT_KEY"), false);
  const changed = await dispatch(f, { threadId: undefined, idempotencyKey: "PRIVATE_CLIENT_KEY", message: "DRIFT" }, async () => assert.fail("must reject drift"));
  assert.ok(changed.statusCode >= 400);
});

test("local-user continuation freezes a new source while retaining intervention identity on replay", async (t) => {
  for (const mode of ["queue_followup", "interrupt_redirect"]) {
    const f = await fixture(t);
    const sourceRun = f.store.getRun("old-run");
    const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode, instruction: "NEW_GUIDANCE",
      requestedBy: "local-user", idempotencyKey: mode }, new Date().toISOString());
    const request = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
    assert.ok(request.normalConversationContext);
    assert.notEqual(request.turnId, "old");
    assert.equal(request.normalConversationContext.hydration.source.turnId, request.turnId);
    assert.equal(f.store.getLingTurn(request.turnId).interventionId, intervention.id);
    assert.equal(f.store.getLingTurn(request.turnId).kind, mode === "queue_followup" ? "queued_followup" : "interrupt_redirect");
    assert.equal(f.store.getConversationItem(request.sourceMessageId).actorType, "local_user");
    assert.equal(request.task.prompt.split("NEW_GUIDANCE").length - 1, 1);
    assert.equal(request.task.prompt.split("EARLY_USER").length - 1, 1);
    persist(f, request, "continuation-run");
    f.store.readSnapshot = () => assert.fail("replay cannot recapture");
    const replay = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
    assert.deepEqual(replay.normalConversationContext, request.normalConversationContext);
    assert.deepEqual(replay.task, JSON.parse(JSON.stringify(request.task)));
  }
});

test("normal queued guidance binds its uploaded file to one continuation input and replays without new ownership", async t => {
  const f = await fixture(t, { sourceRequest: { permissionPreset: "workspace_collaboration" } });
  const attachment = persistConversationAttachment(f.store, { threadId: f.thread.id, fileName: "guidance.txt", contentType: "text/plain",
    contentBase64: Buffer.from("Original guidance attachment bytes").toString("base64") });
  const sourceRun = f.store.getRun("old-run");
  const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "Use the guidance file",
    messagePayload: { body: "Use the guidance file", attachmentIds: [attachment.id], linkPreviewIds: [], fileRefs: [] },
    requestedBy: "local-user", idempotencyKey: "guidance-with-file" }, new Date().toISOString());
  const request = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
  assert.deepEqual(request.conversationAttachmentIds, [attachment.id]);
  assert.equal(request.permissionPreset, "workspace_collaboration");
  assert.equal(request.parentRunId, sourceRun.id);
  assert.equal(request.interventionId, intervention.id);
  assert.equal(f.store.getLingTurn(request.turnId).interventionId, intervention.id);
  assert.deepEqual(f.store.getConversationItem(request.sourceMessageId).payload.attachmentIds, [attachment.id]);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, request.turnId);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const replay = buildRunInterventionContinuationRequest(f.store, f.store.getRun(sourceRun.id), f.store.getRunIntervention(intervention.id));
  assert.equal(replay.sourceMessageId, request.sourceMessageId);
  assert.equal(replay.turnId, request.turnId);
  assert.deepEqual(replay.conversationAttachmentIds, [attachment.id]);
});

test("system continuation freezes its own source and request across no-Run reopen without relabelling the parent", async (t) => {
  const f = await fixture(t);
  await dispatch(f, {}, async (request) => { persist(f, request); return "current-run"; });
  const sourceRun = f.store.getRun("current-run");
  const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "SYSTEM_GUIDANCE",
    requestedBy: "system", idempotencyKey: "system" }, new Date().toISOString());
  const before = f.store.listLingTurns({ threadId: f.thread.id }).length;
  const request = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
  assert.equal(request.createdByActor, "system");
  assert.ok(request.normalConversationContext);
  assert.ok(request.normalConversationPreparedRequestRef);
  assert.notEqual(request.sourceMessageId, sourceRun.requestSnapshot.sourceMessageId);
  assert.equal(f.store.getConversationItem(request.sourceMessageId).actorType, "system");
  assert.equal(f.store.getLingTurn(request.turnId).createdByActor, "system");
  assert.equal(f.store.getLingTurn(request.turnId).sourceTurnId, sourceRun.requestSnapshot.turnId);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id }).length, before + 1);
  assert.equal(request.task.prompt.split("SYSTEM_GUIDANCE").length - 1, 1);
  assert.ok(request.task.prompt.includes("Current system continuation"));
  assert.equal(request.task.prompt.includes("Current user message:\nSYSTEM_GUIDANCE"), false);
  assert.equal(request.task.prompt.split("EARLY_USER").length - 1, 1);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  f.store.appendEvent(sourceRun.id, "message_end", { role: "assistant", text: "LATE_SYSTEM_REPLAY" });
  const replay = buildRunInterventionContinuationRequest(f.store, f.store.getRun(sourceRun.id), f.store.getRunIntervention(intervention.id));
  assert.deepEqual(replay, request);
  assert.equal(replay.task.prompt.includes("LATE_SYSTEM_REPLAY"), false);
  const next = prepareNormalConversationInput({ store: f.store, thread: f.thread, title: "Next", message: "AFTER_SYSTEM",
    attachmentIds: [], fileRefs: [], idempotencyKey: "after-system", now: new Date().toISOString() });
  assert.equal(next.context.hydration.entries.find((entry) => entry.text === "SYSTEM_GUIDANCE")?.role, "context");
});

test("normal continuation rejects a forged system actor or guidance before accepting another input", async (t) => {
  const f = await fixture(t);
  const sourceRun = f.store.getRun("old-run");
  const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "REAL_GUIDANCE",
    requestedBy: "local-user", idempotencyKey: "actor-source" }, new Date().toISOString());
  const before = f.store.listLingTurns({ threadId: f.thread.id }).length;
  for (const change of [{ requestedBy: "system" }, { instruction: "FORGED_GUIDANCE" }, { sourceRunId: "foreign" }, { id: "missing" }]) {
    assert.throws(() => buildRunInterventionContinuationRequest(f.store, sourceRun, { ...intervention, ...change }), /continuation.*source|intervention.*source/i);
  }
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id }).length, before);
});

test("prepared request actor must agree with its canonical accepted source", async (t) => {
  const f = await fixture(t);
  const input = prepareNormalConversationInput({ store: f.store, thread: f.thread, title: "System", message: "SYSTEM_GUIDANCE",
    actorType: "system", attachmentIds: [], fileRefs: [], idempotencyKey: "system-request", now: new Date().toISOString() });
  const request = { cwd: f.cwd, threadId: f.thread.id, turnId: input.turn.id, teammateId: "ling_agent", providerPresetId: "fixture",
    createdByActor: "local-user", idempotencyKey: input.idempotencyKey, task: { id: "system-task", title: "System", prompt: "SYSTEM_GUIDANCE" },
    sourceMessageId: input.turn.sourceItemId, normalConversationContext: input.context, contextProjection: input.context.projection,
    normalConversationAcceptedSnapshotId: input.acceptedSnapshotId };
  assert.throws(() => saveNormalConversationPreparedRequest(f.store, request, new Date().toISOString()), /actor.*mismatch|source mismatch/);
  assert.equal(f.store.getConversationPreparedInput(input.turn.sourceItemId, "request"), undefined);
});

test("normal detail preserves continuation origin and never duplicates a bound no-Run input", async (t) => {
  for (const requestedBy of ["system", "local-user"]) {
    const f = await fixture(t);
    const sourceRun = f.store.getRun("old-run");
    const intervention = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "ONE_GUIDANCE",
      requestedBy, idempotencyKey: "detail-source" }, new Date().toISOString());
    const role = requestedBy === "system" ? "system" : "user";
    const pending = buildConversationDetail(f.store, f.cwd, f.thread).messages.filter((message) => message.content === "ONE_GUIDANCE");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].role, role);
    const request = buildRunInterventionContinuationRequest(f.store, sourceRun, intervention);
    for (const withRun of [false, true]) {
      if (withRun) persist(f, request, "continuation");
      const messages = buildConversationDetail(f.store, f.cwd, f.thread).messages.filter((message) => message.content === "ONE_GUIDANCE");
      assert.equal(messages.length, 1, `${requestedBy} withRun=${withRun}`);
      assert.equal(messages[0].id, request.sourceMessageId);
      assert.equal(messages[0].role, role);
    }
  }
});

test("bound guidance stays suppressed after supersession but a distinct pending intervention with identical text survives", async (t) => {
  const f = await fixture(t);
  const sourceRun = f.store.getRun("old-run");
  const first = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "SAME_TEXT",
    requestedBy: "local-user", idempotencyKey: "guidance-1" }, new Date().toISOString());
  const request = buildRunInterventionContinuationRequest(f.store, sourceRun, first);
  const second = f.store.createRunIntervention({ sourceRunId: sourceRun.id, mode: "queue_followup", instruction: "SAME_TEXT",
    requestedBy: "local-user", idempotencyKey: "guidance-2" }, new Date().toISOString());
  const before = buildConversationDetail(f.store, f.cwd, f.thread).messages.filter((message) => message.content === "SAME_TEXT");
  assert.deepEqual(new Set(before.map((message) => message.id)), new Set([request.sourceMessageId, `conversation-user:intervention:${second.id}`]));
  const database = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  try { database.prepare("UPDATE ling_turns SET status='superseded' WHERE id=?").run(request.turnId); }
  finally { database.close(); }
  const after = buildConversationDetail(f.store, f.cwd, f.thread).messages.filter((message) => message.content === "SAME_TEXT");
  assert.deepEqual(after.map((message) => message.id), [`conversation-user:intervention:${second.id}`]);
});

test("manual resume is a new local input, not a parent snapshot relabelled as a new Run", async (t) => {
  const f = await fixture(t);
  await dispatch(f, {}, async (request) => { persist(f, request); return "current-run"; });
  assert.equal(f.store.transitionRunStatus({ runId: "current-run", event: "runner_started", actor: "runner", now: new Date().toISOString() }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: "current-run", event: "runner_succeeded", actor: "runner", now: new Date().toISOString() }).ok, true);
  const originalTurn = f.store.getLingTurnForRun("current-run");
  f.store.reconcileLingTurnStatus(originalTurn.id, new Date().toISOString());
  let resumed;
  const request = Readable.from([JSON.stringify({ sourceRunId: "current-run", instruction: "MANUAL_GUIDANCE", idempotencyKey: "manual-resume" })]);
  request.method = "POST";
  const response = new Response();
  await handleLingThreadItem(request, response, new URL(`http://fixture/threads/resume?cwd=${encodeURIComponent(f.cwd)}`),
    { getStore: () => f.store }, { kind: "resume", threadId: f.thread.id },
    { maxBodyBytes: 100_000, startResumeRun: async (value) => { resumed = value; return "manual-run"; } });
  assert.equal(response.statusCode, 202, response.body);
  assert.ok(resumed.normalConversationContext);
  assert.notEqual(resumed.turnId, originalTurn.id);
  assert.equal(resumed.parentRunId, "current-run");
  assert.equal(resumed.createdByActor, "local-user");
  assert.equal(f.store.getConversationItem(resumed.sourceMessageId).payload.body, "MANUAL_GUIDANCE");
  assert.equal(resumed.task.prompt.split("MANUAL_GUIDANCE").length - 1, 1);
});
