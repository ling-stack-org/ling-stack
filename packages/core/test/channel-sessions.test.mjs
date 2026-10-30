import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { appendChannelItemFixture } from "./channel-conversation-fixture.mjs";

const now = "2026-10-29T01:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-sessions-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Sessions", boundPath: cwd }, now);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const create = (title, key = title) => store.createChannelSession({ channelId: channel.id, title, idempotencyKey: key }, now).session;
  return { cwd, store, channel, create };
}

test("channel creation has one default conversation and independent named threads", async (t) => {
  const { store, channel, create } = await fixture(t);
  const original = store.listChannelSessions(channel.id).defaultSession;
  assert.ok(original?.isDefault);
  const a = create("A"); const b = create("B");
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, original.id);
  const thread = store.getLingThread(a.id);
  assert.equal(thread.surfaceKind, "channel_session");
  assert.equal(thread.relationKind, "root");
  assert.equal(thread.parentThreadId, undefined);
  assert.equal(thread.parentTurnId, undefined);
  assert.equal(thread.forkContextSnapshotId, undefined);
  assert.equal(store.listChannelSessions(channel.id).defaultSession.id, original.id);
  assert.equal(store.listChannelSessions(channel.id).sessions.length, 2);
});

test("creation retry persists across reopen and rejects another payload for the same key", async (t) => {
  const { store, channel, cwd } = await fixture(t);
  const input = { channelId: channel.id, title: "Repeated", idempotencyKey: "first-create" };
  const first = store.createChannelSession(input, now);
  assert.equal(first.idempotentReplay, false);
  const second = createSqliteRunStore(cwd);
  try {
    const replay = second.createChannelSession(input, now);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.session.id, first.session.id);
    assert.throws(() => second.createChannelSession({ ...input, title: "Other" }, now), { code: "session_creation_conflict" });
    assert.equal(second.listChannelSessions(channel.id).sessions.length, 1);
  } finally { second.close(); }
});

test("directory failure rolls back the thread and creation receipt", async (t) => {
  const { store, channel } = await fixture(t);
  const db = new DatabaseSync(store.paths.databasePath);
  try {
    db.exec(`CREATE TRIGGER test_reject_session BEFORE INSERT ON channel_branches
      WHEN NEW.name = 'Rejected' BEGIN SELECT RAISE(ABORT, 'test-directory-failure'); END;`);
    assert.throws(() => store.createChannelSession({ channelId: channel.id, title: "Rejected", idempotencyKey: "rejected" }, now), /test-directory-failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ling_threads WHERE title = 'Rejected'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_session_requests WHERE idempotency_key = 'rejected'").get().n, 0);
    db.exec("DROP TRIGGER test_reject_session");
    assert.equal(store.createChannelSession({ channelId: channel.id, title: "Rejected", idempotencyKey: "rejected" }, now).idempotentReplay, false);
  } finally { db.close(); }
});

test("canonical and legacy title/lifecycle edits agree without changing activity", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = create("Before");
  store.updateChannelSession(channel.id, a.id, { title: "After" }, "2026-10-29T02:00:00.000Z");
  assert.equal(store.getChannelBranch(a.legacyBranchId).name, "After");
  assert.equal(store.getLingThread(a.id).title, "After");
  store.updateChannelBranch(a.legacyBranchId, { name: "Legacy rename" }, "2026-10-29T03:00:00.000Z");
  assert.equal(store.getChannelSession(channel.id, a.id).title, "Legacy rename");
  store.updateLingThread(a.id, { title: "Thread rename" }, "2026-10-29T04:00:00.000Z");
  assert.equal(store.getChannelBranch(a.legacyBranchId).name, "Thread rename");
  assert.equal(store.getChannelSession(channel.id, a.id).activityAt, a.activityAt);
  store.updateChannelSession(channel.id, a.id, { archived: true }, now);
  assert.equal(store.listChannelSessions(channel.id).sessions.length, 0);
  assert.equal(store.listChannelSessions(channel.id, { archived: true }).sessions[0].id, a.id);
  assert.equal(store.getChannelBranch(a.legacyBranchId).status, "archived");
  store.updateChannelSession(channel.id, a.id, { archived: false }, now);
  assert.equal(store.listChannelSessions(channel.id).sessions[0].id, a.id);
  const root = store.listChannelSessions(channel.id).defaultSession;
  assert.throws(() => store.updateChannelSession(channel.id, root.id, { archived: true }, now), { code: "default_session_required" });
});

