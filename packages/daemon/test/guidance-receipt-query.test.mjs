import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { DirectReplyControlService, handleTeammateDirectInterventions } from "../dist/features/teammates/direct-controls.js";
import { handleRunInterventions } from "../dist/features/runs/interventions.js";
import { persistConversationAttachment } from "../dist/features/channels/attachments.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-guidance-receipt-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  const config = resolveConfig({ host: "127.0.0.1", port: 0 });
  let registry = new RunStoreRegistry(() => f.store);
  f.reopen = () => {
    f.store.close(); f.store = createSqliteRunStore(cwd);
    registry = new RunStoreRegistry(() => f.store);
  };
  const activeRuns = new ActiveRunRegistry();
  const directService = new DirectReplyControlService({});
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const action = url.pathname.startsWith("/runs/")
      ? handleRunInterventions(request, response, config, url, undefined, registry, activeRuns,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, url.pathname.split("/")[2])
      : handleTeammateDirectInterventions(request, response, config, registry, url.pathname.split("/")[2], directService);
    void action.catch(error => { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ message: error.message })); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.base = `http://127.0.0.1:${server.address().port}`;
  f.request = async (path, body) => {
    const url = new URL(path, f.base); url.searchParams.set("cwd", cwd);
    const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); await rm(cwd, { recursive: true, force: true });
  });
  return f;
}

function sourceRun(f, id) {
  const now = "2026-10-15T00:00:00.000Z";
  const thread = f.store.createLingThread({ kind: "conversation", title: id, objective: id, teammateId: "ling_agent" }, now);
  f.store.createRun({ id, cwd: f.cwd, threadId: thread.id, taskId: id, providerName: "openai", providerModel: "fixture",
    taskSnapshot: { id, title: id, prompt: id }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  return thread;
}

test("run guidance exact-key lookup survives the list cap, terminal state and database reopen without another execution", async t => {
  const f = await fixture(t);
  sourceRun(f, "source-run"); sourceRun(f, "other-run");
  const now = "2026-10-15T00:00:00.000Z";
  for (let i = 0; i < 105; i++) f.store.createRunIntervention({ sourceRunId: "source-run", mode: "queue_followup",
    instruction: `Guidance ${i}`, idempotencyKey: `key-${i}` }, now);
  const target = f.store.listRunInterventions({ sourceRunId: "source-run", limit: 500 }).at(-1);
  f.store.updateRunInterventionStatus({ interventionId: target.id, status: "completed", now });
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const result = await f.request(`/runs/source-run/interventions?idempotencyKey=${target.idempotencyKey}&limit=1`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.interventions.map(item => item.id), [target.id]);
  assert.equal(result.data.idempotencyKey, target.idempotencyKey);
  assert.equal(result.data.cwd, f.cwd);
  const missing = await f.request("/runs/source-run/interventions?idempotencyKey=missing");
  assert.deepEqual(missing.data.interventions, []);
  assert.equal(missing.data.idempotencyKey, "missing");
  const foreign = await f.request(`/runs/other-run/interventions?idempotencyKey=${target.idempotencyKey}`);
  assert.deepEqual(foreign.data.interventions, []);
});

test("private guidance exact-key lookup includes completed history but never another teammate", async t => {
  const f = await fixture(t);
  const now = "2026-10-15T00:00:00.000Z";
  const teammateId = "teammate_builtin_engineer";
  const thread = f.store.getOrCreateTeammateDirectThread(teammateId, now);
  const source = f.store.createTeammateDirectMessage({ teammateId, threadId: thread.id,
    authorType: "local-user", authorId: "local-user", body: "Source", status: "ready" }, now);
  for (let i = 0; i < 105; i++) f.store.createTeammateDirectReplyIntervention({ teammateId, threadId: thread.id,
    sourceMessageId: source.id, mode: "queue_followup", instruction: `Guidance ${i}`, idempotencyKey: `private-key-${i}` }, now);
  const target = f.store.listTeammateDirectReplyInterventions({ teammateId, limit: 500 }).at(-1);
  f.store.updateTeammateDirectReplyInterventionStatus({ interventionId: target.id, status: "completed", now });
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const result = await f.request(`/teammates/${teammateId}/direct-interventions?idempotencyKey=${target.idempotencyKey}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.interventions.map(item => item.id), [target.id]);
  assert.equal(result.data.idempotencyKey, target.idempotencyKey);
  assert.equal(result.data.teammateId, teammateId);
  assert.equal(result.data.thread.id, thread.id);
  const missing = await f.request(`/teammates/${teammateId}/direct-interventions?idempotencyKey=missing`);
  assert.deepEqual(missing.data.interventions, []);
  assert.equal(missing.data.idempotencyKey, "missing");
  const other = f.store.listAiTeammates().find(item => item.id !== teammateId);
  const foreign = await f.request(`/teammates/${other.id}/direct-interventions?idempotencyKey=${target.idempotencyKey}`);
  assert.deepEqual(foreign.data.interventions, []);
});

test("normal guidance HTTP acceptance preserves its file and exact query does not create a continuation", async t => {
  const f = await fixture(t);
  const thread = sourceRun(f, "file-source-run");
  const file = persistConversationAttachment(f.store, { threadId: thread.id, fileName: "guidance.txt", contentType: "text/plain",
    contentBase64: Buffer.from("Original guidance file").toString("base64") });
  const input = { mode: "queue_followup", instruction: "Use the file", idempotencyKey: "file-guidance-key",
    messagePayload: { body: "Use the file", attachmentIds: [file.id], linkPreviewIds: [], fileRefs: [] } };
  const accepted = await f.request("/runs/file-source-run/interventions", input);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.intervention.messagePayload.attachmentIds, [file.id]);
  const receipt = await f.request("/runs/file-source-run/interventions?idempotencyKey=file-guidance-key");
  assert.deepEqual(receipt.data.interventions.map(item => item.id), [accepted.data.intervention.id]);
  assert.equal(f.store.getConversationAttachment(file.id).turnId, undefined);
  assert.equal(f.store.listLingTurns({ threadId: thread.id }).length, 0);
  assert.equal(f.store.listRuns().length, 1);
});

test("normal guidance HTTP and SQLite round-trip distinguish lexical and explicit file sources", async t => {
  const f = await fixture(t);
  sourceRun(f, "path-source-run");
  const fileRefs = ["inferred_text", "composer", "explicit_text", "api"].map(source => ({
    path: `${source}/file.txt`, source, rootRelation: "unknown", kind: "unknown", materializationStatus: "not_loaded" }));
  const input = { mode: "queue_followup", instruction: "Explain paths", idempotencyKey: "path-origin",
    messagePayload: { body: "Explain paths", attachmentIds: [], linkPreviewIds: [], fileRefs } };
  const accepted = await f.request("/runs/path-source-run/interventions", input);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.intervention.messagePayload.fileRefs, fileRefs);
  f.reopen();
  const receipt = await f.request("/runs/path-source-run/interventions?idempotencyKey=path-origin");
  assert.equal(receipt.status, 200, JSON.stringify(receipt.data));
  assert.deepEqual(receipt.data.interventions[0].messagePayload.fileRefs, fileRefs);
  const invalid = await f.request("/runs/path-source-run/interventions", { ...input,
    idempotencyKey: "invalid-origin", messagePayload: { ...input.messagePayload, fileRefs: [{ ...fileRefs[0], source: "invalid" }] } });
  assert.equal(invalid.status, 400);
});
