import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSidebarObjectContextSeeds,
  projectSidebarObjectGitContext,
  sidebarObjectContextKey,
} from "../src/app/sidebar-object-context.ts";

test("Sidebar object contexts use object-specific workspaces and latest activity", () => {
  const threads = [
    thread("thread-old", "2026-08-25T00:00:00.000Z"),
    thread("thread-new", "2026-08-26T00:00:00.000Z"),
  ];
  const runs = [
    run("run-conversation-old", { threadId: "thread-new", cwd: "/workspace/old", updatedAt: "2026-08-25T10:00:00.000Z" }),
    run("run-conversation-new", { threadId: "thread-new", cwd: "/workspace/ling-stack", updatedAt: "2026-08-26T10:00:00.000Z" }),
    run("run-channel", { channelId: "channel-engineering", cwd: "/workspace/channel-worktree", updatedAt: "2026-08-27T10:00:00.000Z" }),
    run("run-private", { threadId: "direct-engineer", teammateId: "teammate-engineer", cwd: "/workspace/private-worktree", updatedAt: "2026-08-28T10:00:00.000Z" }),
    run("run-teammate-channel", { threadId: "channel-thread", channelId: "channel-engineering", teammateId: "teammate-engineer", cwd: "/workspace/channel-latest", updatedAt: "2026-08-29T10:00:00.000Z" }),
  ];

  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [channel("channel-engineering")],
    conversationThreads: threads,
    runs,
    teammates: [teammate("teammate-engineer")],
    workspaceCwd: "/workspace/default",
  }), [
    {
      key: sidebarObjectContextKey("channel", "channel-engineering"),
      activityAt: "2026-08-29T10:00:00.000Z",
      cwd: "/workspace/channel-latest",
    },
    {
      key: sidebarObjectContextKey("private_chat", "teammate-engineer"),
      activityAt: "2026-08-28T10:00:00.000Z",
      cwd: "/workspace/private-worktree",
    },
    {
      key: sidebarObjectContextKey("conversation", "thread-new"),
      activityAt: "2026-08-26T10:00:00.000Z",
      cwd: "/workspace/ling-stack",
    },
    {
      key: sidebarObjectContextKey("conversation", "thread-old"),
      activityAt: "2026-08-25T00:00:00.000Z",
    },
  ]);
});

test("channels fall back through workspace binding without inventing private-chat context", () => {
  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [{
      ...channel("channel-engineering"),
      workspaceBinding: {
        mode: "managed_worktree",
        status: "ready",
        worktreePath: "/workspace/channel-binding",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
    }],
    conversationThreads: [],
    runs: [],
    teammates: [teammate("teammate-engineer")],
    workspaceCwd: "/workspace/default",
  }), [
    {
      key: sidebarObjectContextKey("channel", "channel-engineering"),
      activityAt: "2026-08-26T00:00:00.000Z",
      cwd: "/workspace/channel-binding",
    },
    {
      key: sidebarObjectContextKey("private_chat", "teammate-engineer"),
      activityAt: "2026-08-26T00:00:00.000Z",
    },
  ]);
});

test("channels do not inherit the global workspace as Git context", () => {
  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [{
      ...channel("channel-engineering"),
      boundPath: "/workspace/default",
    }],
    conversationThreads: [],
    runs: [],
    teammates: [],
    workspaceCwd: "/workspace/default",
  }), [
    {
      key: sidebarObjectContextKey("channel", "channel-engineering"),
      activityAt: "2026-08-26T00:00:00.000Z",
    },
  ]);
});

test("channels may use an explicit bound path that differs from the global workspace", () => {
  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [{
      ...channel("channel-engineering"),
      boundPath: "/workspace/channel-explicit",
    }],
    conversationThreads: [],
    runs: [],
    teammates: [],
    workspaceCwd: "/workspace/default/",
  }), [
    {
      key: sidebarObjectContextKey("channel", "channel-engineering"),
      activityAt: "2026-08-26T00:00:00.000Z",
      cwd: "/workspace/channel-explicit",
    },
  ]);
});

