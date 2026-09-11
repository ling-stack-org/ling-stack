import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  conversationItemVisibilitiesV1, parseUserInputToolInputV1, userInputRequestStatusesV1,
  type UserInputToolInputV1,
} from "@ling-stack/contracts";
import { redactSecrets } from "../../redaction.js";
import {
  UserInputStoreError, type CreateUserInputRequest, type UserInputRequest, type UserInputSource,
} from "../../user-input-store-types.js";
import { readNumber, readNullableString, readString } from "./helpers.js";

export type UserInputRow = Record<string, SQLOutputValue>;
export function userInputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function assertNonSensitiveUserInput(value: unknown): void {
  if (JSON.stringify(redactSecrets(value)) !== JSON.stringify(value)) throw new UserInputStoreError("sensitive_input");
}
export function userInputTimestamp(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString() !== value) throw new UserInputStoreError("invalid_input");
  return ms;
}
/** Stable envelope: caller property order does not change the idempotency identity. */
export function userInputCreateFingerprint(input: CreateUserInputRequest, toolInput: UserInputToolInputV1): string {
  return userInputHash({
    sourceRunId: input.sourceRunId, sourceItemId: input.sourceItemId,
    sourceFence: { workUnitId: input.sourceFence.workUnitId, attemptId: input.sourceFence.attemptId,
      runtimeInstanceId: input.sourceFence.runtimeInstanceId, fencingToken: input.sourceFence.fencingToken },
    toolCallId: input.toolCallId, idempotencyKey: input.idempotencyKey, toolInput, expiresAt: input.expiresAt,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserInputStoreError("invalid_record");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new UserInputStoreError("invalid_record");
  return value;
}
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : string(value); }

/** Decode persisted Host metadata without re-resolving an old Run against a newer Attempt. */
function sourceFromJson(json: string): UserInputSource {
  const s = object(JSON.parse(json));
  const fence = object(s.fence);
  const taskBinding = object(s.taskBinding);
  if (taskBinding.kind !== "stored_task" && taskBinding.kind !== "run_snapshot") throw new UserInputStoreError("invalid_record");
  const visibility = conversationItemVisibilitiesV1.find(value => value === s.visibility);
  if (!visibility) throw new UserInputStoreError("invalid_record");
  return {
    workspaceId: string(s.workspaceId), threadId: string(s.threadId), turnId: string(s.turnId),
    runId: string(s.runId), taskBinding: { kind: taskBinding.kind, taskId: string(taskBinding.taskId) },
    itemId: string(s.itemId), participantId: string(s.participantId),
    channelId: optionalString(s.channelId), workflowStepId: optionalString(s.workflowStepId),
    fence: { workUnitId: string(fence.workUnitId), attemptId: string(fence.attemptId),
      runtimeInstanceId: string(fence.runtimeInstanceId), fencingToken: string(fence.fencingToken) },
    cwd: string(s.cwd), visibility, visibilityOwnerId: optionalString(s.visibilityOwnerId),
  };
}

export function mapUserInputRequest(row: UserInputRow): UserInputRequest {
  try {
    const source = sourceFromJson(readString(row, "source_json"));
    // Consistency checksum, not a signature or an authorization mechanism.
    if (userInputHash(source) !== row.source_fingerprint) throw new UserInputStoreError("invalid_record");
    const toolInput = parseUserInputToolInputV1(JSON.parse(readString(row, "tool_input_json")));
    const status = userInputRequestStatusesV1.find(value => value === row.status);
    const expiresAt = readNullableString(row, "expires_at");
    if (!toolInput.ok || !status || row.request_version !== 1
      || !Number.isSafeInteger(row.status_revision) || Number(row.status_revision) < 1
      || source.workspaceId !== row.workspace_id || source.threadId !== row.thread_id
      || source.runId !== row.source_run_id || source.fence.attemptId !== row.source_attempt_id
      || (source.visibility === "agent_private") !== (source.visibilityOwnerId !== undefined)) {
      throw new UserInputStoreError("invalid_record");
    }
    const fingerprint = userInputCreateFingerprint({
      sourceRunId: source.runId, sourceItemId: source.itemId, sourceFence: source.fence,
      toolCallId: readString(row, "tool_call_id"), idempotencyKey: readString(row, "idempotency_key"),
      toolInput: toolInput.value, expiresAt,
    }, toolInput.value);
    if (fingerprint !== row.input_fingerprint) throw new UserInputStoreError("invalid_record");
    assertNonSensitiveUserInput(toolInput.value);
    const createdAt = readString(row, "created_at"), updatedAt = readString(row, "updated_at");
    userInputTimestamp(createdAt); userInputTimestamp(updatedAt);
    if (expiresAt !== undefined) userInputTimestamp(expiresAt);
    return { requestId: readString(row, "request_id"), requestVersion: 1,
      statusRevision: readNumber(row, "status_revision"), status, source,
      itemId: readString(row, "item_id"), toolCallId: readString(row, "tool_call_id"),
      waitMode: toolInput.value.waitMode, questions: toolInput.value.questions,
      createdAt, updatedAt, ...(expiresAt ? { expiresAt } : {}) };
  } catch {
    throw new UserInputStoreError("invalid_record");
  }
}
