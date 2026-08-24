import { cwd, type MockState } from "./mock-state";

export const normalConversationFixtureTitle = "Desktop chrome fixture";

export function installNormalConversationFixture(state: MockState): string {
  const threadId = "thread_desktop_chrome";
  const turnId = "turn_desktop_chrome";
  const runId = "run_desktop_chrome";
  const createdAt = "2026-07-29T01:00:00.000Z";
  const completedAt = "2026-07-29T01:01:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: normalConversationFixtureTitle,
    objective: "Verify normal-conversation Desktop chrome behavior.",
    status: "succeeded",
    lastRunId: runId,
    createdAt,
    updatedAt: completedAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: normalConversationFixtureTitle,
    userInstruction: "Verify the Desktop chrome drag contract.",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: completedAt,
    completedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs = [{
    id: runId,
    status: "succeeded",
    cwd,
    taskId: "task_desktop_chrome",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_desktop_chrome", title: normalConversationFixtureTitle },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_desktop_chrome",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "Desktop chrome fixture response." },
  }];
  return threadId;
}
