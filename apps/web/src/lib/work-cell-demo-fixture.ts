import type { ChannelMessage, ChannelWorkflow, ChannelWorkflowStep, ExecutionAction, MemoryObject, PreviewContentKind, PreviewContentResponse, RunArtifact, RunSession, TerminalReportDto, UsedMemoryEvent, WorkflowWorkspaceChangesResponse } from "../types.js";
import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import type { PreviewRequest } from "./previews.js";

export const channelWorkCellDemoStorageKey = "ling-stack.workCellDemo";

export interface ChannelWorkCellDemoFixture {
  readonly channelMessages: readonly ChannelMessage[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly memoryObjects: readonly MemoryObject[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly terminalReports: readonly TerminalReportDto[];
}

const channelWorkCellDemoArtifactPrefix = "demo_work_cell_";
const channelWorkCellDemoRecoveryStateByWorkflowId = new Map<string, "applied" | "undone">();

function demoParticipantAuthority(workflowId: string, participantId: string) {
  return createWorkflowParticipantAuthorityV1({
    kind: "workflow_definition",
    origin: "workflow_graph",
    participantId,
    sourceId: workflowId,
  });
}

export function channelWorkCellDemoFixtureEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return window.localStorage.getItem(channelWorkCellDemoStorageKey) === "true" ||
      params.get("workCellDemo") === "1" ||
      params.get("lingWorkCellDemo") === "true";
  } catch {
    return false;
  }
}

export function channelWorkCellDemoWorkflowRecovery(input: {
  readonly cwd: string;
  readonly workflowId: string;
  readonly action?: "undo" | "reapply";
}): WorkflowWorkspaceChangesResponse | undefined {
  if (!channelWorkCellInteractiveDemoEnabled() || !input.workflowId.startsWith(channelWorkCellDemoArtifactPrefix)) {
    return undefined;
  }
  if (input.action) {
    channelWorkCellDemoRecoveryStateByWorkflowId.set(input.workflowId, input.action === "undo" ? "undone" : "applied");
  }
  const state = channelWorkCellDemoRecoveryStateByWorkflowId.get(input.workflowId) ?? "applied";
  const idPrefix = input.workflowId.endsWith("_workflow")
    ? input.workflowId.slice(0, -"_workflow".length)
    : input.workflowId;
  return {
    cwd: input.cwd,
    workflowId: input.workflowId,
    runIds: [
      `${idPrefix}_run_engineer`,
      `${idPrefix}_run_qa`,
      `${idPrefix}_run_engineer_followup`,
    ],
    state,
    canUndo: state === "applied",
    canReapply: state === "undone",
    files: [],
    summary: {
      fileCount: 5,
      addCount: 0,
      updateCount: 5,
      deleteCount: 0,
      moveCount: 0,
      addedLines: 15,
      removedLines: 4,
    },
    updatedAt: new Date().toISOString(),
  };
}

function channelWorkCellInteractiveDemoEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("workCellDemo") === "1" || params.get("lingWorkCellDemo") === "true";
  } catch {
    return false;
  }
}

