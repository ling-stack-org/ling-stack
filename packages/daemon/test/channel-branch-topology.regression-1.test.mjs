import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { handleChannelBranchesCollection } from "../dist/features/channels/routes.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";

// Regression: C03-BRANCH-TOPOLOGY — sidebar branches bypass canonical lineage.
// Found by /qa on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Real handler + SQLite. HTTP objects and registry lookup are fixtures, not GUI.
const now = "2026-10-25T14:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-c03-branch-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.channel = f.store.createChannel({ name: "Branch topology", boundPath: cwd }, now);
  f.root = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: f.channel.id,
    title: "Parent", objective: "Parent context" }, now).thread;
  return f;
}
class Response extends EventEmitter {
  statusCode = 200; body = "";
  writeHead(status) { this.statusCode = status; } setHeader() {} end(chunk = "") { this.body += chunk; }
}
async function create(f, name = "Independent lane") {
  const req = Readable.from([JSON.stringify({ name })]);
  req.method = "POST"; req.headers = {}; req.url = `/channels/${f.channel.id}/branches?cwd=${encodeURIComponent(f.cwd)}`;
  const res = new Response();
  await handleChannelBranchesCollection(req, res, { host: "127.0.0.1", port: 0, maxBodyBytes: 100_000 },
    { getStore(cwd) { assert.equal(cwd, f.cwd); return f.store; } }, f.channel.id);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
function userTurn(f, thread, body, key) {
  return f.store.appendConversationUserTurn({ threadId: thread.id, channelId: f.channel.id,
    title: body, userInstruction: body, idempotencyKey: key,
    payload: { body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
}
test("empty sidebar branch freezes a truthful zero-item origin without inventing a Turn", async t => {
  const f = await fixture(t), result = await create(f);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const child = f.store.getLingThread(result.body.branch.rootThreadId);
  assert.equal(child.surfaceKind, "branch"); assert.equal(child.relationKind, "branch");
  assert.equal(child.parentThreadId, f.root.id); assert.equal(child.parentTurnId, undefined);
  const snapshot = f.store.getConversationContextSnapshot(child.forkContextSnapshotId);
  assert.equal(snapshot.threadId, f.root.id); assert.equal(snapshot.throughItemSequence, 0);
  assert.equal(snapshot.segmentId, undefined); assert.deepEqual(snapshot.summaryIds, []);
  assert.deepEqual(snapshot.sourceRefs, [{ type: "thread", id: f.root.id }]);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.root.id }), []);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getConversationContextSnapshot(snapshot.id), snapshot);
  userTurn(f, f.root, "LATE_PARENT_ONLY", "late-root");
  const input = userTurn(f, child, "CHILD_ONLY", "child");
  const projection = buildConversationContextProjection({ store: f.store, sourceItemId: input.item.id, view: "reply" });
  assert.deepEqual(projection.items.map(i => i.payload.body), ["CHILD_ONLY"]);
});
test("populated sidebar branch captures the current canonical boundary without cloning history", async t => {
  const f = await fixture(t);
  const parent = userTurn(f, f.root, "PARENT_VISIBLE", "parent");
  const answer = f.store.appendConversationItem({ threadId: f.root.id, turnId: parent.turnId,
    kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent", visibility: "channel",
    payload: { body: "PARENT_ANSWER", format: "markdown", streaming: false, deliveryStatus: "ready" } }, now);
  const result = await create(f);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const child = f.store.getLingThread(result.body.branch.rootThreadId);
  assert.equal(child.surfaceKind, "branch"); assert.equal(child.parentTurnId, parent.turnId);
  const snapshot = f.store.getConversationContextSnapshot(child.forkContextSnapshotId);
  assert.equal(snapshot.throughItemSequence, answer.sequence);
  assert.equal(snapshot.segmentId, parent.contextSegmentId);
  assert.deepEqual(f.store.listConversationItemsPage({ threadId: child.id }).items, []);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getConversationContextSnapshot(snapshot.id), snapshot);
  userTurn(f, f.root, "LATE_PARENT_ONLY", "late-parent");
  const input = userTurn(f, child, "CHILD_ONLY", "child");
  const projection = buildConversationContextProjection({ store: f.store, sourceItemId: input.item.id, view: "reply" });
  assert.deepEqual(projection.items.map(i => i.payload.body).sort(), ["CHILD_ONLY", "PARENT_ANSWER", "PARENT_VISIBLE"].sort());
});
test("branch registry failure rolls back its child and snapshot in the same SQLite transaction", async t => {
  const f = await fixture(t);
  const origin = userTurn(f, f.root, "ORIGIN", "origin");
  const branch = f.store.createChannelBranch({ id: "duplicate", channelId: f.channel.id, name: "Existing" }, now);
  const before = f.store.listLingThreads({ channelId: f.channel.id }).length;
  const snapshots = f.store.listConversationContextSnapshots({ threadId: f.root.id }).length;
  assert.throws(() => f.store.createChannelBranch({ id: branch.id, channelId: f.channel.id, name: "Must roll back",
    conversationThread: { surfaceKind: "branch", channelId: f.channel.id, parentThreadId: f.root.id,
      parentTurnId: origin.turnId, title: "Rollback", objective: "Rollback",
      forkContextSnapshot: { segmentId: origin.contextSegmentId, projectionVersion: "fixture-v1",
        throughItemSequence: origin.item.sequence, summaryIds: [],
        sourceRefs: [{ type: "conversation_item", id: origin.item.id }], policyVersion: "fixture-v1" } } }, now));
  assert.equal(f.store.listLingThreads({ channelId: f.channel.id }).length, before);
  assert.equal(f.store.listConversationContextSnapshots({ threadId: f.root.id }).length, snapshots);
  assert.equal(f.store.getChannelBranch(branch.id).name, "Existing");
});
test("a channel branch cannot import a foreign channel origin", async t => {
  const f = await fixture(t), origin = userTurn(f, f.root, "ORIGIN", "origin");
  const other = f.store.createChannel({ name: "Other", boundPath: f.cwd }, now);
  assert.throws(() => f.store.createChannelBranch({ id: "foreign", channelId: other.id, name: "Forbidden",
    conversationThread: { surfaceKind: "branch", channelId: f.channel.id, parentThreadId: f.root.id,
      parentTurnId: origin.turnId, title: "Foreign", objective: "Foreign",
      forkContextSnapshot: { segmentId: origin.contextSegmentId, projectionVersion: "fixture-v1",
        throughItemSequence: origin.item.sequence, summaryIds: [], sourceRefs: [], policyVersion: "fixture-v1" } } }, now),
    /channel/i);
  assert.equal(f.store.getChannelBranch("foreign"), undefined);
});
test("zero-item origins cannot hide existing Turns or Items", async t => {
  const f = await fixture(t);
  userTurn(f, f.root, "NONEMPTY", "origin");
  assert.throws(() => f.store.resolveOrCreateConversationThread({ surfaceKind: "branch", channelId: f.channel.id,
    parentThreadId: f.root.id, title: "Not empty", objective: "Not empty",
    forkContextSnapshot: { projectionVersion: "empty-v1", throughItemSequence: 0,
      sourceRefs: [{ type: "thread", id: f.root.id }], policyVersion: "empty-v1" } }, now), /empty parent/);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.root.id }), []);
});
test("branch watermark and parent Turn cannot refer to different canonical boundaries", async t => {
  const f = await fixture(t), first = userTurn(f, f.root, "FIRST", "first");
  const second = userTurn(f, f.root, "SECOND", "second");
  assert.throws(() => f.store.resolveOrCreateConversationThread({ surfaceKind: "branch", channelId: f.channel.id,
    parentThreadId: f.root.id, parentTurnId: first.turnId, title: "Mismatched", objective: "Mismatched",
    forkContextSnapshot: { segmentId: second.contextSegmentId, projectionVersion: "fixture-v1",
      throughItemSequence: second.item.sequence, sourceRefs: [], policyVersion: "fixture-v1" } }, now), /watermark.*parent turn/);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.root.id }), []);
});
test("an uncommitted-only parent returns a conflict rather than inventing an empty origin", async t => {
  const f = await fixture(t);
  f.store.appendConversationItem({ threadId: f.root.id, channelId: f.channel.id,
    kind: "assistant_message", status: "pending", actorType: "ling_agent", visibility: "channel",
    payload: { body: "PENDING_ONLY", format: "markdown", streaming: true, deliveryStatus: "pending" } }, now);
  const result = await create(f);
  assert.equal(result.status, 409); assert.equal(result.body.error, "branch_context_unavailable");
  assert.deepEqual(f.store.listChannelBranches({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.root.id }), []);
});
