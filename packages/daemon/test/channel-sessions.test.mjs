import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { createDaemonServer } from "../dist/index.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";
import { collectActiveWorkSources, listChannelContextMessages } from "../dist/features/channels/context-processing/sources.js";
import { resolveChannelConversationLineKey, resolveChannelConversationSurface } from "../dist/features/channels/conversation-surface.js";
import { ensureChannelReplyThread } from "../dist/features/channels/channel-reply-execution.js";
import { ChannelRemoteConversationAdapter } from "../dist/features/remote-access/conversation-adapters.js";
import { findChannelDefaultConversationThread, resolveChannelConversationThread } from "../dist/features/channels/conversation-thread-resolution.js";
import { readConversationSubmission } from "../dist/features/conversations/submission-receipts.js";
import { getChannelPlanModeBlocker, getWorkflowPlanModeBlocker } from "../dist/features/channels/plan-mode-guard.js";

const now = "2026-10-29T09:00:00.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-sessions-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Session container", autoReplyMode: "off" }, now);
  const other = store.createChannel({ name: "Another channel", autoReplyMode: "off" }, now);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { intentSelector: false, terminalReports: false } }, { storeFactory: () => store });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  async function request(path, method = "GET", body, status = 200) {
    const result = await fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`, {
      method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const payload = await result.json();
    assert.equal(result.status, status, JSON.stringify(payload));
    return payload;
  }
  return { cwd, store, channel, other, request, sessions: `/channels/${channel.id}/sessions` };
}

test("sessions facade validates requests, persists retry identity and agrees with legacy lifecycle", async (t) => {
  const { store, channel, other, request, sessions } = await fixture(t);
  const initial = await request(sessions);
  assert.equal(initial.defaultSession.surfaceKind, "channel_root");
  assert.deepEqual(initial.sessions, []);
  for (const body of [{}, { idempotencyKey: " " }, { title: "title" }, { idempotencyKey: "k", title: "" },
    { idempotencyKey: "k", title: "会".repeat(121) }, { idempotencyKey: "k", surfaceKind: "branch" }]) {
    await request(sessions, "POST", body, 400);
  }
  const first = await request(sessions, "POST", { idempotencyKey: "first" }, 201);
  assert.equal(first.session.surfaceKind, "channel_session");
  const thread = store.getLingThread(first.session.id);
  assert.equal(thread.relationKind, "root");
  assert.equal(thread.parentThreadId, undefined);
  assert.equal(thread.forkContextSnapshotId, undefined);
  const replay = await request(sessions, "POST", { idempotencyKey: "first" }, 200);
  assert.equal(replay.session.id, first.session.id);
  assert.equal(replay.idempotentReplay, true);
  await request(sessions, "POST", { idempotencyKey: "first", title: "Changed input" }, 409);
  const item = `${sessions}/${first.session.id}`;
  for (const body of [{}, { archived: "true" }, { title: null }, { title: "new", unexpected: true }]) {
    await request(item, "PATCH", body, 400);
  }
  await request(`/channels/${other.id}/sessions/${first.session.id}`, "GET", undefined, 404);
  await request(`/channels/${other.id}/sessions/${first.session.id}`, "PATCH", { title: "wrong channel" }, 404);
  const renamed = await request(item, "PATCH", { title: "Manual title" });
  assert.equal(renamed.session.title, "Manual title");
  const legacyPath = `/channels/${channel.id}/branches/${first.session.legacyBranchId}`;
  assert.equal((await request(legacyPath)).branch.name, "Manual title");
  await request(legacyPath, "PATCH", { name: "Legacy renamed" });
  assert.equal((await request(item)).session.title, "Legacy renamed");
  await request(`${sessions}/${initial.defaultSession.id}`, "PATCH", { archived: true }, 409);
  await request(item, "PATCH", { archived: true });
  assert.equal((await request(legacyPath)).branch.status, "archived");
  assert.equal((await request(sessions)).sessions.length, 0);
  assert.equal((await request(`${sessions}?archived=true`)).sessions[0].id, first.session.id);
  // Archived history remains readable while writes to it are rejected.
  await request(`/channels/${channel.id}/items?threadId=${first.session.id}`);
  await request(`/channels/${channel.id}/turns`, "POST", { surface: { kind: "thread", threadId: first.session.id }, body: "should reject" }, 409);
  await request(item, "PATCH", { archived: false });
  assert.equal((await request(legacyPath)).branch.status, "active");
  await request(item, "PATCH", { archived: true });
  await request(legacyPath, "DELETE");
  assert.equal((await request(`${sessions}?archived=true`)).sessions.length, 0);
  assert.ok(store.getLingThread(first.session.id).archivedAt);
});

test("session reads do not repair directories; explicit repair preserves legacy identity", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const legacy = store.createChannelBranch({ channelId: channel.id, name: "Empty imported directory" }, now);
  const branchPath = `/channels/${channel.id}/branches/${legacy.id}`;
  const before = store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 100 }).length;
  for (const path of ["/channels", `/channels/${channel.id}/branches`, branchPath, sessions]) await request(path);
  assert.equal(store.getChannelBranch(legacy.id).rootThreadId, undefined);
  assert.equal(store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 100 }).length, before);
  await request(`${branchPath}/repair`, "POST", { guessThreadId: "other" }, 400);
  const repaired = await request(`${branchPath}/repair`, "POST", {});
  assert.equal(repaired.branch.id, legacy.id);
  assert.equal(repaired.session.legacyBranchId, legacy.id);
  assert.equal(repaired.branch.rootThreadId, repaired.session.id);
  assert.equal((await request(`${branchPath}/repair`, "POST")).session.id, repaired.session.id);
  const imported = await request(`/channels/${channel.id}/branches`, "POST", {
    name: "Legacy create", idempotencyKey: "legacy-retry", status: "archived",
  }, 201);
  const repeated = await request(`/channels/${channel.id}/branches`, "POST", {
    name: "Legacy create", idempotencyKey: "legacy-retry", status: "archived",
  });
  assert.equal(repeated.branch.id, imported.branch.id);
  assert.equal(store.getLingThread(imported.branch.rootThreadId).surfaceKind, "channel_session");
  assert.ok((await request(`${sessions}/${imported.branch.rootThreadId}`)).session.archivedAt);
});

test("session facade pagination binds filters and returns notification watermarks beyond the preview", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const identities = [];
  for (let index = 0; index < 12; index += 1) {
    identities.push((await request(sessions, "POST", { title: `设计 ${index}`, idempotencyKey: `page-${index}` }, 201)).session.id);
  }
  const first = await request(`${sessions}?limit=10`);
  assert.equal(first.sessions.length, 10);
  assert.ok(first.nextCursor);
  assert.equal(first.notificationWatermarks.length, 13);
  const second = await request(`${sessions}?limit=10&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(second.sessions.length, 2);
  assert.equal(new Set([...first.sessions, ...second.sessions].map(session => session.id)).size, 12);
  assert.deepEqual(new Set([...first.sessions, ...second.sessions].map(session => session.id)), new Set(identities));
  assert.ok([...first.sessions, ...second.sessions].every(session => session.id !== first.defaultSession.id));
  await request(`${sessions}?q=other&cursor=${encodeURIComponent(first.nextCursor)}`, "GET", undefined, 400);
  for (const query of ["limit=101", "limit=1.5", "archived=unknown", "cursor=malformed"]) {
    await request(`${sessions}?${query}`, "GET", undefined, 400);
  }
  assert.equal((await request(`${sessions}?q=${encodeURIComponent("设计 11")}`)).sessions[0].title, "设计 11");
  store.updateChannel(channel.id, { status: "paused" }, now);
  await request(sessions, "POST", { idempotencyKey: "new-while-paused" }, 409);
  assert.equal((await request(sessions, "POST", { title: "设计 0", idempotencyKey: "page-0" })).session.id, identities[0]);
});

