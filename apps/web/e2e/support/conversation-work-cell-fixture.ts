import type { MockExecutionAction } from "./mock-daemon";
import {
  createChatProvider,
  createMockTeammate,
  cwd,
  isRecord,
  type MockState,
} from "./mock-state";

const workspaceId = "workspace_default";
const providerId = "provider_ui2_work_cell";
const startedAt = "2026-07-24T02:00:00.000Z";
const completedAt = "2026-07-24T02:01:00.000Z";

export function installChannelWorkCellFixture(state: MockState, suffix: string): {
  readonly runId: string;
  readonly threadId: string;
} {
  const baseRun = state.runs[0];
  if (!baseRun) throw new Error("Base state must include a run");

  const threadId = `thread_ui2_work_cell_${suffix}`;
  const turnId = `turn_ui2_work_cell_${suffix}`;
  const runId = `run_ui2_work_cell_${suffix}`;
  const sourceMessageId = `message_ui2_work_cell_${suffix}`;
  const run = {
    ...baseRun,
    id: runId,
    threadId,
    turnId,
    status: "succeeded" as const,
    errorMessage: undefined,
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    startedAt,
    endedAt: completedAt,
    updatedAt: completedAt,
  };

  state.runs = [run, ...state.runs.slice(1)];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === run.taskId
    ? { ...task, status: "done", currentRunId: undefined, updatedAt: completedAt }
    : task);
  state.turns = [{
    id: turnId,
    workspaceId,
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: `Focused WorkCell ${suffix}`,
    userInstruction: `Inspect the focused WorkCell ${suffix}.`,
    channelId: "channel_engineering",
    taskId: run.taskId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: startedAt,
    updatedAt: completedAt,
    completedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: startedAt }];
  state.threads = [{
    id: threadId,
    workspaceId,
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: `Focused WorkCell ${suffix}`,
    objective: `Inspect the focused WorkCell ${suffix}.`,
    status: "succeeded",
    lastRunId: runId,
    surfaceKind: "channel_root",
    relationKind: "root",
    conversationMode: { mode: "default" },
    createdAt: startedAt,
    updatedAt: completedAt,
  }, ...state.threads.filter((candidate) => candidate.id !== threadId)];
  state.channelMessages = [{
    id: sourceMessageId,
    workspaceId,
    channelId: "channel_engineering",
    threadId,
    kind: "message",
    intent: "task",
    authorType: "local-user",
    authorId: "local-user",
    body: `Inspect the focused WorkCell ${suffix}.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    linkedRunId: runId,
    status: "ready",
    createdAt: startedAt,
    updatedAt: startedAt,
  }, ...state.channelMessages.filter((candidate) => isRecord(candidate) && candidate.id !== sourceMessageId)];
  state.executionActions = completedCommandActions(threadId, runId, suffix, sourceMessageId);
  state.approvals = [];
  return { runId, threadId };
}

export function installActiveChannelWorkCellFixture(state: MockState): {
  readonly runId: string;
  readonly threadId: string;
} {
  const result = installChannelWorkCellFixture(state, "active-visibility");
  state.runs = state.runs.map((run) => run.id === result.runId
    ? { ...run, status: "running", endedAt: undefined, updatedAt: startedAt }
    : run);
  state.turns = state.turns.map((turn) => isRecord(turn) && turn.id === `turn_ui2_work_cell_active-visibility`
    ? { ...turn, status: "running", completedAt: undefined, updatedAt: startedAt }
    : turn);
  state.tasks = state.tasks.map((task) => isRecord(task) && task.currentRunId === result.runId
    ? { ...task, status: "running", updatedAt: startedAt }
    : task);
  state.executionActions = state.executionActions.map((action, index) => index === 0
    ? {
      ...action,
      status: "executing",
      completedAt: undefined,
      updatedAt: startedAt,
      commandEvidence: action.commandEvidence
        ? {
          ...action.commandEvidence,
          completedAt: undefined,
          durationMs: undefined,
          exitCode: undefined,
        }
        : undefined,
    }
    : action);
  return result;
}

export function installExplorationWorkCellFixture(state: MockState, readCount = 3): {
  readonly runId: string;
  readonly threadId: string;
} {
  const result = installChannelWorkCellFixture(state, "exploration");
  const readPaths = [
    "apps/web/src/lib/conversation-work-cell.ts",
    "apps/web/src/lib/workflow-progress.ts",
    "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx",
    "packages/conversation-ui-core/src/activity-projection.ts",
    "packages/conversation-ui-core/src/command-batching.ts",
    "apps/web/src/styles/shared/conversation-work-cell-activity.css",
  ];
  state.executionActions = [
    ...Array.from({ length: readCount }, (_, index) => readAction(
      index < 3 ? ["one", "two", "three"][index]! : `item-${index + 1}`,
      result.threadId,
      result.runId,
      readPaths[index % readPaths.length]!,
      index,
      `message_ui2_work_cell_exploration`,
    )),
  ];
  return result;
}

export function installNormalWorkCellFixture(state: MockState): string {
  const title = "Focused normal WorkCell";
  const threadId = "thread_ui2_normal_work_cell";
  const turnId = "turn_ui2_normal_work_cell";
  const runId = "run_ui2_normal_work_cell";
  state.providers = [createChatProvider({
    id: providerId,
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.threads = [{
    id: threadId,
    workspaceId,
    kind: "conversation",
    title,
    objective: "Verify the shared WorkCell in a normal conversation.",
    status: "succeeded",
    lastRunId: runId,
    createdAt: startedAt,
    updatedAt: completedAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId,
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title,
    userInstruction: "Run the focused normal conversation checks.",
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: startedAt,
    updatedAt: completedAt,
    completedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: startedAt }];
  state.runs.unshift(completedRun({ runId, threadId, turnId, title }));
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "Focused normal WorkCell completed." },
  }];
  state.executionActions = completedCommandActions(threadId, runId, "normal", `conversation-assistant:${turnId}`);
  state.terminalReports = [completedTerminalReport({
    id: "terminal_report_ui2_normal_work_cell",
    threadId,
    turnId,
    runId,
    title: "Normal WorkCell verified",
  })];
  state.conversationContextSnapshotsByThreadId = {
    ...(state.conversationContextSnapshotsByThreadId ?? {}),
    [threadId]: [{
      id: "snapshot_ui2_normal_work_cell",
      threadId,
      segmentId: "segment_ui2_normal_work_cell",
      projectionVersion: "ui2-fixture-v1",
      throughItemSequence: 2,
      summaryIds: [],
      sourceRefs: [
        { type: "conversation_item", id: `conversation-user:${turnId}` },
        { type: "conversation_item", id: `conversation-assistant:${turnId}` },
      ],
      policyVersion: "ui2-fixture",
      createdAt: completedAt,
    }],
  };
  return title;
}

export function installTeammateWorkCellFixture(state: MockState): {
  readonly displayName: string;
  readonly teammateId: string;
} {
  const teammateId = "teammate_ui2_work_cell";
  const displayName = "Ling WorkCell Engineer";
  const runThreadId = "thread_ui2_teammate_work_cell";
  const directThreadId = `tdthread_${teammateId}`;
  const runId = "run_ui2_teammate_work_cell";
  state.providers = [createChatProvider({
    id: providerId,
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName,
    providerPresetId: providerId,
  })];
  state.runs.unshift(completedRun({
    runId,
    threadId: runThreadId,
    title: "Teammate WorkCell checks",
  }));
  state.executionActions = completedCommandActions(runThreadId, runId, "teammate", "tdmsg_ui2_teammate_work_cell");
  state.terminalReports = [completedTerminalReport({
    id: "terminal_report_ui2_teammate_work_cell",
    threadId: runThreadId,
    runId,
    title: "Teammate WorkCell verified",
  })];
  state.teammateDirectMessages = [{
    id: "tdmsg_ui2_teammate_work_cell",
    workspaceId,
    threadId: directThreadId,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "Focused teammate WorkCell completed.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    linkedRunId: runId,
    createdAt: completedAt,
    updatedAt: completedAt,
  }];
  return { displayName, teammateId };
}

function completedRun(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly title: string;
}): MockState["runs"][number] {
  return {
    id: input.runId,
    status: "succeeded",
    cwd,
    taskId: `task_${input.runId}`,
    providerPresetId: providerId,
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_${input.runId}`, title: input.title },
    providerSnapshot: {},
    requestSnapshot: { cwd },
    eventLogPath: `.ling-stack/sessions/${input.runId}.jsonl`,
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt: startedAt,
    startedAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  };
}

