import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewPageFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "./channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createSqliteRunStore,
  defaultChannelRuntimePolicy,
} from "../dist/index.js";
import { RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION } from "../dist/storage/sqlite/runtime-attempt-fence-migration.js";
import { createRequiredParticipantManifestV1 } from "../../contracts/dist/index.js";
import { SUPPORTED_LOCALES } from "../../localization/dist/index.js";

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
          schedulingMode: "smart",
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
      schedulingMode: "smart",
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

test("sqlite workspace settings persist provider-safe reasoning summary mode", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-reasoning-summary-"));
  const store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getWorkspaceSettings().defaultReasoningSummary, undefined);
    assert.equal(store.updateWorkspaceSettings({ defaultReasoningSummary: "detailed" }, "2026-09-12T04:30:00.000Z").defaultReasoningSummary, "detailed");
    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getWorkspaceSettings().defaultReasoningSummary, "detailed");
      assert.equal(reopened.updateWorkspaceSettings({ defaultReasoningSummary: "none" }, "2026-09-12T04:31:00.000Z").defaultReasoningSummary, "none");
      assert.equal(reopened.updateWorkspaceSettings({ defaultReasoningSummary: null }, "2026-09-12T04:32:00.000Z").defaultReasoningSummary, undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite workspace settings round-trip every supported interface and response locale", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-locales-"));
  const store = createSqliteRunStore(cwd);
  try {
    for (const [index, locale] of SUPPORTED_LOCALES.entries()) {
      const settings = store.updateWorkspaceSettings(
        { locale, responseLanguage: locale },
        new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
      );
      assert.equal(settings.locale, locale);
      assert.equal(settings.responseLanguage, locale);
    }
    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getWorkspaceSettings().locale, SUPPORTED_LOCALES.at(-1));
      assert.equal(reopened.getWorkspaceSettings().responseLanguage, SUPPORTED_LOCALES.at(-1));
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

    const message = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "这个频道自动回复怎么做？",
      },
      "2026-06-09T00:03:00.000Z",
    );
    const reply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        replyToItemId: message.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_engineer",
        body: "Use default_teammate for deterministic replies.",
      },
      "2026-06-09T00:04:00.000Z",
    );
    const sourceItem = store.getConversationItem(message.id);
    assert.ok(sourceItem?.turnId);
    const sourceAssignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
    assert.ok(sourceAssignment);
    const contextProjection = {
      projectionVersion: "ctxv2_route_test",
      sourceStateFingerprint: "source-state-route-test",
      threadId: sourceItem.threadId,
      turnId: sourceItem.turnId,
      segmentId: sourceAssignment.segmentId,
      throughItemSequence: sourceItem.sequence,
      summaryIds: [],
      sourceRefs: [{ type: "conversation_item", id: sourceItem.id }],
      policyVersion: "continuity-v2-projector-v1",
      visibilityFingerprint: "visibility-route-test",
    };
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
          contextProjection,
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
      contextProjection,
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
    const message = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "所有队友都回复我一下",
      },
      "2026-06-10T00:01:00.000Z",
    );
    const architectReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        replyToItemId: message.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_architect",
        body: "Architect opinion",
      },
      "2026-06-10T00:02:00.000Z",
    );
    const engineerReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        replyToItemId: message.id,
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
        sourceItemId: message.id,
        contextProjection: contextProjectionForItem(store, message.id),
        action: "visible_multi_reply",
        selectedTeammateIds: ["teammate_builtin_architect", "teammate_builtin_engineer"],
        participantManifest: createRequiredParticipantManifestV1([
          {
            participantId: "teammate_builtin_architect",
            role: "architect",
            requirement: "required",
            expectedOutcome: "discussion_reply",
            requiredOperationIds: [],
            requestedBy: "selector_policy",
          },
          {
            participantId: "teammate_builtin_engineer",
            role: "engineer",
            requirement: "required",
            expectedOutcome: "discussion_reply",
            requiredOperationIds: [],
            requestedBy: "selector_policy",
          },
        ]),
        resultItemIds: [architectReply.id, engineerReply.id],
        reason: "Visible multi-reply created for discussion.",
        status: "accepted",
        createdBy: "deterministic",
      },
      "2026-06-10T00:04:00.000Z",
    );

    assert.equal(decision.action, "visible_multi_reply");
    assert.deepEqual(decision.selectedTeammateIds, ["teammate_builtin_architect", "teammate_builtin_engineer"]);
    assert.deepEqual(decision.resultItemIds, [architectReply.id, engineerReply.id]);
    assert.equal(decision.schemaVersion, 2);
    const [listed] = store.listChannelIntentDecisions({ channelId: channel.id, sourceItemId: message.id });
    assert.equal(listed.id, decision.id);
    assert.deepEqual(listed.selectedTeammateIds, decision.selectedTeammateIds);
    assert.deepEqual(listed.resultItemIds, decision.resultItemIds);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function contextProjectionForItem(store, itemId) {
  const item = store.getConversationItem(itemId);
  assert.ok(item?.turnId);
  const assignment = store.getEffectiveTurnContextAssignment(item.turnId);
  assert.ok(assignment);
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

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
    const message = appendChannelItemFixture(store,
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
    assert.deepEqual(listChannelItemViewsFixture(store, { channelId: channel.id }).map((item) => item.id), [message.id]);
    assert.equal(getChannelItemViewFixture(store, message.id).mentions[0].id, "engineer");
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

test("sqlite channel items page latest history with stable sequence cursors", async () => {
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
      messages.push(appendChannelItemFixture(store,
        {
          channelId: channel.id,
          authorType: "local-user",
          body: `Message ${index + 1}`,
        },
        new Date(Date.UTC(2026, 4, 29, 0, 0, index)).toISOString(),
      ));
    }

    const threadId = store.getConversationItem(messages[0].id).threadId;
    const defaultPage = listChannelItemViewPageFixture(store, { threadId, limit: 200 });
    assert.equal(defaultPage.messages.length, 200);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(defaultPage.messages[0].body, "Message 321");
    assert.equal(defaultPage.messages.at(-1).body, "Message 520");
    assert.equal(defaultPage.nextBeforeSequence, store.getConversationItem(defaultPage.messages[0].id).sequence);

    const olderPage = listChannelItemViewPageFixture(store, {
      threadId,
      beforeSequence: defaultPage.nextBeforeSequence,
      limit: 100,
    });
    assert.equal(olderPage.messages.length, 100);
    assert.equal(olderPage.hasMore, true);
    assert.equal(olderPage.messages[0].body, "Message 221");
    assert.equal(olderPage.messages.at(-1).body, "Message 320");
    assert.equal(new Set([...defaultPage.messages, ...olderPage.messages].map((message) => message.id)).size, 300);

    const oversizedPage = listChannelItemViewPageFixture(store, { threadId, limit: 999 });
    assert.equal(oversizedPage.messages.length, 500);
    assert.equal(oversizedPage.messages[0].body, "Message 21");
    assert.equal(oversizedPage.messages.at(-1).body, "Message 520");

    assert.throws(
      () => listChannelItemViewPageFixture(store, { threadId, beforeSequence: 0 }),
      /Invalid conversation item cursor/,
    );

    assert.deepEqual(listChannelItemViewsFixture(store, { channelId: channel.id, limit: 3 }).map((message) => message.body), [
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
    const rootMessage = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "Root message",
      },
      "2026-05-29T00:00:02.000Z",
    );
    const rootItem = store.getConversationItem(rootMessage.id);
    assert.ok(rootItem?.turnId);
    const rootAssignment = store.getEffectiveTurnContextAssignment(rootItem.turnId);
    assert.ok(rootAssignment);
    const branchThread = store.resolveOrCreateConversationThread({
      id: "thread_branch_lane",
      surfaceKind: "branch",
      channelId: channel.id,
      parentThreadId: rootItem.threadId,
      parentTurnId: rootItem.turnId,
      title: "Branch lane",
      objective: "Test branch isolation.",
      forkContextSnapshot: {
        id: "snapshot_branch_lane",
        segmentId: rootAssignment.segmentId,
        projectionVersion: "ctxv2_branch_lane",
        throughItemSequence: rootItem.sequence,
        summaryIds: [],
        sourceRefs: [{ type: "conversation_item", id: rootItem.id }],
        policyVersion: "continuity-v2-snapshot-v1",
      },
    }, "2026-05-29T00:00:02.500Z").thread;
    const branch = store.createChannelBranch(
      {
        channelId: channel.id,
        name: "Branch lane",
        rootThreadId: branchThread.id,
      },
      "2026-05-29T00:00:02.750Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        replyToItemId: rootMessage.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "Root attached reply",
      },
      "2026-05-29T00:00:03.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: branch.rootThreadId,
        authorType: "local-user",
        body: "Branch message",
      },
      "2026-05-29T00:00:04.000Z",
    );

    assert.deepEqual(
      listChannelItemViewsFixture(store, {
        channelId: channel.id,
        excludeThreadIds: [branch.rootThreadId],
        limit: 10,
      }).map((message) => message.body),
      ["Root message", "Root attached reply"],
    );
    assert.deepEqual(
      listChannelItemViewsFixture(store, {
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

test("sqlite channel item sequence cursors keep same-timestamp order stable", async () => {
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
      appendChannelItemFixture(store,
        {
          channelId: channel.id,
          authorType: "local-user",
          body: `Same time ${index + 1}`,
        },
        "2026-05-29T01:01:00.000Z",
      );
    }

    const threadId = store.findLingThreadByOwner({ kind: "channel_discussion", channelId: channel.id }).id;
    const latest = listChannelItemViewPageFixture(store, { threadId, limit: 3 });
    assert.deepEqual(latest.messages.map((message) => message.body), [
      "Same time 4",
      "Same time 5",
      "Same time 6",
    ]);
    const older = listChannelItemViewPageFixture(store, {
      threadId,
      limit: 3,
      beforeSequence: latest.nextBeforeSequence,
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
    const message = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Use manual handoffs." }, now);
    const otherMessage = appendChannelItemFixture(store, { channelId: otherChannel.id, authorType: "local-user", body: "Wrong channel." }, now);
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

test("workflow step complete reads are not truncated at the interactive 500-row limit", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-step-complete-read-"));
  const now = "2026-05-28T04:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Large workflow", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Large workflow",
      objective: "Exercise canonical complete reads.",
      createdBy: "system",
    }, now);
    for (let index = 0; index < 501; index += 1) {
      store.createChannelWorkflowStep({
        workflowId: workflow.id,
        title: `Step ${index}`,
        prompt: `Step ${index}`,
        toParticipantId: "teammate_builtin_engineer",
        toParticipantLabel: "Engineer",
        position: index,
      }, now);
    }
    assert.equal(store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }).length, 500);
    assert.equal(store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true }).length, 501);
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
      ownerType: "system",
      ownerId: "run_first",
      acquiredAt,
      expiresAt,
    });
    assert.ok(first);

    const second = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "system",
      ownerId: "run_second",
      acquiredAt,
      expiresAt,
    });
    assert.equal(second, undefined);
    assert.equal(store.getBlockingResourceLease("bound_path", cwd)?.ownerId, "run_first");

    assert.equal(store.releaseResourceLeasesForOwner("system", "run_first", "2026-05-26T00:05:00.000Z"), 1);
    const afterRelease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "system",
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
      ownerType: "system",
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

