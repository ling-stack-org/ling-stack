import type { HostOfficeLocalSettlement, RunStore } from "@ling-stack/core";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { prepareOfficeArtifact, type OfficeArtifactResultDetails, type OfficeLocalArtifactToolName } from "./office-artifact-preparation.js";
import { readRecord, readString } from "./office-artifact-content.js";
import { assertOfficeLocalReservation, assertOfficeLocalReservationBinding, assertOfficeLocalWriteForwardAuthority,
  blockOfficeLocalReservation, captureOfficeLocalReservationSnapshot,
  closeOfficeLocalReservation, officeLocalWriteState, prepareOfficeLocalWrite, reserveOfficeLocalWriter,
  settleOfficeLocalReservationNoStart, type OfficeLocalReservation, type OfficeLocalWritePlan } from "./office-local-authority.js";
import { copyOfficeLocalSnapshotBytes } from "./office-local-snapshot.js";
import { executeOfficeLocalWrite } from "./office-local-writer.js";

export interface ExecuteOfficeLocalArtifactInput {
  readonly tracker: AttemptHostOperationTracker;
  readonly store: RunStore;
  readonly toolCallId: string;
  readonly workspaceCwd: string;
  readonly toolName: OfficeLocalArtifactToolName;
  readonly input: unknown;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly signal?: AbortSignal;
}
export type OfficeLocalArtifactExecutionResult = OfficeArtifactResultDetails & {
  readonly path: string;
  readonly recoveryPath?: string;
  readonly executionId: string;
  readonly settlement: HostOfficeLocalSettlement;
};
type ExecutionStage = "capture" | "preparation" | "write" | "settlement";

/** Error data is diagnostic, never permission to retry the writer or release its roles. */
export class OfficeLocalExecutionError extends Error {
  constructor(readonly cause: unknown, readonly stage: ExecutionStage, readonly executionId: string | undefined,
    readonly settlementError: unknown = undefined) {
    super("office_local_execution_failed"); this.name = "OfficeLocalExecutionError";
  }
}
const formats = {
  office_create_workbook: "xlsx", office_edit_workbook: "xlsx",
  office_create_document: "docx", office_edit_document: "docx",
  office_create_presentation: "pptx", office_edit_presentation: "pptx",
} as const;

/**
 * Fixed six-tool Host coordinator. Reserve synchronously before the serializer's
 * first await, consume only owned snapshot/SDK bytes, and return only after Core
 * atomically verifies the original parent/producer pair. No old service fallback,
 * generic effect callback, native retry, directory-proof shortcut or U gate.
 */
export async function executeOfficeLocalArtifact(input: ExecuteOfficeLocalArtifactInput): Promise<OfficeLocalArtifactExecutionResult> {
  const reservation = reserveOfficeLocalWriter(input.tracker, input.store, input.toolCallId, input.workspaceCwd);
  return executeReservedOfficeLocalArtifact(reservation, input);
}

/** Reuse only the exact Host reservation acquired at the original MCP callback entry. */
export async function executeReservedOfficeLocalArtifact(reservation: OfficeLocalReservation,
  input: ExecuteOfficeLocalArtifactInput): Promise<OfficeLocalArtifactExecutionResult> {
  const { tracker, store, toolCallId, workspaceCwd, toolName, requestDigest, policyDigest, signal } = input;
  let stage: ExecutionStage = "capture", plan: OfficeLocalWritePlan | undefined;
  const assertForward = (): void => {
    signal?.throwIfAborted();
    if (!plan) assertOfficeLocalReservation(reservation);
    else {
      assertOfficeLocalWriteForwardAuthority(plan);
      tracker.executorGroup.assertAdmissionOpen();
      if (!store.isCurrentRunExecutionOwner(tracker.source.runId, tracker.source)) throw new Error("office_local_source_obsolete");
      tracker.assertOfficeLocalPlanOpen(officeLocalWriteState(plan).ticket);
    }
  };
  try {
    assertOfficeLocalReservationBinding(reservation, { tracker, store, toolCallId, workspaceCwd });
    assertForward();
    if (!Object.hasOwn(formats, toolName)) throw new Error("office_documents_tool_unavailable");
    const ownedInput = structuredClone(readRecord(input.input, "Office local input"));
    const path = readString(ownedInput.path, "path", 4096), format = formats[toolName];
    assertForward();
    const snapshot = captureOfficeLocalReservationSnapshot(reservation, path, format);
    assertForward();
    const bytes = copyOfficeLocalSnapshotBytes(snapshot);
    stage = "preparation";
    const artifact = await prepareOfficeArtifact(toolName, ownedInput, bytes ? { format, bytes } : undefined, signal);
    assertForward();
    plan = prepareOfficeLocalWrite(reservation, snapshot, artifact, requestDigest, policyDigest);
    assertForward();
    stage = "write";
    const written = executeOfficeLocalWrite(plan);
    assertForward();
    stage = "settlement";
    const settlement = tracker.settleOfficeLocalFromStore(officeLocalWriteState(plan).ticket);
    signal?.throwIfAborted();
    return { ...artifact.resultDetails, path: written.path,
      ...(written.recoveryPath ? { recoveryPath: written.recoveryPath } : {}), executionId: plan.executionId, settlement };
  } catch (cause) {
    closeOfficeLocalReservation(reservation); // Latch closure before a late serializer can return.
    let settlementError: unknown;
    try {
      if (plan) tracker.settleOfficeLocalFromStore(officeLocalWriteState(plan).ticket);
      else settleOfficeLocalReservationNoStart(reservation);
    } catch (error) {
      settlementError = error;
      // A missing preparation ACK or unconfirmed original readonly close cannot
      // be downgraded to generic no-start. Original prepared tickets, if retained,
      // remain available to Core reconciliation; no syscall is ever repeated.
      if (!plan) {
        try { blockOfficeLocalReservation(reservation); }
        catch (blockedError) { settlementError = new AggregateError([error, blockedError], "office_local_settlement_unconfirmed"); }
      }
    }
    throw new OfficeLocalExecutionError(cause, stage, plan?.executionId, settlementError);
  }
}
