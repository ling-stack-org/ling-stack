import type {
  ApprovalRequest,
  ChannelWorkflowStep,
  RunSession,
  Task,
  TeammateDirectMessage,
  WorkUnit,
} from "../types.js";
import { readDataString } from "./data.js";

export type RuntimeApprovalOwner =
  | { readonly kind: "channel"; readonly channelId: string }
  | { readonly kind: "normal_conversation"; readonly threadId: string }
  | { readonly kind: "teammate_direct"; readonly teammateId: string; readonly threadId: string };

export interface RuntimeApprovalOwnershipContext {
  readonly runs: readonly RunSession[];
  readonly tasks?: readonly Task[];
  readonly teammateDirectMessages?: readonly TeammateDirectMessage[];
  readonly workUnits?: readonly WorkUnit[];
  readonly workflowSteps?: readonly ChannelWorkflowStep[];
}

export type RuntimeRunOwnershipContext = Pick<
  RuntimeApprovalOwnershipContext,
  "teammateDirectMessages" | "workUnits"
>;

export function resolveRuntimeApprovalOwner(
  approval: ApprovalRequest,
  context: RuntimeApprovalOwnershipContext,
): RuntimeApprovalOwner | undefined {
  if (approval.channelId) {
    return { kind: "channel", channelId: approval.channelId };
  }

  const runById = new Map(context.runs.map((run) => [run.id, run]));
  const workUnitById = new Map(context.workUnits?.map((workUnit) => [workUnit.id, workUnit]));
  const workUnitByRunId = new Map(context.workUnits
    ?.filter((workUnit): workUnit is WorkUnit & { readonly linkedRunId: string } => Boolean(workUnit.linkedRunId))
    .map((workUnit) => [workUnit.linkedRunId, workUnit]));
  const directRunOwner = approval.runId
    ? runtimeApprovalOwnerFromRun(
      runById.get(approval.runId),
      workUnitById,
      workUnitByRunId,
      context.workUnits !== undefined,
      context.teammateDirectMessages,
    )
    : undefined;
  if (directRunOwner) return directRunOwner;

  if (approval.taskId) {
    const task = context.tasks?.find((candidate) => candidate.id === approval.taskId);
    if (task?.channelId) return { kind: "channel", channelId: task.channelId };
  }

  if (approval.workflowStepId) {
    const step = context.workflowSteps?.find((candidate) => candidate.id === approval.workflowStepId);
    if (step?.channelId) return { kind: "channel", channelId: step.channelId };
  }

  const payloadRunId = readDataString(approval.payload, "runId")
    || readDataString(approval.payload, "requestedByRunId");
  return payloadRunId
    ? runtimeApprovalOwnerFromRun(
      runById.get(payloadRunId),
      workUnitById,
      workUnitByRunId,
      context.workUnits !== undefined,
      context.teammateDirectMessages,
    )
    : undefined;
}

export function resolveRuntimeRunOwner(
  run: RunSession,
  context: RuntimeRunOwnershipContext,
): RuntimeApprovalOwner | undefined {
  const workUnitById = new Map(context.workUnits?.map((workUnit) => [workUnit.id, workUnit]));
  const workUnitByRunId = new Map(context.workUnits
    ?.filter((workUnit): workUnit is WorkUnit & { readonly linkedRunId: string } => Boolean(workUnit.linkedRunId))
    .map((workUnit) => [workUnit.linkedRunId, workUnit]));
  return runtimeApprovalOwnerFromRun(
    run,
    workUnitById,
    workUnitByRunId,
    context.workUnits !== undefined,
    context.teammateDirectMessages,
  );
}

export function runtimeApprovalOwnerMatches(
  owner: RuntimeApprovalOwner | undefined,
  target: RuntimeApprovalOwner,
): boolean {
  if (!owner || owner.kind !== target.kind) return false;
  if (owner.kind === "channel" && target.kind === "channel") {
    return owner.channelId === target.channelId;
  }
  if (owner.kind === "normal_conversation" && target.kind === "normal_conversation") {
    return owner.threadId === target.threadId;
  }
  return owner.kind === "teammate_direct" && target.kind === "teammate_direct"
    && owner.teammateId === target.teammateId
    && owner.threadId === target.threadId;
}

function runtimeApprovalOwnerFromRun(
  run: RunSession | undefined,
  workUnitById: ReadonlyMap<string, WorkUnit>,
  workUnitByRunId: ReadonlyMap<string, WorkUnit>,
  workUnitsProvided: boolean,
  teammateDirectMessages: readonly TeammateDirectMessage[] | undefined,
): RuntimeApprovalOwner | undefined {
  if (!run) return undefined;
  if (run.channelId) return { kind: "channel", channelId: run.channelId };

  const workUnit = (run.workUnitId ? workUnitById.get(run.workUnitId) : undefined)
    ?? workUnitByRunId.get(run.id);
  if (run.workUnitId && workUnitsProvided && !workUnit) return undefined;

  const threadId = run.threadId || readDataString(workUnit?.request, "threadId");
  if (workUnit?.kind === "conversation_run") {
    return threadId ? { kind: "normal_conversation", threadId } : undefined;
  }
  if (workUnit?.kind === "teammate_direct_reply") {
    const teammateId = run.teammateId || workUnit.teammateId;
    if (!teammateId) return undefined;
    const directThreadId = resolveTeammateDirectThreadId(run, workUnit, teammateId, teammateDirectMessages);
    if (teammateDirectMessages !== undefined) {
      return directThreadId ? { kind: "teammate_direct", teammateId, threadId: directThreadId } : undefined;
    }
    return threadId ? { kind: "teammate_direct", teammateId, threadId } : undefined;
  }
  if (workUnit?.channelId) {
    return { kind: "channel", channelId: workUnit.channelId };
  }
  if (run.teammateId && run.threadId) {
    const directThreadId = resolveTeammateDirectThreadId(run, workUnit, run.teammateId, teammateDirectMessages);
    if (teammateDirectMessages !== undefined) {
      return directThreadId
        ? { kind: "teammate_direct", teammateId: run.teammateId, threadId: directThreadId }
        : undefined;
    }
    return { kind: "teammate_direct", teammateId: run.teammateId, threadId: run.threadId };
  }
  return run.threadId ? { kind: "normal_conversation", threadId: run.threadId } : undefined;
}

function resolveTeammateDirectThreadId(
  run: RunSession,
  workUnit: WorkUnit | undefined,
  teammateId: string,
  messages: readonly TeammateDirectMessage[] | undefined,
): string | undefined {
  if (!messages) return undefined;

  const sourceMessageId = workUnit?.ownerType === "teammate_direct_message"
    ? workUnit.ownerId
    : readDataString(workUnit?.request, "sourceMessageId");
  const relatedMessages = messages.filter((message) =>
    message.linkedRunId === run.id ||
    message.id === sourceMessageId ||
    message.id === workUnit?.linkedMessageId
  );
  if (relatedMessages.length === 0 || relatedMessages.some((message) => message.teammateId !== teammateId)) {
    return undefined;
  }

  const threadIds = new Set(relatedMessages.map((message) => message.threadId));
  return threadIds.size === 1 ? [...threadIds][0] : undefined;
}
