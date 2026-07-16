import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

test("hard delete removes archived conversation content and preserves unlinked run history", async () => {
  const cwd = await mkdtempPath("ling-stack-thread-cleanup-");
  const now = "2026-07-11T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      title: "Archived conversation",
      objective: "Clean up private conversation data",
      archivedAt: now,
    }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Archived turn",
      userInstruction: "Delete this conversation later",
    }, now);
    const run = store.createRun(createRunInput({
      id: "run_archived_conversation",
      cwd,
      threadId: thread.id,
      createdAt: now,
    }));
    store.createLingThreadGoal({ threadId: thread.id, objective: "Archived goal" }, now);
    store.upsertProposedPlanArtifact({
      id: "plan_archived_conversation",
      threadId: thread.id,
      title: "Archived plan",
      bodyMarkdown: "Delete with the conversation.",
    }, now);
    const attachment = store.createConversationAttachment({
      threadId: thread.id,
      turnId: turn.id,
      kind: "text",
      fileName: "private.txt",
      contentType: "text/plain",
      sizeBytes: 7,
      path: "conversation/private.txt",
      createdAt: now,
    });
    const attachmentPath = resolve(resolveRuntimePaths(cwd).attachmentsDir, attachment.path);
    await mkdir(dirname(attachmentPath), { recursive: true });
    await writeFile(attachmentPath, "private");
    const child = store.createLingThread({
      kind: "conversation",
      title: "Child conversation",
      objective: "Keep child history",
      parentThreadId: thread.id,
    }, now);

    const deleted = store.hardDeleteLingThread(thread.id, { reason: "owner request" }, "2026-07-11T00:01:00.000Z");

    assert.equal(deleted?.tombstone.entityType, "conversation-thread");
    assert.equal(deleted?.tombstone.deletedCounts.lingTurns, 1);
    assert.equal(deleted?.tombstone.deletedCounts.conversationAttachments, 1);
    assert.deepEqual(deleted?.deletedAttachmentPaths, [attachment.path]);
    assert.equal(store.getLingThread(thread.id), undefined);
    assert.equal(store.getLingTurn(turn.id), undefined);
    assert.equal(store.getLingThreadGoal(thread.id), undefined);
    assert.deepEqual(store.listProposedPlanArtifacts({ threadId: thread.id }), []);
    assert.deepEqual(store.listConversationAttachments({ threadId: thread.id }), []);
    assert.equal(store.getRun(run.id)?.threadId, undefined);
    assert.equal(store.getLingThread(child.id)?.parentThreadId, undefined);
    assert.equal((await stat(attachmentPath)).isFile(), true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("hard delete rejects non-conversation and active conversation records", async () => {
  const cwd = await mkdtempPath("ling-stack-thread-cleanup-guard-");
  const now = "2026-07-11T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const taskThread = store.createLingThread({
      kind: "task",
      taskId: "task_guard",
      title: "Archived task thread",
      objective: "Do not delete through conversation cleanup",
      archivedAt: now,
    }, now);
    const activeConversation = store.createLingThread({
      kind: "conversation",
      title: "Active conversation",
      objective: "Archive first",
    }, now);

    assert.throws(() => store.hardDeleteLingThread(taskThread.id, {}, now), /Only conversation threads/);
    assert.throws(() => store.hardDeleteLingThread(activeConversation.id, {}, now), /must be archived/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function mkdtempPath(prefix) {
  return await mkdtemp(resolve(tmpdir(), prefix));
}

function createRunInput({ id, cwd, threadId, createdAt }) {
  return {
    id,
    cwd,
    taskId: "task_archived_conversation",
    providerName: "openai",
    providerModel: "gpt-test",
    taskSnapshot: { id: "task_archived_conversation", title: "Archived conversation", prompt: "Archive" },
    providerSnapshot: { provider: "openai", model: "gpt-test", apiKey: "sk-testsecret000000" },
    requestSnapshot: { cwd, task: { id: "task_archived_conversation", title: "Archived conversation", prompt: "Archive" } },
    threadId,
    createdAt,
  };
}
