import type { LingThread, LingTurn, RunSession, RunStore, WorkUnit } from "@ling-stack/core";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";

type PublicSnapshotStore = Pick<RunStore, "getLingThread" | "getRun">;
const privateWorkflowInput = "Host-dispatched workflow input (private execution context omitted).";

export function isWorkflowExecutionThread(thread: LingThread | undefined): boolean {
  return thread?.kind === "workflow_step" || isWorkflowStepId(thread?.workflowStepId);
}

export function projectPublicLingThread<T extends LingThread>(thread: T): T {
  return isWorkflowExecutionThread(thread) ? { ...thread, objective: privateWorkflowInput } : thread;
}

function isPrivateWorkflowTurn(turn: LingTurn, thread: LingThread | undefined): boolean {
  return turn.createdByActor === "system" && (turn.kind === "workflow_step"
    || isWorkflowStepId(turn.workflowStepId) || isWorkflowExecutionThread(thread));
}

export function projectPublicLingTurn(turn: LingTurn, thread: LingThread | undefined): LingTurn;
export function projectPublicLingTurn(turn: LingTurn | undefined, thread: LingThread | undefined): LingTurn | undefined;
export function projectPublicLingTurn(turn: LingTurn | undefined, thread: LingThread | undefined): LingTurn | undefined {
  return turn && isPrivateWorkflowTurn(turn, thread) ? { ...turn, userInstruction: privateWorkflowInput } : turn;
}

/** Only Host dispatch input is private, never local-user text, tool JSON or Q&A. */
export function projectPublicConversationItem(item: ConversationItemV1, thread: LingThread, turn?: LingTurn): ConversationItemV1 {
  if (item.kind !== "user_message" || item.actorType !== "system") return item;
  if (item.actorId !== "workflow-dispatch" && !(turn && turn.id === item.turnId
    && turn.threadId === item.threadId && isPrivateWorkflowTurn(turn, thread))) return item;
  return { ...item, payload: { ...item.payload, body: privateWorkflowInput } };
}

/** Recovery input contains private history and Memory, not public execution facts. */
function projectPublicRequestSnapshot<T>(request: T, workflowTask = false): T {
  if (!isRecord(request)) return request;
  const { runnerExecutionInput: _execution, preselectedMemoryUse: _memory,
    systemPrompt: _system, appendSystemPrompt: _appendSystem, ...publicRequest } = request;
  return { ...publicRequest,
    ...(workflowTask && "task" in publicRequest ? { task: projectPublicWorkflowTask(publicRequest.task) } : {}),
  } as T;
}

/** Historical workflow task text may contain owner-only role evidence. */
function projectPublicWorkflowTask<T>(task: T): T {
  if (!isRecord(task)) return task;
  const { prompt: _prompt, ...publicTask } = task;
  return publicTask as T;
}

function isWorkflowStepId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isWorkflowRunSession(run: RunSession, store: PublicSnapshotStore | undefined): boolean {
  return isWorkflowStepId(run.workflowStepId)
    || Boolean(run.threadId && isWorkflowExecutionThread(store?.getLingThread(run.threadId)));
}

/** Project at transport boundaries only. The stored input must remain exact for recovery. */
export function projectPublicRunSession(run: RunSession, store: PublicSnapshotStore | undefined): RunSession;
export function projectPublicRunSession(run: RunSession | undefined, store: PublicSnapshotStore | undefined): RunSession | undefined;
export function projectPublicRunSession(run: RunSession | undefined, store: PublicSnapshotStore | undefined): RunSession | undefined {
  if (!run) return undefined;
  const workflowTask = isWorkflowRunSession(run, store);
  return { ...run,
    taskSnapshot: workflowTask ? projectPublicWorkflowTask(run.taskSnapshot) : run.taskSnapshot,
    requestSnapshot: projectPublicRequestSnapshot(run.requestSnapshot, workflowTask),
  };
}

export function projectPublicWorkUnit(workUnit: WorkUnit, store: PublicSnapshotStore | undefined): WorkUnit;
export function projectPublicWorkUnit(workUnit: WorkUnit | undefined, store: PublicSnapshotStore | undefined): WorkUnit | undefined;
export function projectPublicWorkUnit(workUnit: WorkUnit | undefined, store: PublicSnapshotStore | undefined): WorkUnit | undefined {
  if (!workUnit || !["task_run", "conversation_run", "channel_ai_reply", "teammate_direct_reply"].includes(workUnit.kind)) {
    return workUnit;
  }
  const requestThreadId = isRecord(workUnit.request) ? workUnit.request.threadId : undefined;
  const linkedRun = workUnit.linkedRunId ? store?.getRun(workUnit.linkedRunId) : undefined;
  const threadId = linkedRun?.threadId ?? (typeof requestThreadId === "string" ? requestThreadId : undefined);
  const workflowTask = (isRecord(workUnit.request) && isWorkflowStepId(workUnit.request.workflowStepId))
    || isWorkflowStepId(linkedRun?.workflowStepId)
    || Boolean(threadId && isWorkflowExecutionThread(store?.getLingThread(threadId)));
  return { ...workUnit, request: projectPublicRequestSnapshot(workUnit.request, workflowTask) };
}
