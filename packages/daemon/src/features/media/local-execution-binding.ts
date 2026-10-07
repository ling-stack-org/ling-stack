import type { HostOperationSource, RunStore, WorkUnit } from "@ling-stack/core";
import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle, type MediaLocalExecutionRegistry } from "../../runtime/media-local-executions.js";

type ChildStore = Pick<RunStore, "listWorkUnits">;
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"];

/** Persisted lineage identifies an isolated source, never a reusable execution capability. */
export function hasCapturedMediaExecutionAdmission(workUnit: WorkUnit): boolean {
  return isRecord(workUnit.request) && Object.hasOwn(workUnit.request, "executionAdmission");
}

export function isCapturedConversationMediaJob(store: ChildStore, mediaJobId: string): boolean {
  return children(store, mediaJobId).some(hasCapturedMediaExecutionAdmission);
}

/** Caller IDs, startup recovery and manual generations cannot adopt a previously captured job. */
export function assertConversationMediaLocalBinding(input: {
  readonly store: ChildStore;
  readonly mediaJobId: string;
  readonly registry: MediaLocalExecutionRegistry;
  readonly localExecution: MediaLocalExecutionHandle;
}): void {
  const captured = children(input.store, input.mediaJobId).filter(hasCapturedMediaExecutionAdmission);
  if (captured.length === 0) return;
  if (captured.length !== 1) throw new MediaLocalExecutionAdmissionError("ambiguous_child", "Media execution has ambiguous captured child lineage.");
  const child = captured[0]!;
  const request = isRecord(child.request) ? child.request : {};
  const admission = request.executionAdmission;
  const source = isRecord(admission) ? admission.source : undefined;
  if (!isRecord(admission) || Object.keys(admission).length !== 3 || admission.schemaVersion !== 1
    || typeof admission.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(admission.requestDigest)
    || !isRecord(source) || Object.keys(source).length !== sourceKeys.length
    || sourceKeys.some(key => typeof source[key] !== "string" || !/^[a-zA-Z0-9_.:-]{1,512}$/u.test(source[key] as string))
    || !/^(0|[1-9][0-9]*)$/u.test(source.fencingToken as string)
    || source.runId !== child.linkedRunId || typeof request.toolCallId !== "string") {
    throw new MediaLocalExecutionAdmissionError("invalid_captured_binding", "Media execution admission identity is missing or corrupt.");
  }
  input.registry.assertCapturedBinding(input.localExecution, {
    source: source as unknown as HostOperationSource,
    requestDigest: admission.requestDigest,
    toolCallId: request.toolCallId,
    workUnitId: child.id,
  });
}

function children(store: ChildStore, mediaJobId: string): WorkUnit[] {
  return store.listWorkUnits({ kind: "media_job", linkedMediaJobId: mediaJobId, limit: 500 }).filter(workUnit =>
    workUnit.ownerType === "conversation_run" && isRecord(workUnit.request) && workUnit.request.source === "conversation_media_tool");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
