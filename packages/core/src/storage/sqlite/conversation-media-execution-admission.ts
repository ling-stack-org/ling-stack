import type { DatabaseSync } from "node:sqlite";
import type { CreateOrReuseConversationMediaJobInput } from "../../media-generation-routing-types.js";
import type { CreateWorkUnitInput, WorkUnit } from "../../runtime-supervisor-types.js";
import { redactSecrets } from "../../redaction.js";
import { assertHostOperationLineage, hostOperationFailure, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";

type ExecutionAdmission = NonNullable<CreateOrReuseConversationMediaJobInput["executionAdmission"]>;
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
const validatedAdmissions = new WeakMap<ExecutionAdmission, {
  readonly database: DatabaseSync;
  readonly toolCallId: string;
}>();

/** Must be called inside the job/child creation transaction, before either insert. */
export function assertConversationMediaExecutionAdmission(
  database: DatabaseSync,
  input: CreateOrReuseConversationMediaJobInput,
): ExecutionAdmission | undefined {
  assertMediaCreationTransaction(database);
  const admission = readAdmission(input.executionAdmission, input.runId);
  if (admission) {
    assertHostOperationLineage(database, admission.source);
    if (!isCurrentRunExecutionOwner({ database }, input.runId, admission.source, false)) {
      return hostOperationFailure("media_execution_admission_stale_owner");
    }
    Object.freeze(admission.source);
    Object.freeze(admission);
    validatedAdmissions.set(admission, { database, toolCallId: input.toolCallId });
  }
  return admission;
}

/**
 * Internal, single-use persistence seam for the snapshot validated in this Store.
 * General requests retain ordinary secret redaction, including token-shaped keys.
 * Only the immutable Core-validated admission is restored after redaction; neither
 * a matching JSON shape nor a snapshot from another Store grants this exemption.
 */
export function redactConversationMediaWorkUnitRequest(
  database: DatabaseSync,
  input: CreateWorkUnitInput,
  admission: ExecutionAdmission,
): unknown {
  const validated = validatedAdmissions.get(admission);
  const request = input.request;
  if (!validated || validated.database !== database || input.kind !== "media_job"
    || input.ownerType !== "conversation_run" || input.ownerId !== admission.source.runId
    || input.linkedRunId !== admission.source.runId || !record(request)
    || request.source !== "conversation_media_tool" || request.executionAdmission !== admission
    || request.toolCallId !== validated.toolCallId) {
    return hostOperationFailure("media_execution_admission_invalid");
  }
  const redacted = redactSecrets(request);
  if (!record(redacted)) return hostOperationFailure("media_execution_admission_invalid");
  // Redaction traverses ordinary input. Revalidate after that traversal so even
  // a local accessor cannot close the transaction or replace the captured owner.
  assertMediaCreationTransaction(database);
  assertHostOperationLineage(database, admission.source);
  if (!isCurrentRunExecutionOwner({ database }, admission.source.runId, admission.source, false)) {
    return hostOperationFailure("media_execution_admission_stale_owner");
  }
  validatedAdmissions.delete(admission);
  return { ...redacted, executionAdmission: admission };
}

/** Probe SQLite itself: the JS isTransaction flag is unreliable on supported Node 22. */
function assertMediaCreationTransaction(database: DatabaseSync): void {
  try {
    database.exec("BEGIN DEFERRED");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR"
      && error.message === "cannot start a transaction within a transaction") return;
    throw error;
  }
  // This probe opened only an empty transaction; never roll back a caller's one.
  database.exec("ROLLBACK");
  return hostOperationFailure("media_execution_admission_invalid");
}

/** Missing/present or changed lineage cannot turn a persisted job into a new capability. */
export function assertReusableConversationMediaExecutionAdmission(
  workUnit: WorkUnit,
  input: CreateOrReuseConversationMediaJobInput,
  admission: ExecutionAdmission | undefined,
): void {
  const request = workUnit.request;
  if (!record(request)) return hostOperationFailure("media_execution_admission_invalid");
  const saved = readAdmission(request.executionAdmission, input.runId);
  if (saved && (workUnit.kind !== "media_job" || workUnit.ownerType !== "conversation_run"
    || workUnit.ownerId !== input.runId || workUnit.linkedRunId !== input.runId
    || request.source !== "conversation_media_tool" || request.mediaJobId !== workUnit.linkedMediaJobId)) {
    return hostOperationFailure("media_execution_admission_invalid");
  }
  if (Boolean(saved) !== Boolean(admission)
    || (saved && admission && (saved.requestDigest !== admission.requestDigest
      || !sameHostOperationSource(saved.source, admission.source)
      || request.toolCallId !== input.toolCallId))) {
    return hostOperationFailure("media_execution_admission_conflict");
  }
}

/** Read a strict copied snapshot; an arbitrary persisted object is not trusted admission. */
function readAdmission(value: unknown, runId: string): ExecutionAdmission | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length !== 3
    || ["schemaVersion", "source", "requestDigest"].some(key => !Object.hasOwn(value, key))) {
    return hostOperationFailure("media_execution_admission_invalid");
  }
  // Read each primitive once before validation. Accessor changes cannot turn a
  // validated digest/source into a different value during trusted persistence.
  const schemaVersion = value.schemaVersion;
  const requestDigest = value.requestDigest;
  const sourceValue = value.source;
  if (!record(sourceValue) || Object.keys(sourceValue).length !== sourceKeys.length
    || sourceKeys.some(key => !Object.hasOwn(sourceValue, key))) {
    return hostOperationFailure("media_execution_admission_invalid");
  }
  const source = {
    runId: sourceValue.runId,
    workUnitId: sourceValue.workUnitId,
    attemptId: sourceValue.attemptId,
    runtimeInstanceId: sourceValue.runtimeInstanceId,
    fencingToken: sourceValue.fencingToken,
  };
  if (schemaVersion !== 1 || typeof requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(requestDigest)
    || sourceKeys.some(key => typeof source[key] !== "string" || !/^[a-zA-Z0-9_.:-]{1,512}$/u.test(source[key] as string))
    || !/^(0|[1-9][0-9]*)$/u.test(source.fencingToken as string) || source.runId !== runId) {
    return hostOperationFailure("media_execution_admission_invalid");
  }
  return { schemaVersion: 1, requestDigest, source: {
    runId: source.runId as string,
    workUnitId: source.workUnitId as string,
    attemptId: source.attemptId as string,
    runtimeInstanceId: source.runtimeInstanceId as string,
    fencingToken: source.fencingToken as string,
  } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
