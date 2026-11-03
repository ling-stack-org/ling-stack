import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { createCompositeSecretResolver, createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { assertChannelWorkspaceReady } from "../dist/features/channels/workspace.js";
import { ensureDirectWorkspaceReady } from "../dist/features/teammates/direct-workspace.js";
import { createInitialWorkspaceBinding, createManagedGitWorktree, resolveGitRepoRoot } from "../dist/features/workspaces/managed-worktrees.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureEmptyGitRepo, ensureGitRepo } from "./git-test-helpers.mjs";
import { startMockOpenAICompatibleServer } from "./support/mock-openai-compatible-server.mjs";
import {
  ASYNC_SETTLE_TIMEOUT_MS,
  readDocxFixtureBytes,
  RecordingRunner,
  DirectToolRunner,
  DirectApprovalRunner,
  AbortableDelayedRunner,
  startDaemonForTest,
  createChannel,
  createStaticChatProvider,
  postTaskRunAndReadReadyRunId,
  parseAcceptedPrivateSseEvents,
  privateReplyTextEvents,
  parseSseEvents,
  getJson,
  waitForChannelMessageStatus,
  waitForCondition,
  postJson,
  putJson,
  patchJson,
} from "./support/channel-workspace-fixture.mjs";

test("AI teammate private workspace endpoints persist roster, setup, private messages, and activity", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-ai-teammate-api-"));
  const runner = new RecordingRunner();
  let daemon = await startDaemonForTest(runner);
  try {
    const seeded = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(seeded.teammates.some((item) => item.id === "teammate_builtin_engineer"));

    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "custom",
      displayName: "Private Reviewer",
      description: "Reviews private workspace notes.",
      modelBindingMode: "fixed",
      providerPresetId: channel.defaultProviderPresetId,
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    });
    const teammateId = created.teammate.id;

    const memberships = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    assert.deepEqual(memberships.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);

    const skills = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "review", source: "user", enabled: true }],
    });
    assert.deepEqual(skills.bindings.map((item) => item.skillId), ["review"]);

    const memory = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      scopes: [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
    });
    assert.deepEqual(memory.scopes.map((item) => [item.kind, item.channelId ?? null, item.enabled]), [
      ["private-chat-summary", null, true],
      ["private-notes", null, true],
      ["channel-brief", channel.id, true],
      ["channel-decisions", channel.id, true],
    ]);
    const disabledMemory = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopes: [{ kind: "private-chat-summary", enabled: false }],
      }),
    });
    assert.equal(disabledMemory.status, 400);
    const disabledMemoryBody = await disabledMemory.json();
    assert.equal(disabledMemoryBody.error, "bad_request");
    assert.match(disabledMemoryBody.message, /memory is always enabled/i);

    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review private workspace",
      prompt: "Verify private chat state.",
      assigneeTeammateId: teammateId,
    })).task;
    const teammateTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(teammateTasks.tasks.map((item) => item.id), [task.id]);

    const initialDirectWorkspace = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initialDirectWorkspace.binding.status, "not_created");
    const createdDirectWorkspace = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(createdDirectWorkspace.binding.mode, "managed_worktree");
    assert.equal(createdDirectWorkspace.binding.status, "ready");
    assert.match(createdDirectWorkspace.snapshot.executionCwd, /\.ling-stack\/worktrees\/teammates\//);
    await access(createdDirectWorkspace.snapshot.executionCwd);

    const linkPreview = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private-note",
    });
    assert.equal(linkPreview.linkPreview.teammateId, teammateId);
    assert.equal(linkPreview.linkPreview.status, "blocked");
    const listedLinkPreviews = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-link-previews?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listedLinkPreviews.linkPreviews.map((item) => item.id), [linkPreview.linkPreview.id]);

    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please review this private workspace.",
      linkPreviewIds: [linkPreview.linkPreview.id],
      fileRefs: [{
        path: "README.md",
        label: "README.md",
        rootRelation: "inside_workspace",
        kind: "file",
        materializationStatus: "metadata_only",
      }],
      requestAiReply: true,
    });
    assert.equal(message.message.status, "ready");
    assert.deepEqual(message.message.linkPreviewIds, [linkPreview.linkPreview.id]);
    assert.equal(message.message.fileRefs[0].path, "README.md");
    assert.equal(message.aiReply.status, "ready");
    assert.equal(message.aiReply.body, "Designer reply");

    const listedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);

    const activity = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/activity?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(activity.items.some((item) => item.kind === "direct-message" && item.sourceId === message.message.id));
    assert.ok(activity.items.some((item) => item.kind === "task" && item.sourceId === task.id));

    await daemon.close();
    daemon = await startDaemonForTest(runner);

    const restartedRoster = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(restartedRoster.teammates.some((item) => item.id === teammateId && item.displayName === "Private Reviewer"));
    const restartedChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedChannels.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);
    const restartedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);
    const restartedTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedTasks.tasks.map((item) => item.id), [task.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AI teammate private reply waits for startup provider refresh instead of using stale timeout", async (t) => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-provider-startup-refresh-"));
  await ensureGitRepo(cwd);
  const relay = await startMockOpenAICompatibleServer(t);
  const runner = new RecordingRunner();
  let daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "中转站",
      providerId: "relay",
      model: "relay-chat",
      api: "openai-completions",
      baseUrl: `${relay.url}/v1`,
      authHeader: true,
      apiKey: "local-relay-secret",
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await daemon.close();

    const store = createSqliteRunStore(cwd);
    try {
      store.recordProviderCheckResult(provider.id, {
        ok: false,
        code: "network_failed",
        message: "Provider network check failed: The operation was aborted due to timeout",
        checkedAt: "2026-05-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }

    daemon = await startDaemonForTest(runner);
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "重启后直接发一条私聊。",
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.body, "Designer reply");
    assert.equal(runner.runs.length, 1);
    assert.equal(relay.requests.some((request) => request.method === "POST" && request.path === "/v1/chat/completions"), true);

    const refreshed = await getJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(refreshed.provider.lastCheck.ok, true);
    assert.equal(refreshed.provider.lastCheck.code, "ready");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct messages default to latest page and load older history with cursor", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-message-pagination-"));
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_designer";
    const created = [];
    for (let index = 0; index < 106; index += 1) {
      const response = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
        body: `private message ${index + 1}`,
        requestAiReply: false,
      });
      created.push(response.message);
    }

    const latest = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(latest.messages.length, 100);
    assert.equal(latest.hasMore, true);
    assert.equal(latest.nextBeforeMessageId, created[6].id);
    assert.deepEqual(latest.messages.map((message) => message.id), created.slice(6).map((message) => message.id));

    const older = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}&beforeMessageId=${encodeURIComponent(latest.nextBeforeMessageId)}`);
    assert.equal(older.hasMore, false);
    assert.deepEqual(older.messages.map((message) => message.id), created.slice(0, 6).map((message) => message.id));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace settings API persists UI preferences in .ling-stack state", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-workspace-settings-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initial = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.settings.schemaVersion, 1);
    assert.equal(initial.settings.workspaceCwd, undefined);
    assert.equal(initial.settings.lingConversationTone, undefined);
    assert.equal(initial.settings.defaultAuthorizationMode, "smart");
    assert.equal(initial.settings.defaultWorkspaceAccessMode, "workspace_write");
    assert.deepEqual(initial.settings.skillGovernancePolicy, {
      generationMode: "semi_auto",
      recordingMode: "user_initiated",
      invocationMode: "explicit_only",
      publishMode: "manual_review",
      bindMode: "manual_review",
    });

    const patched = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      workspaceCwd: cwd,
      theme: "dark",
      locale: "zh-CN",
      lingConversationTone: "friendly",
      defaultProviderPresetId: "provider_default_chat",
      defaultAuthorizationMode: "ask",
      channelNotifications: { channel_one: "mentions" },
      channelActivityViews: { channel_one: [{ id: "custom:review", name: "Review" }] },
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    assert.equal(patched.settings.workspaceCwd, cwd);
    assert.equal(patched.settings.theme, "dark");
    assert.equal(patched.settings.locale, "zh-CN");
    assert.equal(patched.settings.lingConversationTone, "friendly");
    assert.equal(patched.settings.defaultProviderPresetId, "provider_default_chat");
    assert.equal(patched.settings.defaultAuthorizationMode, "ask");
    assert.equal(patched.settings.defaultWorkspaceAccessMode, "workspace_write");
    assert.equal(patched.settings.defaultPermissionMode, "custom");
    assert.equal(patched.settings.defaultPermissionPreset, "custom");
    assert.equal(patched.settings.channelNotifications.channel_one, "mentions");
    assert.equal(patched.settings.skillGovernancePolicy.generationMode, "approval_only");

    const reopened = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(reopened.settings.theme, "dark");
    assert.equal(reopened.settings.lingConversationTone, "friendly");
    assert.equal(reopened.settings.defaultProviderPresetId, "provider_default_chat");
    assert.equal(reopened.settings.defaultAuthorizationMode, "ask");
    assert.equal(reopened.settings.defaultWorkspaceAccessMode, "workspace_write");
    assert.equal(reopened.settings.channelActivityViews.channel_one[0].id, "custom:review");
    assert.equal(reopened.settings.skillGovernancePolicy.generationMode, "approval_only");

    const reset = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultProviderPresetId: null,
      lingConversationTone: null,
      skillGovernancePolicy: null,
    });
    assert.equal(reset.settings.defaultProviderPresetId, undefined);
    assert.equal(reset.settings.lingConversationTone, undefined);
    assert.equal(reset.settings.skillGovernancePolicy.generationMode, "semi_auto");

    const accessPatched = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultWorkspaceAccessMode: "read_only",
    });
    assert.equal(accessPatched.settings.defaultAuthorizationMode, "ask");
    assert.equal(accessPatched.settings.defaultWorkspaceAccessMode, "read_only");
    assert.equal(accessPatched.settings.defaultPermissionMode, "ask_everything");
    assert.equal(accessPatched.settings.defaultPermissionPreset, "read_only");

    const invalid = await fetch(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lingConversationTone: "verbose" }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /lingConversationTone must be friendly, pragmatic, none, or null/);

    const invalidSandbox = await fetch(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkspaceAccessMode: "trusted_local" }),
    });
    assert.equal(invalidSandbox.status, 400);
    assert.match(await invalidSandbox.text(), /defaultWorkspaceAccessMode must be read_only, workspace_write, full_access, or null/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel workspace API supports local and external path handoff", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-workspace-api-"));
  const externalPath = resolve(cwd, "external-workspace");
  const daemon = await startDaemonForTest();
  try {
    await mkdir(externalPath, { recursive: true });
    const channel = await createChannel(daemon.url, cwd);
    const initial = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.binding.mode, "managed_worktree");
    assert.equal(initial.binding.status, "ready");
    assert.equal(initial.binding.branchName, `ling/channel-${channel.id}`);
    assert.equal(initial.snapshot.workspaceCwd, cwd);
    assert.match(initial.snapshot.executionCwd, /\.ling-stack\/worktrees\/channels\//);
    await access(initial.snapshot.executionCwd);

    const external = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "external_path",
      executionPath: externalPath,
    });
    assert.equal(external.binding.mode, "external_path");
    assert.equal(external.binding.status, "ready");
    assert.equal(external.snapshot.executionCwd, externalPath);

    await rm(externalPath, { recursive: true, force: true });
    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "missing");

    const unavailableOpen = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/open?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unavailableOpen.status, 409);
    assert.equal((await unavailableOpen.json()).error, "channel_workspace_unavailable");

    const local = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    });
    assert.equal(local.binding.mode, "local");
    assert.equal(local.binding.status, "ready");
    assert.equal(local.snapshot.executionCwd, cwd);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation creates an isolated managed worktree by default", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-auto-worktree-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);

    assert.equal(first.workspaceBinding?.mode, "managed_worktree");
    assert.equal(second.workspaceBinding?.mode, "managed_worktree");
    assert.equal(first.workspaceBinding?.status, "ready");
    assert.equal(second.workspaceBinding?.status, "ready");
    assert.equal(first.workspaceBinding?.branchName, `ling/channel-${first.id}`);
    assert.equal(second.workspaceBinding?.branchName, `ling/channel-${second.id}`);
    assert.notEqual(first.workspaceBinding?.worktreePath, second.workspaceBinding?.worktreePath);
    assert.match(first.workspaceBinding?.worktreePath ?? "", /\.ling-stack\/worktrees\/channels\//);
    await access(first.workspaceBinding?.worktreePath ?? "");
    await access(second.workspaceBinding?.worktreePath ?? "");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed channel and direct worktrees use resolved workspace worktrees directory", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-resolved-worktrees-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-resolved-worktrees-user-"));
  let workspacePaths;
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const paths = resolveStoragePaths(storeCwd, {
        userRootDir: userRoot,
        workspaceStateLocation: "user-data-dir",
      }).workspace;
      if (storeCwd === cwd) {
        workspacePaths = paths;
      }
      return createSqliteRunStore(storeCwd, paths);
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    assert.ok(workspacePaths);
    assert.equal(channel.workspaceBinding?.worktreePath?.startsWith(resolve(workspacePaths.worktreesDir, "channels")), true);
    await access(channel.workspaceBinding?.worktreePath ?? "");

    const teammateId = "teammate_builtin_engineer";
    const direct = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(direct.binding.worktreePath.startsWith(resolve(workspacePaths.worktreesDir, "teammates")), true);
    await access(direct.binding.worktreePath);

    await assert.rejects(() => access(resolve(cwd, ".ling-stack", "worktrees")), /ENOENT/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("channel workspace cleanup removes clean managed worktrees and keeps the binding recreatable", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-worktree-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const worktreePath = channel.workspaceBinding?.worktreePath;
    assert.ok(worktreePath);
    await access(worktreePath);

    const cleaned = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cleaned.binding.mode, "managed_worktree");
    assert.equal(cleaned.binding.status, "not_created");
    assert.equal(cleaned.binding.worktreePath, worktreePath);
    await assert.rejects(() => access(worktreePath), /ENOENT/);

    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "not_created");

    const recreated = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(recreated.binding.worktreePath, worktreePath);
    await access(worktreePath);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel workspace cleanup refuses dirty managed worktrees without blocking refresh", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-worktree-dirty-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const worktreePath = channel.workspaceBinding?.worktreePath;
    assert.ok(worktreePath);
    await writeFile(resolve(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    const response = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "worktree_dirty");
    assert.equal(body.binding.status, "ready");
    await access(resolve(worktreePath, "dirty.txt"));

    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "ready");
    assert.equal(refreshed.binding.errorMessage, undefined);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct teammate workspace cleanup removes clean managed worktrees and can recreate them", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-worktree-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    await ensureGitRepo(cwd);
    const teammateId = "teammate_builtin_engineer";
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    const worktreePath = created.binding.worktreePath;
    await access(worktreePath);

    const cleaned = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cleaned.binding.mode, "managed_worktree");
    assert.equal(cleaned.binding.status, "not_created");
    assert.equal(cleaned.binding.worktreePath, worktreePath);
    await assert.rejects(() => access(worktreePath), /ENOENT/);

    const recreated = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(recreated.binding.status, "ready");
    assert.equal(recreated.binding.worktreePath, worktreePath);
    await access(worktreePath);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct teammate workspace cleanup refuses dirty managed worktrees", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-worktree-dirty-cleanup-"));
  const daemon = await startDaemonForTest();
  try {
    await ensureGitRepo(cwd);
    const teammateId = "teammate_builtin_engineer";
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {});
    const worktreePath = created.binding.worktreePath;
    await writeFile(resolve(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/cleanup?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "worktree_dirty");
    assert.equal(body.binding.status, "ready");
    await access(resolve(worktreePath, "dirty.txt"));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation uses local workspace binding when cwd is not a Git repository", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-worktree-nongit-"));
  const boundPath = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-bound-nongit-"));
  const daemon = await startDaemonForTest();
  try {
    const createUrl = `${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`;
    const createBody = await prepareChannelCreateBody(createUrl, {
      name: "Engineering",
      boundPath,
      allowedTools: ["read"],
    });
    const response = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.channel.name, "Engineering");
    assert.equal(body.channel.boundPath, boundPath);
    assert.equal(body.channel.workspaceBinding?.mode, "local");
    assert.equal(body.channel.workspaceBinding?.status, "ready");
    assert.equal(body.channel.workspaceBinding?.executionPath, boundPath);
    assert.equal(body.channel.workspaceBinding?.worktreePath, undefined);

    const listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channels.length, 1);
    assert.equal(listed.channels[0].id, body.channel.id);
    assert.equal(listed.channels[0].workspaceBinding?.mode, "local");

    const explicitWorktree = await fetch(`${daemon.url}/channels/${encodeURIComponent(body.channel.id)}/workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(explicitWorktree.status, 400);
    assert.equal((await explicitWorktree.json()).error, "not_git_repository");

    await rm(boundPath, { recursive: true, force: true });
    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(body.channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.mode, "local");
    assert.equal(refreshed.binding.status, "missing");
    assert.match(refreshed.binding.errorMessage, /不存在、不是目录或不可访问/);
    assert.deepEqual(
      assertChannelWorkspaceReady({ ...body.channel, workspaceBinding: refreshed.binding }, cwd),
      { ok: false, message: "频道工作区不可用，请恢复工作区或切回 Local。" },
    );
  } finally {
    await daemon.close();
    await rm(boundPath, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an empty Git repository uses Local automatically but keeps explicit worktree creation strict", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-worktree-empty-git-"));
  await ensureEmptyGitRepo(cwd);
  const daemon = await startDaemonForTest();
  try {
    const createUrl = `${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`;
    const createBody = await prepareChannelCreateBody(createUrl, {
      name: "Empty Git",
      boundPath: cwd,
      allowedTools: ["read"],
    });
    const response = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.channel.workspaceBinding?.mode, "local");
    assert.equal(body.channel.workspaceBinding?.status, "ready");

    const explicitWorktree = await fetch(`${daemon.url}/channels/${encodeURIComponent(body.channel.id)}/workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(explicitWorktree.status, 400);
    assert.equal((await explicitWorktree.json()).error, "git_inspection_failed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Git repository resolution distinguishes missing Git, non-repositories, and inspection failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-git-resolution-"));
  try {
    const missingWorkspace = await resolveGitRepoRoot(resolve(cwd, "missing"), async () => {
      throw new Error("Git should not run for a missing workspace");
    });
    assert.deepEqual(missingWorkspace, {
      ok: false,
      code: "workspace_unavailable",
      message: "当前工作区目录不存在、不是目录或不可访问，无法创建或管理独立 worktree。",
    });

    const fileWorkspace = resolve(cwd, "workspace.txt");
    await writeFile(fileWorkspace, "not a directory\n", "utf8");
    const unavailableFile = await resolveGitRepoRoot(fileWorkspace, async () => {
      throw new Error("Git should not run for a non-directory workspace");
    });
    assert.deepEqual(unavailableFile, {
      ok: false,
      code: "workspace_unavailable",
      message: "当前工作区目录不存在、不是目录或不可访问，无法创建或管理独立 worktree。",
    });

    const emptyInspection = await resolveGitRepoRoot(cwd, async () => ({ stdout: "", stderr: "" }));
    assert.deepEqual(emptyInspection, {
      ok: false,
      code: "git_inspection_failed",
      message: "Git 仓库检查未返回工作区根目录，无法创建或管理独立 worktree。",
    });

    const gitUnavailable = await resolveGitRepoRoot(cwd, async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    assert.deepEqual(gitUnavailable, {
      ok: false,
      code: "git_unavailable",
      message: "系统未找到 Git 可执行文件，无法创建或管理独立 worktree。",
    });

    const notRepository = await resolveGitRepoRoot(cwd, async () => {
      throw Object.assign(new Error("git rev-parse failed"), {
        code: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      });
    });
    assert.deepEqual(notRepository, {
      ok: false,
      code: "not_git_repository",
      message: "当前工作区不是 Git 仓库，无法创建或管理独立 worktree。",
    });

    const inspectionFailed = await resolveGitRepoRoot(cwd, async () => {
      throw Object.assign(new Error("git rev-parse failed"), { code: "EACCES" });
    });
    assert.deepEqual(inspectionFailed, {
      ok: false,
      code: "git_inspection_failed",
      message: "无法检查 Git 仓库状态，请确认 Git 可用且工作区可访问。",
    });

    const disappearingWorkspace = await mkdtemp(resolve(tmpdir(), "ling-stack-git-resolution-race-"));
    const disappeared = await resolveGitRepoRoot(disappearingWorkspace, async () => {
      await rm(disappearingWorkspace, { recursive: true, force: true });
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    assert.equal(disappeared.ok, false);
    assert.equal(disappeared.code, "workspace_unavailable");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("initial workspace selection falls back to Local only when Git isolation is unavailable", async () => {
  for (const code of ["git_unavailable", "not_git_repository", "git_inspection_failed"]) {
    const result = await createInitialWorkspaceBinding({
      createManaged: async () => ({ ok: false, code, message: code }),
      createLocal: () => ({ ok: true, binding: { mode: "local", status: "ready" } }),
    });
    assert.deepEqual(result, { ok: true, binding: { mode: "local", status: "ready" } });
  }

  const missingWorkspace = await createInitialWorkspaceBinding({
    createManaged: async () => ({ ok: false, code: "workspace_unavailable", message: "missing workspace" }),
    createLocal: () => ({ ok: true, binding: { mode: "local", status: "ready" } }),
  });
  assert.deepEqual(missingWorkspace, { ok: false, code: "workspace_unavailable", message: "missing workspace" });

  const disappearedBeforeFallback = await createInitialWorkspaceBinding({
    createManaged: async () => ({ ok: false, code: "git_unavailable", message: "missing Git" }),
    createLocal: () => ({ ok: false, code: "workspace_unavailable", message: "missing workspace" }),
  });
  assert.deepEqual(disappearedBeforeFallback, { ok: false, code: "workspace_unavailable", message: "missing workspace" });
});

test("direct workspace initialization serializes concurrent first replies into one setup", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-flight-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.getOrCreateTeammateDirectThread("teammate_builtin_designer", new Date().toISOString());
    let createCalls = 0;
    let releaseCreate;
    let markCreateStarted;
    const createStarted = new Promise((resolveStarted) => {
      markCreateStarted = resolveStarted;
    });
    const createBarrier = new Promise((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    const now = new Date().toISOString();
    const bindingFactory = {
      createInitial: async () => {
        createCalls += 1;
        markCreateStarted();
        await createBarrier;
        return {
          ok: true,
          binding: {
            mode: "local",
            status: "ready",
            executionPath: cwd,
            createdAt: now,
            checkedAt: now,
            updatedAt: now,
          },
        };
      },
      createManaged: async () => {
        throw new Error("managed creation should not run for a new direct thread");
      },
    };

    const first = ensureDirectWorkspaceReady({ store, thread, workspaceCwd: cwd, bindingFactory });
    await createStarted;
    const second = ensureDirectWorkspaceReady({ store, thread, workspaceCwd: cwd, bindingFactory });
    await Promise.resolve();
    assert.equal(createCalls, 1);
    releaseCreate();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(firstResult.ok && firstResult.workspace.binding.mode, "local");
    assert.equal(secondResult.ok && secondResult.workspace.binding.mode, "local");
    assert.equal(createCalls, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct workspace handoff waits for initialization and remains the final binding", { timeout: ASYNC_SETTLE_TIMEOUT_MS }, async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-handoff-race-"));
  const managedPath = resolve(cwd, "managed-worktree");
  await mkdir(managedPath, { recursive: true });
  let store;
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      store = createSqliteRunStore(storeCwd);
      return store;
    },
  });
  try {
    const teammateId = "teammate_builtin_designer";
    await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(store);
    const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
    let releaseCreate;
    let markCreateStarted;
    const createStarted = new Promise((resolveStarted) => {
      markCreateStarted = resolveStarted;
    });
    const createBarrier = new Promise((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    const now = new Date().toISOString();
    const initialization = ensureDirectWorkspaceReady({
      store,
      thread,
      workspaceCwd: cwd,
      bindingFactory: {
        createInitial: async () => {
          markCreateStarted();
          await createBarrier;
          return {
            ok: true,
            binding: {
              mode: "managed_worktree",
              status: "ready",
              executionPath: managedPath,
              worktreePath: managedPath,
              branchName: "ling/test-handoff-race",
              baseBranch: "main",
              baseCommit: "abc123",
              createdAt: now,
              checkedAt: now,
              updatedAt: now,
            },
          };
        },
        createManaged: async () => {
          throw new Error("managed recreation should not run for a new direct thread");
        },
      },
    });
    await createStarted;

    // readJsonBody finishes and the handler queues the mutation in microtasks
    // after "end". Cross that boundary before submitting the later reply;
    // a fixed sleep does not establish that order on a busy CI runner.
    const handoffQueued = new Promise((resolveQueued) => {
      daemon.server.prependOnceListener("request", (request) => {
        request.once("end", () => setImmediate(resolveQueued));
      });
    });
    let handoffSettled = false;
    const handoff = postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    }).finally(() => {
      handoffSettled = true;
    });
    await handoffQueued;
    assert.equal(handoffSettled, false);
    let lateFactoryCalls = 0;
    const replyAfterHandoff = ensureDirectWorkspaceReady({
      store,
      thread,
      workspaceCwd: cwd,
      bindingFactory: {
        createInitial: async () => {
          lateFactoryCalls += 1;
          throw new Error("a reply queued after handoff must use the handed-off binding");
        },
        createManaged: async () => {
          lateFactoryCalls += 1;
          throw new Error("a reply queued after handoff must use the handed-off binding");
        },
      },
    });
    releaseCreate();

    const [initialized, handedOff, resumedReply] = await Promise.all([initialization, handoff, replyAfterHandoff]);
    assert.equal(initialized.ok, true);
    assert.equal(initialized.ok && initialized.workspace.binding.mode, "managed_worktree");
    assert.equal(handedOff.binding.mode, "local");
    assert.equal(handedOff.binding.status, "ready");
    assert.equal(resumedReply.ok, true);
    assert.equal(resumedReply.ok && resumedReply.workspace.binding.mode, "local");
    assert.equal(lateFactoryCalls, 0);
    const finalWorkspace = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalWorkspace.binding.mode, "local");
    assert.equal(finalWorkspace.binding.executionPath, cwd);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct workspace initialization releases coordination after a factory error", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-flight-retry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.getOrCreateTeammateDirectThread("teammate_builtin_designer", new Date().toISOString());
    await assert.rejects(
      () => ensureDirectWorkspaceReady({
        store,
        thread,
        workspaceCwd: cwd,
        bindingFactory: {
          createInitial: async () => {
            throw new Error("simulated initialization failure");
          },
          createManaged: async () => {
            throw new Error("managed creation should not run");
          },
        },
      }),
      /simulated initialization failure/,
    );

    const now = new Date().toISOString();
    const retried = await ensureDirectWorkspaceReady({
      store,
      thread,
      workspaceCwd: cwd,
      bindingFactory: {
        createInitial: async () => ({
          ok: true,
          binding: {
            mode: "local",
            status: "ready",
            executionPath: cwd,
            createdAt: now,
            checkedAt: now,
            updatedAt: now,
          },
        }),
        createManaged: async () => {
          throw new Error("managed creation should not run");
        },
      },
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.ok && retried.workspace.binding.mode, "local");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct Local workspaces become unavailable when their directory disappears", async () => {
  const storeCwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-local-store-"));
  const workspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-workspace-local-path-"));
  const store = createSqliteRunStore(storeCwd);
  try {
    const thread = store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", new Date().toISOString());
    const now = new Date().toISOString();
    const localThread = store.updateTeammateDirectThreadWorkspace(thread.id, {
      mode: "local",
      status: "ready",
      executionPath: workspaceCwd,
      createdAt: now,
      checkedAt: now,
      updatedAt: now,
    }, now);
    assert.ok(localThread);
    await rm(workspaceCwd, { recursive: true, force: true });

    const result = await ensureDirectWorkspaceReady({ store, thread: localThread, workspaceCwd });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.code, "direct_workspace_unavailable");
    assert.equal(result.ok || result.binding.mode, "local");
    assert.equal(result.ok || result.binding.status, "missing");
  } finally {
    store.close();
    await rm(workspaceCwd, { recursive: true, force: true });
    await rm(storeCwd, { recursive: true, force: true });
  }
});

test("a previously created direct worktree never downgrades to Local when recreation fails", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-owned-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", new Date().toISOString());
    const now = new Date().toISOString();
    const worktreePath = resolve(cwd, ".ling-stack", "worktrees", "teammates", thread.teammateId, thread.id);
    const ownedThread = store.updateTeammateDirectThreadWorkspace(thread.id, {
      mode: "managed_worktree",
      status: "not_created",
      executionPath: worktreePath,
      worktreePath,
      branchName: `ling/teammate-${thread.teammateId}-${thread.id}`,
      baseBranch: "main",
      baseCommit: "abc123",
      createdAt: now,
      checkedAt: now,
      updatedAt: now,
    }, now);
    assert.ok(ownedThread);
    let initialCalls = 0;
    let managedCalls = 0;
    const result = await ensureDirectWorkspaceReady({
      store,
      thread: ownedThread,
      workspaceCwd: cwd,
      bindingFactory: {
        createInitial: async () => {
          initialCalls += 1;
          return { ok: true, binding: { mode: "local", status: "ready", executionPath: cwd, updatedAt: now } };
        },
        createManaged: async () => {
          managedCalls += 1;
          return { ok: false, code: "git_unavailable", message: "Git is unavailable" };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok || result.code, "git_unavailable");
    assert.equal(initialCalls, 0);
    assert.equal(managedCalls, 1);
    assert.equal(result.ok || result.binding.mode, "managed_worktree");
    assert.equal(result.ok || result.binding.createdAt, now);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a recovered managed direct worktree records ownership before any later disappearance", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-direct-workspace-recovered-"));
  await ensureGitRepo(cwd);
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", new Date().toISOString());
    const worktreePath = resolve(cwd, ".ling-stack", "worktrees", "teammates", thread.teammateId, thread.id);
    const created = await createManagedGitWorktree({
      repoRoot: cwd,
      worktreePath,
      branchName: `ling/teammate-${thread.teammateId}-${thread.id}`,
    });
    assert.equal(created.ok, true);
    const now = new Date().toISOString();
    const recoveredThread = store.updateTeammateDirectThreadWorkspace(thread.id, {
      mode: "managed_worktree",
      status: "blocked",
      executionPath: worktreePath,
      worktreePath,
      branchName: `ling/teammate-${thread.teammateId}-${thread.id}`,
      checkedAt: now,
      updatedAt: now,
    }, now);
    assert.ok(recoveredThread);

    const ready = await ensureDirectWorkspaceReady({ store, thread: recoveredThread, workspaceCwd: cwd });
    assert.equal(ready.ok, true);
    assert.equal(ready.ok && ready.workspace.binding.status, "ready");
    assert.equal(ready.ok && typeof ready.workspace.binding.createdAt, "string");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory API scopes lexical recall and channel replies audit used memory", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-memory-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner, {}, { defaultWorkspaceCwd: cwd });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const otherChannel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(check.ok, true);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const channelMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Model Workbench width",
      body: "Model Workbench should use the same horizontal width as other pages.",
      tags: ["model-workbench"],
    })).memory;
    const teammateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_designer",
      title: "Designer private width preference",
      body: "Designer private memory says Model Workbench width should stay aligned.",
      sensitivity: "private",
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_engineer",
      title: "Engineer private width preference",
      body: "Engineer private memory also mentions Model Workbench width.",
      sensitivity: "private",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: otherChannel.id,
      title: "Other channel width",
      body: "Other channel also mentions Model Workbench width.",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Secret memory",
      body: "Secret-adjacent Model Workbench token.",
      sensitivity: "secret-adjacent",
    });

    const listed = await getJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.vectorRetrieval.status, "not_configured");
    assert.equal(listed.vectorRetrieval.optional, true);

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_designer",
      channelId: channel.id,
      intent: "channel-reply",
      query: "model workbench width",
    });
    assert.ok(recall.memories.some((item) => item.memory.id === channelMemory.id));
    assert.ok(recall.memories.some((item) => item.memory.id === teammateMemory.id));
    assert.equal(recall.memories.some((item) => item.memory.ownerId === otherChannel.id), false);
    assert.equal(recall.memories.some((item) => item.memory.ownerId === "teammate_builtin_engineer"), false);
    assert.equal(recall.memories.some((item) => item.memory.sensitivity === "secret-adjacent"), false);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer fix Model Workbench width",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.aiReply.status, "pending");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.match(runner.runs[0].systemPrompt, /Used memory:/);
    assert.match(runner.runs[0].systemPrompt, /Model Workbench width/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Designer private memory says/);

    const used = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&responseId=${encodeURIComponent(created.aiReply.id)}`);
    assert.ok(used.events[0].memoryIds.includes(channelMemory.id));
    assert.equal(used.events[0].memoryIds.includes(teammateMemory.id), false);
    assert.match(used.events[0].policyVersion, /memory_use_isolation_v2/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory review policy exposes promotion inbox and gates candidate recall", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-memory-review-policy-"));
  const daemon = await startDaemonForTest(undefined, {}, { defaultWorkspaceCwd: cwd });
  try {
    const channel = await createChannel(daemon.url, cwd);

    const defaultPolicy = await getJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(defaultPolicy.policy.mode, "balanced");
    assert.equal(defaultPolicy.policy.requireManualForWorkspace, true);

    const patchedPolicy = await patchJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`, {
      mode: "conservative",
      autoActiveSameScope: false,
    });
    assert.equal(patchedPolicy.policy.mode, "conservative");
    assert.equal(patchedPolicy.policy.autoActiveSameScope, false);

    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Review gated memory",
      body: "Review gated memory should only be recalled after approval.",
      reviewState: "candidate",
      sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Reflection job" }],
    })).memory;

    const blockedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(blockedRecall.memories.some((item) => item.memory.id === candidate.id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === candidate.id), true);
    const inboxItem = inbox.items.find((item) => item.memory.id === candidate.id);
    assert.equal(inboxItem.recommendedAction, "approve");
    assert.match(inboxItem.sourceSummary, /run-event:Reflection job/);

    const approved = await postJson(`${daemon.url}/memory/${encodeURIComponent(candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Verified source event.",
    });
    assert.equal(approved.memory.reviewState, "active");
    assert.equal(approved.memory.enabled, true);
    assert.equal(approved.action.previousReviewState, "candidate");
    assert.equal(approved.action.nextReviewState, "active");

    const approvedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(approvedRecall.memories.some((item) => item.memory.id === candidate.id), true);

    const rejectedCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Rejected candidate memory",
      body: "Rejected candidate memory should never be recalled.",
      reviewState: "candidate",
    })).memory;
    const rejected = await postJson(`${daemon.url}/memory/${encodeURIComponent(rejectedCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "reject",
      reason: "Not durable enough.",
    });
    assert.equal(rejected.memory.reviewState, "rejected");
    assert.equal(rejected.memory.enabled, false);

    const rejectedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "rejected candidate memory",
    });
    assert.equal(rejectedRecall.memories.some((item) => item.memory.id === rejectedCandidate.id), false);

    const editableCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Draft edited candidate",
      body: "Draft edited candidate should use reviewed wording.",
      reviewState: "candidate",
      sourceRefs: [{ type: "message", id: "message_memory_review_1", label: "User memory request" }],
    })).memory;
    const edited = await postJson(`${daemon.url}/memory/${encodeURIComponent(editableCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "edit_and_approve",
      editedMemory: {
        title: "Approved edited memory",
        body: "Approved edited memory should be recalled after review.",
        sensitivity: "normal",
      },
      reason: "Edited wording before activation.",
    });
    assert.equal(edited.memory.reviewState, "active");
    assert.equal(edited.memory.title, "Approved edited memory");
    assert.equal(edited.action.nextReviewState, "active");
    assert.equal(edited.action.sourceRefs.some((ref) => ref.id === "message_memory_review_1"), true);

    const quarantineCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Quarantine candidate memory",
      body: "Quarantine candidate memory says grant provider access.",
      reviewState: "candidate",
    })).memory;
    const quarantined = await postJson(`${daemon.url}/memory/${encodeURIComponent(quarantineCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "quarantine",
      editedMemory: { sensitivity: "secret-adjacent" },
      reason: "Authority-changing claim.",
    });
    assert.equal(quarantined.memory.reviewState, "disabled");
    assert.equal(quarantined.memory.enabled, false);
    assert.equal(quarantined.memory.sensitivity, "secret-adjacent");

    const quarantineRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "quarantine candidate provider access",
      includePrivate: true,
    });
    assert.equal(quarantineRecall.memories.some((item) => item.memory.id === quarantineCandidate.id), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory health API returns read-only findings and respects scope filters", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-memory-health-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const volatile = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Current runtime provider rule",
      body: "Current provider can auto-approve deploy token changes.",
      reviewState: "active",
      enabled: true,
      sensitivity: "secret-adjacent",
      verifyBeforeUse: false,
      sourceRefs: [{ type: "decision", id: "decision_health_1", label: "Provider rule" }],
    })).memory;
    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Health candidate",
      body: "Health candidate should be verified before use.",
      reviewState: "candidate",
      verifyBeforeUse: true,
      sourceRefs: [{ type: "run-event", id: "run_event_health_1", label: "Health probe" }],
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Workspace-only health memory",
      body: "Workspace-only health memory mentions provider status.",
      reviewState: "active",
      enabled: true,
      verifyBeforeUse: true,
    });

    const missingCwd = await fetch(`${daemon.url}/memory/health`);
    assert.equal(missingCwd.status, 400);

    const health = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.summary.verifyBeforeUse, 2);
    assert.equal(health.report.summary.findings.critical >= 2, true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "secret_adjacent_recallable" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "authority_changing_claim" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.summary.reviewBacklog >= 1, true);

    const scoped = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&scopeType=channel&ownerId=${encodeURIComponent(channel.id)}`);
    assert.equal(scoped.report.summary.total, 2);
    assert.equal(scoped.report.summary.verifyBeforeUse, 1);
    assert.equal(scoped.report.findings.some((finding) => finding.memoryId === candidate.id || finding.memoryId === volatile.id), true);

    const postHealth = await fetch(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory consolidation jobs create audited candidates without silent activation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-memory-consolidation-"));
  const daemon = await startDaemonForTest(undefined, {}, { defaultWorkspaceCwd: cwd });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}`, {
      kind: "task_run_lesson",
      sourceScopeType: "channel",
      userExplicitRemember: true,
      confidence: "high",
      candidate: {
        scopeType: "channel",
        ownerId: channel.id,
        title: "Consolidated run lesson",
        body: "When Model Workbench width regresses, check the workspace frame before editing cards.",
        tags: ["model-workbench"],
        sourceRefs: [{ type: "run-event", id: "run_event_consolidation_1", label: "Run succeeded" }],
      },
    });
    assert.equal(created.job.status, "succeeded");
    assert.equal(created.candidates.length, 1);
    assert.equal(created.decisions.length, 1);
    assert.deepEqual(created.job.createdCandidateIds, [created.candidates[0].id]);
    assert.equal(created.candidates[0].reviewState, "candidate");
    assert.equal(created.candidates[0].enabled, true);
    assert.equal(created.decisions[0].outcome, "auto-candidate");
    assert.equal(created.decisions[0].reasonCode, "consolidation_candidate_only");

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "consolidated run lesson model workbench width",
    });
    assert.equal(recall.memories.some((item) => item.memory.id === created.candidates[0].id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === created.candidates[0].id), true);

    const listed = await getJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}&status=succeeded`);
    assert.equal(listed.jobs.some((job) => job.id === created.job.id), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run validates requestedSkillId and records the selected skill", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-aware-run-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Implement skill-aware run",
      prompt: "Use the implement skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
      requestedSkillId: "implement",
    })).task;
    const store = stores.get(cwd);
    assert.ok(store);
    store.upsertSkillSourceSnapshot({
      id: "skill_source_implement_runtime",
      skillId: "implement",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-implement/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.3.0",
      upstreamSkillPath: "gstack-implement/SKILL.md",
      sourceChecksum: "sha256:implement-runtime",
      rawSkillMarkdown: "---\nname: implement\n---\n# Full Implement Skill\nUse full source details.",
      referencedFiles: [{
        path: "references/plan.md",
        kind: "reference",
        checksum: "sha256:ref",
        sizeBytes: 12,
        includedInSnapshot: false,
      }],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");
    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.selectedSkillId, "implement");
    assert.equal(runner.runs[0].tools.includes("edit"), true);
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Implement only the approved slice/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Selected Skill Source Snapshot/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /# Full Implement Skill/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /does not grant tools/.test(line)));
    const skillSourceContext = run.requestSnapshot.skillSourceContext;
    assert.equal(skillSourceContext.runtimeViewKind, "original_source");
    assert.equal(skillSourceContext.optimizationMode, "no_operation");
    assert.equal(skillSourceContext.compiledViewId, undefined);
    assert.equal(skillSourceContext.snapshotId, "skill_source_implement_runtime");
    assert.equal(skillSourceContext.sourceChecksum, "sha256:implement-runtime");
    assert.equal(skillSourceContext.includedRefs.some((ref) => ref.sourceRef === "skill-source:skill_source_implement_runtime:rawSkillMarkdown"), true);
    assert.equal(skillSourceContext.deferredRefs.some((ref) => ref.sourceRef === "skill-source-file:references/plan.md"), true);
    const runCreated = store.listEvents(runId).find((event) => event.type === "run_created");
    assert.equal(runCreated?.data.skillSourceContext.runtimeViewKind, "original_source");
    assert.equal(runCreated?.data.skillSourceContext.snapshotId, "skill_source_implement_runtime");
    assert.equal(runCreated?.data.skillSourceContext.sourceChecksum, "sha256:implement-runtime");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run records compiled skill context fallback plan on missing lazy reference failure", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-runtime-fallback-"));
  // A missing Host skill reference fails before model execution, not inside
  // the SDK provider transport, whose public errors are intentionally redacted.
  const runner = { runs: [], async runTask(options) {
    this.runs.push(options);
    throw new Error("missing reference lazy_examples");
  } };
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Implement with compiled skill context",
      prompt: "Use the implement skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
      requestedSkillId: "implement",
    })).task;
    const store = stores.get(cwd);
    assert.ok(store);
    store.upsertSkillSourceSnapshot({
      id: "skill_source_implement_runtime_compiled",
      skillId: "implement",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-implement/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.3.0",
      upstreamSkillPath: "gstack-implement/SKILL.md",
      sourceChecksum: "sha256:implement-runtime-compiled",
      rawSkillMarkdown: "---\nname: implement\n---\n# Full Implement Skill\nUse full source details.\n# Examples\nLong examples.",
      referencedFiles: [],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");
    store.upsertSkillCompiledRuntimeView({
      view: {
        id: "skill_compiled_implement_runtime",
        skillId: "implement",
        sourceSnapshotId: "skill_source_implement_runtime_compiled",
        createdAt: "2026-06-22T00:01:00.000Z",
        compilerVersion: "test",
        coreRulesMarkdown: "Use compact implement rules.",
        lazyReferences: [{
          id: "lazy_examples",
          title: "Implementation examples",
          kind: "example",
          sourceRef: "SKILL.md#examples",
          summary: "Examples stay lazy until retry.",
          tokenEstimate: 8,
          loadPolicy: "on_retry",
        }],
        sourceMap: [{
          compiledRef: "coreRulesMarkdown",
          sourceRef: "SKILL.md#workflow",
          rationale: "Core workflow remains included.",
        }],
        tokenEstimate: 15,
        fallbackPolicy: "original_on_error",
      },
      authorityBoundary: {
        requiredToolsChanged: false,
        requiredProviderCapabilitiesChanged: false,
        approvalProfileChanged: false,
        teammateBindingsChanged: false,
      },
    }, "2026-06-22T00:02:00.000Z");

    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
      skillOptimizationMode: "auto_runtime_experimental",
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);

    assert.equal(run.status, "failed");
    assert.equal(run.requestSnapshot.skillSourceContext.runtimeViewKind, "compiled_view");
    assert.equal(run.requestSnapshot.skillSourceContext.compiledViewId, "skill_compiled_implement_runtime");
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Selected Skill Compiled Runtime View/.test(line)));
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Available Skill References/.test(line)));
    const runError = store.listEvents(runId).find((event) => event.type === "run_error");
    assert.equal(runError?.data.skillContextFallback.reasonCode, "compiled_missing_reference");
    assert.equal(runError?.data.skillContextFallback.retryRuntimeViewKind, "original_source");
    assert.deepEqual(runError?.data.skillContextFallback.matchedRefIds, ["lazy_examples"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run materializes linked channel attachments into runner prompt", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-task-attachment-run-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Slash task attachment body", "utf8").toString("base64"),
    })).attachment;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review attached brief",
      prompt: "Review the attached brief.",
      attachmentIds: [attachment.id],
    })).task;
    assert.deepEqual(task.attachmentIds, [attachment.id]);

    await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });

    assert.equal(runner.runs.length, 1);
    const prompt = runner.runs[0].task.prompt;
    assert.match(prompt, /Review the attached brief\./);
    assert.match(prompt, /Task attachments:/);
    assert.match(prompt, /brief\.txt/);
    assert.match(prompt, /Slash task attachment body/);

    const durableTask = (await getJson(`${daemon.url}/tasks/${encodeURIComponent(task.id)}?cwd=${encodeURIComponent(cwd)}`)).task;
    assert.equal(durableTask.prompt, "Review the attached brief.");
    assert.deepEqual(durableTask.attachmentIds, [attachment.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill suggestions are visible recommendations and do not mutate run selection", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-suggestions-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "reasoning", "tool_call"] })).provider;
    const suggestions = await postJson(`${daemon.url}/skills/suggestions?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_engineer",
      channelId: channel.id,
      providerPresetId: provider.id,
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
      limit: 5,
    });
    assert.equal(suggestions.suggestions[0].skillId, "review");
    assert.equal(suggestions.suggestions[0].sourceRefs[0].type, "skill");

    const afterExplicitSelection = await postJson(`${daemon.url}/skills/suggestions?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_engineer",
      channelId: channel.id,
      providerPresetId: provider.id,
      title: "Review this pull request",
      prompt: "Find behavioral bugs, missing tests, and risky assumptions.",
      requestedSkillId: "review",
    });
    assert.equal(afterExplicitSelection.suggestions.some((suggestion) => suggestion.skillId === "review"), false);

    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review pull request without explicit skill",
      prompt: "Find behavioral bugs and missing tests, but do not preselect a skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
    })).task;
    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.selectedSkillId ?? undefined, undefined);
    assert.equal((runner.runs[0].appendSystemPrompt ?? []).some((line) => /Find concrete issues first/.test(line)), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate persona draft import returns warnings without mutating durable teammate", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-persona-draft-"));
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_engineer";
    const before = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    const draft = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/persona-draft?cwd=${encodeURIComponent(cwd)}`, {
      sourcePath: "AGENTS.md",
      content: "# Senior Engineer\n\nCan use bash tools and external-send secrets.",
    });
    assert.equal(draft.draft.sourceKind, "agents-md");
    assert.equal(draft.draft.displayName, "Senior Engineer");
    assert.ok(draft.draft.warnings.some((warning) => /cannot grant tools/i.test(warning)));
    const after = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    assert.equal(after.displayName, before.displayName);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill health API returns read-only registry findings", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-health-api-"));
  const daemon = await startDaemonForTest();
  try {
    const missingCwd = await fetch(`${daemon.url}/skills/health`);
    assert.equal(missingCwd.status, 400);

    const health = await getJson(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}&limit=5`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.workspaceId, "workspace_default");
    assert.equal(typeof health.report.generatedAt, "string");
    assert.equal(health.report.summary.totalSkills > 0, true);
    assert.equal(health.report.summary.activeSkills > 0, true);
    assert.equal(Array.isArray(health.report.findings), true);
    assert.equal(health.report.findings.length <= 5, true);

    const postHealth = await fetch(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill source API returns source health and published snapshots", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-source-api-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const initialHealth = await getJson(`${daemon.url}/skills/source-health?cwd=${encodeURIComponent(cwd)}&limit=3`);
    assert.equal(initialHealth.cwd, cwd);
    assert.equal(initialHealth.report.workspaceId, "workspace_default");
    assert.equal(initialHealth.report.summary.totalSkills > 0, true);
    assert.equal(initialHealth.report.summary.missingSourceSnapshots > 0, true);
    assert.equal(initialHealth.report.findings.length <= 3, true);

    const store = stores.get(cwd);
    assert.ok(store);
    const snapshot = store.upsertSkillSourceSnapshot({
      id: "skill_source_review_api",
      skillId: "review",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-review/SKILL.md",
      upstreamName: "review",
      upstreamVersion: "1.58.3.0",
      sourceChecksum: "sha256-review-api",
      rawSkillMarkdown: "---\nname: review\n---\n# Review\n",
      referencedFiles: [],
      warnings: [],
      reviewStatus: "published",
    }, "2026-06-22T00:00:00.000Z");

    const source = await getJson(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(source.cwd, cwd);
    assert.equal(source.snapshot.id, snapshot.id);
    assert.equal(source.snapshot.rawSkillMarkdown.includes("# Review"), true);

    const optimizationPreview = await postJson(`${daemon.url}/skills/review/optimization-preview?cwd=${encodeURIComponent(cwd)}`, {
      mode: "preview_on_demand",
    });
    assert.equal(optimizationPreview.cwd, cwd);
    assert.equal(optimizationPreview.preview.skillId, "review");
    assert.equal(optimizationPreview.preview.sourceSnapshotId, snapshot.id);
    assert.equal(optimizationPreview.preview.mode, "preview_on_demand");
    assert.ok(optimizationPreview.preview.compiledView);
    assert.equal(optimizationPreview.preview.authorityBoundary.requiredToolsChanged, false);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 1);

    const compiledCreate = await postJson(`${daemon.url}/skills/review/compiled-views?cwd=${encodeURIComponent(cwd)}`, {
      mode: "preview_on_demand",
    });
    assert.equal(compiledCreate.cwd, cwd);
    assert.equal(compiledCreate.view.skillId, "review");
    assert.equal(compiledCreate.view.sourceSnapshotId, snapshot.id);
    assert.equal(compiledCreate.view.reviewStatus, "active");
    assert.equal(compiledCreate.view.authorityBoundary.requiredToolsChanged, false);
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review" }).length, 1);

    const compiledList = await getJson(`${daemon.url}/skills/review/compiled-views?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(compiledList.views.length, 1);
    assert.equal(compiledList.views[0].id, compiledCreate.view.id);

    const archivedCompiled = await postJson(`${daemon.url}/skills/review/compiled-views/${encodeURIComponent(compiledCreate.view.id)}/archive?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(archivedCompiled.view.reviewStatus, "archived");
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review" }).length, 0);
    assert.equal(store.listSkillCompiledRuntimeViews({ skillId: "review", includeArchived: true }).length, 1);

    const postSource = await fetch(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postSource.status, 405);

    const archivedSourceResponse = await fetch(`${daemon.url}/skills/review/source/archive?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    assert.equal(archivedSourceResponse.status, 200);
    const archivedSource = await archivedSourceResponse.json();
    assert.equal(archivedSource.cwd, cwd);
    assert.equal(archivedSource.snapshot.id, snapshot.id);
    assert.equal(archivedSource.snapshot.reviewStatus, "archived");

    const missingPublishedSource = await fetch(`${daemon.url}/skills/review/source?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingPublishedSource.status, 404);

    const healthAfterArchive = await getJson(`${daemon.url}/skills/source-health?cwd=${encodeURIComponent(cwd)}&limit=3`);
    assert.equal(healthAfterArchive.report.summary.sourceBackedSkills, 0);
    assert.equal(healthAfterArchive.report.summary.missingSourceSnapshots > 0, true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gstack skill source sync previews and publishes selected snapshots only", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-source-sync-api-"));
  const skillRoot = resolve(cwd, "skills");
  const reviewSkill = resolve(skillRoot, "gstack-review");
  await mkdir(resolve(reviewSkill, "agents"), { recursive: true });
  await mkdir(resolve(reviewSkill, "references"), { recursive: true });
  await writeFile(resolve(reviewSkill, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review the current diff before landing.",
    "---",
    "# Review",
    "Use AskUserQuestion for one-way decisions.",
  ].join("\n"));
  await writeFile(resolve(reviewSkill, "agents", "openai.yaml"), [
    "interface:",
    "  display_name: gstack-review",
    "  short_description: Pre-landing review.",
    "policy:",
    "  allow_implicit_invocation: true",
  ].join("\n"));
  await writeFile(resolve(reviewSkill, "references", "checklist.md"), "# Checklist\n");

  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const syncBody = {
      roots: [{ rootPath: skillRoot, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.58.3.0" }],
      includeDetectedRoots: false,
      includeSkillIds: ["review"],
    };
    const preview = await postJson(`${daemon.url}/skills/sync/gstack/preview?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(preview.cwd, cwd);
    assert.equal(preview.preview.summary.totalRecords, 1);
    assert.equal(preview.preview.records[0].skillId, "review");
    assert.equal(preview.preview.records[0].state, "attachable");
    assert.equal(preview.preview.records[0].agentMetadata.displayName, "gstack-review");
    assert.equal(preview.preview.records[0].referencedFiles.some((file) => file.path === "references/checklist.md"), true);

    const store = stores.get(cwd);
    assert.ok(store);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);
    const registryBefore = store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }).length;

    const refresh = await postJson(`${daemon.url}/skills/sync/gstack/refresh?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(refresh.cwd, cwd);
    assert.equal(refresh.preview.summary.totalRecords, 1);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 0);

    const published = await postJson(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      ...syncBody,
      selectedSkillIds: ["review"],
    });
    assert.equal(published.cwd, cwd);
    assert.equal(published.skills[0].id, "review");
    assert.equal(published.snapshots.length, 1);
    assert.equal(published.snapshots[0].skillId, "review");
    assert.equal(published.snapshots[0].reviewStatus, "published");
    assert.equal(published.snapshots[0].rawSkillMarkdown.includes("# Review"), true);
    assert.equal(store.listSkillSourceSnapshots({ reviewStatus: "published" }).length, 1);
    assert.equal(store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }).length, registryBefore);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gstack skill source sync requires confirmation before publishing new skills", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-source-sync-new-api-"));
  const skillRoot = resolve(cwd, "skills");
  const newSkill = resolve(skillRoot, "gstack-research-lab");
  await mkdir(newSkill, { recursive: true });
  await writeFile(resolve(newSkill, "SKILL.md"), [
    "---",
    "name: research-lab",
    "description: Research a local implementation question before coding.",
    "---",
    "# Research Lab",
  ].join("\n"));

  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const syncBody = {
      roots: [{ rootPath: skillRoot, sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: "1.58.3.0" }],
      includeDetectedRoots: false,
      includeSkillIds: ["research-lab"],
    };
    const preview = await postJson(`${daemon.url}/skills/sync/gstack/preview?cwd=${encodeURIComponent(cwd)}`, syncBody);
    assert.equal(preview.preview.records[0].skillId, "research-lab");
    assert.equal(preview.preview.records[0].state, "new");

    const rejected = await fetch(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...syncBody, selectedSkillIds: ["research-lab"] }),
    });
    assert.equal(rejected.status, 409);

    const published = await postJson(`${daemon.url}/skills/sync/gstack/publish?cwd=${encodeURIComponent(cwd)}`, {
      ...syncBody,
      selectedSkillIds: ["research-lab"],
      allowNewSkills: true,
    });
    assert.equal(published.skills[0].id, "research-lab");
    assert.equal(published.skills[0].source, "gstack");
    assert.equal(published.snapshots[0].skillId, "research-lab");

    const store = stores.get(cwd);
    assert.ok(store);
    assert.equal(store.getSkillRegistryEntry("research-lab").packId, "gstack-source-sync");
    assert.equal(store.getSkillSourceSnapshot("research-lab").reviewStatus, "published");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill candidate API persists manual candidates and gates review approval", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-candidate-api-"));
  const daemon = await startDaemonForTest();
  try {
    const payload = {
      id: "skill_candidate_api_manual",
      title: "Reusable release checklist",
      summary: "Capture the repeated release checklist as a reviewed candidate skill.",
      definition: {
        workflowPhase: "ship",
        positiveTriggers: ["repeated release checklist"],
        negativeTriggers: ["one-off release note"],
        procedureSteps: [{ title: "Collect release evidence", instruction: "Read linked run and approval evidence." }],
        validationSteps: [{ title: "Run skill health", commandOrCheck: "GET /skills/health", expectedResult: "No critical candidate findings." }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      sourceRefs: [{ type: "manual", id: "manual_release_note", label: "Manual release note" }],
    };
    const created = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, payload);
    assert.equal(created.candidate.id, payload.id);
    assert.equal(created.candidate.origin, "manual-draft");
    assert.equal(created.candidate.proposedAction, "create");
    assert.equal(created.candidate.status, "pending");
    assert.equal(created.candidate.duplicateAnalysis.decision, "no_overlap");
    assert.equal("workflowPhase" in created.candidate.definition, false);

    const listed = await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&status=pending&origin=manual-draft&limit=10`);
    assert.deepEqual(listed.candidates.map((candidate) => candidate.id), [payload.id]);

    const detail = await getJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.candidate.id, payload.id);
    assert.deepEqual(detail.reviewRecords, []);

    const approved = await postJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve_for_draft",
      reason: "Manual validation is present.",
      actor: "system",
    });
    assert.equal(approved.candidate.status, "approved_for_draft");
    assert.equal(approved.action.actor, "user");
    assert.equal(approved.action.previousStatus, "pending");
    assert.equal(approved.action.nextStatus, "approved_for_draft");

    const reviewedDetail = await getJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(reviewedDetail.reviewRecords.length, 1);
    assert.equal(reviewedDetail.reviewRecords[0].action, "approve_for_draft");

    const draftResponse = await postJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {
      content: [
        "---",
        "name: Edited release checklist",
        "description: Use the reviewed release checklist with explicit evidence and validation.",
        "---",
        "",
        "Collect release evidence, verify the approval record, and report failures before publishing.",
      ].join("\n"),
    });
    assert.equal(draftResponse.candidate.id, payload.id);
    assert.equal(draftResponse.draft.source, "custom");
    assert.equal(draftResponse.draft.sourcePath, `skill-candidates/${payload.id}`);
    assert.equal(draftResponse.draft.packId, "ling-generated");
    assert.equal(draftResponse.draft.definitions[0].definition.id, "edited-release-checklist");
    assert.equal("workflowPhase" in draftResponse.draft.definitions[0].definition, false);
    assert.match(draftResponse.draft.definitions[0].definition.promptFragments[0], /Collect release evidence/);

    const publishedDraft = await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draftResponse.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(publishedDraft.skills[0].id, "edited-release-checklist");
    assert.equal(publishedDraft.skills[0].packId, "ling-generated");
    assert.equal(publishedDraft.skills[0].sourcePath, `skill-candidates/${payload.id}`);
    const publishedCandidateDetail = await getJson(`${daemon.url}/skill-candidates/${encodeURIComponent(payload.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(publishedCandidateDetail.candidate.status, "published");
    await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draftResponse.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    const listedSkills = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listedSkills.skills.some((skill) => skill.id === "edited-release-checklist" && skill.source === "custom"));
    const draftEvents = await getJson(`${daemon.url}/skills/usage-events?cwd=${encodeURIComponent(cwd)}&candidateId=${encodeURIComponent(payload.id)}&limit=10`);
    assert.deepEqual(draftEvents.events.map((event) => event.kind).sort(), ["draft_created", "published"]);

    const correction = await postJson(`${daemon.url}/skills/edited-release-checklist/corrections?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Correction evidence should be collected before release checklist validation.",
      candidateId: payload.id,
    });
    assert.equal(correction.event.kind, "user_corrected");
    assert.equal(correction.event.skillId, "edited-release-checklist");
    await postJson(`${daemon.url}/skills/edited-release-checklist/corrections?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Correction repeated for health finding.",
      candidateId: payload.id,
    });
    const usageStats = await getJson(`${daemon.url}/skills/usage-stats?cwd=${encodeURIComponent(cwd)}&skillId=edited-release-checklist`);
    assert.equal(usageStats.stats[0].correctionCount, 2);

    const missingGate = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_candidate_missing_gate_api",
      title: "Weak candidate",
      summary: "Candidate without negative triggers cannot be approved.",
      definition: {
        positiveTriggers: ["weak repeated operation"],
        negativeTriggers: [],
        procedureSteps: [{ title: "Read evidence" }],
        validationSteps: [{ title: "Manual check" }],
        requiredTools: [],
        requiredProviderCapabilities: [],
      },
      sourceRefs: [{ type: "manual", id: "manual_weak_note" }],
    });
    const pendingDraft = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(missingGate.candidate.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(pendingDraft.status, 400);
    assert.match(await pendingDraft.text(), /approved_for_draft/);

    const blocked = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(missingGate.candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_for_draft" }),
    });
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /negative triggers/);

    const health = await getJson(`${daemon.url}/skills/health?cwd=${encodeURIComponent(cwd)}&limit=20`);
    assert.equal(health.report.summary.pendingCandidates, 1);
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "missing_negative_triggers" &&
      finding.candidateIds.includes(missingGate.candidate.id)
    ));
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "never_used_skill" &&
      finding.skillIds.includes("edited-release-checklist")
    ));
    assert.ok(health.report.findings.some((finding) =>
      finding.kind === "high_user_correction_skill" &&
      finding.skillIds.includes("edited-release-checklist")
    ));

    const duplicateConflict = await postJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_candidate_duplicate_conflict_api",
      title: "Duplicate release checklist",
      summary: "A duplicate candidate that still needs conflict review.",
      status: "approved_for_draft",
      definition: {
        positiveTriggers: ["release checklist"],
        negativeTriggers: ["one-off note"],
        procedureSteps: [{ title: "Read release evidence" }],
        validationSteps: [{ title: "Run health report" }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      duplicateAnalysis: {
        decision: "conflict_review",
        similarityScore: 0.8,
        matchedSkillIds: ["edited-release-checklist"],
        matchedCandidateIds: [],
        triggerOverlap: ["release checklist"],
        conflictingFields: ["requiredTools"],
        rationale: "Existing release checklist skill overlaps with this candidate.",
      },
      sourceRefs: [{ type: "manual", id: "manual_duplicate_note" }],
    });
    const duplicateDraft = await fetch(`${daemon.url}/skill-candidates/${encodeURIComponent(duplicateConflict.candidate.id)}/draft?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(duplicateDraft.status, 400);
    assert.match(await duplicateDraft.text(), /conflict_review/);

    const missing = await fetch(`${daemon.url}/skill-candidates/missing_candidate?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("procedure observation API routes structured observations before candidate creation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-procedure-observation-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const observationPayload = {
      id: "procedure_observation_api_manual",
      source: "explicit_user_request",
      signals: ["save_as_skill"],
      title: "Reusable UI verification flow",
      summary: "Capture a repeated UI verification flow as a reviewed skill candidate.",
      normalizedGoal: "verify web ui change",
      positiveTriggers: ["web ui verification"],
      negativeTriggers: ["docs-only change"],
      procedureSteps: [{ title: "Run Web typecheck", instruction: "Run the Web typecheck.", requiredTools: ["bash"] }],
      validationSteps: [{ title: "Run Playwright smoke", commandOrCheck: "corepack pnpm --filter @ling-stack/web exec playwright test", expectedResult: "Relevant tests pass." }],
      sourceRefs: [{ type: "manual", id: "manual_ui_observation", label: "Manual UI observation" }],
      confidence: "high",
      reusableScore: 85,
    };

    const createdObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, observationPayload);
    assert.equal(createdObservation.observation.id, observationPayload.id);
    assert.equal(createdObservation.route.kind, "skill");
    assert.deepEqual(createdObservation.route.blockers, []);

    const listedObservations = await getJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}&routeKind=skill&limit=10`);
    assert.deepEqual(listedObservations.observations.map((item) => item.id), [observationPayload.id]);

    const playbookObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, {
      id: "procedure_observation_api_playbook",
      channelId: channel.id,
      source: "workflow_step_output",
      signals: ["long_successful_sequence"],
      title: "Channel workflow release playbook",
      summary: "A channel workflow produced a repeatable release playbook.",
      normalizedGoal: "channel release playbook",
      positiveTriggers: ["channel release workflow"],
      procedureSteps: [{ title: "Summarize release evidence", instruction: "Collect test, review, and rollout evidence.", requiredTools: ["read"] }],
      sourceRefs: [{ type: "run", id: "run_playbook_api", label: "Playbook run" }],
      confidence: "high",
      reusableScore: 79,
    });
    assert.equal(playbookObservation.route.kind, "playbook");
    assert.equal(playbookObservation.route.reasonCode, "channel_scoped_repeatable_playbook");

    const channelObservations = await getJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=playbook&limit=10`);
    assert.deepEqual(channelObservations.observations.map((item) => item.id), ["procedure_observation_api_playbook"]);

    const playbookClusters = await getJson(`${daemon.url}/procedure-observation-clusters?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=playbook&status=ready_for_review&limit=10`);
    assert.equal(playbookClusters.clusters.length, 1);
    assert.equal(playbookClusters.clusters[0].recommendedAction, "create_playbook_candidate");
    assert.equal(playbookClusters.clusters[0].channelId, channel.id);

    const clusterDetail = await getJson(`${daemon.url}/procedure-observation-clusters/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(clusterDetail.cluster.id, playbookClusters.clusters[0].id);
    assert.deepEqual(clusterDetail.observations.map((item) => item.id), ["procedure_observation_api_playbook"]);

    const playbookCandidateResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const playbookCandidateText = await playbookCandidateResponse.text();
    assert.equal(playbookCandidateResponse.status, 201, playbookCandidateText);
    const playbookCandidate = JSON.parse(playbookCandidateText);
    assert.equal(playbookCandidate.candidate.status, "draft");
    assert.equal(playbookCandidate.candidate.channelId, channel.id);
    assert.equal(playbookCandidate.candidate.title, "Channel workflow release playbook");
    assert.equal(playbookCandidate.candidate.procedureSteps.length, 1);
    assert.match(playbookCandidate.candidate.reason, /procedure observation cluster/);
    assert.deepEqual(playbookCandidate.candidate.sourceRefs.map((ref) => ref.type), ["run"]);

    const listedPlaybookCandidates = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates?cwd=${encodeURIComponent(cwd)}&status=draft&limit=10`);
    assert.equal(listedPlaybookCandidates.candidates.some((candidate) => candidate.id === playbookCandidate.candidate.id), true);

    const approvedPlaybookCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/${encodeURIComponent(playbookCandidate.candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Promote to channel playbook.",
    });
    assert.equal(approvedPlaybookCandidate.candidate.status, "active");
    assert.ok(approvedPlaybookCandidate.candidate.activatedAt);

    const duplicatePlaybookCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(duplicatePlaybookCandidate.candidate.id, playbookCandidate.candidate.id);
    assert.equal(duplicatePlaybookCandidate.candidate.status, "active");

    const canvas = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/canvas?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(canvas.protocol.channelId, channel.id);
    assert.equal(canvas.candidateClusters.some((cluster) => cluster.id === playbookClusters.clusters[0].id), true);
    assert.equal(canvas.sections.some((section) => section.kind === "candidate_clusters" && section.status === "needs_review"), true);

    const protocolSourceMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "This channel needs reviewer signoff before implementation handoff.",
    });
    const protocolSourceDecision = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      sourceMessageId: protocolSourceMessage.message.id,
      title: "Handoff review",
      decision: "Reviewer signoff is required before implementation handoff.",
      createdBy: "local-user",
    });
    const protocolObservation = await postJson(`${daemon.url}/procedure-observations?cwd=${encodeURIComponent(cwd)}`, {
      id: "procedure_observation_api_protocol",
      channelId: channel.id,
      source: "multi_agent_handoff",
      signals: ["handoff_stabilized"],
      title: "Stable handoff review protocol",
      summary: "The channel repeatedly hands work from planner to engineer with reviewer signoff.",
      normalizedGoal: "review multi agent handoffs",
      positiveTriggers: ["planner to engineer handoff", "reviewer signoff"],
      negativeTriggers: ["single-agent task"],
      procedureSteps: [{ title: "Require review before implementation handoff", instruction: "Reviewer confirms the next agent has enough context.", requiredTools: ["read"] }],
      validationSteps: [{ title: "Confirm handoff context", commandOrCheck: "Review handoff packet source refs.", expectedResult: "The next agent receives a scoped packet." }],
      sourceRefs: [
        { type: "message", id: protocolSourceMessage.message.id, label: "Protocol source message" },
        { type: "decision", id: protocolSourceDecision.decision.id, label: "Protocol decision" },
      ],
      confidence: "high",
      reusableScore: 88,
    });
    assert.equal(protocolObservation.route.kind, "channel_protocol");
    assert.equal(protocolObservation.route.reasonCode, "multi_agent_handoff_protocol");

    const protocolClusters = await getJson(`${daemon.url}/procedure-observation-clusters?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.id)}&routeKind=channel_protocol&status=ready_for_review&limit=10`);
    assert.equal(protocolClusters.clusters.length, 1);
    assert.equal(protocolClusters.clusters[0].recommendedAction, "create_channel_protocol_candidate");

    const protocolDraftResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const protocolDraftText = await protocolDraftResponse.text();
    assert.equal(protocolDraftResponse.status, 201, protocolDraftText);
    const protocolDraft = JSON.parse(protocolDraftText);
    assert.equal(protocolDraft.draft.status, "draft");
    assert.equal(protocolDraft.draft.channelId, channel.id);
    assert.equal(protocolDraft.draft.proposedPatch.reviewRules.length, 1);
    assert.match(protocolDraft.draft.proposedPatch.reviewRules[0], /Stable handoff review protocol/);
    assert.match(protocolDraft.draft.reason, /procedure observation cluster/);
    assert.deepEqual(protocolDraft.draft.sourceRefs.map((ref) => ref.type), ["message", "channel_decision"]);

    const manualProtocolDraft = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      proposedPatch: { reviewRules: ["Keep multi-agent handoffs reviewed before implementation."] },
      reason: "Reviewer promoted the ready cluster.",
    });
    assert.deepEqual(manualProtocolDraft.draft.proposedPatch.reviewRules, ["Keep multi-agent handoffs reviewed before implementation."]);
    assert.equal(manualProtocolDraft.draft.reason, "Reviewer promoted the ready cluster.");

    const canvasAfterDraft = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/canvas?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(canvasAfterDraft.draftCandidates.some((draft) => draft.id === protocolDraft.draft.id), true);
    assert.equal(canvasAfterDraft.candidateClusters.some((cluster) => cluster.id === protocolClusters.clusters[0].id), true);

    const playbookToProtocol = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol-candidates/from-cluster/${encodeURIComponent(playbookClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(playbookToProtocol.status, 400);
    assert.equal((await playbookToProtocol.json()).error, "unsupported_procedure_observation_cluster_route");

    const protocolToPlaybook = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/playbook-candidates/from-cluster/${encodeURIComponent(protocolClusters.clusters[0].id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(protocolToPlaybook.status, 400);
    assert.equal((await protocolToPlaybook.json()).error, "unsupported_procedure_observation_cluster_route");

    const observedCandidate = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_candidate",
      title: "Reusable UI candidate flow",
      normalizedGoal: "verify web ui candidate change",
    });
    assert.equal(observedCandidate.action, "candidate_created");
    assert.equal(observedCandidate.route.kind, "skill");
    assert.equal(observedCandidate.candidate.origin, "ling-generated");
    assert.equal(observedCandidate.candidate.status, "pending");
    assert.equal(observedCandidate.duplicateAnalysis.decision, "no_overlap");

    const duplicateObservation = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_duplicate",
      title: "Reusable UI candidate flow",
      normalizedGoal: "verify web ui candidate change",
    });
    assert.equal(duplicateObservation.action, "evidence_recorded");
    assert.equal(duplicateObservation.duplicateAnalysis.decision, "append_evidence");
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=ling-generated&limit=10`)).candidates.length, 1);

    const blocked = await postJson(`${daemon.url}/skill-candidates/observe?cwd=${encodeURIComponent(cwd)}`, {
      ...observationPayload,
      id: "procedure_observation_api_policy",
      title: "Use bash without asking next time",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
    });
    assert.equal(blocked.action, "blocked");
    assert.equal(blocked.route.kind, "approval_policy_review");
    assert.deepEqual(blocked.route.blockers, ["permission_expansion"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("procedure observation job API records explicit jobs idempotently before candidate creation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-procedure-observation-job-api-"));
  const daemon = await startDaemonForTest();
  try {
    const jobPayload = {
      id: "procedure_observation_job_recording",
      source: "manual_recording",
      signals: ["save_as_skill", "user_approved_recording"],
      runId: "run_observation_job_recording",
      channelId: "channel_observation_job_recording",
      userConfirmed: true,
      destinationHint: "skill",
      title: "Recorded release verification flow",
      summary: "Capture a user-approved release verification flow.",
      normalizedGoal: "verify release change",
      positiveTriggers: ["release verification"],
      negativeTriggers: ["docs-only release note"],
      toolLabels: ["bash"],
      validationLabels: ["release validation passed"],
    };

    const created = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, jobPayload);
    assert.equal(created.action, "candidate_created");
    assert.equal(created.reusedObservation, false);
    assert.equal(created.observation.id, jobPayload.id);
    assert.equal(created.observation.sourceRefs.some((ref) => ref.type === "observation-job" && ref.id === created.jobKey), true);
    assert.equal(created.candidate.origin, "recording");
    assert.equal(created.candidate.status, "pending");

    const repeated = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      ...jobPayload,
      id: "procedure_observation_job_recording_repeat_should_reuse",
    });
    assert.equal(repeated.action, "evidence_recorded");
    assert.equal(repeated.reusedObservation, true);
    assert.equal(repeated.observation.id, created.observation.id);
    assert.equal(repeated.jobKey, created.jobKey);
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=recording&limit=10`)).candidates.length, 1);

    const recordingEndpoint = await postJson(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_recording_endpoint_observation",
      runId: "run_skill_recording_endpoint",
      title: "Recorded workspace cleanup flow",
      summary: "Capture a user-initiated workspace cleanup recording.",
      normalizedGoal: "record workspace cleanup",
      positiveTriggers: ["workspace cleanup recording"],
      negativeTriggers: ["destructive cleanup"],
      toolLabels: ["bash"],
      validationLabels: ["cleanup reviewed"],
    });
    assert.equal(recordingEndpoint.action, "candidate_created");
    assert.equal(recordingEndpoint.generationMode, "semi_auto");
    assert.equal(recordingEndpoint.recordingMode, "user_initiated");
    assert.equal(recordingEndpoint.candidate.origin, "recording");

    const evidenceOnly = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_success_only",
      userConfirmed: false,
      title: "Successful UI validation chain",
      summary: "Record a successful chain as evidence only.",
      normalizedGoal: "verify ui change",
      positiveTriggers: ["ui verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["web typecheck passed"],
    });
    assert.equal(evidenceOnly.action, "evidence_recorded");
    assert.equal(evidenceOnly.reusedObservation, false);
    assert.equal(evidenceOnly.candidate, undefined);

    const firstPostRun = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_post_run_one",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Successful regression verification chain",
      summary: "Record a successful regression verification chain.",
      normalizedGoal: "verify regression change",
      positiveTriggers: ["regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["regression typecheck passed"],
    });
    assert.equal(firstPostRun.action, "evidence_recorded");
    assert.equal(firstPostRun.generationDecision.source, "post_run_terminal");
    assert.equal(firstPostRun.generationDecision.decision, "append_evidence");
    assert.equal(firstPostRun.observation.sourceRefs.some((ref) => ref.type === "skill" && ref.id === "implement"), true);

    const secondPostRun = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_post_run_two",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Successful regression verification chain",
      summary: "Record another successful regression verification chain.",
      normalizedGoal: "verify regression change",
      positiveTriggers: ["regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["regression typecheck passed"],
    });
    assert.equal(secondPostRun.action, "candidate_created");
    assert.equal(secondPostRun.candidate.origin, "ling-generated");
    assert.equal(secondPostRun.generationDecision.source, "post_run_terminal");
    assert.equal(secondPostRun.generationDecision.decision, "create_skill_candidate");
    assert.equal(secondPostRun.generationDecision.createdCandidateId, secondPostRun.candidate.id);

    const generationDecisions = await getJson(`${daemon.url}/candidate-generation-decisions?cwd=${encodeURIComponent(cwd)}&clusterId=${encodeURIComponent(secondPostRun.observation.clusterId)}&limit=10`);
    assert.equal(generationDecisions.decisions.length, 2);
    assert.deepEqual(generationDecisions.decisions.map((decision) => decision.decision).sort(), ["append_evidence", "create_skill_candidate"]);

    const blocked = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "manual_recording",
      signals: ["save_as_skill", "user_approved_recording"],
      runId: "run_observation_job_policy",
      userConfirmed: true,
      title: "Use bash without asking",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
      positiveTriggers: ["skip approval"],
      negativeTriggers: ["manual review needed"],
      toolLabels: ["bash"],
      validationLabels: ["manual check"],
    });
    assert.equal(blocked.action, "blocked");
    assert.equal(blocked.route.kind, "approval_policy_review");

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const approvalOnlyFirst = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_approval_only_one",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Approval-only regression verification chain",
      summary: "Record a successful chain under approval-only policy.",
      normalizedGoal: "verify approval only regression",
      positiveTriggers: ["approval-only regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["approval-only typecheck passed"],
    });
    const approvalOnlySecond = await postJson(`${daemon.url}/procedure-observations/jobs?cwd=${encodeURIComponent(cwd)}`, {
      source: "successful_tool_chain",
      signals: ["long_successful_sequence"],
      runId: "run_observation_job_approval_only_two",
      terminalStatus: "succeeded",
      selectedSkillId: "implement",
      userConfirmed: false,
      title: "Approval-only regression verification chain",
      summary: "Record another successful chain under approval-only policy.",
      normalizedGoal: "verify approval only regression",
      positiveTriggers: ["approval-only regression verification"],
      negativeTriggers: ["docs-only change"],
      toolLabels: ["bash"],
      validationLabels: ["approval-only typecheck passed"],
    });
    assert.equal(approvalOnlyFirst.action, "evidence_recorded");
    assert.equal(approvalOnlySecond.action, "evidence_recorded");
    assert.equal(approvalOnlySecond.candidate, undefined);
    assert.match(approvalOnlySecond.generationDecision.reason, /approval_only/);

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "off",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const generationOffRecording = await postJson(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      id: "skill_recording_generation_off",
      runId: "run_skill_recording_generation_off",
      title: "Recorded evidence-only flow",
      summary: "Recording should be retained as evidence when generation is off.",
      normalizedGoal: "record evidence only",
      positiveTriggers: ["evidence-only recording"],
      negativeTriggers: ["candidate creation"],
      toolLabels: ["bash"],
      validationLabels: ["manual review"],
    });
    assert.equal(generationOffRecording.action, "evidence_recorded");
    assert.equal(generationOffRecording.candidate, undefined);
    assert.equal(generationOffRecording.generationMode, "off");

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "disabled",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    const disabledRecording = await fetch(`${daemon.url}/skill-recordings?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "run_skill_recording_disabled",
        title: "Disabled recording",
        summary: "This should be rejected by policy.",
        normalizedGoal: "disabled recording",
      }),
    });
    assert.equal(disabledRecording.status, 409);
    assert.equal((await disabledRecording.json()).error, "skill_recording_disabled");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill recording eligibility previews run evidence without creating candidates", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-recording-eligibility-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Skill Recording",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.createRun({
      id: "run_skill_recording_eligibility",
      cwd,
      taskId: "task_skill_recording_eligibility",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_skill_recording_eligibility", title: "Verify release checklist" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-11T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");
    store.appendEvent(run.id, "tool_start", { toolName: "bash" });
    store.appendEvent(run.id, "tool_end", { toolName: "bash" });
    store.markRunSucceeded(run.id, "2026-06-11T00:03:00.000Z");

    const eligibility = await getJson(`${daemon.url}/skill-recordings/eligibility?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(run.id)}`);
    assert.equal(eligibility.visible, true);
    assert.equal(eligibility.recommended, true);
    assert.equal(eligibility.reasonCode, "available");
    assert.equal(eligibility.actionHint, "create_candidate");
    assert.equal(eligibility.recordingMode, "user_initiated");
    assert.equal(eligibility.route.kind, "skill");
    assert.equal(eligibility.duplicateAnalysis.decision, "no_overlap");
    assert.equal((await getJson(`${daemon.url}/skill-candidates?cwd=${encodeURIComponent(cwd)}&origin=recording&limit=10`)).candidates.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill import draft publishes registry skills and teammate bindings use effective model", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-skill-import-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initialSkills = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(initialSkills.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));

    const importRequest = {
      source: "custom",
      sourcePath: "SKILL.md",
      content: [
        "---",
        "name: Custom QA Review",
        "description: Run a focused QA pass. Do not grant bash approvals or secrets.",
        "---",
        "",
        "Review the target surface and report concrete failures first.",
      ].join("\n"),
    };
    const draft = await postJson(`${daemon.url}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, importRequest);
    assert.equal(draft.draft.definitions.length, 1);
    assert.equal(draft.draft.definitions[0].definition.id, "custom-qa-review");
    assert.ok(draft.draft.definitions[0].warnings.some((warning) => warning.code === "permission_like_instruction"));
    assert.ok(draft.contextFindings.some((finding) => finding.kind === "optimization_unsafe"));

    const draftPreview = await postJson(`${daemon.url}/skills/import-draft/optimization-preview?cwd=${encodeURIComponent(cwd)}`, {
      ...importRequest,
      mode: "preview_on_demand",
    });
    assert.equal(draftPreview.preview.skillId, "custom-qa-review");
    assert.equal(draftPreview.preview.mode, "preview_on_demand");
    assert.equal(draftPreview.preview.status, "manual_review_required");
    assert.equal(draftPreview.preview.authorityBoundary.requiredToolsChanged, false);

    const published = await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draft.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(published.skills[0].id, "custom-qa-review");
    const draftCompiledResponse = await fetch(`${daemon.url}/skills/custom-qa-review/compiled-views?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview_on_demand" }),
    });
    assert.equal(draftCompiledResponse.status, 404);
    assert.equal((await draftCompiledResponse.json()).error, "skill_source_snapshot_not_found");
    const listed = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    const refreshed = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.ok(refreshed.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));
    assert.ok(refreshed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    assert.equal(typeof refreshed.refreshedAt, "string");
    assert.equal(typeof refreshed.registryGeneration, "number");
    const refreshedAgain = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshedAgain.registryGeneration > refreshed.registryGeneration, true);

    const teammateId = "teammate_builtin_engineer";
    const updated = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "custom-qa-review", source: "user", enabled: true }],
    });
    const customEffective = updated.effectiveSkills.find((skill) => skill.skillId === "custom-qa-review");
    assert.ok(customEffective);
    assert.equal(customEffective.executable, true);

    const unknownResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: [{ skillId: "missing-new-skill", source: "user", enabled: true }] }),
    });
    assert.equal(unknownResponse.status, 400);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct replies use a local workspace when cwd is not a Git repository", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-nongit-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const initialWorkspace = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initialWorkspace.binding.mode, "managed_worktree");
    assert.equal(initialWorkspace.binding.status, "not_created");
    const store = stores.get(cwd);
    assert.ok(store);
    const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
    const blockedAt = new Date().toISOString();
    store.updateTeammateDirectThreadWorkspace(thread.id, {
      ...initialWorkspace.binding,
      status: "blocked",
      errorMessage: "当前工作区不是 Git 仓库，无法创建独立私聊工作区。",
      checkedAt: blockedAt,
      updatedAt: blockedAt,
    }, blockedAt);

    const explicitWorktree = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(explicitWorktree.status, 400);
    assert.equal((await explicitWorktree.json()).error, "not_git_repository");

    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你是谁",
      providerPresetId: provider.id,
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.body, "Designer reply");
    assert.ok(created.aiReply.linkedRunId);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].cwd, cwd);

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(created.aiReply.linkedRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.requestSnapshot.directWorkspaceBinding.mode, "local");
    assert.equal(run.requestSnapshot.directWorkspaceBinding.status, "ready");
    assert.equal(run.requestSnapshot.cwd, cwd);

    const workspace = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workspace.binding.mode, "local");
    assert.equal(workspace.binding.status, "ready");
    assert.equal(workspace.snapshot.executionCwd, cwd);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct message stream emits accepted ready delta and done events", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-stream-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Stream a private reply.",
        providerPresetId: provider.id,
        permissionPreset: "read_only",
      }),
    });
    assert.equal(response.status, 200);
    const events = privateReplyTextEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "run_linked", "delta", "done"]);
    assert.ok(events[1].data.linkedRunId);
    assert.equal(events[1].data.activeReply.runId, events[1].data.linkedRunId);
    assert.equal(events[1].data.activeReply.sourceRunId, events[1].data.linkedRunId);
    assert.equal(events[1].data.activeReply.teammateId, teammateId);
    assert.equal(events[1].data.activeReply.status, "queued");
    assert.ok(events[1].data.activeReply.workUnitId);
    assert.equal(JSON.stringify(events[1].data.activeReply).includes("providerSnapshot"), false);
    assert.equal(events[2].data.delta, "Designer reply");
    assert.equal(events[3].data.aiReply.body, "Designer reply");
    assert.equal(events[3].data.aiReply.linkedRunId, events[1].data.linkedRunId);
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(events[1].data.linkedRunId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.teammateId, teammateId);
    assert.ok(run.threadId);
    assert.ok(run.requestSnapshot.turnId);
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.mode, "ask_everything");
    assert.equal(run.requestSnapshot.directWorkspaceBinding.mode, "managed_worktree");
    assert.ok(runner.runs[0].tools.includes("read"));
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.messages.at(-1).body, "Designer reply");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct replies hide leading receipt echoes while preserving the answer", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-receipt-echo-"));
  await ensureGitRepo(cwd);
  const runner = {
    runs: [],
    async runTask(options) {
      this.runs.push(options);
      const chunks = ["收", "到：111。\n", "如果这是排队号或引导码，可以查看现场大屏确认进度。"];
      for (const text of chunks) {
        options.onEvent?.({ type: "assistant_text_delta", text });
      }
      return {
        taskId: options.task.id,
        messages: [chunks.join("")],
        events: [],
      };
    },
  };
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "111", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const visibleBodies = events
      .filter((event) => event.event === "delta" || event.event === "done")
      .map((event) => event.event === "done" ? event.data.aiReply.body : event.data.body);
    assert.equal(visibleBodies.some((body) => body.includes("收到：111")), false);
    assert.equal(events.find((event) => event.event === "done").data.aiReply.body, "如果这是排队号或引导码，可以查看现场大屏确认进度。");
    assert.match(runner.runs[0].systemPrompt, /Do not start with a receipt acknowledgement or echo the user's message/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct execution creates a supervised run and projects tool events", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-supervised-run-"));
  await ensureGitRepo(cwd);
  const runner = new DirectToolRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Read package.json and report the result.",
        providerPresetId: provider.id,
        permissionPreset: "workspace_collaboration",
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const linked = events.find((event) => event.event === "run_linked");
    const done = events.find((event) => event.event === "done");
    assert.ok(linked?.data.linkedRunId);
    assert.equal(done?.data.aiReply.linkedRunId, linked.data.linkedRunId);

    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.getRun(linked.data.linkedRunId);
    assert.ok(run);
    assert.equal(run.status, "succeeded");
    assert.equal(run.teammateId, teammateId);
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.mode, "workspace_write");
    const thread = store.getLingThread(run.threadId);
    const turn = store.getLingTurnForRun(run.id);
    assert.equal(thread?.kind, "teammate_direct");
    assert.equal(turn?.sourceItemId, run.taskId);
    const anchor = store.getConversationItem(turn.sourceItemId);
    assert.ok(anchor, "private tool events require a persisted canonical conversation item");
    assert.equal(anchor.threadId, run.threadId);
    assert.equal(anchor.turnId, turn.id);
    assert.equal(anchor.visibility, "agent_private");
    assert.equal(anchor.visibilityOwnerId, teammateId);
    const actions = await getJson(`${daemon.url}/execution-actions?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(run.id)}`);
    assert.ok(actions.actions.some((action) => action.sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === anchor.id)));
    const workUnit = store.getWorkUnit(run.workUnitId);
    assert.equal(workUnit?.kind, "teammate_direct_reply");
    assert.equal(workUnit?.linkedRunId, run.id);
    assert.equal(workUnit?.linkedMessageId, done.data.aiReply.id);
    assert.equal(workUnit?.teammateId, teammateId);
    assert.ok(runner.runs[0].tools.includes("read"));
    assert.ok(runner.runs[0].tools.includes("edit"));
    const runEvents = store.listEvents(run.id, { limit: 100 });
    assert.ok(runEvents.some((event) => event.type === "tool_start"));
    assert.ok(runEvents.some((event) => event.type === "tool_end"));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct execution waits for approval and resumes the same supervised run", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-supervised-approval-"));
  await ensureGitRepo(cwd);
  const runner = new DirectApprovalRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read", "bash"],
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Run a private shell check after approval.",
        providerPresetId: provider.id,
        permissionPreset: "read_only",
      }),
    });
    assert.equal(response.status, 200);

    await waitForCondition(async () => {
      const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending`);
      return pending.approvals.length === 1;
    }, "private direct approval request");
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending`);
    const approval = pending.approvals[0];
    assert.ok(approval?.runId);

    const store = stores.get(cwd);
    assert.ok(store);
    const waitingRun = store.getRun(approval.runId);
    assert.equal(waitingRun?.status, "waiting_for_approval");
    assert.equal(store.getWorkUnit(waitingRun.workUnitId)?.status, "waiting_for_approval");

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Approve private shell check",
    });
    const events = parseSseEvents(await response.text());
    const done = events.find((event) => event.event === "done");
    assert.ok(done?.data.aiReply.linkedRunId);
    assert.equal(done.data.aiReply.linkedRunId, approval.runId);
    assert.equal(store.getRun(approval.runId)?.status, "succeeded");
    assert.equal(store.getWorkUnit(waitingRun.workUnitId)?.status, "succeeded");
    assert.deepEqual(runner.decisions.map((decision) => decision.approved), [true]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct execution does not expose tools outside teammate policy", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-tool-boundary-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read"],
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Read the workspace without mutating it.",
        providerPresetId: provider.id,
        permissionPreset: "workspace_collaboration",
      }),
    });
    assert.equal(response.status, 200);
    parseSseEvents(await response.text());

    assert.equal(runner.runs.length, 1);
    assert.ok(runner.runs[0].tools.includes("read"));
    assert.equal(runner.runs[0].tools.includes("bash"), false);
    assert.equal(runner.runs[0].tools.includes("edit"), false);
    assert.equal(runner.runs[0].tools.includes("write"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply injects web search context before runner reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-web-search-context-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const webSearchCalls = [];
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    webFetch: async (url, init) => {
      webSearchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Private fresh web evidence summary.",
        output: [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [
                { type: "url", url: "https://example.com/private-fresh", title: "Private fresh source" },
              ],
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai",
      displayName: "OpenAI Responses + Web Search",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      authHeader: true,
      capabilities: ["chat", "tool_call", "reasoning", "web_search"],
    })).provider;
    const store = stores.get(cwd);
    assert.ok(store);
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider ready for private web search context test.",
      checkedAt: new Date().toISOString(),
    });
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "查一下 Ling Stack 最新消息", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseAcceptedPrivateSseEvents(await response.text());
    assert.equal(events[0].event, "ready");
    assert.equal(events.at(-1).event, "done");
    assert.ok(events.some((event) => event.event === "delta" && /正在准备 web_search/.test(event.data.body)));
    assert.ok(events.some((event) => event.event === "delta" && /正在搜索网页/.test(event.data.body)));
    assert.ok(events.some((event) => event.event === "delta" && /web_search 找到 1 个来源/.test(event.data.body)));
    const doneEvent = events.find((event) => event.event === "done");
    assert.equal(doneEvent.data.aiReply.webEvidence.status, "available");
    assert.equal(doneEvent.data.aiReply.webEvidence.query, "查一下 Ling Stack 最新消息");
    assert.equal(doneEvent.data.aiReply.webEvidence.provider.adapterId, "openai-responses-web-search");
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.sources.map((source) => source.url), ["https://example.com/private-fresh"]);
    assert.doesNotMatch(JSON.stringify(doneEvent.data.aiReply.webEvidence), /sk-test-secret-value/);
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const finalReply = listed.messages.find((message) => message.id === doneEvent.data.aiReply.id);
    assert.equal(finalReply.webEvidence.status, "available");
    const workUnit = store.listWorkUnits({ kind: "teammate_direct_reply", linkedMessageId: finalReply.id, limit: 1 })[0];
    assert.ok(workUnit);
    const webProgressEvents = store.listRuntimeEvents(workUnit.id).filter((event) => event.type === "work_unit_progress" && event.data.toolSurface === "web");
    assert.deepEqual(webProgressEvents.map((event) => event.data.type), [
      "web_search_planned",
      "web_search_started",
      "web_search_completed",
    ]);
    assert.equal(webProgressEvents[2].data.status, "available");
    assert.equal(webProgressEvents[2].data.sourceCount, 1);

    assert.equal(webSearchCalls.length, 1);
    assert.equal(webSearchCalls[0].url, "https://api.openai.com/v1/responses");
    const requestBody = JSON.parse(webSearchCalls[0].init.body);
    assert.deepEqual(requestBody.tools, [{ type: "web_search", search_context_size: "low" }]);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Ling web context:/);
    assert.match(runner.runs[0].task.prompt, /Private fresh web evidence summary/);
    assert.match(runner.runs[0].task.prompt, /https:\/\/example\.com\/private-fresh/);
    assert.match(runner.runs[0].systemPrompt, /If Ling web context is included/);
    assert.match(runner.runs[0].systemPrompt, /explain the limitation briefly in user-facing language/);
    assert.match(runner.runs[0].systemPrompt, /do not repeat provider, relay, or protocol diagnostics verbatim/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct web search context blocks unsupported providers without fetching", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-web-search-unsupported-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  let fetched = false;
  const daemon = await startDaemonForTest(runner, {
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    webFetch: async () => {
      fetched = true;
      return new Response("should not fetch", { status: 200 });
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "查一下 Ling Stack 最新消息", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseAcceptedPrivateSseEvents(await response.text());
    assert.equal(events[0].event, "ready");
    assert.equal(events.at(-1).event, "done");
    assert.ok(events.some((event) => event.event === "delta" && /web_search 被阻止/.test(event.data.body)));
    const doneEvent = events.find((event) => event.event === "done");
    assert.equal(doneEvent.data.aiReply.webEvidence.status, "blocked");
    assert.match(doneEvent.data.aiReply.webEvidence.reason, /No Ling global web_search backend is configured/);
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.sources, []);
    assert.deepEqual(doneEvent.data.aiReply.webEvidence.readUrls, []);

    assert.equal(fetched, false);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Web search status: blocked/);
    assert.match(runner.runs[0].task.prompt, /No Ling global web_search backend is configured/);
    assert.match(runner.runs[0].task.prompt, /will not bypass model settings/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /sk-test-secret-value/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct message rejects workspace file refs outside private workspace", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-file-ref-boundary-"));
  await ensureGitRepo(cwd);
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_designer";
    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Read this file.",
        fileRefs: [{ path: resolve(tmpdir(), "outside-private-chat.txt"), label: "outside-private-chat.txt", source: "composer" }],
      }),
    });
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.match(error.message, /文件引用不在私聊工作区范围内/);
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.messages.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply materializes current text and docx attachments", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-attachment-materialization-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const textAttachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-note.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Private direct attachment body", "utf8").toString("base64"),
    })).attachment;
    const docxAttachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-brief.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBase64: (await readDocxFixtureBytes()).toString("base64"),
    })).attachment;

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Summarize these private attachments.",
        attachmentIds: [textAttachment.id, docxAttachment.id],
        providerPresetId: provider.id,
      }),
    });
    assert.equal(response.status, 200);
    const events = privateReplyTextEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "run_linked", "delta", "done"]);

    const prompt = runner.runs[0].task.prompt;
    assert.match(prompt, /Attachment content:/);
    assert.match(prompt, /Private direct attachment body/);
    assert.match(prompt, /Walking on imported air/);
    assert.doesNotMatch(prompt, /currently exposes attachment metadata only/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply uses private chat memory isolation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-memory-isolation-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const channel = await createChannel(daemon.url, cwd);
    const privateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Direct memory token",
      body: "Designer private directmemorytoken preference should be available in private chat.",
      sensitivity: "private",
    })).memory;
    const otherPrivateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_engineer",
      title: "Other direct memory token",
      body: "Engineer private directmemorytoken preference must stay isolated.",
      sensitivity: "private",
    })).memory;
    const channelMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Channel direct memory token",
      body: "Channel directmemorytoken context must not enter private chat by default.",
    })).memory;

    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Use directmemorytoken in this private reply.",
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Used memory:/);
    assert.match(runner.runs[0].systemPrompt, /Designer private directmemorytoken preference/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Engineer private directmemorytoken preference/);
    assert.doesNotMatch(runner.runs[0].systemPrompt, /Channel directmemorytoken context/);

    const used = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&responseId=${encodeURIComponent(created.aiReply.id)}`);
    assert.ok(used.events[0].memoryIds.includes(privateMemory.id));
    assert.equal(used.events[0].memoryIds.includes(otherPrivateMemory.id), false);
    assert.equal(used.events[0].memoryIds.includes(channelMemory.id), false);
    assert.match(used.events[0].policyVersion, /memory_use_isolation_v2/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct prompt anchors latest attachment message instead of old guidance context", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-attachment-anchor-"));
  await ensureGitRepo(cwd);
  const runner = new RecordingRunner();
  const stores = [];
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.push(store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "要继续补「排队引导」相关内容。",
      requestAiReply: false,
    });
    const store = stores.find((item) => item.paths.cwd === cwd);
    assert.ok(store);
    const thread = store.getOrCreateTeammateDirectThread(teammateId, "2026-06-12T08:00:00.000Z");
    store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId,
        authorType: "system",
        authorId: "system",
        systemPurpose: "execution_control",
        body: "排队引导：旧排队引导不应继续生效。",
        status: "ready",
      },
      "2026-06-12T08:01:00.000Z",
    );
    const attachment = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "screenshot.png",
      contentType: "image/png",
      contentBase64: Buffer.from("not-a-real-image").toString("base64"),
      scope: "teammate_direct_thread",
    })).attachment;

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "描述下这个图片是什么内容",
        attachmentIds: [attachment.id],
        providerPresetId: provider.id,
      }),
    });
    assert.equal(response.status, 200);
    const events = privateReplyTextEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "run_linked", "delta", "done"]);

    const prompt = runner.runs.at(-1).task.prompt;
    const oldGuidanceIndex = prompt.indexOf("要继续补「排队引导」相关内容。");
    const latestIndex = prompt.indexOf("Latest message to answer now:\nUser: 描述下这个图片是什么内容");
    assert.equal(oldGuidanceIndex >= 0, true);
    assert.equal(latestIndex > oldGuidanceIndex, true);
    assert.doesNotMatch(prompt, /旧排队引导不应继续生效/);
    assert.match(prompt, /Attachments: screenshot\.png \(image, image\/png,/);
    assert.match(prompt, /Reply to the Latest message to answer now/);
    assert.match(prompt, /Do not infer unseen attachment contents/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply cancel aborts active reply and marks pending message cancelled", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-cancel-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start a cancellable private reply.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(response.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "private reply runner to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runtime.activeReply.status, "running");
    assert.ok(runtime.activeReply.workUnitId);
    assert.ok(runtime.activeReply.messageId);

    const cancelled = await postJson(`${daemon.url}/teammate-direct-replies/${encodeURIComponent(runtime.activeReply.workUnitId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");
    assert.equal(cancelled.message.status, "cancelled");
    assert.equal(cancelled.message.body, "回复已停止");
    assert.equal(runner.abortCount, 1);

    runner.resolve("Late private reply");
    await response.text().catch(() => "");
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const aiReply = listed.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(aiReply.status, "cancelled");
    assert.equal(aiReply.body, "回复已停止");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance can promote to immediate continuation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-promote-guidance-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start thinking.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "direct reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const rejectedGuidance = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "queue_followup",
        instruction: "Use outside file.",
        messagePayload: {
          body: "Use outside file.",
          attachmentIds: [],
          fileRefs: [{ path: resolve(tmpdir(), "outside-guidance.txt"), label: "outside-guidance.txt", source: "composer" }],
        },
        idempotencyKey: "test-reject-outside-guidance-file-ref",
      }),
    });
    assert.equal(rejectedGuidance.status, 400);
    assert.match((await rejectedGuidance.json()).message, /文件引用不在私聊工作区范围内/);

    const queued = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Use this queued guidance immediately.",
      messagePayload: {
        body: "Use this queued guidance immediately.",
        attachmentIds: [],
      },
      idempotencyKey: "test-promote-queued-guidance",
    });
    assert.equal(queued.intervention.status, "queued");
    assert.deepEqual(queued.intervention.messagePayload, {
      body: "Use this queued guidance immediately.",
      attachmentIds: [],
      linkPreviewIds: [],
    });

    const promoted = await postJson(`${daemon.url}/teammate-direct-interventions/${encodeURIComponent(queued.intervention.id)}/promote?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(promoted.intervention.id, queued.intervention.id);
    assert.deepEqual(promoted.intervention.messagePayload, queued.intervention.messagePayload);
    assert.equal(promoted.intervention.status, "cancelling_source");
    assert.equal(runner.abortCount, 1);
    await waitForCondition(() => runner.runs.length === 2, "promoted continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes("Use this queued guidance immediately."), true);
    assert.equal(runner.runs[1].task.prompt.includes("排队引导"), false);
    assert.match(runner.runs[1].task.prompt, /User: Use this queued guidance immediately\./);
    assert.match(runner.runs[1].systemPrompt, /Do not acknowledge receipt, queueing, or continuation mechanics/);

    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.interventions.filter((item) => item.id === queued.intervention.id).length, 1);
    assert.equal(listed.interventions.some((item) => item.status === "queued"), false);

    runner.resolve("Promoted continuation reply");
    await streamResponse.text().catch(() => "");
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const cancelledReply = messages.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(cancelledReply.status, "cancelled");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance starts automatically after source reply completes", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-queued-guidance-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start and then follow queued guidance.", providerPresetId: provider.id }),
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "source private reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const queued = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Continue from the queued guidance.",
      idempotencyKey: "test-auto-queued-guidance",
    });
    assert.equal(queued.intervention.status, "queued");

    runner.resolve("Initial private reply");
    await waitForCondition(() => runner.runs.length === 2, "queued continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes("Continue from the queued guidance."), true);
    assert.equal(runner.runs[1].task.prompt.includes("排队引导"), false);
    assert.match(runner.runs[1].task.prompt, /User: Continue from the queued guidance\./);
    assert.match(runner.runs[1].systemPrompt, /Do not acknowledge receipt, queueing, or continuation mechanics/);
    runner.resolve("Queued continuation reply");
    await streamResponse.text();

    const listedInterventions = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedInterventions.interventions.some((item) => item.id === queued.intervention.id), false);
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(messages.messages.some((message) => message.authorType === "local-user" && message.body === "Continue from the queued guidance."), true);
    assert.equal(messages.messages.at(-1).body, "Queued continuation reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance drains multiple queued items in thread FIFO order", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-queued-guidance-fifo-"));
  await ensureGitRepo(cwd);
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start and then drain queued guidance.", providerPresetId: provider.id }),
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "source private reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const queuedInstructions = [
      "Queued guidance one.",
      "Queued guidance two.",
      "Queued guidance three.",
    ];
    const queued = [];
    for (const [index, instruction] of queuedInstructions.entries()) {
      const response = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
        mode: "queue_followup",
        instruction,
        idempotencyKey: `test-auto-queued-guidance-fifo-${index}`,
      });
      assert.equal(response.intervention.status, "queued");
      queued.push(response.intervention);
    }

    runner.resolve("Initial private reply");
    await waitForCondition(() => runner.runs.length === 2, "first queued continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes(queuedInstructions[0]), true);

    runner.resolve("First queued continuation reply");
    await waitForCondition(() => runner.runs.length === 3, "second queued continuation to start");
    assert.equal(runner.runs[2].task.prompt.includes(queuedInstructions[1]), true);

    runner.resolve("Second queued continuation reply");
    await waitForCondition(() => runner.runs.length === 4, "third queued continuation to start");
    assert.equal(runner.runs[3].task.prompt.includes(queuedInstructions[2]), true);

    runner.resolve("Third queued continuation reply");
    await streamResponse.text();
    const queuedIds = new Set(queued.map((item) => item.id));
    await waitForCondition(async () => {
      const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
      return !listed.interventions.some((item) => queuedIds.has(item.id));
    }, "queued guidance chain to close");
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    for (const instruction of queuedInstructions) {
      assert.equal(messages.messages.some((message) => message.authorType === "local-user" && message.body === instruction), true);
    }
    assert.equal(messages.messages.at(-1).body, "Third queued continuation reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private attachments avatar and hard delete stay scoped to teammate private data", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-private-attachments-hard-delete-"));
  const daemon = await startDaemonForTest(undefined, {}, { defaultWorkspaceCwd: cwd });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    const attachment = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-note.txt",
      contentBase64: Buffer.from("private note", "utf8").toString("base64"),
    });
    const content = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(await content.text(), "private note");
    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "See the private note.",
      attachmentIds: [attachment.attachment.id],
    });
    assert.deepEqual(message.message.attachmentIds, [attachment.attachment.id]);
    const avatar = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/avatar?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "avatar.png",
      contentBase64: Buffer.from("png", "utf8").toString("base64"),
    });
    assert.equal(avatar.teammate.avatarImageAttachmentId, avatar.attachment.id);
    const crossScope = await fetch(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "bad", attachmentIds: [attachment.attachment.id] }),
    });
    assert.equal(crossScope.status, 400);
    assert.match((await crossScope.json()).message, /does not belong/i);

    const memory = await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Hard delete private memory",
      body: "This memory should disappear.",
      sensitivity: "private",
    });
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Assigned before delete",
      prompt: "Keep task history.",
      assigneeTeammateId: teammateId,
    })).task;

    const deleted = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test delete",
    });
    assert.equal(deleted.tombstone.entityId, teammateId);
    assert.equal(deleted.tombstone.deletedCounts.privateAttachments, 2);
    const missingMessages = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingMessages.status, 404);
    const missingContent = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingContent.status, 404);
    const updatedTask = (await getJson(`${daemon.url}/tasks/${encodeURIComponent(task.id)}?cwd=${encodeURIComponent(cwd)}`)).task;
    assert.equal(updatedTask.assigneeTeammateId, undefined);
    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId,
      intent: "private-chat",
      query: "Hard delete private memory",
      includePrivate: true,
    });
    assert.equal(recall.memories.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