test("session context, reply routing and archived recovery retain the original thread", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const a = (await request(sessions, "POST", { title: "A", idempotencyKey: "a" }, 201)).session;
  const b = (await request(sessions, "POST", { title: "B", idempotencyKey: "b" }, 201)).session;
  const messageA = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "A private working history" }, now);
  const messageB = appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "B separate history" }, now);
  const contextA = buildConversationContextProjection({ store, sourceItemId: messageA.id, view: "reply" });
  const contextB = buildConversationContextProjection({ store, sourceItemId: messageB.id, view: "reply" });
  assert.deepEqual(contextA.items.map(item => item.threadId), [a.id]);
  assert.deepEqual(contextB.items.map(item => item.threadId), [b.id]);
  assert.notEqual(contextA.segment.id, contextB.segment.id);
  assert.equal(contextA.forkSnapshot, undefined);
  assert.equal(contextB.forkSnapshot, undefined);
  assert.deepEqual(listChannelContextMessages({ store, channelId: channel.id, sourceMessage: messageA }).map(message => message.body), [messageA.body]);
  assert.equal(resolveChannelConversationSurface(store, channel.id, messageA).kind, "session");
  assert.notEqual(resolveChannelConversationLineKey(store, channel.id, messageA), resolveChannelConversationLineKey(store, channel.id, messageB));
  assert.equal(ensureChannelReplyThread(store, channel, messageA).id, a.id);
  for (const [session, expected] of [[a, messageA.body], [b, messageB.body]]) {
    const page = await request(`/channels/${channel.id}/items?threadId=${session.id}`);
    assert.deepEqual(page.items.map(item => item.payload.body), [expected]);
  }
  const archived = store.updateLingThread(a.id, { archivedAt: now }, now);
  assert.ok(archived.archivedAt);
  assert.throws(() => ensureChannelReplyThread(store, channel, messageA), /Reply source thread is unavailable/);
  assert.equal(ensureChannelReplyThread(store, channel, messageB).id, b.id);
});