test("first user message names only a placeholder and remains in its own history", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = store.createChannelSession({ channelId: channel.id, idempotencyKey: "blank" }, now).session;
  const b = create("Manual title");
  appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Fix   the login\nDetails" }, now);
  appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "Other request" }, now);
  assert.equal(store.getChannelSession(channel.id, a.id).title, "Fix the login");
  assert.equal(store.getChannelSession(channel.id, b.id).title, "Manual title");
  assert.deepEqual(store.listConversationItemsPage({ threadId: a.id }).items.map((i) => i.payload.body), ["Fix   the login\nDetails"]);
  assert.deepEqual(store.listConversationItemsPage({ threadId: b.id }).items.map((i) => i.payload.body), ["Other request"]);
});

test("notification revisions cover a late streaming completion but not token replay or private items", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = create("Stream");
  const user = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Start" }, now);
  const reply = store.appendConversationItem({ channelId: channel.id, threadId: a.id, turnId: user.turnId,
    kind: "assistant_message", status: "pending", actorType: "ling_agent", visibility: "channel",
    payload: { body: "", format: "plain_text", streaming: true, deliveryStatus: "pending", presentationRole: "narration" } }, now);
  const db = new DatabaseSync(store.paths.databasePath);
  try {
    const update = (payload) => db.prepare("UPDATE conversation_items SET payload_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(payload), payload.streaming ? "pending" : "committed", "2026-10-29T01:01:00.000Z", reply.id);
    update({ ...reply.payload, body: "Hello" });
    const first = store.getChannelSession(channel.id, a.id).latestNotificationRevision;
    assert.equal(first, 1);
    update({ ...reply.payload, body: "Hello world" });
    assert.equal(store.getChannelSession(channel.id, a.id).latestNotificationRevision, first);
    const final = { ...reply.payload, body: "Hello world", streaming: false, deliveryStatus: "ready" };
    update(final);
    const completed = store.getChannelSession(channel.id, a.id).latestNotificationRevision;
    assert.equal(completed, first + 1);
    update(final);
    assert.equal(store.getChannelSession(channel.id, a.id).latestNotificationRevision, completed);
    store.appendConversationItem({ channelId: channel.id, threadId: a.id, turnId: user.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "operator",
      payload: final }, now);
    assert.equal(store.getChannelSession(channel.id, a.id).latestNotificationRevision, completed);
  } finally { db.close(); }
});

test("notification guards exclude private, unrelated and malformed payloads before decoding", async (t) => {
  const { store, channel, create } = await fixture(t);
  const session = create("Guarded notifications");
  const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: session.id, authorType: "local-user", body: "Start" }, now);
  const db = new DatabaseSync(store.paths.databasePath);
  try {
    for (const visibility of ["operator", "agent_private", "channel"]) {
      const item = store.appendConversationItem({ channelId: channel.id, threadId: session.id, turnId: source.turnId,
        kind: "assistant_message", status: "pending", actorType: "ling_agent", visibility,
        ...(visibility === "agent_private" ? { visibilityOwnerId: "other-agent" } : {}),
        payload: { body: "", format: "plain_text", streaming: true, deliveryStatus: "pending", presentationRole: "narration" } }, now);
      const before = store.getChannelSession(channel.id, session.id).latestNotificationRevision;
      assert.doesNotThrow(() => db.prepare("UPDATE conversation_items SET payload_json='invalid-json' WHERE id=?").run(item.id));
      assert.equal(store.getChannelSession(channel.id, session.id).latestNotificationRevision, before);
    }
  } finally { db.close(); }
});

