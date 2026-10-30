import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyChannelSessionMigration } from "../dist/storage/sqlite/channel-session-migration.js";

const now = "2026-10-29T01:00:00.000Z";
const later = "2026-10-29T02:00:00.000Z";
const payload = (body) => ({ body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });
async function fixture(t, depth = 2) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-session-topic-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Topic sessions" }, now);
  const session = store.createChannelSession({ channelId: channel.id, title: "Owner" }, now).session;
  const input = (threadId, key, dispatch = false) => ({ channelId: channel.id, threadId, title: key,
    userInstruction: key, payload: payload(key), idempotencyKey: key,
    ...(dispatch ? { dispatch: { schemaVersion: 1, requestAiReply: true } } : {}) });
  const append = (threadId, key, dispatch = false) => store.appendConversationUserTurn(input(threadId, key, dispatch), now);
  const anchor = append(session.id, "anchor");
  let topic = store.getLingThread(session.id);
  let source = anchor;
  for (let i = 0; i < depth; i++) {
    topic = store.resolveOrCreateConversationThread({ channelId: channel.id, surfaceKind: "topic",
      anchorItemId: source.item.id, title: `Topic ${i}`, objective: "Topic work" }, now).thread;
    source = append(topic.id, `topic-source-${i}`);
  }
  const runInput = (id, threadId = topic.id, extra = {}) => ({ id, cwd, taskId: "snapshot", channelId: channel.id,
    threadId, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: now, ...extra });
  const workInput = (key, extra = {}) => ({ workspaceId: "workspace_default", channelId: channel.id,
    kind: "channel_turn_dispatch", ownerType: "ling_turn", ownerId: source.turnId,
    idempotencyKey: key, createdByActor: "user", request: {}, now, ...extra });
  const archive = () => store.updateChannelSession(channel.id, session.id, { archived: true }, later);
  const restore = () => store.updateChannelSession(channel.id, session.id, { archived: false }, later);
  return { cwd, store, channel, session, topic, source, anchor, input, append, runInput, workInput, archive, restore };
}

for (const depth of [1, 2]) {
  test(`topic depth ${depth} owns queued/running work, rejects archived sends and retries, and restores`, async (t) => {
    const f = await fixture(t, depth);
    const turn = f.append(f.topic.id, "dispatch", true);
    const workId = turn.dispatchWorkUnitId;
    assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).runtimeState, "queued");
    assert.throws(f.archive, { code: "session_has_active_work" });
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: workId, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: workId, expectedStatus: "claimed", event: "runner_started", actor: "system", now }).ok, true);
    assert.throws(f.archive, { code: "session_has_active_work" });
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: workId, expectedStatus: "running", event: "runner_failed", actor: "system", now }).ok, true);
    f.archive();
    assert.throws(() => f.append(f.topic.id, "after-archive", true), /archived/);
    assert.throws(() => f.append(f.topic.id, "dispatch", true), /archived/);
    assert.throws(() => f.store.createLingTurn({ threadId: f.topic.id, kind: "manual_followup", title: "Bypass",
      userInstruction: "Bypass", createdByActor: "local-user" }, now), /archived/);
    const retry = { workUnitId: workId, expectedStatus: "failed", event: "retry", actor: "local-user", now };
    assert.equal(f.store.transitionWorkUnitStatus(retry).ok, false);
    assert.equal(f.store.getWorkUnit(workId).status, "failed");
    f.restore();
    assert.doesNotThrow(() => f.append(f.topic.id, "restored"));
    assert.equal(f.store.transitionWorkUnitStatus(retry).ok, true);
  });
}