test("active work and pending approvals enter context only through persisted session lineage", () => {
  const channel = { id: "channel", workspaceId: "default", name: "Shared channel" };
  const items = new Map([["sourceA", { threadId: "sessionA" }], ["sourceB", { threadId: "sessionB" }]]);
  const proposal = (id, sourceMessageId) => ({ id, sourceMessageId, title: id, status: "draft", channelId: channel.id, workspaceId: "default", requiredTools: [] });
  const workflow = (id, sourceMessageId) => ({ id, title: id, status: "running", channelId: channel.id, workspaceId: "default", metadata: { sourceMessageId } });
  const approval = { id: "approvalA", title: "Confirm A", runId: "runA", status: "pending", actionType: "bash" };
  const store = {
    getConversationItem: id => items.get(id), getLingTurn: () => undefined,
    listChannelExecutionProposals: () => [proposal("proposalA", "sourceA"), proposal("proposalB", "sourceB"), proposal("legacyProposal", "unknown")],
    listChannelWorkflows: () => [workflow("workflowA", "sourceA"), workflow("workflowB", "sourceB"), workflow("legacyWorkflow", undefined)],
    listChannelWorkflowSteps: ({ workflowId }) => [{ id: `step:${workflowId}`, workflowId, title: workflowId, status: "running", workspaceId: "default" }],
    listRuns: () => [
      { id: "runA", taskId: "taskA", threadId: "sessionA", channelId: channel.id, status: "waiting_for_approval" },
      { id: "runB", taskId: "taskB", threadId: "sessionB", channelId: channel.id, status: "running" },
      { id: "legacyRun", taskId: "legacyTask", channelId: channel.id, status: "running" },
    ],
    listApprovalRequests: ({ runId, workflowStepId }) => runId === "runA" || workflowStepId === "step:workflowA" ? [approval] : [],
  };
  const sources = collectActiveWorkSources({ store, channel, threadId: "sessionA" });
  assert.deepEqual(sources.map(source => source.id), [
    "active_work:proposal:proposalA", "active_work:workflow:workflowA", "active_work:workflow_step:step:workflowA",
    "active_work:run:runA", "active_work:approval:approvalA",
  ]);
  assert.ok(sources.every(source => !JSON.stringify(source).includes("sourceB")));
});

test("read-only topic lookups never materialize a missing topic thread", async (t) => {
  const { store, channel } = await fixture(t);
  const defaultSession = store.listChannelSessions(channel.id).defaultSession;
  const anchor = appendChannelItemFixture(store, {
    channelId: channel.id,
    threadId: defaultSession.id,
    authorType: "local-user",
    body: "Topic anchor",
  }, now);
  const before = store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 100 }).length;
  assert.throws(() => resolveChannelConversationThread({
    store,
    channel,
    surface: { kind: "topic", anchorItemId: anchor.id },
    now,
    readOnly: true,
  }), { code: "conversation_topic_not_found", statusCode: 404 });
  assert.equal(store.listLingThreads({ channelId: channel.id, includeArchived: true, limit: 100 }).length, before);
  const created = resolveChannelConversationThread({
    store,
    channel,
    surface: { kind: "topic", anchorItemId: anchor.id },
    now,
  });
  assert.equal(resolveChannelConversationThread({
    store,
    channel,
    surface: { kind: "topic", anchorItemId: anchor.id },
    now,
    readOnly: true,
  }).id, created.id);
  for (let index = 0; index < 510; index += 1) {
    store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
      surfaceKind: "channel_session", relationKind: "root", title: `Session ${index}`, objective: "Filler" }, `2026-10-30T${String(index % 24).padStart(2, "0")}:00:00.000Z`);
  }
  assert.equal(resolveChannelConversationThread({
    store,
    channel,
    surface: { kind: "topic", anchorItemId: anchor.id },
    now,
    readOnly: true,
  }).id, created.id);
});

