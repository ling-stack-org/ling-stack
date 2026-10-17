import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { normalSubmissionThreadId, readConversationSubmission } from "../dist/features/conversations/submission-receipts.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";

const now = "2026-10-14T00:00:00.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-receipt-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  return f;
}

test("normal lookup uses the exact existing acceptance key and never manufactures a first thread", async t => {
  const f = await fixture(t);
  const query = { surface: "normal", idempotencyKey: "normal-submit" };
  assert.equal(readConversationSubmission(f.store, query).status, "unknown");
  assert.equal(f.store.listLingThreads({ kind: "conversation" }).length, 0);
  const thread = f.store.createLingThread({ id: normalSubmissionThreadId(f.cwd, query.idempotencyKey),
    kind: "conversation", teammateId: "ling_agent", title: "Test", objective: "Test" }, now);
  const input = prepareNormalConversationInput({ store: f.store, thread, message: "Receipt body", title: "Test", attachmentIds: [],
    fileRefs: [], idempotencyKey: query.idempotencyKey, now });
  assert.deepEqual(readConversationSubmission(f.store, query), { cwd: f.cwd, idempotencyKey: query.idempotencyKey,
    status: "accepted", threadId: thread.id, turnId: input.turn.id, sourceItemId: input.turn.sourceItemId,
    sourceItem: f.store.getConversationItem(input.turn.sourceItemId) });
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.equal(readConversationSubmission(f.store, query).status, "accepted");
  assert.equal(readConversationSubmission(f.store, { ...query, threadId: "foreign-thread" }).status, "unknown");
});

test("channel lookup isolates root, branch, channel and workspace without creating topology", async t => {
  const f = await fixture(t);
  const channel = f.store.createChannel({ name: "Receipt test", boundPath: f.cwd }, now);
  const query = { surface: "channel", channelId: channel.id, idempotencyKey: "channel-submit" };
  assert.equal(readConversationSubmission(f.store, query).status, "unknown");
  const root = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id, title: "Root", objective: "Test" }, now).thread;
  const branch = f.store.createLingThread({ kind: "channel_discussion", surfaceKind: "branch", relationKind: "branch", channelId: channel.id,
    parentThreadId: root.id, title: "Branch", objective: "Test" }, now);
  const source = f.store.appendConversationUserTurn({ threadId: branch.id, channelId: channel.id, userInstruction: "Branch body",
    title: "Test", idempotencyKey: query.idempotencyKey,
    payload: { body: "Branch body", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  assert.equal(readConversationSubmission(f.store, query).status, "unknown");
  assert.equal(readConversationSubmission(f.store, { ...query, threadId: branch.id }).sourceItemId, source.item.id);
  assert.equal(readConversationSubmission(f.store, { ...query, channelId: "foreign", threadId: branch.id }).status, "unknown");
  assert.equal(readConversationSubmission(f.store, { surface: "normal", threadId: branch.id, idempotencyKey: query.idempotencyKey }).status, "unknown");
});