export function createChannelWorkCellDemoFixture(input: {
  readonly channelId: string;
  readonly cwd: string;
}): ChannelWorkCellDemoFixture | undefined {
  const channelId = input.channelId.trim();
  if (!channelId) {
    return undefined;
  }

  const workspaceId = "workspace_default";
  const idPrefix = `${channelWorkCellDemoArtifactPrefix}${safeId(channelId)}`;
  const discussionMessageId = `${idPrefix}_message_discussion`;
  const sourceMessageId = `${idPrefix}_message_request`;
  const terminalReportId = `${idPrefix}_terminal_report`;
  const terminalMessageId = `message_${terminalReportId}`;
  const workflowId = `${idPrefix}_workflow`;
  const runArchitectId = `${idPrefix}_run_architect`;
  const runDesignerId = `${idPrefix}_run_designer`;
  const runEngineerId = `${idPrefix}_run_engineer`;
  const runQaId = `${idPrefix}_run_qa`;
  const runEngineerFollowupId = `${idPrefix}_run_engineer_followup`;
  const stepArchitectId = `${idPrefix}_step_architect`;
  const stepDesignerId = `${idPrefix}_step_designer`;
  const stepEngineerId = `${idPrefix}_step_engineer`;
  const stepQaId = `${idPrefix}_step_qa`;
  const stepEngineerFollowupId = `${idPrefix}_step_engineer_followup`;
  const startedAt = "2026-07-10T09:12:00.000Z";
  const completedAt = "2026-07-10T09:14:18.000Z";

  const workflow: ChannelWorkflow = {
    id: workflowId,
    workspaceId,
    channelId,
    title: "频道 work-cell 操作记录样例",
    objective: "主要任务：把多 agent 操作记录接入频道会话，并验证折叠、展开、命令、编辑和二次收口展示。",
    status: "succeeded",
    createdBy: "local-user",
    metadata: { responseLanguage: "zh-CN", sourceMessageId },
    createdAt: startedAt,
    updatedAt: completedAt,
  };

  const channelMessages: ChannelMessage[] = [
    {
      id: discussionMessageId,
      workspaceId,
      channelId,
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "local-user",
      body: "讨论一下：多 Agent 讨论问题时，应该保留每位专家的独立观点，还是只显示 Ling Agent 的统一结论？",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-10T09:10:00.000Z",
      updatedAt: "2026-07-10T09:10:00.000Z",
    },
    demoDiscussionReply({
      id: `${idPrefix}_message_discussion_architect`,
      workspaceId,
      channelId,
      threadId: discussionMessageId,
      authorId: "teammate_builtin_architect",
      body: "从信息结构看，讨论阶段应该保留各自观点。不同专家的判断依据可能冲突，这些差异本身就是讨论价值；只有进入执行决策时，才需要由 Ling Agent 收口。",
      createdAt: "2026-07-10T09:10:08.000Z",
    }),
    demoDiscussionReply({
      id: `${idPrefix}_message_discussion_designer`,
      workspaceId,
      channelId,
      threadId: discussionMessageId,
      authorId: "teammate_builtin_designer",
      body: "界面上直接使用普通会话行最清晰：头像、名字、观点正文依次出现，不增加状态卡片。用户可以快速判断是谁提出了什么意见。",
      createdAt: "2026-07-10T09:10:16.000Z",
    }),
    demoDiscussionReply({
      id: `${idPrefix}_message_discussion_engineer`,
      workspaceId,
      channelId,
      threadId: discussionMessageId,
      authorId: "teammate_builtin_engineer",
      body: "实现上讨论回复和普通频道消息完全一致，不创建 workflow、run 或操作记录。只有用户确认要执行后，才切换到下面这种 work-cell 展示。",
      createdAt: "2026-07-10T09:10:24.000Z",
    }),
    demoDiscussionReply({
      id: `${idPrefix}_message_discussion_qa`,
      workspaceId,
      channelId,
      threadId: discussionMessageId,
      authorId: "teammate_builtin_qa",
      body: "我建议保留独立回复，同时限制可见参与人数。需要验证的重点是：不能把未参与的 Agent 算进去，也不能让讨论状态与执行完成状态混在一起。",
      createdAt: "2026-07-10T09:10:32.000Z",
    }),
    {
      id: sourceMessageId,
      workspaceId,
      channelId,
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "local-user",
      body: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-10T09:11:55.000Z",
      updatedAt: "2026-07-10T09:11:55.000Z",
    },
    {
      id: terminalMessageId,
      workspaceId,
      channelId,
      threadId: sourceMessageId,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "完成：「频道 work-cell 操作记录样例」。\n结果：主要任务已完成：频道已接入本地多 agent 操作记录样例，并保持完成后折叠展示。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-10T09:14:19.000Z",
      updatedAt: "2026-07-10T09:14:19.000Z",
    },
  ];
  const memoryObjects: MemoryObject[] = [{
    id: `${idPrefix}_memory_reference_rule`,
    workspaceId,
    scopeType: "channel",
    ownerId: channelId,
    title: "完成态引用展示规则",
    body: "完成态顶部只保留引用，消息下方继续显示已使用记忆。",
    tags: ["work-cell-demo"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    verifyBeforeUse: false,
    sensitivity: "normal",
    createdAt: "2026-07-10T09:10:00.000Z",
    updatedAt: "2026-07-10T09:10:00.000Z",
  }];
  const usedMemoryEvents: UsedMemoryEvent[] = [{
    id: `${idPrefix}_used_memory_reference_rule`,
    workspaceId,
    memoryIds: memoryObjects.map((memory) => memory.id),
    intent: "channel-reply",
    recallQuery: "完成态引用展示",
    responseId: terminalMessageId,
    policyVersion: "ling-memory-v1-lexical",
    createdAt: "2026-07-10T09:14:18.000Z",
  }];

  const workflowSteps: ChannelWorkflowStep[] = [
    {
      id: stepArchitectId,
      workspaceId,
      channelId,
      workflowId,
      position: 1,
      title: "审查频道投影链路",
      prompt: "确认 workflow、step、run、action、artifact 如何进入频道会话投影。",
      toParticipantId: "architect",
      toParticipantLabel: "Architect",
      participantAuthority: demoParticipantAuthority(workflowId, "architect"),
      status: "succeeded",
      resultSummary: "确认频道工作记录应从现有 workflow progress 投影渲染。",
      createdAt: "2026-07-10T09:12:03.000Z",
      updatedAt: "2026-07-10T09:12:28.000Z",
      runId: runArchitectId,
    },
    {
      id: stepDesignerId,
      workspaceId,
      channelId,
      workflowId,
      position: 2,
      title: "审阅界面一致性",
      prompt: "确认操作记录不使用气泡，悬停时提升对比度，展开只影响自己的行。",
      toParticipantId: "designer",
      toParticipantLabel: "Designer",
      participantAuthority: demoParticipantAuthority(workflowId, "designer"),
      status: "succeeded",
      resultSummary: "确认 read/search 行保持简约，代码和命令只在展开细节里展示。",
      createdAt: "2026-07-10T09:12:16.000Z",
      updatedAt: "2026-07-10T09:12:45.000Z",
      runId: runDesignerId,
    },
    {
      id: stepEngineerId,
      workspaceId,
      channelId,
      workflowId,
      position: 3,
      title: "实现操作记录展示",
      prompt: "接入工作记录行、编辑记录、命令记录和完成后的折叠摘要。",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      participantAuthority: demoParticipantAuthority(workflowId, "engineer"),
      status: "succeeded",
      resultSummary: "完成频道 work-cell 操作记录投影。",
      createdAt: "2026-07-10T09:12:46.000Z",
      updatedAt: "2026-07-10T09:13:32.000Z",
      runId: runEngineerId,
    },
    {
      id: stepQaId,
      workspaceId,
      channelId,
      workflowId,
      position: 4,
      title: "验证频道样例",
      prompt: "验证频道中多 agent 操作记录可以折叠、展开，并且命令细节不会默认打断阅读。",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      participantAuthority: demoParticipantAuthority(workflowId, "qa"),
      status: "succeeded",
      resultSummary: "通过频道工作记录样例回归。",
      createdAt: "2026-07-10T09:13:33.000Z",
      updatedAt: "2026-07-10T09:14:02.000Z",
      runId: runQaId,
    },
    {
      id: stepEngineerFollowupId,
      workspaceId,
      channelId,
      workflowId,
      position: 5,
      title: "根据 QA 反馈收口",
      prompt: "补齐本地样例记录和设计文档，保持第二轮动作在新位置单独展示。",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      participantAuthority: demoParticipantAuthority(workflowId, "engineer"),
      status: "succeeded",
      resultSummary: "主要任务已完成：频道已接入本地多 agent 操作记录样例，并保持完成后折叠展示。",
      createdAt: "2026-07-10T09:14:03.000Z",
      updatedAt: completedAt,
      runId: runEngineerFollowupId,
    },
  ];

  const runs: RunSession[] = [
    demoRun({ id: runArchitectId, channelId, cwd: input.cwd, taskId: `${idPrefix}_task_architect`, workflowStepId: stepArchitectId, teammateId: "architect", title: "审查频道投影链路", createdAt: "2026-07-10T09:12:03.000Z", endedAt: "2026-07-10T09:12:28.000Z" }),
    demoRun({ id: runDesignerId, channelId, cwd: input.cwd, taskId: `${idPrefix}_task_designer`, workflowStepId: stepDesignerId, teammateId: "designer", title: "审阅界面一致性", createdAt: "2026-07-10T09:12:16.000Z", endedAt: "2026-07-10T09:12:45.000Z" }),
    demoRun({ id: runEngineerId, channelId, cwd: input.cwd, taskId: `${idPrefix}_task_engineer`, workflowStepId: stepEngineerId, teammateId: "engineer", title: "实现操作记录展示", createdAt: "2026-07-10T09:12:46.000Z", endedAt: "2026-07-10T09:13:32.000Z" }),
    demoRun({ id: runQaId, channelId, cwd: input.cwd, taskId: `${idPrefix}_task_qa`, workflowStepId: stepQaId, teammateId: "qa", title: "验证频道样例", createdAt: "2026-07-10T09:13:33.000Z", endedAt: "2026-07-10T09:14:02.000Z" }),
    demoRun({ id: runEngineerFollowupId, channelId, cwd: input.cwd, taskId: `${idPrefix}_task_engineer_followup`, workflowStepId: stepEngineerFollowupId, teammateId: "engineer", title: "根据 QA 反馈收口", createdAt: "2026-07-10T09:14:03.000Z", endedAt: completedAt }),
  ];

  const artifactEngineerDiff: RunArtifact = {
    id: `${idPrefix}_artifact_engineer_diff`,
    runId: runEngineerId,
    type: "diff",
    path: "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx",
    title: "ConversationWorkCell.tsx",
    contentType: "text/x-diff",
    sizeBytes: 1842,
    createdAt: "2026-07-10T09:13:20.000Z",
  };
  const artifactEngineerCss: RunArtifact = {
    id: `${idPrefix}_artifact_engineer_css`,
    runId: runEngineerId,
    type: "diff",
    path: "apps/web/src/styles/components.css",
    title: "components.css",
    contentType: "text/x-diff",
    sizeBytes: 1168,
    createdAt: "2026-07-10T09:13:24.000Z",
  };
  const artifactQaLog: RunArtifact = {
    id: `${idPrefix}_artifact_qa_log`,
    runId: runQaId,
    type: "log",
    path: "tmp/ling-work-cell-demo/channel-work-cell-e2e.log",
    title: "channel-work-cell-e2e.log",
    contentType: "text/plain; charset=utf-8",
    sizeBytes: 924,
    createdAt: "2026-07-10T09:14:01.000Z",
  };
  const artifactQaSpecDiff: RunArtifact = {
    id: `${idPrefix}_artifact_qa_spec_diff`,
    runId: runQaId,
    type: "diff",
    path: "apps/web/e2e/channel.spec.ts",
    title: "channel.spec.ts",
    contentType: "text/x-diff",
    sizeBytes: 742,
    createdAt: "2026-07-10T09:14:02.000Z",
  };
  const artifactDocDiff: RunArtifact = {
    id: `${idPrefix}_artifact_doc_diff`,
    runId: runEngineerFollowupId,
    type: "diff",
    path: "docs/design/conversation-work-cell-operation-records.md",
    title: "conversation-work-cell-operation-records.md",
    contentType: "text/x-diff",
    sizeBytes: 956,
    createdAt: "2026-07-10T09:14:14.000Z",
  };
  const artifactDoc: RunArtifact = {
    id: `${idPrefix}_artifact_doc`,
    runId: runEngineerFollowupId,
    type: "markdown",
    path: "docs/design/conversation-work-cell-operation-records.md",
    title: "conversation-work-cell-operation-records.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 1320,
    createdAt: "2026-07-10T09:14:15.000Z",
  };
  const artifactI18nDiff: RunArtifact = {
    id: `${idPrefix}_artifact_i18n_diff`,
    runId: runEngineerFollowupId,
    type: "diff",
    path: "apps/web/src/i18n/locales/zh-CN.ts",
    title: "zh-CN.ts",
    contentType: "text/x-diff",
    sizeBytes: 386,
    createdAt: "2026-07-10T09:14:16.000Z",
  };
  const terminalReport: TerminalReportDto = {
    schemaVersion: 1,
    id: terminalReportId,
    workspaceId,
    channelId,
    threadId: sourceMessageId,
    sourceMessageId,
    source: { kind: "workflow", id: workflowId },
    status: "committed",
    language: "zh-CN",
    outcome: {
      status: "succeeded",
      title: "多 Agent 操作记录已接入频道会话",
      summary: "频道现在会保留 Architect、Designer、Engineer 和 QA 的真实操作过程，并在完成后展示结构化总结。",
      corrections: [],
      sourceRefs: [{ kind: "workflow", id: workflowId, label: workflow.title, visibility: "conversation" }],
    },
    changes: [
      {
        id: `${terminalReportId}_change_ui`,
        kind: "behavior",
        title: "重构操作记录展示",
        summary: "过程记录逐行流式展示，完成总结位于过程 shell 外部，artifact 位于总结下方。",
        paths: ["apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx", "apps/web/src/styles/components.css"],
        addedLines: 142,
        deletedLines: 18,
        sourceRefs: [{ kind: "artifact", id: artifactEngineerDiff.id, label: artifactEngineerDiff.title, visibility: "conversation" }],
      },
      {
        id: `${terminalReportId}_change_docs`,
        kind: "documentation",
        title: "记录会话组件规则",
        summary: "补充完成态、引用和第二轮 Agent 操作的展示约束。",
        paths: ["docs/design/conversation-work-cell-operation-records.md"],
        addedLines: 36,
        deletedLines: 0,
        sourceRefs: [{ kind: "artifact", id: artifactDoc.id, label: artifactDoc.title, visibility: "conversation" }],
      },
    ],
    verification: [
      {
        id: `${terminalReportId}_check_typecheck`,
        title: "Web typecheck",
        status: "passed",
        command: "corepack pnpm --filter @ling-stack/web typecheck",
        summary: "会话投影与组件类型检查通过。",
        sourceRefs: [],
      },
      {
        id: `${terminalReportId}_check_e2e`,
        title: "频道 work-cell E2E",
        status: "passed",
        command: "playwright test apps/web/e2e/channel.spec.ts -g work-cell",
        summary: "完成态、逐项展开和 artifact 预览通过。",
        sourceRefs: [{ kind: "artifact", id: artifactQaLog.id, label: artifactQaLog.title, visibility: "folded_evidence" }],
      },
    ],
    participants: [
      { agentId: "architect", displayName: "Architect", status: "completed", contribution: "确认 workflow、run、action 和 artifact 的会话投影边界。", sourceRefs: [] },
      { agentId: "designer", displayName: "Designer", status: "completed", contribution: "收紧无气泡、低噪音和悬停反馈的视觉规则。", sourceRefs: [] },
      { agentId: "engineer", displayName: "Engineer", status: "completed", contribution: "完成组件、样式和第二轮文档收口。", sourceRefs: [] },
      { agentId: "qa", displayName: "QA", status: "completed", contribution: "验证频道真实路径、完成态折叠和 artifact 预览。", sourceRefs: [] },
    ],
    artifacts: [
      {
        id: artifactEngineerDiff.id,
        kind: "diff",
        title: artifactEngineerDiff.title ?? "ConversationWorkCell.tsx",
        path: artifactEngineerDiff.path,
        addedLines: 142,
        deletedLines: 18,
        sourceRefs: [{ kind: "file", id: artifactEngineerDiff.path, label: artifactEngineerDiff.title, visibility: "conversation" }],
      },
      {
        id: artifactDoc.id,
        kind: "document",
        title: artifactDoc.title ?? "conversation-work-cell-operation-records.md",
        path: artifactDoc.path,
        sourceRefs: [{ kind: "file", id: artifactDoc.path, label: artifactDoc.title, visibility: "conversation" }],
      },
    ],
    risks: [],
    references: [{ kind: "memory", id: memoryObjects[0].id, label: memoryObjects[0].title, visibility: "conversation" }],
    evidenceSnapshotId: `${terminalReportId}_snapshot`,
    evidenceFingerprint: `${terminalReportId}_fingerprint`,
    synthesis: { mode: "model", promptVersion: "terminal-report-v1", attemptCount: 1, validationCodes: [] },
    createdAt: completedAt,
    committedAt: "2026-07-10T09:14:19.000Z",
  };

  return {
    channelMessages,
    memoryObjects,
    usedMemoryEvents,
    terminalReports: [terminalReport],
    workflows: [workflow],
    workflowSteps,
    runs,
    executionActions: [
      demoAction({
        id: `${idPrefix}_action_architect_read`,
        runId: runArchitectId,
        workspaceId,
        actionType: "read",
        title: "读取频道投影入口",
        summary: "Architect 读取 WorkspaceClientView 的 workflow progress 接入点。",
        scopeSummary: "先确认频道会话实际读取哪条投影链路，避免只改 demo 组件却没有接入真实 channel feed。",
        targetRefs: [{ type: "file", path: "apps/web/src/features/workspace/WorkspaceClientView.tsx" }],
        createdAt: "2026-07-10T09:12:08.000Z",
        completedAt: "2026-07-10T09:12:16.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_architect_search`,
        runId: runArchitectId,
        workspaceId,
        actionType: "grep",
        title: "搜索 work-cell 投影函数",
        summary: "Architect 搜索 workflowProgressToConversationWorkCell 的使用位置。",
        scopeSummary: "再沿着 workflowProgressToConversationWorkCell 反查数据来源，确认 workflow、step、run、action 会汇到同一个 work-cell。",
        targetRefs: [{ type: "file", path: "apps/web/src/lib/workflow-progress.ts" }],
        createdAt: "2026-07-10T09:12:17.000Z",
        completedAt: "2026-07-10T09:12:27.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_designer_review`,
        runId: runDesignerId,
        workspaceId,
        actionType: "mcp_tool_call",
        title: "审阅操作记录视觉层级",
        summary: "Designer 检查无气泡、低对比默认态和悬停高亮规则。",
        scopeSummary: "视觉上先保留操作过程，但默认降低存在感，只在用户关注到具体行时提升对比度。",
        targetRefs: [{ type: "mcp_tool", label: "design.review" }],
        createdAt: "2026-07-10T09:12:22.000Z",
        completedAt: "2026-07-10T09:12:42.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_edit_component`,
        runId: runEngineerId,
        workspaceId,
        actionType: "edit",
        risk: "medium",
        title: "接入 agent 操作记录行",
        summary: "Engineer 修改 work-cell 行展示，保留单行折叠和逐行展开。",
        scopeSummary: "先把 agent 内部工作流拆成可扫描的步骤：描述意图，再记录真实 edit/cmd 动作，展开只影响自己的行。",
        targetRefs: [{ type: "file", path: "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx" }],
        resultArtifactIds: [artifactEngineerDiff.id],
        createdAt: "2026-07-10T09:12:58.000Z",
        completedAt: "2026-07-10T09:13:18.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_edit_css`,
        runId: runEngineerId,
        workspaceId,
        actionType: "edit",
        risk: "medium",
        title: "调整操作记录 hover/focus 样式",
        summary: "Engineer 调整默认弱化文案，悬停或聚焦后恢复正常会话对比度。",
        scopeSummary: "然后收紧视觉噪音：读取和搜索不做气泡，折叠箭头默认隐藏，代码和命令细节只在展开后出现。",
        targetRefs: [{ type: "file", path: "apps/web/src/styles/components.css" }],
        resultArtifactIds: [artifactEngineerCss.id],
        createdAt: "2026-07-10T09:13:19.000Z",
        completedAt: "2026-07-10T09:13:25.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_typecheck`,
        runId: runEngineerId,
        workspaceId,
        actionType: "bash",
        risk: "medium",
        title: "运行 Web typecheck",
        summary: "Engineer 验证 work-cell 类型和投影数据结构。",
        scopeSummary: "改完后先跑类型检查，确认新增的 note 行不会破坏 conversation-ui-core 到 web 的类型契约。",
        targetRefs: [{ type: "command", label: "corepack pnpm --filter @ling-stack/web typecheck" }],
        createdAt: "2026-07-10T09:13:26.000Z",
        completedAt: "2026-07-10T09:13:32.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_qa_e2e`,
        runId: runQaId,
        workspaceId,
        actionType: "bash",
        risk: "medium",
        title: "运行频道 work-cell 回归",
        summary: "QA 验证频道 feed 中完成态折叠、多 agent 展开和命令细节。",
        scopeSummary: "QA 按频道真实路径回归，重点看折叠摘要、agent 展开、命令细节和 artifact 预览是否同时成立。",
        targetRefs: [{ type: "command", label: "corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g \"work cell\"" }],
        resultArtifactIds: [artifactQaLog.id],
        createdAt: "2026-07-10T09:13:42.000Z",
        completedAt: "2026-07-10T09:14:01.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_doc`,
        runId: runEngineerFollowupId,
        workspaceId,
        actionType: "edit",
        risk: "low",
        title: "记录本地频道样例开关",
        summary: "Engineer 第二轮补齐 demo 记录，作为独立收口动作展示。",
        scopeSummary: "最后把第二轮收口保留在新的时间位置，不合并回上一轮，用户才能看到 QA 后又补了一次。",
        targetRefs: [{ type: "file", path: "docs/design/conversation-work-cell-operation-records.md" }],
        resultArtifactIds: [artifactDocDiff.id, artifactDoc.id],
        createdAt: "2026-07-10T09:14:06.000Z",
        completedAt: "2026-07-10T09:14:14.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_followup_typecheck`,
        runId: runEngineerFollowupId,
        workspaceId,
        actionType: "bash",
        title: "复查会话类型",
        summary: "Engineer 复查统一会话投影类型。",
        targetRefs: [{ type: "command", label: "corepack pnpm --filter @ling-stack/web typecheck" }],
        createdAt: "2026-07-10T09:14:14.100Z",
        completedAt: "2026-07-10T09:14:15.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_followup_i18n`,
        runId: runEngineerFollowupId,
        workspaceId,
        actionType: "bash",
        title: "检查会话文案",
        summary: "Engineer 检查命令批次文案。",
        targetRefs: [{ type: "command", label: "corepack pnpm --filter @ling-stack/web check:i18n" }],
        createdAt: "2026-07-10T09:14:15.100Z",
        completedAt: "2026-07-10T09:14:16.000Z",
      }),
      demoAction({
        id: `${idPrefix}_action_engineer_followup_diff_check`,
        runId: runEngineerFollowupId,
        workspaceId,
        actionType: "bash",
        title: "检查补丁格式",
        summary: "Engineer 检查最终补丁格式。",
        targetRefs: [{ type: "command", label: "git diff --check" }],
        createdAt: "2026-07-10T09:14:16.100Z",
        completedAt: "2026-07-10T09:14:17.000Z",
      }),
    ],
    artifactsByRun: {
      [runEngineerId]: [artifactEngineerDiff, artifactEngineerCss],
      [runQaId]: [artifactQaLog, artifactQaSpecDiff],
      [runEngineerFollowupId]: [artifactDocDiff, artifactDoc, artifactI18nDiff],
    },
  };
}

export function resolveChannelWorkCellDemoPreview(input: {
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly request: PreviewRequest;
}): PreviewContentResponse | undefined {
  const request = input.request;
  if (request.source !== "artifact") {
    return undefined;
  }
  const artifactId = request.artifactId;
  if (!artifactId.startsWith(channelWorkCellDemoArtifactPrefix)) {
    return undefined;
  }

  const artifact = Object.values(input.artifactsByRun)
    .flat()
    .find((item) => item.id === artifactId);
  if (!artifact) {
    return undefined;
  }

  const text = demoArtifactPreviewText(artifact);
  const maxBytes = request.maxBytes && Number.isFinite(request.maxBytes)
    ? Math.max(1, Math.floor(request.maxBytes))
    : undefined;
  const previewText = maxBytes ? text.slice(0, maxBytes) : text;

  return {
    ref: {
      id: artifact.id,
      source: "artifact",
      scope: "run",
      label: artifact.title || basename(artifact.path) || artifact.id,
      displayPath: artifact.path,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      previewable: true,
    },
    kind: demoArtifactPreviewKind(artifact),
    text: previewText,
    truncated: previewText.length < text.length,
    sizeBytes: artifact.sizeBytes,
    redactionNotes: ["Preview is read-only and not included in AI context."],
  };
}

function demoRun(input: {
  readonly id: string;
  readonly channelId: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly workflowStepId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly endedAt: string;
}): RunSession {
  return {
    id: input.id,
    status: "succeeded",
    cwd: input.cwd,
    taskId: input.taskId,
    channelId: input.channelId,
    teammateId: input.teammateId,
    workflowStepId: input.workflowStepId,
    providerName: "Local demo",
    providerModel: "fixture",
    taskSnapshot: { id: input.taskId, title: input.title },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `tmp/ling-work-cell-demo/${input.id}.jsonl`,
    createdAt: input.createdAt,
    startedAt: input.createdAt,
    endedAt: input.endedAt,
    updatedAt: input.endedAt,
  };
}

function demoArtifactPreviewKind(artifact: RunArtifact): PreviewContentKind {
  if (artifact.type === "markdown") {
    return "markdown_text";
  }
  if (artifact.type === "diff") {
    return "diff";
  }
  if (artifact.type === "log") {
    return "log";
  }
  if (artifact.type === "json") {
    return "json";
  }
  return "plain_text";
}

function demoArtifactPreviewText(artifact: RunArtifact): string {
  if (artifact.id.endsWith("_artifact_engineer_diff")) {
    return [
      "diff --git a/apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx b/apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx",
      "--- a/apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx",
      "+++ b/apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx",
      "@@ -117,7 +117,10 @@",
      " const active = isActiveOperation(model.status);",
      " const operationRows = visibleOperationRows(model);",
      " const visibleArtifactItems = terminalSummaryRendered ? [] : model.artifactStripItems;",
      "+ const shellStatusLabel = operationShellStatusLabel(model, active, t);",
      "+ <div className=\"conversation-operation-shell completed tone-success collapsed\">",
      "+ <ActiveTurnItemStream rows={operationRows} />",
      "- <OperationBubble status={model.status} active={active}>",
      "+ <ConversationArtifactStrip items={visibleArtifactItems} cwd={cwd} onPreview={setPreviewItem} />",
      " return (",
      "   <section className=\"conversation-work-cell\">",
      "     {operationBody}",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_engineer_css")) {
    return [
      "diff --git a/apps/web/src/styles/components.css b/apps/web/src/styles/components.css",
      "--- a/apps/web/src/styles/components.css",
      "+++ b/apps/web/src/styles/components.css",
      "@@ -4018,6 +4018,10 @@",
      "   transition: color 120ms ease;",
      " }",
      " ",
      "+.conversation-work-cell-row { color: var(--text-muted); }",
      "+.conversation-work-cell-row:hover,",
      "+.conversation-work-cell-row:focus-within { color: var(--text-primary); }",
      "+.conversation-work-cell-shell-detail code { white-space: pre-wrap; }",
      " ",
      " .conversation-work-cell-row-copy {",
      "   min-width: 0;",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_qa_log")) {
    return [
      "Running channel work-cell demo regression",
      "PASS local channel work-cell demo fixture renders a realistic multi-agent operation record",
      "PASS artifact preview opens from demo fixture without daemon lookup",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_qa_spec_diff")) {
    return [
      "diff --git a/apps/web/e2e/channel.spec.ts b/apps/web/e2e/channel.spec.ts",
      "--- a/apps/web/e2e/channel.spec.ts",
      "+++ b/apps/web/e2e/channel.spec.ts",
      "@@ -7927,7 +7927,8 @@",
      "   const changedGroup = transcriptArtifacts.locator(\".conversation-work-cell-change-group\");",
      "   await expect(changedGroup).toBeVisible();",
      " ",
      "- await expect(previewDrawer).toBeVisible();",
      "+ await changedSummary.click();",
      "+ await expect(changedFiles).toHaveCount(3);",
      " ",
      "   const hoverPreview = page.locator(\".conversation-artifact-hover-preview\");",
      "   await page.mouse.move(0, 0);",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_doc_diff")) {
    return [
      "diff --git a/docs/design/conversation-work-cell-operation-records.md b/docs/design/conversation-work-cell-operation-records.md",
      "--- a/docs/design/conversation-work-cell-operation-records.md",
      "+++ b/docs/design/conversation-work-cell-operation-records.md",
      "@@ -45,8 +45,9 @@",
      " Each disclosure controls only itself:",
      " ",
      " - the completed shell expands or collapses the work cell body;",
      "-展开后逐行展示 agent 操作记录。",
      "-编辑行只显示文件名。",
      "+展开后逐行展示 agent 操作记录，并保持动作顺序。",
      "+编辑行显示真实的新增/删除数量。",
      "+点击编辑行展示该次修改的局部 diff。",
      " - clicking an operation row must not collapse sibling rows.",
      " ",
      " ## Visual Rules",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_doc")) {
    return [
      "# Conversation Work Cell Operation Records",
      "",
      "本地 demo 通过 `?workCellDemo=1` 注入 display-only workflow、runs、actions 和 artifacts。",
      "",
      "- 普通产物文件显示在上方。",
      "- 变更文件收进独立的编辑摘要。",
      "- 悬停文件 2 秒显示紧凑预览。",
      "",
    ].join("\n");
  }
  if (artifact.id.endsWith("_artifact_i18n_diff")) {
    return [
      "diff --git a/apps/web/src/i18n/locales/zh-CN.ts b/apps/web/src/i18n/locales/zh-CN.ts",
      "--- a/apps/web/src/i18n/locales/zh-CN.ts",
      "+++ b/apps/web/src/i18n/locales/zh-CN.ts",
      "@@ -1568,6 +1568,8 @@",
      "   \"Preview\": \"预览\",",
      "   \"Preview unavailable\": \"无法预览\",",
      " ",
      "+ \"Show {count} more files\": \"再显示 {count} 个文件\"",
      "+ \"Show fewer files\": \"收起部分文件\"",
      " ",
      "   \"Show details\": \"显示详情\",",
      "   \"Hide details\": \"隐藏详情\",",
      "",
    ].join("\n");
  }
  return `${artifact.title || basename(artifact.path) || artifact.id}\n${artifact.path}\n`;
}

function demoAction(input: {
  readonly id: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly actionType: ExecutionAction["actionType"];
  readonly title: string;
  readonly summary: string;
  readonly scopeSummary?: string;
  readonly targetRefs: ExecutionAction["targetRefs"];
  readonly createdAt: string;
  readonly completedAt: string;
  readonly risk?: ExecutionAction["risk"];
  readonly resultArtifactIds?: readonly string[];
}): ExecutionAction {
  const commandText = input.actionType === "bash"
    ? input.targetRefs.find((ref) => ref.type === "command")?.label
    : undefined;
  const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.createdAt));
  return {
    id: input.id,
    revision: 3,
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: `attempt:${input.runId}`,
    actionType: input.actionType,
    risk: input.risk ?? "low",
    status: "succeeded",
    title: input.title,
    summary: input.summary,
    ...(input.scopeSummary ? { scopeSummary: input.scopeSummary } : {}),
    targetRefs: input.targetRefs,
    previewArtifactIds: [],
    resultArtifactIds: input.resultArtifactIds ?? [],
    sourceRefs: input.targetRefs.map((ref) => ({
      kind: ref.type,
      id: ref.path ?? ref.id ?? ref.label ?? ref.type,
      ...(ref.label ? { label: ref.label } : {}),
      ...(ref.path ? { path: ref.path } : {}),
    })),
    ...(commandText ? {
      toolCallId: `tool_${input.id}`,
      commandEvidence: {
        command: commandText,
        cwd: "/repo",
        startedAt: input.createdAt,
        completedAt: input.completedAt,
        durationMs,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        latestEventSeq: 3,
        outputTail: [{
          eventSeq: 2,
          stream: "stdout",
          text: "Completed successfully.\n",
          byteCount: 24,
          redacted: false,
          ts: input.completedAt,
        }],
        outputByteCount: 24,
        outputLineCount: 1,
        outputTruncated: false,
      },
    } : {}),
    createdAt: input.createdAt,
    updatedAt: input.completedAt,
    resolvedAt: input.createdAt,
    executedAt: input.createdAt,
    completedAt: input.completedAt,
  };
}

function demoDiscussionReply(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}): ChannelMessage {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadId: input.threadId,
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: input.authorId,
    body: input.body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "channel";
}

function basename(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
