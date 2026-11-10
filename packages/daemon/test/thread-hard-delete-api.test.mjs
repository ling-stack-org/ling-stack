import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { persistConversationAttachment } from "../dist/features/channels/attachments.js";

test("thread hard delete removes archived conversation data and keeps unlinked run history", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-thread-hard-delete-"));
  const store = createSqliteRunStore(cwd);
  const daemon = await startDaemonForTest(cwd, { storeFactory: () => store });
  try {
    await requestJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`);
    const now = "2026-07-11T00:00:00.000Z";
    const thread = store.createLingThread({
      kind: "conversation",
      title: "Archived private conversation",
      objective: "Delete private conversation content",
      archivedAt: now,
    }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Private request",
      userInstruction: "Remove this conversation later.",
    }, now);
    store.createLingThreadGoal({ threadId: thread.id, objective: "Private goal" }, now);
    store.upsertProposedPlanArtifact({
      id: "plan_thread_hard_delete",
      threadId: thread.id,
      title: "Private plan",
      bodyMarkdown: "Delete this plan with the conversation.",
    }, now);
    const attachment = persistConversationAttachment(store, {
      threadId: thread.id,
      fileName: "private.txt",
      contentBase64: Buffer.from("private", "utf8").toString("base64"),
    });
    const attachmentPath = resolve(store.paths.attachmentsDir, attachment.path);
    await access(attachmentPath);
    const child = store.createLingThread({
      kind: "conversation",
      title: "Preserved child",
      objective: "Keep child history",
      parentThreadId: thread.id,
    }, now);
    const run = store.createRun(createRunInput({
      id: "run_thread_hard_delete",
      cwd,
      threadId: thread.id,
      createdAt: now,
    }));
    store.markRunStarted(run.id, "2026-07-11T00:00:10.000Z");
    store.markRunSucceeded(run.id, "2026-07-11T00:00:20.000Z");

    const response = await requestJson(`${daemon.url}/threads/${encodeURIComponent(thread.id)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: { reason: "owner request" },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.tombstone.entityType, "conversation-thread");
    assert.equal(response.body.tombstone.entityId, thread.id);
    assert.equal(response.body.tombstone.reason, "owner request");
    assert.equal(response.body.tombstone.deletedCounts.lingTurns, 1);
    assert.equal(response.body.tombstone.deletedCounts.conversationAttachments, 1);
    assert.equal(store.getLingThread(thread.id), undefined);
    assert.equal(store.getLingTurn(turn.id), undefined);
    assert.equal(store.getRun(run.id)?.threadId, undefined);
    assert.equal(store.getLingThread(child.id)?.parentThreadId, undefined);
    await assert.rejects(access(attachmentPath), { code: "ENOENT" });
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread hard delete rejects unsafe records and enabled automation targets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-thread-hard-delete-guards-"));
  const store = createSqliteRunStore(cwd);
  const daemon = await startDaemonForTest(cwd, { storeFactory: () => store });
  try {
    await requestJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`);
    const now = "2026-07-11T00:00:00.000Z";
    const openConversation = store.createLingThread({
      kind: "conversation",
      title: "Open conversation",
      objective: "Archive first",
    }, now);
    const archivedTask = store.createLingThread({
      kind: "task",
      taskId: "task_thread_delete_guard",
      title: "Archived task",
      objective: "Do not delete through conversation cleanup",
      archivedAt: now,
    }, now);
    const activeRunConversation = store.createLingThread({
      kind: "conversation",
      title: "Conversation with active run",
      objective: "Wait for run completion",
      archivedAt: now,
    }, now);
    store.createRun(createRunInput({
      id: "run_thread_delete_active",
      cwd,
      threadId: activeRunConversation.id,
      createdAt: now,
    }));
    const activeTurnConversation = store.createLingThread({
      kind: "conversation",
      title: "Conversation with active turn",
      objective: "Wait for turn completion",
      archivedAt: now,
    }, now);
    store.createLingTurn({
      threadId: activeTurnConversation.id,
      kind: "manual_followup",
      status: "running",
      title: "Active turn",
      userInstruction: "Still working.",
    }, now);

    await assertConflict(daemon.url, cwd, openConversation.id, "thread_not_archived");
    await assertConflict(daemon.url, cwd, archivedTask.id, "thread_delete_kind_unsupported");
    await assertConflict(daemon.url, cwd, activeRunConversation.id, "active_thread_archive_blocked");
    await assertConflict(daemon.url, cwd, activeTurnConversation.id, "active_thread_archive_blocked");

    const automationTarget = store.createLingThread({
      kind: "conversation",
      title: "Automation target",
      objective: "Detach automation before delete",
      archivedAt: now,
    }, now);
    const automationThread = store.createLingThread({
      kind: "automation",
      title: "Automation owner",
      objective: "Own automation history",
    }, now);
    const automation = store.createAutomationDefinition({
      threadId: automationThread.id,
      targetThreadId: automationTarget.id,
      title: "Conversation follow-up",
      kind: "custom_prompt",
      status: "enabled",
      trigger: { type: "manual" },
      target: {
        scope: "thread",
        workspaceId: DEFAULT_WORKSPACE_ID,
        threadId: automationTarget.id,
        cwd,
      },
      promptTemplate: {
        templateVersion: 1,
        promptMarkdown: "Follow up on the conversation.",
        contextSelectors: [],
      },
      executionPolicy: {},
      outputPolicy: {
        destinations: [{ type: "automation_thread" }],
        artifactFormat: "markdown",
      },
    }, now);

    await assertConflict(daemon.url, cwd, automationTarget.id, "thread_automation_target");
    store.updateAutomationDefinition(automation.id, { status: "archived" }, "2026-07-11T00:01:00.000Z");
    const archivedAutomationResponse = await requestJson(`${daemon.url}/threads/${encodeURIComponent(automationTarget.id)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {},
    });
    assert.equal(archivedAutomationResponse.status, 200, JSON.stringify(archivedAutomationResponse.body));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest(cwd, dependencies = {}) {
  const daemon = createDaemonServer({
    defaultWorkspaceCwd: cwd,
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    channels: { intentSelector: false },
  }, dependencies);
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function assertConflict(baseUrl, cwd, threadId, errorCode) {
  const response = await requestJson(`${baseUrl}/threads/${encodeURIComponent(threadId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, errorCode);
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function createRunInput({ id, cwd, threadId, createdAt }) {
  return {
    id,
    cwd,
    taskId: `${id}_task`,
    providerName: "openai",
    providerModel: "gpt-test",
    taskSnapshot: { id: `${id}_task`, title: "Thread delete test", prompt: "Test thread delete." },
    providerSnapshot: { provider: "openai", model: "gpt-test", apiKey: "sk-testsecret000000" },
    requestSnapshot: { cwd, task: { id: `${id}_task`, title: "Thread delete test", prompt: "Test thread delete." } },
    threadId,
    createdAt,
  };
}