test("new workflow, work-thread Run and WorkUnit activity reorder A/B without maintenance writes", async (t) => {
  const { store, channel, create, cwd } = await fixture(t);
  const a = create("A"); const b = create("B");
  const time = (minute) => `2026-10-29T01:${String(minute).padStart(2, "0")}:00.000Z`;
  const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "A source" }, now);
  const bSource = appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "B is newer" }, time(1));
  const bWorkflow = store.createChannelWorkflow({ channelId: channel.id, title: "Older B workflow", objective: "B",
    createdBy: "test", metadata: { sourceTurnId: bSource.turnId } }, time(1));
  const order = () => store.listChannelSessions(channel.id).sessions.map((session) => session.id);
  assert.deepEqual(order(), [b.id, a.id]);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "A preflight", objective: "A",
    status: "waiting_for_approval", createdBy: "test", metadata: { sourceTurnId: source.turnId } }, time(2));
  assert.deepEqual(order(), [a.id, b.id]);
  assert.equal(store.getChannelSession(channel.id, a.id).activityAt, time(2));
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "A step", prompt: "Work",
    toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, time(2));
  const workThread = store.createLingThread({ channelId: channel.id, kind: "channel_discussion", title: "A execution",
    objective: "Work", workflowId: workflow.id, workflowStepId: step.id, surfaceKind: "work" }, time(2));
  appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "B next" }, time(3));
  assert.deepEqual(order(), [b.id, a.id]);
  store.createRun({ id: "activity-work-thread-run", cwd, taskId: "snapshot", channelId: channel.id,
    threadId: workThread.id, workflowStepId: step.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: time(4) });
  assert.deepEqual(order(), [a.id, b.id]);
  assert.equal(store.getChannelSession(channel.id, a.id).activityAt, time(4));
  appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "B again" }, time(5));
  assert.deepEqual(order(), [b.id, a.id]);
  store.createWorkUnit({ workspaceId: "workspace_default", kind: "task_run", ownerType: "workflow_step", ownerId: step.id,
    channelId: channel.id, idempotencyKey: "activity-work-unit", createdByActor: "user", request: {}, now: time(6) });
  assert.deepEqual(order(), [a.id, b.id]);
  assert.equal(store.getChannelSession(channel.id, a.id).activityAt, time(6));
  store.updateChannelSession(channel.id, b.id, { title: "Renamed B" }, time(7));
  store.updateChannelWorkflow(bWorkflow.id, { title: "Maintenance B" }, time(8));
  assert.deepEqual(order(), [a.id, b.id]);
  assert.equal(store.getChannelSession(channel.id, b.id).activityAt, time(5));
});

test("sessions paginate without duplicating the default and reject a cross-query cursor", async (t) => {
  const { store, channel, create } = await fixture(t);
  for (let i = 0; i < 13; i++) create(`Work ${i}`);
  const first = store.listChannelSessions(channel.id, { limit: 10 });
  assert.equal(first.sessions.length, 10);
  const next = store.listChannelSessions(channel.id, { limit: 10, cursor: first.nextCursor });
  assert.equal(next.sessions.length, 3);
  assert.equal(new Set([...first.sessions, ...next.sessions].map((s) => s.id)).size, 13);
  assert.equal(first.defaultSession.id, next.defaultSession.id);
  assert.throws(() => store.listChannelSessions(channel.id, { q: "other", cursor: first.nextCursor }), { code: "invalid_session_cursor" });
  assert.equal(store.listChannelSessions(channel.id, { q: "Work 12" }).sessions.length, 1);
});

test("channel status and source identity restrict session mutation", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = create("A");
  const other = store.createChannel({ name: "Other" }, now);
  assert.equal(store.getChannelSession(other.id, a.id), undefined);
  assert.throws(() => store.updateChannelSession(other.id, a.id, { title: "Hijack" }, now), { code: "channel_session_not_found" });
  store.updateChannel(channel.id, { status: "paused" }, now);
  assert.throws(() => create("Paused"), { code: "channel_not_active" });
  store.updateChannel(channel.id, { status: "archived" }, now);
  assert.throws(() => store.updateChannelSession(channel.id, a.id, { title: "Archived rename" }, now), { code: "channel_archived" });
});

test("generic rename owns placeholder and generic archive blocks subsequent input and Run creation", async (t) => {
  const { store, channel, cwd } = await fixture(t);
  const a = store.createChannelSession({ channelId: channel.id, idempotencyKey: "generic" }, now).session;
  store.updateLingThread(a.id, { title: "Manually chosen" }, now);
  appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Never overwrite the title" }, now);
  assert.equal(store.getLingThread(a.id).title, "Manually chosen");
  store.updateLingThread(a.id, { status: "archived" }, now);
  assert.equal(store.getChannelBranch(a.legacyBranchId).status, "archived");
  assert.throws(() => appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id,
    authorType: "local-user", body: "A late send" }, now), /archived/);
  assert.throws(() => store.createRun({ id: "late-run", cwd, taskId: "late-run-snapshot", channelId: channel.id,
    threadId: a.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: now }), /archived/);
  assert.equal(store.getRun("late-run"), undefined);
  store.updateLingThread(a.id, { archivedAt: null }, now);
  assert.equal(store.getChannelBranch(a.legacyBranchId).status, "active");
});