test("topic Runs and approvals belong to the session and all delayed writers reject its archive", async (t) => {
  const f = await fixture(t);
  const run = f.store.createRun(f.runInput("topic-run"));
  f.store.markRunRunning(run.id, now);
  assert.deepEqual(f.store.getChannelSession(f.channel.id, f.session.id).activeRunIds, [run.id]);
  assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).runtimeState, "running");
  assert.throws(f.archive, { code: "session_has_active_work" });
  f.store.markRunCancelled(run.id, now);
  const approvalInput = { runId: run.id, taskId: "snapshot", channelId: f.channel.id, toolCallId: "approve-topic",
    actionType: "command", risk: "high", title: "Approve", description: "Topic approval", payload: {} };
  const approval = f.store.createApprovalRequest(approvalInput, now);
  assert.deepEqual(f.store.getChannelSession(f.channel.id, f.session.id).pendingApprovalIds, [approval.id]);
  assert.throws(f.archive, { code: "session_has_active_work" });
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.prepare("UPDATE approval_requests SET status='denied' WHERE id=?").run(approval.id);
  f.archive();
  assert.throws(() => f.store.createRun(f.runInput("late-topic-run")), /archived/);
  assert.throws(() => f.store.createApprovalRequest({ ...approvalInput, toolCallId: "late-topic-approval" }, now), /channel_session_archived/);
  assert.throws(() => f.store.createWorkUnit(f.workInput("late-topic-work")), /channel_session_archived/);
  assert.throws(() => f.store.createWorkUnit(f.workInput("late-topic-message", { ownerType: "channel", ownerId: f.channel.id,
    linkedMessageId: f.source.item.id })), /channel_session_archived/);
  f.restore();
  assert.ok(f.store.createRun(f.runInput("restored-topic-run")));
});

for (const sourceKey of ["sourceTurnId", "sourceMessageId"]) {
  test(`nested topic ${sourceKey} follows workflow execution back to its owning session`, async (t) => {
    const f = await fixture(t);
    const metadata = { [sourceKey]: sourceKey === "sourceTurnId" ? f.source.turnId : f.source.item.id };
    const workflowInput = { channelId: f.channel.id, title: "Topic workflow", objective: "Topic work", createdBy: "test", metadata };
    const workflow = f.store.createChannelWorkflow(workflowInput, now);
    const stepInput = { workflowId: workflow.id, title: "Step", prompt: "Work", toParticipantId: "ling_agent", toParticipantLabel: "Ling" };
    const step = f.store.createChannelWorkflowStep(stepInput, now);
    const execution = f.store.createLingThread({ channelId: f.channel.id, kind: "channel_discussion", title: "Workflow execution",
      objective: "Work", workflowId: workflow.id, workflowStepId: step.id, surfaceKind: "work" }, now);
    const workSource = f.append(execution.id, "execution-source");
    const executionTopic = f.store.resolveOrCreateConversationThread({ channelId: f.channel.id, surfaceKind: "topic",
      anchorItemId: workSource.item.id, title: "Execution topic", objective: "Nested execution" }, now).thread;
    const run = f.store.createRun(f.runInput(`workflow-${sourceKey}`, executionTopic.id));
    assert.deepEqual(f.store.getChannelSession(f.channel.id, f.session.id).activeRunIds, [run.id]);
    const approvalInput = { workflowStepId: step.id, channelId: f.channel.id, toolCallId: "preflight",
      actionType: "workflow_step", risk: "high", title: "Approve", description: "Preflight", payload: {} };
    const approval = f.store.createApprovalRequest(approvalInput, now);
    assert.deepEqual(f.store.getChannelSession(f.channel.id, f.session.id).pendingApprovalIds, [approval.id]);
    assert.throws(f.archive, { code: "session_has_active_work" });
    f.store.markRunCancelled(run.id, now);
    f.store.updateChannelWorkflow(workflow.id, { status: "cancelled" }, now);
    f.store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now);
    const db = new DatabaseSync(f.store.paths.databasePath);
    t.after(() => db.close());
    db.prepare("UPDATE approval_requests SET status='denied' WHERE id=?").run(approval.id);
    f.archive();
    assert.throws(() => f.append(executionTopic.id, "late-execution-topic"), /archived/);
    assert.throws(() => f.store.createRun(f.runInput(`late-workflow-${sourceKey}`, execution.id, { workflowStepId: step.id })), /archived/);
    assert.throws(() => f.store.createChannelWorkflow(workflowInput, now), /channel_session_archived/);
    assert.throws(() => f.store.createChannelWorkflowStep(stepInput, now), /channel_session_archived/);
    assert.throws(() => f.store.createWorkUnit(f.workInput("late-step", { ownerType: "workflow_step", ownerId: step.id })), /channel_session_archived/);
    assert.throws(() => f.store.createApprovalRequest({ ...approvalInput, toolCallId: "late-preflight" }, now), /channel_session_archived/);
  });
}

