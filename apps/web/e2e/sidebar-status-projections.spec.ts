import { expect, test } from "@playwright/test";
import {
  buildSidebarChannelNotifications,
  buildSidebarConversationApprovalCounts,
  buildSidebarTeammateNotifications,
  projectSidebarConversationStatus,
} from "../src/app/sidebar-status-projections.js";
import {
  resolveRuntimeApprovalOwner,
  runtimeApprovalOwnerMatches,
} from "../src/lib/runtime-approval-ownership.js";
import type {
  AiTeammate,
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  RunSession,
  Task,
  TeammateDirectMessage,
  WorkUnit,
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
    notificationLevels: { channel_running: "all", channel_unread: "all" },
    runs,
    selectedChannelId: "",
    tasks,
    workUnits: [],
  })).toEqual({
    channel_paused: { primaryStatus: "paused" },
    channel_waiting: { count: 1, primaryStatus: "waiting" },
    channel_failed: { primaryStatus: "failed" },
    channel_running: { primaryStatus: "running" },
    channel_unread: { unread: true },
  });
});

test("channel notification levels filter activity and blockers without hiding structural state", () => {
  const tasks = [
    task("task_all_running", "channel_all_running", "running"),
    task("task_mentions_running", "channel_mentions_running", "running"),
    task("task_mentions_failed", "channel_mentions_failed", "failed"),
    task("task_muted_failed", "channel_muted_failed", "failed"),
  ];
  const runs = [
    run("run_all_running", "task_all_running", "running", "2026-07-19T00:01:00.000Z"),
    run("run_mentions_running", "task_mentions_running", "running", "2026-07-19T00:01:00.000Z"),
    run("run_mentions_failed", "task_mentions_failed", "failed", "2026-07-19T00:01:00.000Z"),
    run("run_muted_failed", "task_muted_failed", "failed", "2026-07-19T00:01:00.000Z"),
  ];
  const channels = [
    channel("channel_all_running"),
    channel("channel_mentions_running"),
    channel("channel_mentions_failed"),
    channel("channel_mentions_approval"),
    channel("channel_muted_failed"),
    channel("channel_muted_regular"),
    channel("channel_muted_critical"),
    channel("channel_muted_paused", "paused"),
  ];

  expect(buildSidebarChannelNotifications({
    approvals: [
      { ...approval("approval_mentions", "task_missing"), channelId: "channel_mentions_approval" },
      { ...approval("approval_muted_regular", "task_missing"), channelId: "channel_muted_regular" },
      { ...approval("approval_muted_critical", "task_missing"), channelId: "channel_muted_critical", risk: "critical" },
    ],
    channels,
    channelUnreadById: {},
    notificationLevels: {
      channel_all_running: "all",
      channel_mentions_running: "mentions",
      channel_mentions_failed: "mentions",
      channel_mentions_approval: "mentions",
      channel_muted_failed: "muted",
      channel_muted_regular: "muted",
      channel_muted_critical: "muted",
      channel_muted_paused: "muted",
    },
    runs,
    selectedChannelId: "",
    tasks,
    workUnits: [],
  })).toEqual({
    channel_all_running: { primaryStatus: "running" },
    channel_mentions_failed: { primaryStatus: "failed" },
    channel_mentions_approval: { count: 1, primaryStatus: "waiting" },
    channel_muted_critical: { count: 1, primaryStatus: "waiting" },
    channel_muted_paused: { primaryStatus: "paused" },
  });
});