test("queued work and pending approval veto both new and compatibility archive/delete paths", async (t) => {
  const { store, channel, create, cwd } = await fixture(t);
  const a = create("Active");
  const run = store.createRun({ id: "active-run", cwd, taskId: "snapshot", channelId: channel.id,
    threadId: a.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: now });
  for (const mutate of [
    () => store.updateChannelSession(channel.id, a.id, { archived: true }, now),
    () => store.updateLingThread(a.id, { archivedAt: now }, now),
    () => store.updateChannelBranch(a.legacyBranchId, { status: "archived" }, now),
    () => store.deleteChannelBranch(a.legacyBranchId),
  ]) assert.throws(mutate, { code: "session_has_active_work" });
  store.markRunCancelled(run.id, now);
  const approval = store.createApprovalRequest({ runId: run.id, taskId: "snapshot", channelId: channel.id,
    toolCallId: "approval", actionType: "command", risk: "high", title: "Approve command", description: "Approval",
    payload: {} }, now);
  assert.equal(store.getChannelSession(channel.id, a.id).pendingApprovalCount, 1);
  assert.throws(() => store.updateChannelSession(channel.id, a.id, { archived: true }, now), { code: "session_has_active_work" });
  const db = new DatabaseSync(store.paths.databasePath);
  try { db.prepare("UPDATE approval_requests SET status = 'denied' WHERE id = ?").run(approval.id); } finally { db.close(); }
  store.updateChannelSession(channel.id, a.id, { archived: true }, now);
  assert.equal(store.getChannelBranch(a.legacyBranchId).status, "archived");
});

test("explicit empty directory repair is idempotent and does not change directory identity", async (t) => {
  const { store, channel } = await fixture(t);
  const branch = store.createChannelBranch({ channelId: channel.id, name: "Old empty directory" }, now);
  assert.ok(store.listChannelSessions(channel.id).diagnostics.find((d) => d.branchId === branch.id));
  const before = store.listLingThreads({ channelId: channel.id }).length;
  const session = store.repairChannelSessionDirectory(channel.id, branch.id, now);
  assert.equal(session.legacyBranchId, branch.id);
  assert.equal(store.repairChannelSessionDirectory(channel.id, branch.id, now).id, session.id);
  assert.equal(store.listLingThreads({ channelId: channel.id }).length, before + 1);
  assert.equal(store.listChannelSessions(channel.id).diagnostics.length, 0);
  const other = store.createChannelBranch({ channelId: channel.id, name: "Ambiguous directory" }, now);
  const orphan = store.createLingThread({ channelId: channel.id, kind: "channel_discussion", title: "Orphan history", objective: "History", surfaceKind: "work" }, now);
  appendChannelItemFixture(store, { channelId: channel.id, threadId: orphan.id, authorType: "local-user", body: "Existing history" }, now);
  assert.throws(() => store.repairChannelSessionDirectory(channel.id, other.id, now), { code: "session_requires_repair" });
  assert.equal(store.getChannelBranch(other.id).rootThreadId, undefined);
});

test("notification reconciliation covers sessions beyond a filtered preview", async (t) => {
  const { store, channel, create } = await fixture(t);
  for (let i = 0; i < 12; i++) create(`Session ${i}`);
  const response = store.listChannelSessions(channel.id, { limit: 1, q: "Session 1" });
  assert.equal(response.sessions.length, 1);
  assert.equal(response.notificationWatermarks.length, 13);
  assert.equal(new Set(response.notificationWatermarks.map((s) => s.id)).size, 13);
});

