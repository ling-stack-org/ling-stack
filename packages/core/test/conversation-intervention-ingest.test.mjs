import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("atomic continuation input preserves intervention lineage and rejects divergent replay", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-intervention-ingest-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-01T00:00:00.000Z";
  const thread = store.createLingThread({ kind: "conversation", title: "N03", objective: "Lineage", teammateId: "ling_agent" }, now);
  store.createRun({ id: "source-run", cwd, threadId: thread.id, taskId: "source-task", providerName: "openai", providerModel: "fixture",
    taskSnapshot: { id: "source-task", title: "Source", prompt: "Source" }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const intervention = store.createRunIntervention({ sourceRunId: "source-run", mode: "queue_followup", instruction: "NEXT_USER",
    requestedBy: "local-user", idempotencyKey: "intervention" }, now);
  const input = { threadId: thread.id, title: "Next", userInstruction: "NEXT_USER", actorType: "local_user", turnKind: "queued_followup",
    interventionId: intervention.id, idempotencyKey: "next", payload: { body: "NEXT_USER", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } };
  const first = store.appendConversationUserTurn(input, now);
  assert.equal(store.getLingTurn(first.turnId).interventionId, intervention.id);
  assert.equal(store.appendConversationUserTurn(input, now).idempotentReplay, true);
  assert.throws(() => store.appendConversationUserTurn({ ...input, interventionId: "different" }, now), /another input/);
  assert.throws(() => store.appendConversationUserTurn({ ...input, interventionId: undefined }, now), /another input/);
});

test("normal guidance accepts fresh files in its own conversation and rejects foreign or already used files", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-p2-guidance-attachment-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-15T00:00:00.000Z";
  const thread = store.createLingThread({ kind: "conversation", title: "Guidance owner", objective: "Files", teammateId: "ling_agent" }, now);
  const other = store.createLingThread({ kind: "conversation", title: "Other owner", objective: "Separate files", teammateId: "ling_agent" }, now);
  store.createRun({ id: "normal-guidance-run", cwd, threadId: thread.id, taskId: "source-task", providerName: "openai", providerModel: "fixture",
    taskSnapshot: { id: "source-task", title: "Source", prompt: "Source" }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const file = input => store.createConversationAttachment({ kind: "file", fileName: "guidance.txt", contentType: "text/plain", sizeBytes: 1,
    path: join(cwd, "guidance.txt"), ...input });
  const submit = (attachmentIds, idempotencyKey, extra = {}) => store.createRunIntervention({ sourceRunId: "normal-guidance-run",
    mode: "queue_followup", instruction: "Use these files", idempotencyKey,
    messagePayload: { body: "Use these files", attachmentIds, linkPreviewIds: [], fileRefs: [], ...extra } }, now);
  const unbound = file({});
  const owned = file({ threadId: thread.id });
  const accepted = submit([unbound.id, owned.id], "own-files");
  assert.deepEqual(accepted.messagePayload.attachmentIds, [unbound.id, owned.id]);
  assert.equal(submit([unbound.id, owned.id], "own-files").id, accepted.id);
  const foreign = file({ threadId: other.id });
  const previous = store.appendConversationUserTurn({ threadId: thread.id, title: "Previous input", userInstruction: "Previous input", idempotencyKey: "previous",
    payload: { body: "Previous input", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const used = file({ threadId: thread.id, turnId: previous.turnId });
  assert.throws(() => submit([foreign.id], "foreign-file"), /different thread/);
  assert.throws(() => submit([used.id], "used-file"), /already used/);
  assert.throws(() => submit(["not-found"], "missing-file"), /not found/);
  assert.throws(() => submit([], "foreign-link", { linkPreviewIds: ["channel-preview"] }), /channel/);
  assert.throws(() => submit(Array.from({ length: 11 }, () => file({}).id), "too-many-files"), /at most 10/);
  assert.equal(store.listRunInterventions({ sourceRunId: "normal-guidance-run" }).length, 1);
});
