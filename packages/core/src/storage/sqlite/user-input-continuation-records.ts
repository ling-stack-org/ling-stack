import type { ConversationDomainRef } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { assertNonSensitiveUserInput, userInputHash, userInputTimestamp } from "./user-input-records.js";
import { readCanonicalItem, type readUserInputDelivery, type UserInputDeliveryReadPorts } from "./user-input-delivery-records.js";

export const USER_INPUT_SEED_USE = "user_input_continuation_seed";
export const userInputSeedId = (deliveryId: string): string => `${USER_INPUT_SEED_USE}:${deliveryId}`;
export type UserInputSeedSource = NonNullable<ReturnType<typeof readUserInputDelivery>>;
export type UserInputSeedPorts = UserInputDeliveryReadPorts & Pick<RunStore,
  "getUserInputWait" | "getEffectiveTurnContextAssignment" | "getContextSegment">;

/** Rebuild only immutable evidence for validation. Never read latest history or another participant. */
export function captureUserInputSeed(
  ports: UserInputSeedPorts, bound: UserInputSeedSource, successorRunId: string, createdAt: string,
  frozenAssignment?: UserInputContinuationSeed["contextAssignment"],
): UserInputContinuationSeed {
  const { delivery, request, answer } = bound, { source } = request;
  const wait = ports.getUserInputWait(source.threadId, request.requestId);
  const assignment = frozenAssignment ?? ports.getEffectiveTurnContextAssignment(source.turnId);
  const segment = assignment ? ports.getContextSegment(assignment.segmentId) : undefined;
  if (!wait || !assignment || !segment || segment.threadId !== source.threadId
    || !Number.isSafeInteger(assignment.revision) || assignment.revision < 1
    || request.waitMode !== "required" || wait.checkpoint.requestId !== request.requestId
    || userInputHash(wait.checkpoint.source) !== userInputHash(source)) throw new UserInputStoreError("invalid_record");
  const timestamp = evidenceTimestamp(createdAt);
  if (timestamp < Math.max(evidenceTimestamp(answer.acceptedAt), evidenceTimestamp(wait.checkpoint.committedAt), evidenceTimestamp(assignment.createdAt))) {
    throw new UserInputStoreError("invalid_record");
  }
  const itemRefs = [source.itemId, request.itemId, answer.itemId].map(id => {
    const item = readCanonicalItem(ports, id);
    if (!item || item.status !== "committed" || item.workspaceId !== source.workspaceId || item.threadId !== source.threadId
      || item.turnId !== source.turnId || item.channelId !== source.channelId || item.visibility !== source.visibility
      || item.visibilityOwnerId !== source.visibilityOwnerId || !Number.isSafeInteger(item.sequence) || item.sequence < 1
      || !Number.isSafeInteger(item.revision) || item.revision < 0) throw new UserInputStoreError("invalid_record");
    return { id, sequence: item.sequence, revision: item.revision, fingerprint: userInputHash(item) };
  });
  if (!(itemRefs[0]!.sequence < itemRefs[1]!.sequence && itemRefs[1]!.sequence < itemRefs[2]!.sequence)) {
    throw new UserInputStoreError("invalid_record");
  }
  const frozenRequest = { requestId: request.requestId, requestVersion: request.requestVersion, itemId: request.itemId,
    toolCallId: request.toolCallId, waitMode: request.waitMode, questions: request.questions, createdAt: request.createdAt };
  const checkpointFingerprint = userInputHash(wait.checkpoint);
  const contextAssignment = { id: assignment.id, revision: assignment.revision, segmentId: assignment.segmentId, createdAt: assignment.createdAt };
  const sourceRefs: ConversationDomainRef[] = [
    ...itemRefs.map(ref => ({ type: "conversation_item" as const, id: ref.id })),
    { type: "user_input_request", id: request.requestId }, { type: "user_input_answer", id: answer.answerId },
    { type: "run", id: source.runId }, { type: "turn", id: source.turnId }, { type: "thread", id: source.threadId },
    { type: "task", id: source.taskBinding.taskId },
    ...(source.workflowStepId ? [{ type: "workflow_step" as const, id: source.workflowStepId }] : []),
  ];
  const projection = {
    projectionVersion: "user-input-answer-v1", policyVersion: "user-input-answer-v1",
    threadId: source.threadId, turnId: source.turnId, segmentId: segment.id,
    throughItemSequence: itemRefs[2]!.sequence, summaryIds: [], sourceRefs,
    sourceStateFingerprint: userInputHash({ itemRefs, frozenRequest, answer, checkpointFingerprint, contextAssignment }),
    visibilityFingerprint: userInputHash({ workspaceId: source.workspaceId, threadId: source.threadId,
      participantId: source.participantId, visibility: source.visibility, visibilityOwnerId: source.visibilityOwnerId }),
  };
  // Serialize under the caller's read-only SQLite window; detach all port-returned objects.
  const body = JSON.parse(JSON.stringify({ id: userInputSeedId(delivery.deliveryId), schemaVersion: 1, use: USER_INPUT_SEED_USE,
    deliveryId: delivery.deliveryId, successorRunId, source, request: frozenRequest, answer,
    checkpoint: wait.checkpoint, checkpointFingerprint, contextAssignment, itemRefs, projection, createdAt })) as Omit<UserInputContinuationSeed, "fingerprint">;
  // Questions/answers are untrusted content; source/checkpoint are validated Host metadata.
  // The required execution fencingToken is not a credential and must remain exact.
  assertNonSensitiveUserInput({ request: body.request, answer: body.answer });
  return freezeUserInputSeed({ ...body, fingerprint: userInputHash(body) });
}

export function freezeUserInputSeed<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeUserInputSeed); Object.freeze(value); }
  return value;
}

/** Invalid persisted timestamps are corruption, not a caller validation error. */
function evidenceTimestamp(value: string): number {
  try { return userInputTimestamp(value); }
  catch (error) {
    if (error instanceof UserInputStoreError && error.code === "invalid_input") throw new UserInputStoreError("invalid_record");
    throw error;
  }
}