test("channel bindings outrank historical runs from the shared workspace", () => {
  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [{
      ...channel("channel-engineering"),
      boundPath: "/workspace/default",
      workspaceBinding: {
        mode: "managed_worktree",
        status: "ready",
        executionPath: "/workspace/channel-binding",
        worktreePath: "/workspace/channel-binding",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
    }],
    conversationThreads: [],
    runs: [run("run-channel-global", {
      channelId: "channel-engineering",
      cwd: "/workspace/default",
      updatedAt: "2026-08-27T00:00:00.000Z",
    })],
    teammates: [],
    workspaceCwd: "/workspace/default",
  }), [
    {
      key: sidebarObjectContextKey("channel", "channel-engineering"),
      activityAt: "2026-08-27T00:00:00.000Z",
      cwd: "/workspace/channel-binding",
    },
  ]);
});

test("private chats and conversations do not project shared-workspace runs as object Git", () => {
  assert.deepEqual(buildSidebarObjectContextSeeds({
    channels: [],
    conversationThreads: [thread("thread-global", "2026-08-26T00:00:00.000Z")],
    runs: [
      run("run-conversation-global", {
        threadId: "thread-global",
        cwd: "/workspace/default/",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }),
      run("run-private-global", {
        threadId: "direct-engineer",
        teammateId: "teammate-engineer",
        cwd: "/workspace/default",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }),
    ],
    teammates: [teammate("teammate-engineer")],
    workspaceCwd: "/workspace/default",
  }), [
    {
      key: sidebarObjectContextKey("private_chat", "teammate-engineer"),
      activityAt: "2026-08-28T00:00:00.000Z",
    },
    {
      key: sidebarObjectContextKey("conversation", "thread-global"),
      activityAt: "2026-08-27T00:00:00.000Z",
    },
  ]);
});

test("Git projection hides unavailable workspaces and strips absolute paths", () => {
  assert.deepEqual(projectSidebarObjectGitContext({
    cwd: "/workspace/ling-stack/apps/web",
    state: "dirty",
    repoRoot: "/workspace/ling-stack",
    branchName: "codex/sidebar-approval-dialogs",
    additions: 0,
    deletions: 0,
    files: [],
    totalFileCount: 0,
    truncated: false,
    checkedAt: "2026-08-26T00:00:00.000Z",
  }), {
    repositoryLabel: "ling-stack",
    branchName: "codex/sidebar-approval-dialogs",
  });
  assert.equal(projectSidebarObjectGitContext({
    cwd: "/tmp/not-a-repo",
    state: "not_git_repo",
    additions: 0,
    deletions: 0,
    files: [],
    totalFileCount: 0,
    truncated: false,
    checkedAt: "2026-08-26T00:00:00.000Z",
  }), undefined);
});

function thread(id, activityAt) {
  return {
    id,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: id,
    objective: "test",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: activityAt,
    updatedAt: activityAt,
    metadata: { schemaVersion: 1, lastActivityAt: activityAt },
  };
}

function channel(id) {
  return {
    id,
    workspaceId: "workspace_default",
    name: "Engineering",
    status: "active",
    autoReplyMode: "mentions_only",
    allowedTools: [],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "workspace",
      allowReadOnlyParallel: false,
      queueOnConflict: true,
    },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function teammate(id) {
  return {
    id,
    workspaceId: "workspace_default",
    roleKey: "engineer",
    displayName: "Engineer",
    description: "test",
    modelBindingMode: "workspace_default",
    appendSystemPrompt: [],
    allowedTools: [],
    approvalProfile: "balanced",
    status: "active",
    pinned: false,
    hidden: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function run(id, { channelId, cwd, teammateId, threadId, updatedAt }) {
  return {
    id,
    status: "succeeded",
    cwd,
    taskId: `${id}-task`,
    channelId,
    teammateId,
    providerName: "test",
    providerModel: "test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `${cwd}/events.jsonl`,
    threadId,
    createdAt: updatedAt,
    updatedAt,
  };
}
