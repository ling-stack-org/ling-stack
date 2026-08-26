import type { Channel, LingThread, LingTurn, LingTurnRunRole, RunSession, RunStore, WorkUnit, WorkUnitAttempt } from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { QueueableRunConflictCode } from "./concurrency.js";
import type { RunRequest } from "./schemas.js";
import { markLingThreadRunActive } from "./threads.js";

export function createQueuedRunForConflict(input: {
  readonly store: RunStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly workspaceCwd: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly channel?: Channel;
  readonly provider: PiRunnerProviderConfig;
  readonly thread?: LingThread;
  readonly turn?: LingTurn;
  readonly turnRunRole?: LingTurnRunRole;
  readonly selectedSkillId?: string;
  readonly queuedAt: string;
  readonly reason: QueueableRunConflictCode;
  readonly message: string;
}): RunSession {
  const run = input.store.createRun({
    id: input.runId,
    cwd: input.runRequest.cwd,
    taskId: input.runRequest.task.id,
    channelId: input.channel?.id ?? input.runRequest.task.channelId,
    teammateId: input.runRequest.teammateId,
    workflowStepId: input.runRequest.workflowStepId,
    selectedSkillId: input.selectedSkillId,
    providerPresetId: input.runRequest.providerPresetId,
    providerName: input.provider.provider,
    providerModel: input.provider.model,
    taskSnapshot: input.runRequest.task,
    providerSnapshot: { providerPresetId: input.runRequest.providerPresetId, ...input.provider },
    requestSnapshot: {
      ...input.runRequest,
      workspaceCwd: input.workspaceCwd,
      provider: input.provider,
      threadId: input.thread?.id,
      turnId: input.turn?.id,
      runnerResolution: {
        requestedRunnerId: input.workUnit.requestedRunnerId ?? input.workUnit.effectiveRunnerId ?? input.workUnit.runnerId,
        effectiveRunnerId: input.workUnit.effectiveRunnerId ?? input.workUnit.runnerId,
        fallbackReason: input.workUnit.fallbackReason,
      },
      selectedSkillId: input.selectedSkillId,
      queued: true,
      queueReason: input.reason,
    },
    workUnitId: input.workUnit.id,
    threadId: input.thread?.id,
    turnId: input.turn?.id,
    turnRunRole: input.turnRunRole,
    createdAt: input.queuedAt,
  });
  input.store.linkRunToWorkUnit(run.id, input.workUnit.id, input.queuedAt);
  if (input.thread) {
    markLingThreadRunActive(input.store, input.thread.id, run.id, input.queuedAt);
  }
  input.storeRegistry.rememberRun(run.id, input.store);
  input.store.appendEvent(run.id, "run_created", {
    taskId: run.taskId,
    workUnitId: input.workUnit.id,
    attemptId: input.attempt.id,
    threadId: input.thread?.id,
    workspaceCwd: input.workspaceCwd,
    cwd: run.cwd,
    providerName: run.providerName,
    providerModel: run.providerModel,
    requestedRunnerId: input.workUnit.requestedRunnerId,
    effectiveRunnerId: input.workUnit.effectiveRunnerId ?? input.workUnit.runnerId,
    fallbackReason: input.workUnit.fallbackReason,
    teammateId: run.teammateId,
    selectedSkillId: run.selectedSkillId,
    queued: true,
    queueReason: input.reason,
    message: input.message,
  });
  input.store.appendRuntimeEvent({
    workUnitId: input.workUnit.id,
    attemptId: input.attempt.id,
    runtimeInstanceId: input.attempt.runtimeInstanceId,
    fencingToken: input.attempt.fencingToken,
    type: "work_unit_queued",
    actor: "system",
    ts: input.queuedAt,
    data: {
      runId: run.id,
      reason: input.reason,
      message: input.message,
    },
  });
  return run;
}