test("topic input waits block parent archive and cannot be reactivated after it is archived", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  // A projection-only fixture isolates wait ownership from unrelated runner fencing logic.
  db.prepare(`INSERT INTO user_input_requests(request_id,workspace_id,thread_id,request_version,status_revision,status,
    source_run_id,source_attempt_id,tool_call_id,idempotency_key,input_fingerprint,source_json,source_fingerprint,
    tool_input_json,item_id,created_at,updated_at,wait_status,wait_revision)
    VALUES('topic-wait','workspace_default',?,1,1,'pending','closed-run','closed-attempt','wait','wait','test','{}','test','{}',?,?,?,'waiting',1)`)
    .run(f.topic.id, f.source.item.id, now, now);
  assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).runtimeState, "waiting");
  assert.throws(f.archive, { code: "session_has_active_work" });
  db.exec("UPDATE user_input_requests SET wait_status='cancelled' WHERE request_id='topic-wait'");
  f.archive();
  assert.throws(() => db.exec("UPDATE user_input_requests SET wait_status='resuming' WHERE request_id='topic-wait'"), /channel_session_archived/);
  f.restore();
  assert.doesNotThrow(() => db.exec("UPDATE user_input_requests SET wait_status='resuming' WHERE request_id='topic-wait'"));
});

test("a true fork and its topic stay independent from the archived ancestor session", async (t) => {
  const f = await fixture(t);
  const fork = f.store.resolveOrCreateConversationThread({ channelId: f.channel.id, surfaceKind: "branch",
    parentThreadId: f.session.id, parentTurnId: f.anchor.turnId, title: "Independent fork", objective: "Fork",
    forkContextSnapshot: { id: "topic-fork-snapshot", segmentId: f.anchor.contextSegmentId,
      projectionVersion: "ctxv2_branch_runtime", throughItemSequence: f.anchor.item.sequence, summaryIds: [],
      sourceRefs: [{ type: "conversation_item", id: f.anchor.item.id }], policyVersion: "continuity-v2-snapshot-v1" } }, now).thread;
  f.store.createChannelBranch({ channelId: f.channel.id, name: "Fork", rootThreadId: fork.id }, now);
  const forkSource = f.append(fork.id, "fork-anchor");
  const topic = f.store.resolveOrCreateConversationThread({ channelId: f.channel.id, surfaceKind: "topic",
    anchorItemId: forkSource.item.id, title: "Fork topic", objective: "Fork work" }, now).thread;
  const forkDispatch = f.append(topic.id, "fork-dispatch", true);
  f.store.appendConversationItem({ channelId: f.channel.id, threadId: topic.id, turnId: forkDispatch.turnId,
    kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
    payload: { body: "Fork topic result", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" } }, later);
  assert.equal(f.store.getChannelSession(f.channel.id, fork.id).latestNotificationRevision, 1);
  assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).latestNotificationRevision, 0);
  assert.equal(f.store.getChannelSession(f.channel.id, fork.id).activityAt, later);
  assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).activityAt, now);
  assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).runtimeState, "idle");
  f.archive();
  assert.doesNotThrow(() => f.append(topic.id, "fork-after-parent-archive", true));
  assert.throws(() => f.store.updateChannelSession(f.channel.id, fork.id, { archived: true }, now), { code: "session_has_active_work" });
});

