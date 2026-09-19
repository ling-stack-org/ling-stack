import { expect, test } from "@playwright/test";
import {
  buildSidebarChannelNotifications,
  buildSidebarTeammateNotifications,
  projectSidebarConversationStatus,
} from "../src/app/sidebar-status-projections.js";
import type {
  AiTeammate,
  ApprovalRequest,
  Channel,
  RunSession,
  Task,
} from "../src/types.js";

test("channel projection exposes one primary state and keeps unread as the fallback", () => {
  const tasks = [
    task("task_waiting", "channel_waiting", "running"),
    task("task_failed", "channel_failed", "failed"),
    task("task_running", "channel_running", "running"),
    task("task_resolved", "channel_resolved", "done"),
  ];
  const runs = [
    run("run_failed", "task_failed", "failed", "2026-07-19T00:01:00.000Z"),
    run("run_running", "task_running", "running", "2026-07-19T00:02:00.000Z"),
    run("run_resolved_old", "task_resolved", "failed", "2026-07-19T00:01:00.000Z"),
    run("run_resolved_new", "task_resolved", "succeeded", "2026-07-19T00:03:00.000Z"),
  ];
  const channels = [
    channel("channel_paused", "paused"),
    channel("channel_waiting"),
    channel("channel_failed"),
    channel("channel_running"),
    channel("channel_unread"),
    channel("channel_resolved"),
  ];

  expect(buildSidebarChannelNotifications({
    approvals: [approval("approval_waiting", "task_waiting")],
    channels,
    channelUnreadById: { channel_unread: { unread: true, mentioned: false } },
    notificationLevels: { channel_unread: "all" },
    runs,
    selectedChannelId: "",
    tasks,
  })).toEqual({
    channel_paused: { primaryStatus: "paused" },
    channel_waiting: { count: 1, primaryStatus: "waiting" },
    channel_failed: { primaryStatus: "failed" },
    channel_running: { primaryStatus: "running" },
    channel_unread: { unread: true },
  });
});

test("teammate projection uses real assignment signals without inventing idle status", () => {
  const tasks = [
    task("task_waiting", "channel_1", "running", "teammate_waiting"),
    task("task_failed", "channel_1", "failed", "teammate_failed"),
    task("task_running", "channel_1", "running", "teammate_running"),
  ];

  expect(buildSidebarTeammateNotifications({
    approvals: [approval("approval_waiting", "task_waiting")],
    runs: [run("run_failed", "task_failed", "failed", "2026-07-19T00:01:00.000Z")],
    tasks,
    teammates: [
      teammate("teammate_paused", "paused"),
      teammate("teammate_waiting"),
      teammate("teammate_failed"),
      teammate("teammate_running"),
      teammate("teammate_idle"),
    ],
  })).toEqual({
    teammate_paused: { primaryStatus: "paused" },
    teammate_waiting: { count: 1, primaryStatus: "waiting" },
    teammate_failed: { primaryStatus: "failed" },
    teammate_running: { primaryStatus: "running" },
  });
});

test("conversation projection preserves actionable thread state across refresh", () => {
  expect(projectSidebarConversationStatus("waiting_for_approval", false)).toBe("waiting");
  expect(projectSidebarConversationStatus("blocked", false)).toBe("failed");
  expect(projectSidebarConversationStatus("failed", false)).toBe("failed");
  expect(projectSidebarConversationStatus("running", false)).toBe("running");
  expect(projectSidebarConversationStatus("open", true)).toBe("running");
  expect(projectSidebarConversationStatus("succeeded", false)).toBeUndefined();
});

function channel(id: string, status: Channel["status"] = "active"): Channel {
  return {
    id, workspaceId: "workspace_default", name: id, status, autoReplyMode: "mentions_only",
    allowedTools: [], runtimePolicy: {
      maxConcurrentRuns: 1, schedulingMode: "smart", writeLockScope: "boundPath",
      allowReadOnlyParallel: true, queueOnConflict: true,
    }, createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function teammate(id: string, status: AiTeammate["status"] = "active"): AiTeammate {
  return {
    id, workspaceId: "workspace_default", roleKey: "custom", displayName: id, description: id,
    appendSystemPrompt: [], allowedTools: [], approvalProfile: { mode: "standard" }, status,
    pinned: true, hidden: false, createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function task(id: string, channelId: string, status: Task["status"], assigneeTeammateId?: string): Task {
  return {
    id, workspaceId: "workspace_default", channelId, title: id, prompt: id, status,
    assigneeTeammateId, attachmentIds: [], createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function run(id: string, taskId: string, status: RunSession["status"], updatedAt: string): RunSession {
  return {
    id, status, cwd: "/tmp/workspace", taskId, providerName: "local", providerModel: "gpt-test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: `${id}.jsonl`,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt,
  };
}

function approval(id: string, taskId: string): ApprovalRequest {
  return {
    id, taskId, actionType: "bash", risk: "medium", title: id, description: id, payload: {},
    status: "pending", createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-07-19T00:00:00.000Z",
  };
}
