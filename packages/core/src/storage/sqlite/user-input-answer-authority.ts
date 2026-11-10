import { timingSafeEqual } from "node:crypto";
import type { UserInputAnswerAuthorityV1 } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import { UserInputStoreError, type UserInputRequest, type UserInputSource } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { userInputHash, userInputTimestamp } from "./user-input-records.js";
import type { UserInputSourcePorts } from "./user-input-source.js";
import { assertUserInputWaitingSource } from "./user-input-wait-source.js";

export type UserInputAnswerAuthorityPorts = UserInputSourcePorts & Pick<RunStore, "getUserInputWait">;

/**
 * Project a short-lived public optimistic authority for the exact request
 * snapshot. The opaque token is derived from private Host source lineage, but
 * is not itself a runtime fence, permission grant, delivery claim or Runner ACK.
 */
export function projectUserInputAnswerAuthority(
  context: SqliteStoreContext,
  ports: UserInputAnswerAuthorityPorts,
  request: UserInputRequest,
  now: string,
): UserInputAnswerAuthorityV1 | undefined {
  const nowMs = userInputTimestamp(now);
  if (request.status !== "pending" || request.expiresAt && nowMs >= userInputTimestamp(request.expiresAt)) return undefined;
  const thread = ports.getLingThread(request.source.threadId);
  if (!thread || thread.status === "archived" || thread.workspaceId !== request.source.workspaceId) return undefined;
  if (isCurrentRunExecutionOwner(context, request.source.runId, request.source.fence, false)) {
    if (!matchesActiveSource(ports, request.source)) return undefined;
  } else {
    const wait = ports.getUserInputWait(request.source.threadId, request.requestId);
    if (!wait || wait.status !== "waiting") return undefined;
    try {
      assertUserInputWaitingSource(ports, request, wait);
    } catch (error) {
      if (error instanceof UserInputStoreError && error.code === "source_conflict") return undefined;
      throw error;
    }
  }
  return authorityFor(request, request.statusRevision);
}

/** Validate public lineage and token, optionally requiring current answerability. */
export function assertUserInputAnswerAuthority(
  context: SqliteStoreContext,
  ports: UserInputAnswerAuthorityPorts,
  request: UserInputRequest,
  authority: UserInputAnswerAuthorityV1,
  now: string,
  options: { readonly requireCurrent: boolean },
): void {
  const expected = authorityFor(request, authority.statusRevision);
  if (authority.schemaVersion !== 1 || authority.threadId !== request.source.threadId
    || authority.runId !== request.source.runId || authority.attemptId !== request.source.fence.attemptId
    || authority.participantId !== request.source.participantId || authority.requestId !== request.requestId
    || authority.requestVersion !== request.requestVersion || !sameToken(authority.token, expected.token)) {
    throw new UserInputStoreError("source_conflict");
  }
  if (!options.requireCurrent) return;
  const current = projectUserInputAnswerAuthority(context, ports, request, now);
  if (!current || authority.statusRevision !== request.statusRevision || !sameToken(authority.token, current.token)) {
    throw new UserInputStoreError("stale_request");
  }
}

function authorityFor(request: UserInputRequest, statusRevision: number): UserInputAnswerAuthorityV1 {
  return {
    schemaVersion: 1,
    threadId: request.source.threadId,
    runId: request.source.runId,
    attemptId: request.source.fence.attemptId,
    participantId: request.source.participantId,
    requestId: request.requestId,
    requestVersion: request.requestVersion,
    statusRevision,
    token: userInputHash({
      schemaVersion: 1,
      kind: "user_input_answer_authority",
      source: request.source,
      requestId: request.requestId,
      requestVersion: request.requestVersion,
      statusRevision,
    }),
  };
}

function sameToken(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !/^[a-f0-9]{64}$/u.test(left)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function matchesActiveSource(ports: UserInputAnswerAuthorityPorts, source: UserInputSource): boolean {
  const run = ports.getRun(source.runId);
  const unit = ports.getWorkUnit(source.fence.workUnitId);
  const attempt = ports.getWorkUnitAttempt(source.fence.attemptId);
  const thread = ports.getLingThread(source.threadId);
  const turn = ports.getLingTurnForRun(source.runId);
  if (!run || !unit || !attempt || !thread || !turn || thread.status === "archived"
    || run.threadId !== source.threadId || turn.id !== source.turnId || run.workUnitId !== source.fence.workUnitId
    || run.taskId !== source.taskBinding.taskId || run.cwd !== source.cwd || run.channelId !== source.channelId
    || run.workflowStepId !== source.workflowStepId || (run.teammateId ?? "ling_agent") !== source.participantId
    || unit.workspaceId !== source.workspaceId || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id
    || attempt.workUnitId !== unit.id || attempt.runtimeInstanceId !== source.fence.runtimeInstanceId
    || attempt.fencingToken !== source.fence.fencingToken || thread.workspaceId !== source.workspaceId
    || thread.channelId !== source.channelId || turn.id !== source.turnId || turn.threadId !== source.threadId
    || turn.channelId !== source.channelId || (thread.kind === "teammate_direct" && thread.teammateId !== source.participantId)
    || (unit.teammateId !== undefined && unit.teammateId !== source.participantId)
    || (unit.channelId !== undefined && unit.channelId !== source.channelId)) return false;
  const task = ports.getTask(source.taskBinding.taskId);
  if (source.taskBinding.kind === "stored_task" ? !task : task !== undefined) return false;
  if (source.workflowStepId) {
    const step = ports.getChannelWorkflowStep(source.workflowStepId);
    if (!step || !["running", "waiting_for_approval"].includes(step.status) || step.runId !== run.id
      || step.workspaceId !== source.workspaceId || step.channelId !== source.channelId
      || step.toParticipantId !== source.participantId) return false;
  }
  return true;
}