test("dispatch admission and session archive cannot pass one another", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = create("Dispatch");
  const user = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Dispatch next" }, now);
  const input = { workspaceId: "workspace_default", kind: "channel_turn_dispatch", ownerType: "ling_turn", ownerId: user.turnId,
    channelId: channel.id, idempotencyKey: "archive-race", createdByActor: "user", request: {}, now };
  store.updateChannelSession(channel.id, a.id, { archived: true }, now);
  assert.throws(() => store.createWorkUnit(input), /channel_session_archived/);
  store.updateChannelSession(channel.id, a.id, { archived: false }, now);
  store.createWorkUnit(input);
  assert.throws(() => store.updateChannelSession(channel.id, a.id, { archived: true }, now), { code: "session_has_active_work" });
});

test("archiving a failed dispatch rejects retry until its original session is restored", async (t) => {
  const { store, channel, create } = await fixture(t);
  const a = create("Failed dispatch");
  const user = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Retry source" }, now);
  const work = store.createWorkUnit({ workspaceId: "workspace_default", kind: "channel_turn_dispatch", ownerType: "ling_turn",
    ownerId: user.turnId, channelId: channel.id, idempotencyKey: "retry-archive", createdByActor: "user", request: {}, now });
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: work.id, expectedStatus: "queued", event: "runner_failed", actor: "system", now }).ok, true);
  store.updateChannelSession(channel.id, a.id, { archived: true }, now);
  const retry = { workUnitId: work.id, expectedStatus: "failed", event: "retry", actor: "local-user", now };
  assert.deepEqual(store.transitionWorkUnitStatus(retry), { ok: false, code: "terminal_state", currentStatus: "failed" });
  assert.equal(store.getWorkUnit(work.id).status, "failed");
  store.updateChannelSession(channel.id, a.id, { archived: false }, now);
  assert.equal(store.transitionWorkUnitStatus(retry).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: work.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
});

test("aggregate approvals deduplicate explicit references across sessions", async (t) => {
  const { store, channel, create, cwd } = await fixture(t);
  const a = create("Approval source"); const b = create("Approval reference");
  const run = store.createRun({ id: "referenced-run", cwd, taskId: "snapshot", channelId: channel.id,
    threadId: a.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const approval = store.createApprovalRequest({ runId: run.id, taskId: "snapshot", channelId: channel.id, toolCallId: "shared-approval",
    actionType: "command", risk: "high", title: "Approve", description: "Approval", payload: {} }, now);
  const user = appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "Reference the approval" }, now);
  store.appendConversationItem({ channelId: channel.id, threadId: b.id, turnId: user.turnId,
    kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
    payload: { body: "Requires approval", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "narration" },
    domainRefs: [{ type: "approval", id: approval.id }] }, now);
  assert.equal(store.getChannelSession(channel.id, a.id).pendingApprovalCount, 1);
  assert.equal(store.getChannelSession(channel.id, b.id).pendingApprovalCount, 1);
  assert.deepEqual(store.getChannelSession(channel.id, a.id).activeRunIds, [run.id]);
  assert.deepEqual(store.getChannelSession(channel.id, a.id).pendingApprovalIds, [approval.id]);
  assert.deepEqual(store.getChannelSession(channel.id, b.id).pendingApprovalIds, [approval.id]);
  assert.equal(store.listChannelSessions(channel.id).aggregate.pendingApprovalCount, 1);
});

