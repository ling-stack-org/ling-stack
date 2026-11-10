import type { RunStore, WorkUnit } from "@ling-stack/core";
import type { RunRequest } from "./schemas.js";
import { resolveRunWorkUnitOwner } from "./orchestrator.js";

/** A retry reads the original authority before consulting mutable admission dependencies. */
export function findExistingIdempotentRunRequest(store: RunStore, request: RunRequest): WorkUnit | undefined {
  if (!request.idempotencyKey) return undefined;
  const parent = request.parentRunId ? store.getRun(request.parentRunId) : undefined;
  const parentThread = parent?.threadId ? store.getLingThread(parent.threadId) : undefined;
  const step = request.workflowStepId ? store.getChannelWorkflowStep(request.workflowStepId) : undefined;
  const thread = request.threadId ? store.getLingThread(request.threadId)
    : parentThread ?? (request.workflowStepId ? store.findLingThreadByOwner({ kind: "workflow_step",
        workflowStepId: request.workflowStepId, channelId: step?.channelId ?? request.task.channelId })
      : store.findLingThreadByOwner({ kind: "task", taskId: request.task.id, channelId: request.task.channelId }));
  if (!thread || (thread.kind === "conversation" && !request.turnId)) return undefined;
  const owner = resolveRunWorkUnitOwner(thread, request, request.turnId ?? "");
  return store.findWorkUnitByIdempotency({ ...owner, idempotencyKey: request.idempotencyKey });
}
