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