test("topic ancestry fails closed for cross-channel, cross-workspace and cyclic parents", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  const other = f.store.createChannel({ name: "Other" }, now);
  const foreign = f.store.createChannelSession({ channelId: other.id, title: "Other owner" }, now).session;
  const originalParent = f.store.getLingThread(f.topic.id).parentThreadId;
  db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(foreign.id, f.topic.id);
  assert.throws(() => f.append(f.topic.id, "foreign-channel"), /lineage/);
  db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(originalParent, f.topic.id);
  db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('foreign-workspace','Foreign',?,?)").run(now, now);
  db.prepare("UPDATE ling_threads SET workspace_id='foreign-workspace' WHERE id=?").run(originalParent);
  assert.throws(() => f.append(f.topic.id, "foreign-workspace"), /lineage/);
  db.prepare("UPDATE ling_threads SET workspace_id='workspace_default' WHERE id=?").run(originalParent);
  db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(f.topic.id, originalParent);
  assert.throws(() => f.append(f.topic.id, "cycle"), /lineage/);
});

test("migration180 upgrades existing179 triggers without refilling session data and is stable on reopen", async (t) => {
  const f = await fixture(t);
  f.archive();
  const before = f.store.getChannelSession(f.channel.id, f.session.id);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  db.exec(`DELETE FROM schema_migrations WHERE version=180;
    DROP TRIGGER IF EXISTS trg_channel_session_work_admission;
    CREATE TRIGGER trg_channel_session_work_admission BEFORE INSERT ON work_units WHEN 0
    BEGIN SELECT RAISE(ABORT,'old179-placeholder'); END;`);
  db.close();
  const upgraded = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(upgraded.getChannelSession(f.channel.id, f.session.id), before);
    assert.throws(() => upgraded.createWorkUnit(f.workInput("upgraded-topic-work")), /channel_session_archived/);
    const read = new DatabaseSync(upgraded.paths.databasePath, { readOnly: true });
    try { assert.equal(read.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=180").get().n, 1); }
    finally { read.close(); }
  } finally { upgraded.close(); }
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(reopened.getChannelSession(f.channel.id, f.session.id), before); }
  finally { reopened.close(); }
});

for (const depth of [1, 2]) {
  test(`visible topic depth ${depth} replies publish activity and unread only to their owning session`, async (t) => {
    const f = await fixture(t, depth);
    const other = f.store.createChannelSession({ channelId: f.channel.id, title: "Other" }, now).session;
    const before = f.store.getChannelSession(f.channel.id, f.session.id);
    f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
      payload: { body: "Visible topic result", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" } }, later);
    const after = f.store.getChannelSession(f.channel.id, f.session.id);
    assert.equal(after.activityAt, later);
    assert.equal(after.latestNotificationRevision, before.latestNotificationRevision + 1);
    const page = f.store.listChannelSessions(f.channel.id);
    assert.equal(page.notificationWatermarks.find(row => row.id === f.session.id).latestNotificationRevision, after.latestNotificationRevision);
    assert.equal(page.notificationWatermarks.find(row => row.id === other.id).latestNotificationRevision, 0);
    assert.equal(page.defaultSession.latestNotificationRevision, 0);
    assert.equal(page.notificationWatermarks.some(row => row.id === f.topic.id), false);
  });
}

test("topic stream completion notifies its owner without token replay or private/superseded leakage", async (t) => {
  const f = await fixture(t);
  const payload = { body: "", format: "plain_text", streaming: true, deliveryStatus: "pending", presentationRole: "reply_result" };
  const item = f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
    kind: "assistant_message", status: "pending", actorType: "ling_agent", visibility: "channel", payload }, now);
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  const revision = () => f.store.getChannelSession(f.channel.id, f.session.id).latestNotificationRevision;
  const update = (body, streaming = true) => db.prepare("UPDATE conversation_items SET payload_json=?, status=?, updated_at=? WHERE id=?")
    .run(JSON.stringify({ ...payload, body, streaming, deliveryStatus: streaming ? "pending" : "ready" }), streaming ? "pending" : "committed", later, item.id);
  const start = revision();
  update("First"); assert.equal(revision(), start + 1);
  update("First tokens"); assert.equal(revision(), start + 1);
  update("First tokens", false); assert.equal(revision(), start + 2);
  update("First tokens", false); assert.equal(revision(), start + 2);
  for (const visibility of ["operator", "agent_private"]) {
    f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility,
      ...(visibility === "agent_private" ? { visibilityOwnerId: "other-agent" } : {}),
      payload: { ...payload, body: "Private", streaming: false, deliveryStatus: "ready" } }, later);
  }
  assert.equal(revision(), start + 2);
  db.prepare("UPDATE ling_turns SET status='superseded' WHERE id=?").run(f.source.turnId);
  f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
    kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
    payload: { ...payload, body: "Superseded", streaming: false, deliveryStatus: "ready" } }, later);
  update("", true);
  update("Late superseded completion", false);
  assert.equal(revision(), start + 2);
});