function completedCommandActions(threadId: string, runId: string, suffix: string, anchorItemId: string): MockExecutionAction[] {
  return [
    commandAction(`typecheck_${suffix}`, threadId, runId, "corepack pnpm --filter @ling-stack/web typecheck", 1_200, anchorItemId),
    commandAction(`i18n_${suffix}`, threadId, runId, "corepack pnpm --filter @ling-stack/web check:i18n", 700, anchorItemId),
    commandAction(`diff_${suffix}`, threadId, runId, "git diff --check", 300, anchorItemId),
  ];
}

function readAction(
  id: string,
  threadId: string,
  runId: string,
  path: string,
  index: number,
  anchorItemId: string,
): MockExecutionAction {
  const actionTime = new Date(Date.parse(startedAt) + ((index + 1) * 8_000)).toISOString();
  return {
    id: `execution_action_read_${id}`,
    workspaceId,
    threadId,
    runId,
    attemptId: `attempt_${runId}`,
    toolCallId: `tool_read_${id}`,
    actionType: "read",
    risk: "low",
    status: "succeeded",
    title: "Read file",
    summary: `Read ${path}`,
    targetRefs: [{ type: "file", path, label: path }],
    sourceRefs: [{ kind: "conversation_item", id: anchorItemId }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    createdAt: actionTime,
    updatedAt: actionTime,
    executedAt: actionTime,
    completedAt: actionTime,
  };
}

function commandAction(
  id: string,
  threadId: string,
  runId: string,
  command: string,
  durationMs: number,
  anchorItemId: string,
): MockExecutionAction {
  const actionStartedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  const actionCompletedAt = new Date(Date.parse(actionStartedAt) + durationMs).toISOString();
  return {
    id: `execution_action_${id}`,
    workspaceId,
    threadId,
    runId,
    attemptId: `attempt_${runId}`,
    toolCallId: `tool_${id}`,
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: "Run command",
    summary: command,
    targetRefs: [{ type: "command", label: command }],
    sourceRefs: [{ kind: "conversation_item", id: anchorItemId }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command,
      cwd,
      startedAt: actionStartedAt,
      completedAt: actionCompletedAt,
      durationMs,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      latestEventSeq: 2,
      outputTail: [{
        eventSeq: 2,
        stream: "stdout",
        text: `${command} passed.\n`,
        byteCount: command.length + 9,
        redacted: false,
        ts: actionCompletedAt,
      }],
      outputByteCount: command.length + 9,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: actionStartedAt,
    updatedAt: actionCompletedAt,
    executedAt: actionStartedAt,
    completedAt: actionCompletedAt,
  };
}

function completedTerminalReport(input: {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId: string;
  readonly title: string;
}): MockState["terminalReports"][number] {
  return {
    schemaVersion: 1,
    id: input.id,
    generation: 1,
    resultItemId: `result_terminal_report:${input.id}`,
    workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    source: input.turnId
      ? { kind: "turn", id: input.turnId }
      : { kind: "run", id: input.runId },
    status: "committed",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: input.title,
      summary: "The shared WorkCell retained a compact, keyboard-operable command history.",
      corrections: [],
      sourceRefs: [{ kind: "run", id: input.runId, visibility: "conversation" }],
    },
    changes: [],
    verification: [],
    participants: [],
    artifacts: [],
    risks: [],
    references: [],
    evidenceSnapshotId: `snapshot_${input.id}`,
    evidenceFingerprint: `fingerprint_${input.id}`,
    synthesis: {
      mode: "deterministic_fallback",
      promptVersion: "terminal-report-v1",
      attemptCount: 0,
      validationCodes: [],
    },
    createdAt: completedAt,
    committedAt: completedAt,
  };
}
