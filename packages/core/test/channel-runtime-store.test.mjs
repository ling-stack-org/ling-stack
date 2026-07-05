import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  defaultChannelRuntimePolicy,
} from "../dist/index.js";

test("sqlite channels persist default and edited runtime policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-runtime-"));
  const now = "2026-05-26T00:00:00.000Z";
  const updatedAt = "2026-05-26T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const created = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      now,
    );

    assert.equal(created.status, "active");
    assert.deepEqual(created.runtimePolicy, defaultChannelRuntimePolicy);

    const updated = store.updateChannel(
      created.id,
      {
        status: "paused",
        runtimePolicy: {
          executionMode: "parallel",
          maxConcurrentRuns: 3,
          writeLockScope: "workspace",
          allowReadOnlyParallel: false,
          queueOnConflict: false,
        },
      },
      updatedAt,
    );

    assert.ok(updated);
    assert.equal(updated.status, "paused");
    assert.deepEqual(updated.runtimePolicy, {
      executionMode: "parallel",
      maxConcurrentRuns: 3,
      writeLockScope: "workspace",
      allowReadOnlyParallel: false,
      queueOnConflict: false,
    });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite workspace settings persist default provider preset", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-default-provider-"));
  const now = "2026-06-30T00:00:00.000Z";
  const updatedAt = "2026-06-30T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const settings = store.updateWorkspaceSettings({ defaultProviderPresetId: "provider_default_chat" }, now);
    assert.equal(settings.defaultProviderPresetId, "provider_default_chat");
    store.close();

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getWorkspaceSettings().defaultProviderPresetId, "provider_default_chat");
      const cleared = reopened.updateWorkspaceSettings({ defaultProviderPresetId: null }, updatedAt);
      assert.equal(cleared.defaultProviderPresetId, undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite workspace settings persist Ling conversation tone", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-ling-tone-"));
  const store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getWorkspaceSettings().lingConversationTone, undefined);
    const friendly = store.updateWorkspaceSettings({ lingConversationTone: "friendly" }, "2026-07-05T00:00:00.000Z");
    assert.equal(friendly.lingConversationTone, "friendly");
    const none = store.updateWorkspaceSettings({ lingConversationTone: "none" }, "2026-07-05T00:01:00.000Z");
    assert.equal(none.lingConversationTone, "none");
    store.close();

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getWorkspaceSettings().lingConversationTone, "none");
      const pragmatic = reopened.updateWorkspaceSettings({ lingConversationTone: "pragmatic" }, "2026-07-05T00:02:00.000Z");
      assert.equal(pragmatic.lingConversationTone, "pragmatic");
      const cleared = reopened.updateWorkspaceSettings({ lingConversationTone: null }, "2026-07-05T00:03:00.000Z");
      assert.equal(cleared.lingConversationTone, undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel creation can use a preallocated channel id", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-preallocated-id-"));
  const now = "2026-06-10T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        id: "channel_preallocated_for_worktree",
        name: "Isolated Engineering",
        boundPath: cwd,
      },
      now,
    );

    assert.equal(channel.id, "channel_preallocated_for_worktree");
    assert.equal(store.getChannel("channel_preallocated_for_worktree")?.name, "Isolated Engineering");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite tasks persist linked channel attachment ids", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-task-attachments-"));
  const now = "2026-06-23T00:00:00.000Z";
  const updatedAt = "2026-06-23T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const firstAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "text",
      fileName: "review-notes.md",
      contentType: "text/markdown",
      sizeBytes: 128,
      path: "channel/review-notes.md",
      createdAt: now,
    });
    const secondAttachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "text",
      fileName: "trace.log",
      contentType: "text/plain",
      sizeBytes: 256,
      path: "channel/trace.log",
      createdAt: now,
    });

    const task = store.createTask({
      channelId: channel.id,
      title: "Review attachments",
      prompt: "Use the linked files.",
      attachmentIds: [firstAttachment.id],
    }, now);
    assert.deepEqual(task.attachmentIds, [firstAttachment.id]);
    assert.deepEqual(store.getTask(task.id)?.attachmentIds, [firstAttachment.id]);

    const updated = store.updateTask(task.id, { attachmentIds: [firstAttachment.id, secondAttachment.id] }, updatedAt);
    assert.deepEqual(updated?.attachmentIds, [firstAttachment.id, secondAttachment.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel auto reply mode and route decisions round trip", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-reply-"));
  const now = "2026-06-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      now,
    );
    assert.equal(channel.autoReplyMode, "mentions_only");

    const updated = store.updateChannel(channel.id, { autoReplyMode: "default_teammate" }, "2026-06-09T00:01:00.000Z");
    assert.equal(updated.autoReplyMode, "default_teammate");
    const reset = store.updateChannel(channel.id, { autoReplyMode: null }, "2026-06-09T00:02:00.000Z");
    assert.equal(reset.autoReplyMode, "mentions_only");

    const message = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "这个频道自动回复怎么做？",
      },
      "2026-06-09T00:03:00.000Z",
    );
    const reply = store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: message.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_engineer",
        body: "Use default_teammate for deterministic replies.",
      },
      "2026-06-09T00:04:00.000Z",
    );
    const decision = store.createChannelMessageRouteDecision(
      {
        channelId: channel.id,
        sourceMessageId: message.id,
        replyMessageId: reply.id,
        mode: "default_teammate",
        action: "reply",
        selectedTeammateId: "teammate_builtin_engineer",
        selectedProviderPresetId: "provider_static",
        confidence: 1,
        reason: "Default teammate answered.",
        alternativesConsidered: [
          {
            teammateId: "teammate_builtin_engineer",
            label: "Engineer",
            score: 1,
            reason: "Default teammate candidate.",
          },
        ],
        contextPack: {
          schemaVersion: 1,
          kind: "channel_reply",
          providerPresetId: "provider_static",
          modelId: "static-chat",
          sectionIds: ["channel_collaboration_protocol", "channel_discussion"],
          droppedSectionIds: [],
          sourceRefCounts: { channel: 1, message: 1 },
          compactionIds: [],
        },
        status: "accepted",
        createdBy: "deterministic",
      },
      "2026-06-09T00:05:00.000Z",
    );

    assert.equal(store.getChannelMessageRouteDecision(decision.id).replyMessageId, reply.id);
    assert.deepEqual(store.getChannelMessageRouteDecision(decision.id).contextPack, {
      schemaVersion: 1,
      kind: "channel_reply",
      providerPresetId: "provider_static",
      modelId: "static-chat",
      sectionIds: ["channel_collaboration_protocol", "channel_discussion"],
      droppedSectionIds: [],
      sourceRefCounts: { channel: 1, message: 1 },
      compactionIds: [],
    });
    assert.deepEqual(store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: message.id }).map((item) => item.id), [decision.id]);
    const failed = store.updateChannelMessageRouteDecision(
      decision.id,
      {
        status: "failed",
        errorMessage: "selector failed",
        confidence: 0.2,
      },
      "2026-06-09T00:06:00.000Z",
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage, "selector failed");
    assert.equal(failed.confidence, 0.2);
    assert.equal(failed.contextPack.kind, "channel_reply");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel intent decisions round trip visible multi-reply ids", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-visible-multi-reply-intent-"));
  const now = "2026-06-10T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultTeammateId: "teammate_builtin_engineer",
      },
      now,
    );
    const message = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "所有队友都回复我一下",
      },
      "2026-06-10T00:01:00.000Z",
    );
    const architectReply = store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: message.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_architect",
        body: "Architect opinion",
      },
      "2026-06-10T00:02:00.000Z",
    );
    const engineerReply = store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: message.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_engineer",
        body: "Engineer opinion",
      },
      "2026-06-10T00:03:00.000Z",
    );

    const decision = store.createChannelIntentDecision(
      {
        channelId: channel.id,
        sourceMessageId: message.id,
        action: "visible_multi_reply",
        selectedTeammateIds: ["teammate_builtin_architect", "teammate_builtin_engineer"],
        replyMessageIds: [architectReply.id, engineerReply.id],
        reason: "Visible multi-reply created for discussion.",
        status: "accepted",
        createdBy: "deterministic",
      },
      "2026-06-10T00:04:00.000Z",
    );

    assert.equal(decision.action, "visible_multi_reply");
    assert.deepEqual(decision.selectedTeammateIds, ["teammate_builtin_architect", "teammate_builtin_engineer"]);
    assert.deepEqual(decision.replyMessageIds, [architectReply.id, engineerReply.id]);
    const [listed] = store.listChannelIntentDecisions({ channelId: channel.id, sourceMessageId: message.id });
    assert.equal(listed.id, decision.id);
    assert.deepEqual(listed.selectedTeammateIds, decision.selectedTeammateIds);
    assert.deepEqual(listed.replyMessageIds, decision.replyMessageIds);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channels persist workspace binding and workspace settings", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-binding-"));
  const now = "2026-06-09T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Worktree Channel",
        boundPath: cwd,
        workspaceBinding: {
          mode: "external_path",
          status: "ready",
          executionPath: resolve(cwd, "external"),
          updatedAt: now,
        },
      },
      now,
    );
    assert.equal(channel.workspaceBinding.mode, "external_path");
    assert.equal(channel.workspaceBinding.executionPath, resolve(cwd, "external"));

    const settings = store.updateWorkspaceSettings(
      {
        workspaceCwd: cwd,
        theme: "dark",
        locale: "zh-CN",
        defaultPermissionMode: "workspace_write",
        defaultPermissionPreset: "workspace_collaboration",
        channelNotifications: { [channel.id]: "mentions" },
        channelActivityViews: { [channel.id]: [{ id: "custom:risks", name: "Risks" }] },
      },
      "2026-06-09T00:01:00.000Z",
    );
    assert.equal(settings.workspaceCwd, cwd);
    assert.equal(settings.theme, "dark");
    assert.equal(settings.defaultPermissionMode, "workspace_write");
    assert.equal(settings.defaultPermissionPreset, "workspace_collaboration");
    assert.equal(settings.channelNotifications[channel.id], "mentions");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const [reopenedChannel] = store.listChannels();
    assert.equal(reopenedChannel.workspaceBinding.mode, "external_path");
    assert.equal(reopenedChannel.workspaceBinding.executionPath, resolve(cwd, "external"));
    const reopenedSettings = store.getWorkspaceSettings();
    assert.equal(reopenedSettings.workspaceCwd, cwd);
    assert.equal(reopenedSettings.theme, "dark");
    assert.equal(reopenedSettings.locale, "zh-CN");
    assert.equal(reopenedSettings.defaultPermissionMode, "workspace_write");
    assert.equal(reopenedSettings.defaultPermissionPreset, "workspace_collaboration");
    assert.equal(reopenedSettings.channelNotifications[reopenedChannel.id], "mentions");
    assert.equal(Array.isArray(reopenedSettings.channelActivityViews[reopenedChannel.id]), true);

    const cleared = store.updateChannel(reopenedChannel.id, { workspaceBinding: null }, "2026-06-09T00:02:00.000Z");
    assert.equal(cleared.workspaceBinding, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workspace assets persist messages, attachments, and link previews", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-"));
  const now = "2026-05-28T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultTeammateId: "engineer",
      },
      now,
    );
    const message = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        authorId: "tian",
        body: "请 @Engineer 看一下需求",
        mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      },
      now,
    );
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      messageId: message.id,
      kind: "pdf",
      fileName: "brief.pdf",
      contentType: "application/pdf",
      sizeBytes: 128,
      path: `${channel.id}/brief.pdf`,
      createdAt: now,
    });
    const preview = store.createChannelLinkPreview(
      {
        channelId: channel.id,
        messageId: message.id,
        url: "https://example.com/#ignored",
        normalizedUrl: "https://example.com/",
        title: "Example",
        status: "ready",
      },
      now,
    );

    assert.equal(store.getChannel(channel.id).defaultTeammateId, "engineer");
    assert.deepEqual(store.listChannelMessages({ channelId: channel.id }).map((item) => item.id), [message.id]);
    assert.equal(store.getChannelMessage(message.id).mentions[0].id, "engineer");
    assert.deepEqual(store.listChannelAttachments({ channelId: channel.id }).map((item) => item.id), [attachment.id]);
    assert.equal(store.getChannelAttachment(attachment.id).fileName, "brief.pdf");
    assert.deepEqual(store.listChannelLinkPreviews({ channelId: channel.id }).map((item) => item.id), [preview.id]);

    const updatedPreview = store.updateChannelLinkPreview(
      preview.id,
      { status: "failed", errorMessage: "blocked", title: null },
      "2026-05-28T00:01:00.000Z",
    );
    assert.equal(updatedPreview.status, "failed");
    assert.equal(updatedPreview.title, undefined);
    assert.equal(updatedPreview.errorMessage, "blocked");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel messages page latest history with stable cursors", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-page-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      "2026-05-29T00:00:00.000Z",
    );
    const messages = [];
    for (let index = 0; index < 520; index += 1) {
      messages.push(store.createChannelMessage(
        {
          channelId: channel.id,
          authorType: "local-user",
          body: `Message ${index + 1}`,
        },
        new Date(Date.UTC(2026, 4, 29, 0, 0, index)).toISOString(),
      ));
    }

    const defaultPage = store.listChannelMessagesPage({ channelId: channel.id });
    assert.equal(defaultPage.messages.length, 200);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(defaultPage.messages[0].body, "Message 321");
    assert.equal(defaultPage.messages.at(-1).body, "Message 520");
    assert.equal(defaultPage.nextBeforeMessageId, defaultPage.messages[0].id);

    const olderPage = store.listChannelMessagesPage({
      channelId: channel.id,
      beforeMessageId: defaultPage.nextBeforeMessageId,
      limit: 100,
    });
    assert.equal(olderPage.messages.length, 100);
    assert.equal(olderPage.hasMore, true);
    assert.equal(olderPage.messages[0].body, "Message 221");
    assert.equal(olderPage.messages.at(-1).body, "Message 320");
    assert.equal(new Set([...defaultPage.messages, ...olderPage.messages].map((message) => message.id)).size, 300);

    const oversizedPage = store.listChannelMessagesPage({ channelId: channel.id, limit: 999 });
    assert.equal(oversizedPage.messages.length, 500);
    assert.equal(oversizedPage.messages[0].body, "Message 21");
    assert.equal(oversizedPage.messages.at(-1).body, "Message 520");

    assert.throws(
      () => store.listChannelMessagesPage({ channelId: channel.id, beforeMessageId: "message_missing" }),
      /Invalid channel message cursor/,
    );

    assert.deepEqual(store.listChannelMessages({ channelId: channel.id, limit: 3 }).map((message) => message.body), [
      "Message 518",
      "Message 519",
      "Message 520",
    ]);

    assert.equal(messages.length, 520);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel message root pages can exclude channel branch lanes while keeping topic replies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-surface-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      "2026-05-29T00:00:00.000Z",
    );
    const branch = store.createChannelBranch(
      {
        channelId: channel.id,
        name: "Branch lane",
        rootThreadId: "thread_branch_lane",
      },
      "2026-05-29T00:00:01.000Z",
    );
    const rootMessage = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "Root message",
      },
      "2026-05-29T00:00:02.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: rootMessage.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "Root attached reply",
      },
      "2026-05-29T00:00:03.000Z",
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: branch.rootThreadId,
        authorType: "local-user",
        body: "Branch message",
      },
      "2026-05-29T00:00:04.000Z",
    );

    assert.deepEqual(
      store.listChannelMessages({
        channelId: channel.id,
        excludeThreadIds: [branch.rootThreadId],
        limit: 10,
      }).map((message) => message.body),
      ["Root message", "Root attached reply"],
    );
    assert.deepEqual(
      store.listChannelMessages({
        channelId: channel.id,
        threadId: branch.rootThreadId,
        limit: 10,
      }).map((message) => message.body),
      ["Branch message"],
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel message cursors keep same-timestamp order stable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-same-time-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      "2026-05-29T01:00:00.000Z",
    );
    for (let index = 0; index < 6; index += 1) {
      store.createChannelMessage(
        {
          channelId: channel.id,
          authorType: "local-user",
          body: `Same time ${index + 1}`,
        },
        "2026-05-29T01:01:00.000Z",
      );
    }

    const latest = store.listChannelMessagesPage({ channelId: channel.id, limit: 3 });
    assert.deepEqual(latest.messages.map((message) => message.body), [
      "Same time 4",
      "Same time 5",
      "Same time 6",
    ]);
    const older = store.listChannelMessagesPage({
      channelId: channel.id,
      limit: 3,
      beforeMessageId: latest.nextBeforeMessageId,
    });
    assert.deepEqual(older.messages.map((message) => message.body), [
      "Same time 1",
      "Same time 2",
      "Same time 3",
    ]);
    assert.equal(older.hasMore, false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel collaboration protocol persists brief, decisions, handoffs, and summaries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-"));
  const now = "2026-05-28T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const otherChannel = store.createChannel({ name: "Design", boundPath: cwd }, now);
    const message = store.createChannelMessage({ channelId: channel.id, authorType: "local-user", body: "Use manual handoffs." }, now);
    const otherMessage = store.createChannelMessage({ channelId: otherChannel.id, authorType: "local-user", body: "Wrong channel." }, now);
    const task = store.createTask({ channelId: channel.id, title: "Implement protocol", prompt: "Build v1.1." }, now);

    const firstDecision = store.createChannelDecision(
      {
        channelId: channel.id,
        sourceMessageId: message.id,
        title: "Manual handoffs",
        decision: "Handoffs are records only.",
        createdBy: "local-user",
      },
      now,
    );
    const secondDecision = store.createChannelDecision(
      {
        channelId: channel.id,
        title: "Manual handoffs update",
        decision: "Supersede without running agents.",
        supersedesDecisionId: firstDecision.id,
        createdBy: "local-user",
      },
      "2026-05-28T01:01:00.000Z",
    );
    assert.equal(store.getChannelDecision(firstDecision.id).status, "superseded");
    assert.equal(secondDecision.status, "active");

    const brief = store.updateChannelBrief(
      channel.id,
      {
        objective: "Ship channel v1.1",
        scope: "Track collaboration protocol.",
        acceptanceCriteria: ["Brief round trip"],
        decisionIds: [secondDecision.id],
        updatedBy: "local-user",
      },
      "2026-05-28T01:02:00.000Z",
    );
    assert.equal(store.getChannelBrief(channel.id).id, brief.id);
    assert.deepEqual(store.getChannelBrief(channel.id).decisionIds, [secondDecision.id]);

    const handoff = store.createChannelHandoff(
      {
        channelId: channel.id,
        sourceTaskId: task.id,
        fromParticipantId: "tian",
        fromParticipantLabel: "Tian",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        reason: "Need implementation",
        requiredInput: "Plan",
        expectedOutput: "Patch",
        createdBy: "local-user",
      },
      "2026-05-28T01:03:00.000Z",
    );
    assert.equal(store.updateChannelHandoff(handoff.id, { status: "completed" }, "2026-05-28T01:04:00.000Z").status, "completed");
    assert.equal(store.getTask(task.id).status, "todo");

    const summary = store.createChannelContextSummary(
      {
        channelId: channel.id,
        targetType: "task",
        targetId: task.id,
        sourceMessageIds: [message.id],
        decisionIds: [secondDecision.id],
        summary: "Implement the protocol state without agent automation.",
        authorType: "local-user",
      },
      "2026-05-28T01:05:00.000Z",
    );
    assert.deepEqual(store.listChannelContextSummaries({ channelId: channel.id, targetType: "task", targetId: task.id }).map((item) => item.id), [summary.id]);
    assert.throws(
      () => store.createChannelContextSummary(
        {
          channelId: channel.id,
          targetType: "thread",
          targetId: otherMessage.id,
          sourceMessageIds: [otherMessage.id],
          summary: "Cross channel should fail.",
          authorType: "local-user",
        },
        now,
      ),
      /does not belong to channel|not found/,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite handoff workflows persist steps, transitions, and workflow-step leases", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflows-"));
  const now = "2026-05-28T03:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Implement workflows", prompt: "Build v1.2." }, now);
    const handoff = store.createChannelHandoff(
      {
        channelId: channel.id,
        sourceTaskId: task.id,
        fromParticipantId: "tian",
        fromParticipantLabel: "Tian",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        reason: "Need implementation",
        requiredInput: "v1.2 plan",
        expectedOutput: "Patch",
        createdBy: "local-user",
      },
      now,
    );
    const summary = store.createChannelContextSummary(
      {
        channelId: channel.id,
        targetType: "task",
        targetId: task.id,
        summary: "Start from the handoff and create a workflow step.",
        authorType: "local-user",
      },
      now,
    );

    const workflow = store.createChannelWorkflow(
      {
        channelId: channel.id,
        sourceHandoffId: handoff.id,
        title: "Engineer handoff",
        objective: "Complete the implementation handoff.",
        createdBy: "local-user",
      },
      now,
    );
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        sourceHandoffId: handoff.id,
        contextSummaryId: summary.id,
        title: "Implement",
        prompt: "Create the patch.",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        metadata: {
          councilSlotKey: "engineer",
          proposalStepSources: [
            {
              kind: "council",
              councilId: "council_builtin_development",
              councilDisplayName: "Development Council",
              slotKey: "engineer",
              label: "Engineer",
            },
          ],
        },
      },
      now,
    );

    assert.equal(workflow.status, "draft");
    assert.equal(step.status, "queued");
    assert.equal(step.metadata.councilSlotKey, "engineer");
    assert.equal(step.metadata.proposalStepSources[0].councilId, "council_builtin_development");
    assert.deepEqual(store.listChannelWorkflows({ channelId: channel.id }).map((item) => item.id), [workflow.id]);
    assert.deepEqual(store.listChannelWorkflowSteps({ workflowId: workflow.id }).map((item) => item.id), [step.id]);

    assert.deepEqual(store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "draft",
      event: "prepare",
      actor: "system",
      now: "2026-05-28T03:01:00.000Z",
    }), { ok: true, from: "draft", to: "ready" });
    assert.deepEqual(store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "ready",
      event: "start",
      actor: "system",
      now: "2026-05-28T03:02:00.000Z",
    }), { ok: true, from: "ready", to: "running" });

    const firstLease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "workflow_step",
      resourceKey: step.id,
      ownerType: "workflow_step",
      ownerId: step.id,
      acquiredAt: "2026-05-28T03:02:30.000Z",
      expiresAt: "2026-05-28T04:02:30.000Z",
    });
    assert.ok(firstLease);
    assert.equal(store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "workflow_step",
      resourceKey: step.id,
      ownerType: "workflow_step",
      ownerId: "other-step",
      acquiredAt: "2026-05-28T03:02:31.000Z",
      expiresAt: "2026-05-28T04:02:31.000Z",
    }), undefined);

    assert.deepEqual(store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now: "2026-05-28T03:03:00.000Z",
    }), { ok: true, from: "queued", to: "claimed" });
    assert.deepEqual(store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now: "2026-05-28T03:04:00.000Z",
      taskId: task.id,
    }), { ok: true, from: "claimed", to: "running" });
    assert.deepEqual(store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      now: "2026-05-28T03:05:00.000Z",
      taskId: task.id,
      resultSummary: "Task created.",
    }), { ok: true, from: "running", to: "succeeded" });
    assert.equal(store.listResourceLeases({ status: "active", resourceType: "workflow_step" }).length, 0);

    const events = store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id });
    assert.deepEqual(events.map((event) => event.toStatus).sort(), ["claimed", "running", "succeeded"]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite task CAS claim and idempotency allow only one real transition", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-task-cas-"));
  const now = "2026-05-26T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const task = store.createTask(
      {
        channelId: channel.id,
        title: "Inspect workspace",
        prompt: "Inspect the repo.",
      },
      now,
    );

    const first = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:01.000Z",
    });
    assert.deepEqual(first, { ok: true, from: "todo", to: "claimed" });

    const stale = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_second",
      idempotencyKey: "client-key-2",
      now: "2026-05-26T00:00:02.000Z",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "stale_transition",
      currentStatus: "claimed",
    });

    const duplicate = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:03.000Z",
    });
    assert.deepEqual(duplicate, {
      ok: true,
      from: "claimed",
      to: "claimed",
      duplicate: true,
    });

    const events = store.listStateTransitionEvents({ entityType: "task", entityId: task.id });
    assert.equal(events.length, 1);
    assert.equal(events[0].fromStatus, "todo");
    assert.equal(events[0].toStatus, "claimed");
    assert.equal(events[0].idempotencyKey, "client-key-1");
    assert.equal(store.findStateTransitionByIdempotency("task", task.id, "client-key-1")?.reason, "run:run_first");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite active resource lease index blocks conflicting writers until release", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-conflict-"));
  const store = createSqliteRunStore(cwd);
  const acquiredAt = "2026-05-26T00:00:00.000Z";
  const expiresAt = "2026-05-26T01:00:00.000Z";
  try {
    const first = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_first",
      acquiredAt,
      expiresAt,
    });
    assert.ok(first);

    const second = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt,
      expiresAt,
    });
    assert.equal(second, undefined);
    assert.equal(store.getBlockingResourceLease("bound_path", cwd)?.ownerId, "run_first");

    assert.equal(store.releaseResourceLeasesForOwner("run", "run_first", "2026-05-26T00:05:00.000Z"), 1);
    const afterRelease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt: "2026-05-26T00:05:01.000Z",
      expiresAt,
    });
    assert.ok(afterRelease);
    assert.equal(store.listResourceLeases({ status: "active", resourceType: "bound_path" }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite lease expiry marks active stale leases as expired", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-expiry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "channel",
      resourceKey: "channel_1",
      ownerType: "run",
      ownerId: "run_stale",
      acquiredAt: "2026-05-26T00:00:00.000Z",
      expiresAt: "2026-05-26T00:01:00.000Z",
    });
    assert.ok(lease);

    assert.equal(store.expireResourceLeases("2026-05-26T00:02:00.000Z"), 1);
    assert.equal(store.listResourceLeases({ status: "active" }).length, 0);
    const expired = store.listResourceLeases({ status: "expired" });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].ownerId, "run_stale");
    assert.equal(expired[0].releasedAt, "2026-05-26T00:02:00.000Z");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite work units link run sessions and enforce CAS transitions", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-work-unit-cas-"));
  const now = "2026-06-04T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Runtime task", prompt: "Run under supervisor." }, now);
    const workUnit = store.createWorkUnit({
      id: "wu_task_runtime",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: task.id,
      channelId: channel.id,
      taskId: task.id,
      providerPresetId: "provider_runtime",
      idempotencyKey: "wu-key-1",
      createdByActor: "user",
      request: { prompt: task.prompt, apiKey: "secret-value" },
      now,
    });
    assert.equal(workUnit.status, "queued");
    assert.equal(workUnit.attemptCount, 0);
    assert.deepEqual(workUnit.request, { prompt: task.prompt, apiKey: "[REDACTED]" });
    assert.equal(
      store.findWorkUnitByIdempotency({
        kind: "task_run",
        ownerType: "task",
        ownerId: task.id,
        idempotencyKey: "wu-key-1",
      })?.id,
      workUnit.id,
    );

    store.createRun({
      id: "run_linked_runtime",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      providerPresetId: "provider_runtime",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: task,
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const linked = store.linkRunToWorkUnit("run_linked_runtime", workUnit.id, "2026-06-04T00:00:01.000Z");
    assert.equal(linked?.workUnitId, workUnit.id);
    assert.equal(store.getWorkUnit(workUnit.id)?.linkedRunId, "run_linked_runtime");

    const claimed = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      reason: "runtime_supervisor",
      idempotencyKey: "claim-once",
      now: "2026-06-04T00:00:02.000Z",
    });
    assert.deepEqual(claimed, { ok: true, from: "queued", to: "claimed" });

    const stale = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      reason: "runtime_supervisor",
      idempotencyKey: "claim-twice",
      now: "2026-06-04T00:00:03.000Z",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "stale_transition",
      currentStatus: "claimed",
    });

    const duplicate = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      reason: "runtime_supervisor",
      idempotencyKey: "claim-once",
      now: "2026-06-04T00:00:04.000Z",
    });
    assert.deepEqual(duplicate, { ok: true, from: "claimed", to: "claimed", duplicate: true });
    const transitions = store.listStateTransitionEvents({ entityType: "work_unit", entityId: workUnit.id });
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].event, "claim");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite runtime events heartbeat lease renewal and semaphore limits are durable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-heartbeat-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T00:10:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_heartbeat",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_heartbeat",
      idempotencyKey: "wu-heartbeat-key",
      createdByActor: "system",
      request: { prompt: "heartbeat" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_heartbeat",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_test",
      runnerId: "runner_pi_embedded",
      providerPresetId: "provider_runtime",
      now,
    });

    const firstEvent = store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      type: "work_unit_started",
      actor: "runner",
      data: { ok: true },
      ts: "2026-06-04T00:10:01.000Z",
    });
    const secondEvent = store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      type: "work_unit_progress",
      actor: "runner",
      data: { message: "progress" },
      ts: "2026-06-04T00:10:02.000Z",
    });
    assert.equal(firstEvent.seq, 1);
    assert.equal(secondEvent.seq, 2);
    assert.deepEqual(store.listRuntimeEvents(workUnit.id, { afterSeq: 1 }).map((event) => event.seq), [2]);

    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      acquiredAt: "2026-06-04T00:10:03.000Z",
      expiresAt: "2026-06-04T00:20:03.000Z",
    });
    assert.ok(lease);
    const slot = store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      acquiredAt: "2026-06-04T00:10:04.000Z",
      expiresAt: "2026-06-04T00:20:04.000Z",
    });
    assert.ok(slot);
    assert.equal(store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: "attempt_blocked",
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      acquiredAt: "2026-06-04T00:10:05.000Z",
      expiresAt: "2026-06-04T00:20:05.000Z",
    }), undefined);

    store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: "runtime_test",
      ts: "2026-06-04T00:11:00.000Z",
      source: "runner",
      detail: { apiKey: "secret-value" },
    });
    assert.equal(store.getWorkUnit(workUnit.id)?.lastHeartbeatAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.getWorkUnitAttempt(attempt.id)?.lastHeartbeatAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.listResourceLeases({ workUnitId: workUnit.id, status: "active" })[0]?.lastRenewedAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "active" })[0]?.lastRenewedAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, "2026-06-04T00:12:00.000Z", "test_release"), 1);
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "released" })[0]?.releaseReason, "test_release");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite runtime supervisor migration self-heals missing runtime tables while preserving legacy runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-supervisor-heal-"));
  let store = createSqliteRunStore(cwd);
  try {
    const databasePath = store.paths.databasePath;
    store.createRun({
      id: "run_legacy_no_work_unit",
      cwd,
      taskId: "task_legacy_no_work_unit",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_legacy_no_work_unit", title: "Legacy" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-04T00:30:00.000Z",
    });
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP TABLE IF EXISTS runtime_semaphore_slots;
        DROP TABLE IF EXISTS runtime_heartbeats;
        DROP TABLE IF EXISTS runtime_events;
        DROP TABLE IF EXISTS work_unit_attempts;
        DROP TABLE IF EXISTS work_units;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_units'").get()), false);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal(store.getRun("run_legacy_no_work_unit")?.workUnitId, undefined);
    const workUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: "media_job_after_heal",
      idempotencyKey: "after-heal",
      createdByActor: "system",
      request: { operation: "image_generate" },
      now: "2026-06-04T00:31:00.000Z",
    });
    assert.equal(store.getWorkUnit(workUnit.id)?.kind, "media_job");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel runtime migration self-heals missing lease tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-runtime-heal-"));
  let store = createSqliteRunStore(cwd);
  try {
    const databasePath = store.paths.databasePath;
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("DROP TABLE resource_leases;");
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_leases'").get()), false);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_healed",
      acquiredAt: "2026-05-26T00:20:00.000Z",
      expiresAt: "2026-05-26T00:30:00.000Z",
    });
    assert.ok(lease);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workspace migration self-heals old channel and task columns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-heal-"));
  const now = "2026-05-28T00:10:00.000Z";
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        ALTER TABLE channels DROP COLUMN default_teammate_id;
        ALTER TABLE tasks DROP COLUMN assignee_teammate_id;
        DROP TABLE channel_messages;
        DROP TABLE channel_attachments;
        DROP TABLE channel_link_previews;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get()), false);
    } finally {
      database.close();
    }

    const store = createSqliteRunStore(cwd);
    try {
      const channel = store.createChannel(
        {
          name: "Engineering",
          boundPath: cwd,
          defaultTeammateId: "engineer",
        },
        now,
      );
      const task = store.createTask(
        {
          channelId: channel.id,
          title: "Clarify channel requirements",
          prompt: "Turn the discussion into an executable task.",
          assigneeTeammateId: "engineer",
        },
        now,
      );
      const message = store.createChannelMessage(
        {
          channelId: channel.id,
          authorType: "local-user",
          body: "Migration should keep channel chat writable.",
        },
        now,
      );

      assert.equal(store.getChannel(channel.id).defaultTeammateId, "engineer");
      assert.equal(store.getTask(task.id).assigneeTeammateId, "engineer");
      assert.equal(store.getChannelMessage(message.id).body, "Migration should keep channel chat writable.");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel protocol migration self-heals missing protocol tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-heal-"));
  const now = "2026-05-28T02:00:00.000Z";
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP TABLE channel_briefs;
        DROP TABLE channel_decisions;
        DROP TABLE channel_handoffs;
        DROP TABLE channel_context_summaries;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_briefs'").get()), false);
    } finally {
      database.close();
    }

    const store = createSqliteRunStore(cwd);
    try {
      const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
      const brief = store.updateChannelBrief(
        channel.id,
        {
          objective: "Self heal protocol tables",
          scope: "Ensure old DBs can write v1.1 state.",
          updatedBy: "local-user",
        },
        now,
      );
      assert.equal(brief.objective, "Self heal protocol tables");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workflow migration self-heals missing workflow tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-heal-"));
  const now = "2026-05-28T04:00:00.000Z";
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP TABLE channel_workflow_steps;
        DROP TABLE channel_workflows;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_workflows'").get()), false);
    } finally {
      database.close();
    }

    const store = createSqliteRunStore(cwd);
    try {
      const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
      const workflow = store.createChannelWorkflow(
        {
          channelId: channel.id,
          title: "Self heal workflow tables",
          objective: "Ensure old DBs can write v1.2 state.",
          createdBy: "local-user",
        },
        now,
      );
      assert.equal(workflow.title, "Self heal workflow tables");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recoverStaleChannelWorkflows reconciles running steps from linked terminal runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-recovery-"));
  const now = "2026-06-05T00:00:00.000Z";
  const recoveredAt = "2026-06-05T00:05:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow(
      {
        channelId: channel.id,
        title: "Recover stale workflow",
        objective: "Reconcile linked run terminal state.",
        status: "running",
        createdBy: "system",
      },
      now,
    );
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        title: "Implementation",
        prompt: "Implement the thing.",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        status: "running",
      },
      now,
    );
    const task = store.createTask(
      {
        channelId: channel.id,
        title: "Workflow recovery",
        prompt: "Recover this workflow.",
      },
      now,
    );
    const run = store.createRun({
      id: "run_workflow_recovery_stale",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {
        id: task.id,
        title: "Workflow recovery",
        prompt: "Recover this workflow.",
        channelId: channel.id,
      },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "runner",
      now,
      startedAt: now,
    });
    store.updateChannelWorkflowStep(step.id, {
      taskId: task.id,
      runId: run.id,
    }, now);

    assert.equal(store.recoverStaleRuns(recoveredAt), 1);
    assert.ok(store.recoverStaleChannelWorkflows(recoveredAt) >= 2);

    assert.equal(store.getRun(run.id).status, "failed");
    assert.equal(store.getChannelWorkflowStep(step.id).status, "failed");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "failed");
    assert.equal(store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id }).some((event) => event.event === "fail"), true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
