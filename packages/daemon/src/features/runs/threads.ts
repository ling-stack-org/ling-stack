import type {
  LingThread,
  RunEventEnvelope,
  RunEventType,
  RunSession,
  RunStatus,
  RunStore,
} from "@ling-stack/core";
import type { RunRequest } from "./schemas.js";

export function ensureLingThreadForRun(store: RunStore, runRequest: RunRequest, now: string): LingThread {
  if (runRequest.threadId) {
    const requestedThread = store.getLingThread(runRequest.threadId);
    if (!requestedThread) {
      throw new Error(`Ling thread not found: ${runRequest.threadId}`);
    }
    if (requestedThread.status === "archived") {
      throw new Error(`Ling thread is archived: ${runRequest.threadId}`);
    }
    return requestedThread;
  }

  const parentThread = findParentLingThread(store, runRequest.parentRunId);
  if (parentThread && parentThread.status !== "archived") {
    return parentThread;
  }

  if (runRequest.workflowStepId) {
    const workflowStep = store.getChannelWorkflowStep(runRequest.workflowStepId);
    const existing = store.findLingThreadByOwner({
      kind: "workflow_step",
      workflowStepId: runRequest.workflowStepId,
      channelId: workflowStep?.channelId ?? runRequest.task.channelId,
    });
    if (existing && existing.status !== "archived") {
      return existing;
    }

    return store.createLingThread(
      {
        kind: "workflow_step",
        channelId: workflowStep?.channelId ?? runRequest.task.channelId,
        taskId: runRequest.task.id,
        teammateId: runRequest.teammateId,
        workflowId: workflowStep?.workflowId,
        workflowStepId: runRequest.workflowStepId,
        title: workflowStep?.title ?? runRequest.task.title,
        objective: workflowStep?.prompt ?? runRequest.task.prompt,
        status: "open",
      },
      now,
    );
  }

  const existing = store.findLingThreadByOwner({
    kind: "task",
    taskId: runRequest.task.id,
    channelId: runRequest.task.channelId,
  });
  if (existing && existing.status !== "archived") {
    return existing;
  }

  return store.createLingThread(
    {
      kind: "task",
      channelId: runRequest.task.channelId,
      taskId: runRequest.task.id,
      title: runRequest.task.title,
      objective: runRequest.task.prompt,
      status: "open",
    },
    now,
  );
}

export function markLingThreadRunActive(
  store: RunStore,
  threadId: string | undefined,
  runId: string,
  now: string,
): LingThread | undefined {
  if (!threadId) {
    return undefined;
  }
  return store.updateLingThread(
    threadId,
    {
      status: "running",
      activeRunId: runId,
      lastRunId: runId,
    },
    now,
  );
}

export function syncLingThreadForRunEvent(
  store: RunStore,
  run: RunSession,
  type: RunEventType,
  envelope: RunEventEnvelope,
): void {
  if (!run.threadId) {
    return;
  }

  if (type === "approval_requested") {
    store.updateLingThread(
      run.threadId,
      {
        status: "waiting_for_approval",
        activeRunId: run.id,
        lastRunId: run.id,
      },
      envelope.ts,
    );
    return;
  }

  if (type === "approval_approved") {
    store.updateLingThread(
      run.threadId,
      {
        status: "running",
        activeRunId: run.id,
        lastRunId: run.id,
      },
      envelope.ts,
    );
    return;
  }

  if (type === "approval_denied" || type === "approval_expired" || type === "run_cancelled") {
    updateLingThreadForTerminalRunStatus(store, run, type === "run_cancelled" ? "cancelled" : "failed", envelope.ts);
  }
}

export function syncLingThreadForTerminalRun(store: RunStore, runId: string, now: string): LingThread | undefined {
  const run = store.getRun(runId);
  if (!run || !isTerminalRunStatus(run.status)) {
    return undefined;
  }
  return updateLingThreadForTerminalRunStatus(store, run, run.status, now);
}

export function updateLingThreadForTerminalRunStatus(
  store: RunStore,
  run: RunSession,
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
  now: string,
): LingThread | undefined {
  if (!run.threadId) {
    return undefined;
  }
  const thread = store.getLingThread(run.threadId);
  if (!thread) {
    return undefined;
  }
  return store.updateLingThread(
    run.threadId,
    {
      status,
      activeRunId: thread.activeRunId === run.id ? null : thread.activeRunId,
      lastRunId: run.id,
    },
    now,
  );
}

function findParentLingThread(store: RunStore, parentRunId: string | undefined): LingThread | undefined {
  if (!parentRunId) {
    return undefined;
  }
  const parentRun = store.getRun(parentRunId);
  if (!parentRun?.threadId) {
    return undefined;
  }
  return store.getLingThread(parentRun.threadId);
}

function isTerminalRunStatus(status: RunStatus): status is Extract<RunStatus, "succeeded" | "failed" | "cancelled"> {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