test("runtime Run leases require the current Attempt fence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-lease-contract-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T00:05:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "run",
      ownerId: "run_fenced_contract",
      idempotencyKey: "runtime-lease-contract",
      createdByActor: "system",
      request: { prompt: "fenced lease" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_contract",
      runnerId: "runner_pi_embedded",
      now,
    });
    const base = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_contract",
      ownerType: "run",
      ownerId: "run_fenced_contract",
      acquiredAt: now,
      expiresAt: "2099-06-04T00:05:00.000Z",
    };
    assert.equal(store.acquireResourceLease(base), undefined);
    assert.equal(store.acquireResourceLease({
      ...base,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: "stale",
    }), undefined);
    const lease = store.acquireResourceLease({
      ...base,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    });
    assert.ok(lease);
    assert.throws(
      () => store.releaseResourceLeasesForOwner("run", "run_fenced_contract", now),
      /Owner-level resource lease release requires workflow_step or system ownership/u,
    );
    assert.equal(store.listResourceLeases({ ownerType: "run", ownerId: "run_fenced_contract", status: "active" }).length, 1);
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
      contextViewId: "context_view_runtime",
      contextViewCreatedAt: "2026-06-04T00:00:00.000Z",
      createdAt: now,
    });
    assert.equal(store.getRun("run_linked_runtime")?.contextViewId, "context_view_runtime");
    assert.equal(store.getRun("run_linked_runtime")?.contextViewCreatedAt, "2026-06-04T00:00:00.000Z");
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
    assert.equal(attempt.fencingToken, "1");

    const firstEvent = store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: "work_unit_started",
      actor: "runner",
      data: { ok: true },
      ts: "2026-06-04T00:10:01.000Z",
    });
    const secondEvent = store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: "work_unit_progress",
      actor: "runner",
      data: { message: "progress" },
      ts: "2026-06-04T00:10:02.000Z",
    });
    assert.equal(firstEvent.seq, 2);
    assert.equal(secondEvent.seq, 3);
    assert.equal(firstEvent.fencingToken, attempt.fencingToken);
    assert.equal(secondEvent.fencingToken, attempt.fencingToken);
    assert.deepEqual(store.listRuntimeEvents(workUnit.id, { afterSeq: 2 }).map((event) => event.seq), [3]);

    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      acquiredAt: "2026-06-04T00:10:03.000Z",
      expiresAt: "2026-06-04T00:20:03.000Z",
    });
    assert.ok(lease);
    assert.equal(lease.fencingToken, attempt.fencingToken);
    const slot = store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      acquiredAt: "2026-06-04T00:10:04.000Z",
      expiresAt: "2026-06-04T00:20:04.000Z",
    });
    assert.ok(slot);
    assert.equal(slot.fencingToken, attempt.fencingToken);
    assert.equal(store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_runtime",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: "attempt_blocked",
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      acquiredAt: "2026-06-04T00:10:05.000Z",
      expiresAt: "2026-06-04T00:20:05.000Z",
    }), undefined);

    store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: "runtime_test",
      fencingToken: attempt.fencingToken,
      ts: "2026-06-04T00:11:00.000Z",
      source: "runner",
      detail: { apiKey: "secret-value" },
    });
    assert.equal(store.getWorkUnit(workUnit.id)?.lastHeartbeatAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.getWorkUnitAttempt(attempt.id)?.lastHeartbeatAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.listResourceLeases({ workUnitId: workUnit.id, status: "active" })[0]?.lastRenewedAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "active" })[0]?.lastRenewedAt, "2026-06-04T00:11:00.000Z");
    assert.equal(store.releaseRuntimeSemaphoreSlotsForAttempt({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    }, "2026-06-04T00:12:00.000Z", "test_release"), 1);
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "released" })[0]?.releaseReason, "test_release");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime heartbeat rolls back the audit row when canonical activity cannot commit", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-heartbeat-atomic-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T00:30:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_heartbeat_atomic",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_heartbeat_atomic",
      idempotencyKey: "wu-heartbeat-atomic-key",
      createdByActor: "system",
      request: { prompt: "heartbeat atomically" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_heartbeat_atomic",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_atomic",
      runnerId: "runner_pi_embedded",
      status: "started",
      now,
    });
    store.database.exec(`
      CREATE TRIGGER fail_runtime_heartbeat_canonical_activity
      BEFORE UPDATE OF last_heartbeat_at ON work_units
      WHEN NEW.id = 'wu_runtime_heartbeat_atomic'
      BEGIN
        SELECT RAISE(ABORT, 'runtime heartbeat canonical activity fault');
      END;
    `);

    assert.throws(() => store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      source: "runner",
      ts: "2026-06-04T00:30:01.000Z",
    }), /runtime heartbeat canonical activity fault/u);
    assert.equal(store.database.prepare(`
      SELECT COUNT(*) AS count FROM runtime_heartbeats WHERE work_unit_id = ?
    `).get(workUnit.id).count, 0);
    assert.equal(store.getWorkUnit(workUnit.id)?.lastHeartbeatAt, undefined);
    assert.equal(store.getWorkUnitAttempt(attempt.id)?.lastHeartbeatAt, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime semaphore acquisition expires abandoned slots before enforcing the limit", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-semaphore-expiry-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T00:40:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_semaphore_expiry",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_semaphore_expiry",
      idempotencyKey: "wu-semaphore-expiry-key",
      createdByActor: "system",
      request: { prompt: "recover semaphore capacity" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_semaphore_expiry",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_semaphore_expiry",
      runnerId: "runner_pi_embedded",
      status: "started",
      now,
    });
    const fence = {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    };
    const abandoned = store.acquireRuntimeSemaphoreSlot({
      ...fence,
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_expiring",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      acquiredAt: now,
      expiresAt: "2026-06-04T00:40:01.000Z",
    });
    assert.ok(abandoned);

    const replacement = store.acquireRuntimeSemaphoreSlot({
      ...fence,
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_expiring",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: attempt.id,
      acquiredAt: "2026-06-04T00:40:02.000Z",
      expiresAt: "2026-06-04T00:50:02.000Z",
    });
    assert.ok(replacement);
    assert.equal(store.listRuntimeSemaphoreSlots({ status: "expired", workUnitId: workUnit.id })[0]?.id, abandoned.id);
    assert.equal(store.listRuntimeSemaphoreSlots({ status: "expired", workUnitId: workUnit.id })[0]?.releaseReason, "expired");
    assert.equal(store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: workUnit.id })[0]?.id, replacement.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime fencing rejects callbacks from a replaced Attempt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-fence-stale-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T01:00:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_fence_stale",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_fence_stale",
      idempotencyKey: "wu-fence-stale-key",
      createdByActor: "system",
      request: { prompt: "fence" },
      now,
    });
    const first = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_stale_1",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_old",
      runnerId: "runner_pi_embedded",
      now,
    });
    const second = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_stale_2",
      workUnitId: workUnit.id,
      attemptNumber: 2,
      runtimeInstanceId: "runtime_new",
      runnerId: "runner_pi_embedded",
      now: "2026-06-04T01:00:01.000Z",
    });
    assert.equal(first.fencingToken, "1");
    assert.equal(second.fencingToken, "2");
    assert.equal(store.getWorkUnit(workUnit.id)?.activeAttemptId, second.id);
    assert.equal(store.getWorkUnitAttempt(first.id)?.status, "lost");
    const currentLease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_replacement",
      ownerType: "work_unit_attempt",
      ownerId: second.id,
      workUnitId: workUnit.id,
      attemptId: second.id,
      runtimeInstanceId: second.runtimeInstanceId,
      fencingToken: second.fencingToken,
      acquiredAt: "2026-06-04T01:00:01.500Z",
      expiresAt: "2026-06-04T01:10:01.500Z",
    });
    const currentSlot = store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_replacement",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: second.id,
      workUnitId: workUnit.id,
      attemptId: second.id,
      runtimeInstanceId: second.runtimeInstanceId,
      fencingToken: second.fencingToken,
      acquiredAt: "2026-06-04T01:00:01.500Z",
      expiresAt: "2026-06-04T01:10:01.500Z",
    });
    assert.ok(currentLease);
    assert.ok(currentSlot);
    const staleFence = {
      workUnitId: workUnit.id,
      attemptId: first.id,
      runtimeInstanceId: first.runtimeInstanceId,
      fencingToken: first.fencingToken,
    };
    assert.equal(store.renewResourceLeasesForAttempt(staleFence, "2026-06-04T01:00:02.000Z"), 0);
    assert.equal(store.releaseResourceLeasesForAttempt(staleFence, "2026-06-04T01:00:02.000Z", "stale"), 0);
    assert.equal(store.releaseRuntimeSemaphoreSlotsForAttempt(staleFence, "2026-06-04T01:00:02.000Z", "stale"), 0);
    assert.equal(store.listResourceLeases({ workUnitId: workUnit.id, status: "active" }).some((lease) => lease.id === currentLease.id), true);
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "active" }).some((slot) => slot.id === currentSlot.id), true);
    assert.throws(() => store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: second.id,
      type: "work_unit_progress",
      actor: "runner",
      data: { missingFence: true },
      ts: "2026-06-04T01:00:02.000Z",
    }), /Stale runtime attempt fence/);
    const beforeDiagnostic = store.getWorkUnit(workUnit.id);
    const beforeDiagnosticAttempt = store.getWorkUnitAttempt(first.id);
    const diagnostic = store.appendRuntimeDiagnosticEvent({
      ...staleFence,
      type: "stale_runner_completion_ignored",
      actor: "system",
      data: { reason: "attempt_not_current" },
      ts: "2026-06-04T01:00:02.000Z",
    });
    assert.equal(diagnostic.attemptId, first.id);
    assert.equal(diagnostic.runtimeInstanceId, first.runtimeInstanceId);
    assert.equal(store.getWorkUnit(workUnit.id)?.lastEventAt, beforeDiagnostic?.lastEventAt);
    assert.equal(store.getWorkUnitAttempt(first.id)?.lastEventAt, beforeDiagnosticAttempt?.lastEventAt);
    assert.throws(() => store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: first.id,
      runtimeInstanceId: first.runtimeInstanceId,
      fencingToken: first.fencingToken,
      type: "work_unit_progress",
      actor: "runner",
      data: { stale: true },
      ts: "2026-06-04T01:00:02.000Z",
    }), /Stale runtime attempt fence/);
    assert.equal(store.updateWorkUnitAttemptStatus({
      attemptId: first.id,
      workUnitId: workUnit.id,
      runtimeInstanceId: first.runtimeInstanceId,
      fencingToken: first.fencingToken,
      status: "started",
      now: "2026-06-04T01:00:02.000Z",
    }), undefined);
    assert.throws(() => store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: first.id,
      runtimeInstanceId: first.runtimeInstanceId,
      fencingToken: first.fencingToken,
      source: "runner",
      ts: "2026-06-04T01:00:02.000Z",
    }), /Stale runtime heartbeat fence/);
    assert.equal(store.listRuntimeEvents(workUnit.id).filter((event) => event.attemptId === first.id && event.type === "work_unit_progress").length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal runtime audit is fenced, idempotent, and replayable only by the current owner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-terminal-audit-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T02:00:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_terminal_audit",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_terminal_audit",
      idempotencyKey: "wu-terminal-audit-key",
      createdByActor: "system",
      request: { prompt: "terminal audit" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_terminal_audit",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_terminal_audit",
      runnerId: "runner_pi_embedded",
      now,
    });
    const fence = {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    };
    assert.equal(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
    assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok, true);
    const terminalAt = "2026-06-04T02:00:01.000Z";
    assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: terminalAt, endedAt: terminalAt }).ok, true);
    const terminalAttempt = store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", now: terminalAt, endedAt: terminalAt });
    assert.equal(terminalAttempt?.status, "succeeded");
    const capability = { ...fence, attemptStatus: "succeeded", transitionedAt: terminalAt };
    const first = store.appendTerminalRuntimeAudit({
      capability,
      type: "work_unit_succeeded",
      actor: "runner",
      data: { verified: true },
    });
    const replay = store.appendTerminalRuntimeAudit({
      capability,
      type: "work_unit_succeeded",
      actor: "runner",
      data: { replay: true },
    });
    assert.equal(replay.id, first.id);
    assert.equal(store.listRuntimeEvents(workUnit.id).filter((event) => event.type === "work_unit_succeeded").length, 1);
    assert.throws(() => store.appendTerminalRuntimeAudit({
      capability: { ...capability, fencingToken: "999" },
      type: "work_unit_succeeded",
      actor: "runner",
      data: {},
    }), /Stale terminal audit fence/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal Work Unit transition rolls back Work Unit, Attempt, and audit together", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-terminal-atomic-"));
  const initial = createSqliteRunStore(cwd);
  const now = "2026-06-04T02:30:00.000Z";
  const workUnit = initial.createWorkUnit({
    id: "wu_runtime_terminal_atomic",
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "task",
    ownerId: "task_runtime_terminal_atomic",
    idempotencyKey: "wu-terminal-atomic-key",
    createdByActor: "system",
    request: { prompt: "terminal atomicity" },
    now,
  });
  const attempt = initial.createWorkUnitAttempt({
    id: "attempt_runtime_terminal_atomic",
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_terminal_atomic",
    runnerId: "runner_pi_embedded",
    now,
  });
  const fence = {
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken,
  };
  assert.equal(initial.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
  assert.equal(initial.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok, true);
  assert.ok(initial.updateWorkUnitAttemptStatus({ ...fence, status: "started", now, startedAt: now }));
  const databasePath = initial.paths.databasePath;
  initial.close();

  const injected = new DatabaseSync(databasePath);
  injected.exec(`
    CREATE TRIGGER fail_terminal_runtime_audit
    BEFORE INSERT ON runtime_events
    WHEN NEW.type = 'work_unit_succeeded'
    BEGIN
      SELECT RAISE(ABORT, 'inject_terminal_runtime_audit_failure');
    END;
  `);
  injected.close();

  const store = createSqliteRunStore(cwd);
  try {
    const terminalAt = "2026-06-04T02:30:01.000Z";
    assert.throws(() => store.transitionWorkUnitAttemptTerminal({
      ...fence,
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
      actor: "runner",
      now: terminalAt,
    }), /inject_terminal_runtime_audit_failure/);
    assert.equal(store.getWorkUnit(workUnit.id)?.status, "running");
    assert.equal(store.getWorkUnit(workUnit.id)?.endedAt, undefined);
    assert.equal(store.getWorkUnitAttempt(attempt.id)?.status, "started");
    assert.equal(store.getWorkUnitAttempt(attempt.id)?.endedAt, undefined);
    assert.equal(store.listRuntimeEvents(workUnit.id).some((event) => event.type === "work_unit_succeeded"), false);
    assert.equal(
      store.listStateTransitionEvents({ entityType: "work_unit", entityId: workUnit.id })
        .some((event) => event.toStatus === "succeeded"),
      false,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lost Attempt reconciliation accepts only runner_failed from system authority", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-lost-reconcile-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T03:00:00.000Z";
  try {
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_lost_reconcile",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_lost_reconcile",
      idempotencyKey: "wu-lost-reconcile-key",
      createdByActor: "system",
      request: { prompt: "lost reconciliation" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_lost_reconcile",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_lost_reconcile",
      runnerId: "runner_pi_embedded",
      now,
    });
    const fence = {
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    };
    assert.equal(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
    assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok, true);
    const lostAt = "2026-06-04T03:00:01.000Z";
    assert.equal(store.updateWorkUnitAttemptStatus({ ...fence, status: "lost", now: lostAt, endedAt: lostAt })?.status, "lost");
    const ownership = { kind: "lost_attempt_reconciliation" };
    assert.equal(store.transitionWorkUnitStatus({ ...fence, terminalAttemptOwnership: ownership, expectedStatus: "running", event: "runner_succeeded", actor: "system", now: lostAt }).ok, false);
    assert.equal(store.transitionWorkUnitStatus({ ...fence, terminalAttemptOwnership: ownership, expectedStatus: "running", event: "runner_failed", actor: "runner", now: lostAt }).ok, false);
    assert.equal(store.transitionWorkUnitStatus({ ...fence, terminalAttemptOwnership: ownership, expectedStatus: "running", event: "runner_failed", actor: "system", now: lostAt, endedAt: lostAt }).ok, true);
    assert.equal(store.getWorkUnit(workUnit.id)?.status, "failed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime attempt fence migration discards unfenced development runtime state without fabricating tokens", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-fence-clean-break-"));
  let store = createSqliteRunStore(cwd);
  const now = "2026-06-04T04:00:00.000Z";
  try {
    const databasePath = store.paths.databasePath;
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_fence_clean_break",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_fence_clean_break",
      idempotencyKey: "wu-runtime-fence-clean-break",
      createdByActor: "system",
      request: { prompt: "backfill legacy runtime projections" },
      now,
    });
    const priorAttempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_clean_break_1",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_fence_clean_break_old",
      runnerId: "runner_pi_embedded",
      now,
    });
    const currentAttempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_clean_break_2",
      workUnitId: workUnit.id,
      attemptNumber: 2,
      runtimeInstanceId: "runtime_fence_clean_break_current",
      runnerId: "runner_pi_embedded",
      now: "2026-06-04T04:00:01.000Z",
    });
    // The old row is inserted below as a pre-fence development snapshot. A
    // replaced Attempt is not allowed to acquire a new lease at runtime.
    const priorLease = { id: "lease_runtime_fence_prior" };
    const currentLease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: `${cwd}/current`,
      ownerType: "work_unit_attempt",
      ownerId: currentAttempt.id,
      workUnitId: workUnit.id,
      attemptId: currentAttempt.id,
      runtimeInstanceId: currentAttempt.runtimeInstanceId,
      fencingToken: currentAttempt.fencingToken,
      acquiredAt: "2026-06-04T04:00:02.000Z",
      expiresAt: "2099-06-04T04:00:02.000Z",
    });
    // Like the prior lease, seed historical unfenced state below. Runtime admission
    // must reject a replaced attempt, even when a migration fixture needs its old row.
    const priorSlot = { id: "slot_runtime_fence_prior" };
    const currentSlot = store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "provider",
      resourceKey: "provider_fence_clean_break_current",
      limit: 1,
      ownerType: "work_unit_attempt",
      ownerId: currentAttempt.id,
      workUnitId: workUnit.id,
      attemptId: currentAttempt.id,
      runtimeInstanceId: currentAttempt.runtimeInstanceId,
      fencingToken: currentAttempt.fencingToken,
      acquiredAt: "2026-06-04T04:00:02.000Z",
      expiresAt: "2099-06-04T04:00:02.000Z",
    });
    assert.ok(priorLease);
    assert.ok(currentLease);
    assert.ok(priorSlot);
    assert.ok(currentSlot);
    store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: currentAttempt.id,
      runtimeInstanceId: currentAttempt.runtimeInstanceId,
      fencingToken: currentAttempt.fencingToken,
      ts: "2026-06-04T04:00:03.000Z",
      source: "runner",
    });
    store.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    try {
      legacyDatabase.exec(`
        DROP INDEX idx_work_unit_attempts_active;
        DROP INDEX idx_work_unit_attempts_fence;
        DROP INDEX idx_runtime_events_fence;
        DROP INDEX idx_runtime_heartbeats_fence;
        DROP INDEX idx_runtime_semaphore_fence;
        DROP INDEX idx_resource_leases_fence;
        DELETE FROM schema_migrations WHERE version = ${RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION};
        ALTER TABLE work_unit_attempts DROP COLUMN fencing_token;
        ALTER TABLE runtime_events DROP COLUMN runtime_instance_id;
        ALTER TABLE runtime_events DROP COLUMN fencing_token;
        ALTER TABLE runtime_heartbeats DROP COLUMN fencing_token;
        ALTER TABLE runtime_semaphore_slots DROP COLUMN runtime_instance_id;
        ALTER TABLE runtime_semaphore_slots DROP COLUMN fencing_token;
        ALTER TABLE resource_leases DROP COLUMN runtime_instance_id;
        ALTER TABLE resource_leases DROP COLUMN fencing_token;
        INSERT INTO runtime_semaphore_slots (
          id, workspace_id, resource_type, resource_key, owner_type, owner_id,
          work_unit_id, attempt_id, status, acquired_at, last_renewed_at, expires_at
        ) VALUES (
          '${priorSlot.id}', 'workspace_default', 'provider', 'provider_fence_clean_break_old',
          'work_unit_attempt', '${priorAttempt.id}', '${workUnit.id}', '${priorAttempt.id}',
          'active', '2026-06-04T04:00:02.000Z', '2026-06-04T04:00:02.000Z', '2099-06-04T04:00:02.000Z'
        );
        UPDATE work_unit_attempts
        SET
          status = CASE WHEN id = '${priorAttempt.id}' THEN 'started' ELSE status END,
          ended_at = CASE WHEN id = '${priorAttempt.id}' THEN NULL ELSE ended_at END,
          error_code = CASE WHEN id = '${priorAttempt.id}' THEN NULL ELSE error_code END,
          error_message = CASE WHEN id = '${priorAttempt.id}' THEN NULL ELSE error_message END;
        INSERT INTO resource_leases (
          id, workspace_id, resource_type, resource_key, owner_type, owner_id,
          status, acquired_at, expires_at, last_renewed_at, released_at,
          release_reason, work_unit_id, attempt_id
        ) VALUES (
          'lease_runtime_fence_prior', 'workspace_default', 'bound_path',
          '${cwd}/prior', 'work_unit_attempt', '${priorAttempt.id}', 'active',
          '2026-06-04T04:00:02.000Z', '2099-06-04T04:00:02.000Z',
          '2026-06-04T04:00:02.000Z', NULL, NULL, '${workUnit.id}',
          '${priorAttempt.id}'
        );
        INSERT INTO resource_leases (
          id, workspace_id, resource_type, resource_key, owner_type, owner_id,
          status, acquired_at, expires_at, last_renewed_at, released_at,
          release_reason, work_unit_id, attempt_id
        ) VALUES (
          'lease_runtime_fence_unbound_run', 'workspace_default', 'provider',
          '${cwd}/legacy-unbound-run', 'run', 'run_legacy_unbound', 'active',
          '2026-06-04T04:00:02.000Z', '2099-06-04T04:00:02.000Z',
          '2026-06-04T04:00:02.000Z', NULL, NULL, NULL, NULL
        );
      `);
    } finally {
      legacyDatabase.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal(store.getWorkUnitAttempt(priorAttempt.id), undefined);
    assert.equal(store.getWorkUnitAttempt(currentAttempt.id), undefined);
    assert.equal(store.getWorkUnit(workUnit.id)?.activeAttemptId, undefined);
    assert.equal(store.listRuntimeEvents(workUnit.id).some((event) => event.attemptId), false);
    assert.equal(store.listResourceLeases({ workUnitId: workUnit.id, limit: 10 }).length, 0);
    assert.equal(store.listResourceLeases({ ownerType: "run", ownerId: "run_legacy_unbound", limit: 10 }).length, 0);
    assert.equal(store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, limit: 10 }).length, 0);

    const freshAttempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_after_clean_break",
      workUnitId: workUnit.id,
      attemptNumber: 3,
      runtimeInstanceId: "runtime_fence_after_clean_break",
      runnerId: "runner_pi_embedded",
      now: "2026-06-04T04:00:04.000Z",
    });
    assert.equal(freshAttempt.fencingToken, "1");

    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const unfencedRows = migratedDatabase.prepare(`
        SELECT
          (SELECT COUNT(*) FROM work_unit_attempts WHERE fencing_token IS NULL OR fencing_token = '')
          + (SELECT COUNT(*) FROM runtime_heartbeats WHERE fencing_token IS NULL OR fencing_token = '')
          + (SELECT COUNT(*) FROM runtime_semaphore_slots
             WHERE runtime_instance_id IS NULL OR fencing_token IS NULL OR fencing_token = '') AS count
      `).get();
      assert.equal(Number(unfencedRows?.count), 0);
    } finally {
      migratedDatabase.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime attempt fence migration discards an orphan development heartbeat", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-fence-orphan-heartbeat-"));
  let store = createSqliteRunStore(cwd);
  const now = "2026-06-04T05:00:00.000Z";
  try {
    const databasePath = store.paths.databasePath;
    const workUnit = store.createWorkUnit({
      id: "wu_runtime_fence_orphan_heartbeat",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_runtime_fence_orphan_heartbeat",
      idempotencyKey: "wu-runtime-fence-orphan-heartbeat",
      createdByActor: "system",
      request: { prompt: "orphan heartbeat" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_runtime_fence_orphan_heartbeat",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_fence_orphan_heartbeat",
      runnerId: "runner_pi_embedded",
      now,
    });
    store.recordRuntimeHeartbeat({
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      ts: "2026-06-04T05:00:01.000Z",
      source: "runner",
    });
    store.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    try {
      legacyDatabase.exec(`
        PRAGMA foreign_keys = OFF;
        DROP INDEX idx_runtime_heartbeats_fence;
        DELETE FROM schema_migrations WHERE version = ${RUNTIME_ATTEMPT_FENCE_MIGRATION_VERSION};
        ALTER TABLE runtime_heartbeats DROP COLUMN fencing_token;
        UPDATE runtime_heartbeats
        SET attempt_id = 'attempt_missing_after_legacy_crash';
      `);
    } finally {
      legacyDatabase.close();
    }

    store = createSqliteRunStore(cwd);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const heartbeatCount = migratedDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM runtime_heartbeats
        WHERE work_unit_id = ?
      `).get(workUnit.id);
      assert.equal(Number(heartbeatCount?.count), 0);
      assert.equal(store.getWorkUnitAttempt(attempt.id)?.fencingToken, attempt.fencingToken);
    } finally {
      migratedDatabase.close();
    }
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
        DROP TABLE IF EXISTS runner_continuations;
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
      ownerType: "system",
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
        DROP TABLE channel_attachments;
        DROP TABLE channel_link_previews;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_items'").get()), true);
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
      const message = appendChannelItemFixture(store,
        {
          channelId: channel.id,
          authorType: "local-user",
          body: "Migration should keep channel chat writable.",
        },
        now,
      );

      assert.equal(store.getChannel(channel.id).defaultTeammateId, "engineer");
      assert.equal(store.getTask(task.id).assigneeTeammateId, "engineer");
      assert.equal(getChannelItemViewFixture(store, message.id).body, "Migration should keep channel chat writable.");
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

test("sqlite workflow agent context migration self-heals its durable stamp column and handoff index", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-agent-context-heal-"));
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("ALTER TABLE workflow_handoff_intents DROP COLUMN agent_context_json;");
      assert.equal(
        database.prepare("PRAGMA table_info(workflow_handoff_intents)").all().some((row) => row.name === "agent_context_json"),
        false,
      );
    } finally {
      database.close();
    }

    createSqliteRunStore(cwd).close();
    const repaired = new DatabaseSync(databasePath);
    try {
      assert.equal(
        repaired.prepare("PRAGMA table_info(workflow_handoff_intents)").all().some((row) => row.name === "agent_context_json"),
        true,
      );
      assert.ok(repaired.prepare(
        "SELECT version FROM schema_migrations WHERE version = 112 AND name = 'add_workflow_agent_context_stamp'",
      ).get());
      assert.ok(repaired.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_handoff_intents_channel_handoff'",
      ).get());
      repaired.exec("DROP INDEX idx_workflow_handoff_intents_channel_handoff;");
    } finally {
      repaired.close();
    }

    createSqliteRunStore(cwd).close();
    const indexRepaired = new DatabaseSync(databasePath);
    try {
      assert.ok(indexRepaired.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_handoff_intents_channel_handoff'",
      ).get());
    } finally {
      indexRepaired.close();
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

test("startup recovery preserves a waiting Run with a valid pending approval resume checkpoint", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-recover-approval-checkpoint-"));
  const now = "2026-08-15T04:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const run = store.createRun({
      id: "run_recover_approval_checkpoint",
      cwd,
      taskId: "task_recover_approval_checkpoint",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_recover_approval_checkpoint", title: "Recover approval" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    store.markRunStarted(run.id, now);
    const sideEffect = { type: "bash", cwd, command: "echo recover", riskFlags: [] };
    const approval = store.createApprovalRequest({
      runId: run.id,
      taskId: run.taskId,
      toolCallId: "tool_recover_approval_checkpoint",
      actionType: "bash",
      risk: "medium",
      title: "Approve recovery",
      description: "echo recover",
      payload: sideEffect,
    }, now);
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now,
    });
    const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(checkpoint);
    const resumeBasis = createApprovalResumeBasisV1({
      approvalId: approval.id,
      runId: run.id,
      workUnitId: "work_unit_recover_approval_checkpoint",
      priorAttemptId: "attempt_recover_approval_checkpoint",
      toolCallId: approval.toolCallId,
      actionType: approval.actionType,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
    });
    assert.ok(store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "pending",
      expectedStatus: "pending",
      expectedRevision: checkpoint.revision,
      resumeBasis,
    }, now));

    assert.equal(store.recoverStaleRuns("2026-08-15T04:01:00.000Z"), 0);
    assert.equal(store.getRun(run.id).status, "waiting_for_approval");
    assert.equal(store.getApprovalRequest(approval.id).status, "pending");
    assert.equal(store.listEvents(run.id, { limit: 100 }).some((event) => event.type === "run_error"), false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow step success is rejected until required operation evidence is verified", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-operation-transition-"));
  const now = "2026-08-12T16:30:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Operation transition", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Operation transition",
      objective: "Require verified operation evidence",
      status: "running",
      createdBy: "system",
    }, now);
    const executionPlan = {
      operations: [{
        id: "create_file",
        kind: "file_create",
        targetKind: "file",
        targetRef: { type: "operation", id: "target:create_file", label: "app.js" },
        required: true,
        dependsOn: [],
      }],
    };
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Create app.js",
      prompt: "Create app.js",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      metadata: { executionPlan, executionOperationIds: ["create_file"] },
    }, now);

    const rejected = store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      now,
    });
    assert.deepEqual(rejected, { ok: false, code: "invalid_transition", currentStatus: "running" });

    store.updateChannelWorkflowStep(step.id, {
      metadata: {
        ...step.metadata,
        executionVerification: {
          status: "verified",
          checkedAt: now,
          operationResults: [{ operationId: "create_file", status: "succeeded", evidenceActionIds: ["action_write_app"] }],
        },
      },
    }, now);
    const accepted = store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      now,
    });
    assert.equal(accepted.ok, true);
    assert.equal(store.getChannelWorkflowStep(step.id).status, "succeeded");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("startup recovery blocks execution-backed success without durable verification", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-operation-recovery-"));
  const now = "2026-08-12T17:00:00.000Z";
  const recoveredAt = "2026-08-12T17:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Operation recovery", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Operation recovery",
      objective: "Do not invent operation evidence on restart",
      status: "running",
      createdBy: "system",
    }, now);
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Run command",
      prompt: "Run node app.js",
      toParticipantId: "teammate_builtin_qa",
      toParticipantLabel: "QA",
      status: "running",
      metadata: {
        executionPlan: {
          operations: [{
            id: "run_command",
            kind: "run_command",
            targetKind: "command",
            targetRef: { type: "operation", id: "target:run_command", label: "node app.js" },
            commandMatchPolicy: { kind: "exact_command", command: "node app.js" },
            required: true,
            dependsOn: [],
          }],
        },
        executionOperationIds: ["run_command"],
      },
    }, now);
    const task = store.createTask({ channelId: channel.id, title: "Run command", prompt: "Run node app.js" }, now);
    const run = store.createRun({
      id: "run_operation_recovery_without_verification",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      workflowStepId: step.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    store.markRunStarted(run.id, now);
    store.markRunSucceeded(run.id, now);
    store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, now);

    assert.ok(store.recoverStaleChannelWorkflows(recoveredAt) > 0);
    assert.equal(store.getChannelWorkflowStep(step.id).status, "blocked");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "blocked");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recoverStaleChannelWorkflows closes resolved approval-only workflow owners", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-approval-recovery-"));
  const now = "2026-06-05T01:00:00.000Z";
  const resolvedAt = "2026-06-05T01:02:00.000Z";
  const recoveredAt = "2026-06-05T01:05:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Approval recovery", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Recover approval owner",
      objective: "Close a legacy approval-only workflow step.",
      status: "waiting_for_approval",
      createdBy: "system",
    }, now);
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Review risky shell command",
      prompt: "Review the command.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "waiting_for_approval",
    }, now);
    const approval = store.createApprovalRequest({
      workflowStepId: step.id,
      channelId: channel.id,
      actionType: "bash",
      risk: "high",
      title: "Review risky shell command",
      description: "Legacy approval-only owner.",
      payload: { type: "bash", cwd, command: "git status --short", riskFlags: ["requires_user_review"] },
    }, now);
    store.approveApprovalRequest(approval.id, { reason: "Reviewed.", resolvedBy: "local-user" }, resolvedAt);

    assert.ok(store.recoverStaleChannelWorkflows(recoveredAt) > 0);
    assert.equal(store.getChannelWorkflowStep(step.id).status, "succeeded");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "succeeded");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