test("legacy remote channel view exposes the default conversation without another session preview", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const a = (await request(sessions, "POST", { title: "A", idempotencyKey: "a" }, 201)).session;
  appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Default history" }, now);
  appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Separate session history" }, now);
  appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "ai-teammate", authorId: "ling_agent", status: "pending", body: "Separate streaming response" }, now);
  const adapter = new ChannelRemoteConversationAdapter({ store, workspaceId: channel.workspaceId, localUserId: "local-user" });
  const page = adapter.open(channel.id, undefined, now);
  assert.deepEqual(page.messages.map(message => message.body), ["Default history"]);
  assert.equal(adapter.getSummary(channel.id, now).latestPreview, "Default history");
  assert.equal(adapter.isBusy(channel.id), false);
});

test("newer archived roots cannot replace the canonical default for reads, sends, receipts or remote views", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const canonical = (await request(sessions)).defaultSession;
  const source = appendChannelItemFixture(store, { id: "active-root-message", channelId: channel.id,
    threadId: canonical.id, authorType: "local-user", body: "Current default history" }, now);
  const historical = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
    surfaceKind: "channel_root", relationKind: "root", title: "Archived older conversation", objective: "Old root",
    archivedAt: now }, "2026-10-29T10:00:00.000Z");
  // The old owner lookup intentionally returns the recently touched historical row.
  assert.equal(store.findLingThreadByOwner({ kind: "channel_discussion", channelId: channel.id, surfaceKind: "channel_root" }).id, historical.id);
  assert.equal(findChannelDefaultConversationThread(store, channel.id).id, canonical.id);
  assert.equal(resolveChannelConversationThread({ store, channel, now }).id, canonical.id);
  assert.equal(ensureChannelReplyThread(store, channel, { ...source, threadId: undefined }).id, canonical.id);
  assert.equal((await request(`/channels/${channel.id}/items`)).thread.id, canonical.id);
  const receipt = readConversationSubmission(store, { surface: "channel", channelId: channel.id,
    idempotencyKey: "fixture-channel-item:active-root-message" });
  assert.equal(receipt.threadId, canonical.id);
  assert.equal(receipt.sourceItemId, source.id);
  const adapter = new ChannelRemoteConversationAdapter({ store, workspaceId: channel.workspaceId, localUserId: "local-user" });
  assert.deepEqual(adapter.open(channel.id, undefined, now).messages.map(message => message.body), [source.body]);
  assert.equal(adapter.getSummary(channel.id, now).latestPreview, source.body);
});

test("workflow Plan Mode belongs to its source conversation and cannot follow another selected session", async (t) => {
  const { store, channel, other, request, sessions } = await fixture(t);
  const root = (await request(sessions)).defaultSession;
  const a = (await request(sessions, "POST", { title: "A", idempotencyKey: "plan-a" }, 201)).session;
  const b = (await request(sessions, "POST", { title: "B", idempotencyKey: "plan-b" }, 201)).session;
  const sourceA = appendChannelItemFixture(store, { channelId: channel.id, threadId: a.id, authorType: "local-user", body: "Plan A" }, now);
  const sourceB = appendChannelItemFixture(store, { channelId: channel.id, threadId: b.id, authorType: "local-user", body: "Execute B" }, now);
  store.updateLingThreadConversationMode(a.id, { mode: "plan" }, now);
  const workflow = (metadata) => ({ channelId: channel.id, metadata });
  assert.match(getWorkflowPlanModeBlocker(store, workflow({ sourceMessageId: sourceA.id })), /Plan Mode/);
  assert.match(getWorkflowPlanModeBlocker(store, workflow({ sourceTurnId: sourceA.turnId })), /Plan Mode/);
  assert.equal(getWorkflowPlanModeBlocker(store, workflow({ sourceMessageId: sourceB.id, sourceTurnId: sourceB.turnId })), undefined);
  assert.equal(getWorkflowPlanModeBlocker(store, workflow(undefined)), undefined);
  assert.equal(getChannelPlanModeBlocker(store, channel.id), undefined);
  store.updateLingThreadConversationMode(root.id, { mode: "plan" }, now);
  assert.match(getWorkflowPlanModeBlocker(store, workflow(undefined)), /Plan Mode/);
  assert.match(getChannelPlanModeBlocker(store, channel.id), /Plan Mode/);
  assert.equal(getWorkflowPlanModeBlocker(store, workflow({ sourceMessageId: sourceB.id })), undefined);
  assert.match(getWorkflowPlanModeBlocker(store, workflow({ sourceMessageId: sourceB.id, sourceTurnId: sourceA.turnId })), /unavailable or inconsistent/);
  assert.match(getWorkflowPlanModeBlocker(store, workflow({ sourceMessageId: "missing" })), /unavailable or inconsistent/);
  assert.match(getWorkflowPlanModeBlocker(store, { ...workflow({ sourceMessageId: sourceB.id }), channelId: other.id }), /unavailable or inconsistent/);
});