test("default session creation failure rolls back the channel and membership bootstrap", async (t) => {
  const { store } = await fixture(t);
  const db = new DatabaseSync(store.paths.databasePath);
  try {
    db.exec(`CREATE TRIGGER test_reject_default BEFORE INSERT ON ling_threads WHEN NEW.channel_id = 'channel-rollback'
      BEGIN SELECT RAISE(ABORT, 'reject-default'); END;`);
    assert.throws(() => store.createChannel({ id: "channel-rollback", name: "Rollback channel" }, now), /reject-default/);
    assert.equal(store.getChannel("channel-rollback"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM teammate_channel_memberships WHERE channel_id = 'channel-rollback'").get().n, 0);
    db.exec("DROP TRIGGER test_reject_default");
    const channel = store.createChannel({ id: "channel-rollback", name: "Rollback channel" }, now);
    assert.ok(store.listChannelSessions(channel.id).defaultSession);
  } finally { db.close(); }
});

test("legacy soft and permanent directory deletion retain archived history without rediscovery", async (t) => {
  const { store, channel, create } = await fixture(t);
  const session = create("Delete safely");
  appendChannelItemFixture(store, { channelId: channel.id, threadId: session.id, authorType: "local-user", body: "Keep this source history" }, now);
  store.updateChannelBranch(session.legacyBranchId, { deletedAt: now }, now);
  assert.equal(store.getChannelSession(channel.id, session.id), undefined);
  assert.ok(store.getLingThread(session.id).archivedAt);
  assert.equal(store.deleteChannelBranch(session.legacyBranchId), true);
  assert.equal(store.listChannelSessions(channel.id, { archived: true }).sessions.length, 0);
  assert.equal(store.listConversationItemsPage({ threadId: session.id }).items[0].payload.body, "Keep this source history");
});

test("a delayed approval cannot reintroduce waiting work into an archived conversation", async (t) => {
  const { store, channel, create, cwd } = await fixture(t);
  const session = create("Delayed approval");
  const run = store.createRun({ id: "closed-run", cwd, taskId: "snapshot", channelId: channel.id, threadId: session.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.markRunCancelled(run.id, now);
  store.updateChannelSession(channel.id, session.id, { archived: true }, now);
  assert.throws(() => store.createApprovalRequest({ runId: run.id, taskId: "snapshot", channelId: channel.id,
    toolCallId: "late-approval", actionType: "command", risk: "high", title: "Too late", description: "Approval", payload: {} }, now), /channel_session_archived/);
  assert.equal(store.getChannelSession(channel.id, session.id).pendingApprovalCount, 0);
});

for (const sourceKey of ["sourceTurnId", "sourceMessageId"]) {
  test(`workflow preflight without a Run uses ${sourceKey} for approvals, archive conflicts, and new execution admission`, async (t) => {
    const { store, channel, create, cwd } = await fixture(t);
    const a = create("Workflow source"); const b = create("Unrelated session");
    const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Run this workflow" }, now);
    const metadata = { [sourceKey]: sourceKey === "sourceTurnId" ? source.turnId : source.id };
    const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Preflight", objective: "Check before running",
      createdBy: "test", status: "waiting_for_approval", metadata }, now);
    const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Preflight step", prompt: "Wait for approval",
      toParticipantId: "ling_agent", toParticipantLabel: "Ling", status: "waiting_for_approval" }, now);
    const executionThread = store.createLingThread({ channelId: channel.id, kind: "channel_discussion", title: "Workflow work",
      objective: "Workflow work", workflowId: workflow.id, workflowStepId: step.id, surfaceKind: "work" }, now);
    const input = { workflowStepId: step.id, channelId: channel.id, toolCallId: "preflight", actionType: "workflow_step", risk: "high",
      title: "Approve workflow", description: "Preflight without a Run", payload: { type: "workflow_step", workflowStepId: step.id } };
    const approval = store.createApprovalRequest(input, now);
    assert.equal(store.getChannelSession(channel.id, a.id).pendingApprovalCount, 1);
    assert.deepEqual(store.getChannelSession(channel.id, a.id).pendingApprovalIds, [approval.id]);
    assert.deepEqual(store.getChannelSession(channel.id, a.id).activeRunIds, []);
    assert.equal(store.getChannelSession(channel.id, a.id).runtimeState, "waiting");
    assert.equal(store.getChannelSession(channel.id, b.id).pendingApprovalCount, 0);
    assert.deepEqual(store.getChannelSession(channel.id, b.id).pendingApprovalIds, []);
    assert.deepEqual(store.getChannelSession(channel.id, b.id).activeRunIds, []);
    assert.equal(store.getChannelSession(channel.id, b.id).runtimeState, "idle");
    assert.equal(store.listChannelSessions(channel.id).aggregate.pendingApprovalCount, 1);
    // A workflow may execute in a separate work Thread; actions still belong to its original session.
    const run = store.createRun({ id: `workflow-child-${sourceKey}`, cwd, taskId: "snapshot", channelId: channel.id,
      threadId: executionThread.id, workflowStepId: step.id, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    assert.deepEqual(store.getChannelSession(channel.id, a.id).activeRunIds, [run.id]);
    assert.deepEqual(store.getChannelSession(channel.id, b.id).activeRunIds, []);
    store.markRunCancelled(run.id, now);
    assert.throws(() => store.updateChannelSession(channel.id, a.id, { archived: true }, now), { code: "session_has_active_work" });
    const db = new DatabaseSync(store.paths.databasePath);
    try {
      db.prepare("UPDATE approval_requests SET status = 'denied' WHERE id = ?").run(approval.id);
      // Workflow lifecycle alone still owns active work even without an Approval or Run.
      assert.throws(() => store.updateChannelSession(channel.id, a.id, { archived: true }, now), { code: "session_has_active_work" });
      store.updateChannelWorkflow(workflow.id, { status: "cancelled" }, now);
      store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now);
      store.updateChannelSession(channel.id, a.id, { archived: true }, now);
      assert.throws(() => store.createApprovalRequest({ ...input, toolCallId: "late-preflight" }, now), /channel_session_archived/);
      assert.throws(() => store.createRun({ id: `late-workflow-${sourceKey}`, cwd, taskId: "snapshot", channelId: channel.id,
        threadId: executionThread.id, workflowStepId: step.id, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now }), /archived/);
      assert.throws(() => store.createChannelWorkflow({ channelId: channel.id, title: "Late workflow", objective: "Late workflow",
        createdBy: "test", metadata }, now), /channel_session_archived/);
      assert.throws(() => store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Late step", prompt: "Late step",
        toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now), /channel_session_archived/);
      assert.throws(() => store.createWorkUnit({ workspaceId: "workspace_default", kind: "task_run", ownerType: "workflow_step",
        ownerId: step.id, channelId: channel.id, idempotencyKey: "late-workflow-unit", createdByActor: "user", request: {}, now }), /channel_session_archived/);
    } finally { db.close(); }
  });
}