test("migration181 refreshes existing179/180 notifications without resetting history or watermarks", async (t) => {
  const f = await fixture(t);
  f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.session.id, turnId: f.anchor.turnId,
    kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
    payload: { body: "Existing result", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" } }, now);
  const before = f.store.getChannelSession(f.channel.id, f.session.id);
  const history = f.store.listConversationItemsPage({ threadId: f.session.id }).items;
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  db.exec(`DELETE FROM schema_migrations WHERE version=181;
    DROP TRIGGER trg_channel_session_activity_insert;
    DROP TRIGGER trg_channel_session_notification_update;`);
  db.close();
  const upgraded = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(upgraded.getChannelSession(f.channel.id, f.session.id), before);
    assert.deepEqual(upgraded.listConversationItemsPage({ threadId: f.session.id }).items, history);
    upgraded.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
      payload: { body: "After upgrade", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" } }, later);
    assert.equal(upgraded.getChannelSession(f.channel.id, f.session.id).latestNotificationRevision, before.latestNotificationRevision + 1);
    const read = new DatabaseSync(upgraded.paths.databasePath, { readOnly: true });
    try { assert.equal(read.prepare("SELECT name FROM schema_migrations WHERE version=181").get()?.name, "channel_session_topic_notifications"); }
    finally { read.close(); }
  } finally { upgraded.close(); }
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.equal(reopened.getChannelSession(f.channel.id, f.session.id).latestNotificationRevision, before.latestNotificationRevision + 1); }
  finally { reopened.close(); }
});

for (const corruption of ["foreign-channel", "foreign-workspace", "cycle"]) {
  test(`topic notification ancestry never publishes to a session through ${corruption}`, async (t) => {
    const f = await fixture(t);
    const db = new DatabaseSync(f.store.paths.databasePath);
    t.after(() => db.close());
    const parent = f.store.getLingThread(f.topic.id).parentThreadId;
    const foreignChannel = f.store.createChannel({ name: "Foreign" }, now);
    const foreign = f.store.createChannelSession({ channelId: foreignChannel.id, title: "Foreign" }, now).session;
    if (corruption === "foreign-channel") db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(foreign.id, f.topic.id);
    if (corruption === "foreign-workspace") {
      db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('notification-foreign','Foreign',?,?)").run(now, now);
      db.prepare("UPDATE ling_threads SET workspace_id='notification-foreign' WHERE id=?").run(parent);
    }
    if (corruption === "cycle") db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(f.topic.id, parent);
    f.store.appendConversationItem({ channelId: f.channel.id, threadId: f.topic.id, turnId: f.source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", visibility: "channel",
      payload: { body: "Late result on damaged lineage", format: "plain_text", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" } }, later);
    assert.equal(f.store.getChannelSession(f.channel.id, f.session.id).latestNotificationRevision, 0);
    assert.equal(f.store.getChannelSession(foreignChannel.id, foreign.id).latestNotificationRevision, 0);
  });
}

test("migration181 marker failure rolls back trigger replacement on an existing180 database", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.exec("DELETE FROM schema_migrations WHERE version=181; DROP TRIGGER trg_channel_session_activity_insert;");
  db.exec("CREATE TRIGGER trg_channel_session_activity_insert AFTER INSERT ON conversation_items WHEN 0 BEGIN SELECT 1; END;");
  const schema = () => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const before = schema();
  assert.throws(() => applyChannelSessionMigration({ database: db,
    hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: version => { assert.equal(version, 181); throw new Error("181 marker rejected"); },
  }), /181 marker rejected/);
  assert.deepEqual(schema(), before);
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE version=181").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (179,180)").get().n, 2);
});
