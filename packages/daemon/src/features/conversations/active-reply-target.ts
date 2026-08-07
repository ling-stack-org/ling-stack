import type { ConversationActiveReplyStatus, ConversationActiveReplyTarget } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";

export function projectConversationActiveReplyTarget(input: {
  readonly store: RunStore;
  readonly runId: string | undefined;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly teammateId?: string;
}): ConversationActiveReplyTarget | undefined {
  const runId = input.runId?.trim();
  if (!runId) return undefined;

  const run = input.store.getRun(runId);
  if (!run || !isActiveReplyStatus(run.status) || !run.workUnitId) return undefined;
  const workUnit = input.store.getWorkUnit(run.workUnitId);
  if (!workUnit || workUnit.linkedRunId !== run.id) return undefined;

  return {
    runId: run.id,
    sourceRunId: run.parentRunId ?? run.id,
    workUnitId: workUnit.id,
    channelId: input.channelId ?? run.channelId ?? workUnit.channelId,
    threadId: input.threadId ?? run.threadId,
    teammateId: input.teammateId ?? run.teammateId ?? workUnit.teammateId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function isActiveReplyStatus(status: string): status is ConversationActiveReplyStatus {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}