test("runtime retry returns 409 for a dispatch whose original conversation is archived", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  const session = (await request(sessions, "POST", { title: "Failed dispatch", idempotencyKey: "archived-retry" }, 201)).session;
  const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: session.id,
    authorType: "local-user", body: "Keep original retry history" }, now);
  // Start terminal so the background dispatch worker cannot claim this fixture.
  const work = store.createWorkUnit({ workspaceId: channel.workspaceId, kind: "channel_turn_dispatch", ownerType: "ling_turn",
    ownerId: source.turnId, channelId: channel.id, idempotencyKey: "archived-dispatch", status: "failed",
    createdByActor: "user", request: {}, now });
  await request(`${sessions}/${session.id}`, "PATCH", { archived: true });
  const result = await request(`/work-units/${work.id}/retry`, "POST", {}, 409);
  assert.equal(result.error, "terminal_state");
  assert.equal(result.workUnit.status, "failed");
  assert.equal(store.getWorkUnit(work.id).status, "failed");
  assert.equal(store.listRuntimeEvents(work.id).some(event => event.type === "work_unit_queued"), false);
  const history = await request(`/channels/${channel.id}/items?threadId=${session.id}`);
  assert.ok(history.items.some(item => item.id === source.id));
});

test("existing topic HTTP sends and dispatch retries obey the owning session archive and restore", async (t) => {
  const { store, channel, request, sessions } = await fixture(t);
  store.updateChannel(channel.id, { autoReplyMode: "mentions_only" }, now);
  const session = (await request(sessions, "POST", { title: "Topic owner", idempotencyKey: "topic-owner" }, 201)).session;
  const anchor = appendChannelItemFixture(store, { channelId: channel.id, threadId: session.id,
    authorType: "local-user", body: "A topic belongs to this conversation" }, now);
  const topic = store.resolveOrCreateConversationThread({ surfaceKind: "topic", channelId: channel.id,
    anchorItemId: anchor.id, title: "Existing topic", objective: "Keep topic history on its own thread" }, now).thread;
  const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: topic.id,
    authorType: "local-user", body: "Topic history survives parent archive" }, now);
  const work = store.createWorkUnit({ workspaceId: channel.workspaceId, kind: "channel_turn_dispatch", ownerType: "ling_turn",
    ownerId: source.turnId, channelId: channel.id, idempotencyKey: "topic-terminal-dispatch", status: "failed",
    createdByActor: "user", request: {}, now });

  await request(`${sessions}/${session.id}`, "PATCH", { archived: true });
  const rejected = await request(`/channels/${channel.id}/turns`, "POST", {
    surface: { kind: "thread", threadId: topic.id }, body: "Must not enter an archived conversation",
  }, 409);
  assert.equal(rejected.error, "session_archived");
  assert.equal(store.listConversationItemsPage({ threadId: topic.id, limit: 100 }).items.some(item =>
    item.kind === "user_message" && item.payload.body === "Must not enter an archived conversation"), false);
  const retry = await request(`/work-units/${work.id}/retry`, "POST", {}, 409);
  assert.equal(retry.error, "terminal_state");
  assert.equal(store.getWorkUnit(work.id).status, "failed");
  assert.equal(store.listRuntimeEvents(work.id).some(event => event.type === "work_unit_queued"), false);
  const history = await request(`/channels/${channel.id}/items?threadId=${topic.id}`);
  assert.ok(history.items.some(item => item.id === source.id));

  await request(`${sessions}/${session.id}`, "PATCH", { archived: false });
  await request(`/channels/${channel.id}/turns`, "POST", {
    surface: { kind: "thread", threadId: topic.id }, body: "Sending to the restored topic is allowed",
  }, 201);
  const restoredHistory = await request(`/channels/${channel.id}/items?threadId=${topic.id}`);
  assert.ok(restoredHistory.items.some(item => item.kind === "user_message"
    && item.payload.body === "Sending to the restored topic is allowed"));
});