test("missing directory cannot acquire a foreign thread through the generic compatibility PATCH", async (t) => {
  const { store, channel } = await fixture(t);
  const other = store.createChannel({ name: "Other channel" }, now);
  const branch = store.createChannelBranch({ channelId: channel.id, name: "Unmapped" }, now);
  const foreign = store.createLingThread({ channelId: other.id, kind: "channel_discussion", title: "Foreign work", objective: "Foreign work", surfaceKind: "work" }, now);
  assert.throws(() => store.updateChannelBranch(branch.id, { rootThreadId: foreign.id }, now), { code: "session_mapping_immutable" });
  assert.equal(store.getChannelBranch(branch.id).rootThreadId, undefined);
  assert.ok(store.listChannelSessions(channel.id).diagnostics.some((d) => d.branchId === branch.id));
});

test("late text and completion of a superseded response do not create unread notifications", async (t) => {
  const { store, channel, create } = await fixture(t);
  const session = create("Replaced request");
  const message = appendChannelItemFixture(store, { channelId: channel.id, threadId: session.id, authorType: "local-user", body: "Old request" }, now);
  const reply = store.appendConversationItem({ channelId: channel.id, threadId: session.id, turnId: message.turnId,
    kind: "assistant_message", status: "pending", actorType: "ling_agent", visibility: "channel",
    payload: { body: "", format: "plain_text", streaming: true, deliveryStatus: "pending", presentationRole: "narration" } }, now);
  const content = { mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] };
  store.commitConversationMessageEdit({ surface: "channel_branch", ownerId: channel.id, laneId: session.id,
    messageId: message.id, expectedRevision: 1, current: { body: message.body, ...content },
    replacement: { body: "Replacement request", ...content }, sourceTurnId: message.turnId, supersededTurnId: message.turnId,
    supersededRunIds: [], supersededResponseMessageIds: [reply.id], idempotencyKey: "replace-before-late-response" }, now);
  const revision = store.getChannelSession(channel.id, session.id).latestNotificationRevision;
  store.updatePendingConversationItem(reply.id, { expectedRevision: reply.revision, payload: { ...reply.payload, body: "Hidden late answer" } }, now);
  assert.equal(store.getChannelSession(channel.id, session.id).latestNotificationRevision, revision);
  const db = new DatabaseSync(store.paths.databasePath);
  try {
    db.prepare("UPDATE conversation_items SET payload_json = ?, status = 'committed' WHERE id = ?")
      .run(JSON.stringify({ ...reply.payload, body: "Hidden late answer", streaming: false, deliveryStatus: "ready" }), reply.id);
    assert.equal(store.getChannelSession(channel.id, session.id).latestNotificationRevision, revision);
  } finally { db.close(); }
});