test("teammate projection uses real assignment signals without inventing idle status", () => {
  const tasks = [
    task("task_waiting", "channel_1", "running", "teammate_waiting"),
    task("task_failed", "channel_1", "failed", "teammate_failed"),
    task("task_running", "channel_1", "running", "teammate_running"),
  ];

  expect(buildSidebarTeammateNotifications({
    approvals: [{ ...approval("approval_waiting", "task_waiting"), taskId: undefined, runId: "run_direct_waiting" }],
    runs: [
      run("run_failed", "task_failed", "failed", "2026-07-19T00:01:00.000Z"),
      {
        ...run("run_direct_waiting", "task_waiting", "waiting_for_approval", "2026-07-19T00:02:00.000Z"),
        teammateId: "teammate_waiting",
        threadId: "thread_direct_waiting",
      },
    ],
    tasks,
    teammates: [
      teammate("teammate_paused", "paused"),
      teammate("teammate_waiting"),
      teammate("teammate_failed"),
      teammate("teammate_running"),
      teammate("teammate_idle"),
    ],
    workUnits: [],
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
  expect(projectSidebarConversationStatus("failed", false, true)).toBe("waiting");
  expect(projectSidebarConversationStatus("failed", false, false, true)).toBeUndefined();
  expect(projectSidebarConversationStatus("blocked", false, false, true)).toBeUndefined();
  expect(projectSidebarConversationStatus("running", false, false, true)).toBe("running");
});

test("conversation approval ownership follows approval run to its thread", () => {
  const runs = [
    { ...run("run_conversation", "task_1", "waiting_for_approval", "2026-07-19T00:02:00.000Z"), teammateId: "ling_agent", threadId: "thread_owner", workUnitId: "work_unit_conversation" },
    { ...run("run_other", "task_1", "running", "2026-07-19T00:03:00.000Z"), threadId: "thread_other" },
  ];
  const approvals = [
    { ...approval("approval_owner", "task_1"), runId: "run_conversation" },
    { ...approval("approval_duplicate_owner", "task_1"), runId: "run_conversation" },
    { ...approval("approval_without_run", "task_1"), runId: undefined },
  ];

  expect([...buildSidebarConversationApprovalCounts(approvals, runs, [
    workUnit("work_unit_conversation", "conversation_run", "run_conversation", "ling_agent"),
  ])]).toEqual([
    ["thread_owner", 2],
  ]);
  expect(buildSidebarTeammateNotifications({
    approvals,
    runs,
    tasks: [],
    teammates: [teammate("ling_agent")],
    workUnits: [workUnit("work_unit_conversation", "conversation_run", "run_conversation", "ling_agent")],
  })).toEqual({});
});

test("runtime approval ownership follows explicit, run, task, workflow, and payload lineage", () => {
  const ownershipRuns = [
    { ...run("run_channel", "task_1", "running", "2026-07-19T00:01:00.000Z"), channelId: "channel_run", threadId: "thread_channel" },
    { ...run("run_direct", "task_1", "running", "2026-07-19T00:02:00.000Z"), teammateId: "teammate_direct", threadId: "thread_direct", workUnitId: "work_unit_direct" },
    { ...run("run_conversation", "task_1", "running", "2026-07-19T00:03:00.000Z"), teammateId: "ling_agent", threadId: "thread_conversation", workUnitId: "work_unit_conversation" },
  ];
  const ownershipContext = {
    runs: ownershipRuns,
    tasks: [task("task_channel", "channel_task", "running")],
    workflowSteps: [workflowStep("step_channel", "channel_workflow")],
    workUnits: [
      workUnit("work_unit_direct", "teammate_direct_reply", "run_direct", "teammate_direct"),
      workUnit("work_unit_conversation", "conversation_run", "run_conversation", "ling_agent"),
    ],
  };

  expect(resolveRuntimeApprovalOwner({
    ...approval("approval_explicit", "task_channel"),
    channelId: "channel_explicit",
    runId: "run_direct",
  }, ownershipContext)).toEqual({ kind: "channel", channelId: "channel_explicit" });
  expect(resolveRuntimeApprovalOwner({ ...approval("approval_run", "task_missing"), runId: "run_channel" }, ownershipContext))
    .toEqual({ kind: "channel", channelId: "channel_run" });
  expect(resolveRuntimeApprovalOwner({ ...approval("approval_direct", "task_missing"), runId: "run_direct" }, ownershipContext))
    .toEqual({ kind: "teammate_direct", teammateId: "teammate_direct", threadId: "thread_direct" });
  expect(resolveRuntimeApprovalOwner({ ...approval("approval_conversation", "task_missing"), runId: "run_conversation" }, ownershipContext))
    .toEqual({ kind: "normal_conversation", threadId: "thread_conversation" });
  expect(resolveRuntimeApprovalOwner(approval("approval_task", "task_channel"), ownershipContext))
    .toEqual({ kind: "channel", channelId: "channel_task" });
  expect(resolveRuntimeApprovalOwner({ ...approval("approval_workflow", "task_missing"), workflowStepId: "step_channel" }, ownershipContext))
    .toEqual({ kind: "channel", channelId: "channel_workflow" });
  expect(resolveRuntimeApprovalOwner({
    ...approval("approval_payload", "task_missing"),
    payload: { requestedByRunId: "run_conversation" },
  }, ownershipContext)).toEqual({ kind: "normal_conversation", threadId: "thread_conversation" });
  expect(resolveRuntimeApprovalOwner(approval("approval_unknown", "task_missing"), ownershipContext)).toBeUndefined();
});

test("runtime approval owner matching is exact for channel, conversation, and private thread", () => {
  expect(runtimeApprovalOwnerMatches(
    { kind: "channel", channelId: "channel_1" },
    { kind: "channel", channelId: "channel_2" },
  )).toBe(false);
  expect(runtimeApprovalOwnerMatches(
    { kind: "normal_conversation", threadId: "thread_1" },
    { kind: "normal_conversation", threadId: "thread_1" },
  )).toBe(true);
  expect(runtimeApprovalOwnerMatches(
    { kind: "teammate_direct", teammateId: "teammate_1", threadId: "thread_1" },
    { kind: "teammate_direct", teammateId: "teammate_1", threadId: "thread_2" },
  )).toBe(false);
});

test("teammate approval maps its execution thread through direct-message lineage", () => {
  const runItem = {
    ...run("run_direct_mapped", "task_1", "waiting_for_approval", "2026-07-19T00:04:00.000Z"),
    teammateId: "teammate_direct",
    threadId: "thread_execution",
    workUnitId: "work_unit_direct_mapped",
  };
  const unit = {
    ...workUnit("work_unit_direct_mapped", "teammate_direct_reply", runItem.id, "teammate_direct"),
    ownerType: "teammate_direct_message",
    ownerId: "direct_source",
    linkedMessageId: "direct_reply",
    request: { sourceMessageId: "direct_source" },
  };
  const messages = [
    directMessage("direct_source", "dm_thread_owner", "teammate_direct"),
    { ...directMessage("direct_reply", "dm_thread_owner", "teammate_direct"), linkedRunId: runItem.id },
  ];

  expect(resolveRuntimeApprovalOwner(
    { ...approval("approval_direct_mapped", "task_1"), runId: runItem.id },
    { runs: [runItem], workUnits: [unit], teammateDirectMessages: messages },
  )).toEqual({ kind: "teammate_direct", teammateId: "teammate_direct", threadId: "dm_thread_owner" });
  expect(resolveRuntimeApprovalOwner(
    { ...approval("approval_direct_conflict", "task_1"), runId: runItem.id },
    {
      runs: [runItem],
      workUnits: [unit],
      teammateDirectMessages: [messages[0], { ...messages[1], threadId: "dm_thread_other" }],
    },
  )).toBeUndefined();
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

function workUnit(
  id: string,
  kind: WorkUnit["kind"],
  linkedRunId: string,
  teammateId?: string,
): WorkUnit {
  return {
    id,
    workspaceId: "workspace_default",
    kind,
    ownerType: kind === "conversation_run" ? "conversation_turn" : "teammate_direct_message",
    ownerId: `${id}_owner`,
    teammateId,
    idempotencyKey: id,
    status: "waiting_for_approval",
    priority: 0,
    attemptCount: 1,
    createdByActor: "user",
    request: {},
    timeoutPolicy: {
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 45_000,
      idleTimeoutMs: 600_000,
      hardTimeoutMs: 3_600_000,
      cancelGraceMs: 15_000,
    },
    linkedRunId,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function directMessage(id: string, threadId: string, teammateId: string): TeammateDirectMessage {
  return {
    id,
    workspaceId: "workspace_default",
    threadId,
    teammateId,
    authorType: "local-user",
    body: id,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function workflowStep(id: string, channelId: string): ChannelWorkflowStep {
  return {
    id,
    workspaceId: "workspace_default",
    channelId,
    workflowId: "workflow_1",
    position: 0,
    title: id,
    prompt: id,
    toParticipantId: "teammate_1",
    toParticipantLabel: "Teammate 1",
    participantAuthority: {
      schemaVersion: 1,
      kind: "channel_selection",
      origin: "channel_intent_proposal",
      participantId: "teammate_1",
      sourceId: "source_1",
      fingerprint: "fingerprint_1",
    },
    status: "waiting_for_approval",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function approval(id: string, taskId: string): ApprovalRequest {
  return {
    id, taskId, actionType: "bash", risk: "medium", title: id, description: id, payload: {},
    status: "pending", createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-07-19T00:00:00.000Z",
  };
}
