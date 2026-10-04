import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HostOfficeLocalMember, HostOfficeLocalPrepared, HostOfficeLocalTicket, RunStore } from "@ling-stack/core";
import { HOST_OFFICE_LOCAL_PROTOCOL } from "@ling-stack/core";
import type { AttemptHostOperationHandle, AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import type { PreparedOfficeArtifact } from "./office-artifact-preparation.js";
import { copyOfficeLocalSnapshotBytes, revalidateOfficeLocalSnapshot, type OfficeLocalReadSnapshot } from "./office-local-snapshot.js";
import { officeBytesDigest, OfficeLocalMemberLedger } from "./office-local-members.js";

declare const reservationBrand: unique symbol;
declare const planBrand: unique symbol;
export interface OfficeLocalReservation { readonly [reservationBrand]: true }
export interface OfficeLocalWritePlan { readonly executionId: string; readonly [planBrand]: true }
interface ReservationState {
  readonly tracker: AttemptHostOperationTracker;
  readonly store: RunStore;
  readonly parent: AttemptHostOperationHandle;
  readonly producer: AttemptHostOperationHandle;
  readonly toolCallId: string;
  readonly workspacePath: string;
  /** Shared by the original reservation and plan; never copy the closure bit. */
  readonly lifecycle: { closed: boolean; preparationClaimed: boolean };
  prepared: boolean;
}
export interface OfficeLocalWriteState extends ReservationState {
  readonly ticket: HostOfficeLocalTicket;
  readonly prepared: true;
  readonly execution: HostOfficeLocalPrepared;
  readonly identityDigest: string;
  readonly bytes: Buffer;
  readonly inputBytes?: Buffer;
  readonly ledger: OfficeLocalMemberLedger;
  used: boolean;
}
const reservations = new WeakMap<OfficeLocalReservation, ReservationState>();
const plans = new WeakMap<OfficeLocalWritePlan, OfficeLocalWriteState>();

/** Reserve parent and fixed binary producer synchronously, before serialization's first await. */
export function reserveOfficeLocalWriter(tracker: AttemptHostOperationTracker, store: RunStore,
  toolCallId: string, workspaceCwd: string): OfficeLocalReservation {
  tracker.executorGroup.assertAdmissionOpen();
  const run = store.getRun(tracker.source.runId), workspacePath = resolve(workspaceCwd);
  // Alias/noncanonical Run cwd is unsupported, never silently rewritten into authority.
  if (!run || run.cwd !== workspacePath || realpathSync(workspacePath) !== workspacePath
    || !store.isCurrentRunExecutionOwner(run.id, tracker.source)) throw new Error("office_local_workspace_invalid");
  const parent = tracker.beginHostCall("mcp", toolCallId);
  let producer: AttemptHostOperationHandle;
  try { producer = tracker.registerProducer(parent, "file_mutation", "office-local-binary"); }
  catch (error) { try { tracker.settleNoStart(parent); } catch { /* Reserved blockers remain. */ } throw error; }
  const reservation = Object.freeze({}) as OfficeLocalReservation;
  reservations.set(reservation, { tracker, store, parent, producer, toolCallId, workspacePath,
    lifecycle: { closed: false, preparationClaimed: false }, prepared: false });
  return reservation;
}

/** Recheck captured source before reading input, not merely before the subsequent write. */
export function assertOfficeLocalReservation(reservation: OfficeLocalReservation): void {
  const state = reservations.get(reservation);
  if (!state || state.lifecycle.closed) throw new Error("office_local_reservation_closed");
  if (state.prepared || state.lifecycle.preparationClaimed) throw new Error("office_local_reservation_invalid");
  state.tracker.executorGroup.assertAdmissionOpen();
  if (!state.store.isCurrentRunExecutionOwner(state.tracker.source.runId, state.tracker.source)) throw new Error("office_local_source_obsolete");
}

/** Irreversible local closure before settling a reservation or accepting a late serializer result. */
export function closeOfficeLocalReservation(reservation: OfficeLocalReservation): void {
  const state = reservations.get(reservation);
  if (!state) throw new Error("office_local_reservation_invalid");
  state.lifecycle.closed = true;
}

/** Own all bytes/member identities before issuance. The serializer result is data, not a receipt. */
export function prepareOfficeLocalWrite(reservation: OfficeLocalReservation, snapshot: OfficeLocalReadSnapshot,
  artifact: PreparedOfficeArtifact, requestDigest: string, policyDigest: string): OfficeLocalWritePlan {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!;
  const bytes = Buffer.from(artifact.bytes), inputBytes = copyOfficeLocalSnapshotBytes(snapshot);
  revalidateOfficeLocalSnapshot(snapshot);
  if (!isDeepStrictEqual(snapshot.source, state.tracker.source) || snapshot.workspacePath !== state.workspacePath
    || snapshot.format !== artifact.format || resolve(state.workspacePath, artifact.requestedPath) !== snapshot.targetPath
    || bytes.length === 0 || bytes.length > 50 * 1024 * 1024) throw new Error("office_local_preparation_invalid");
  const executionId = randomUUID(), parentPath = dirname(snapshot.targetPath);
  const members: HostOfficeLocalMember[] = [
    { memberId: "target", role: "target", path: snapshot.targetPath, initial: snapshot.input },
    { memberId: "temporary", role: "temporary", path: join(parentPath, `.ling-office-${executionId}.tmp`), initial: { state: "absent" } },
    ...(inputBytes ? [{ memberId: "recovery", role: "recovery" as const,
      path: join(parentPath, `.ling-office-recovery-${executionId}.${artifact.format}`), initial: { state: "absent" as const } }] : []),
    ...snapshot.directories.map((directory, index) => ({ memberId: `directory-${index}`, role: "directory" as const,
      path: directory.path, initial: directory.identity ? { state: "directory" as const, identity: directory.identity } : { state: "absent" as const } })),
  ];
  const ledger = new OfficeLocalMemberLedger(state.workspacePath, members, snapshot.workspaceIdentity);
  const execution: HostOfficeLocalPrepared = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, executionId,
    source: state.tracker.source, parentOperationId: state.parent.operationId, producerOperationId: state.producer.operationId,
    toolCallId: state.toolCallId, toolName: artifact.toolName, format: artifact.format, workspacePath: state.workspacePath,
    workspaceIdentity: snapshot.workspaceIdentity,
    targetPath: snapshot.targetPath, overwrite: artifact.overwrite, requestDigest, policyDigest, input: snapshot.input,
    output: { bytesSha256: officeBytesDigest(bytes), sizeBytes: bytes.length }, members, preparedAt: new Date().toISOString() };
  // Lost INSERT/COMMIT acknowledgements cannot permit a second preparation under
  // this original reservation. This claim is not proof of a prepared execution.
  state.lifecycle.preparationClaimed = true;
  const seal = state.store.createArtifact({ runId: state.tracker.source.runId, type: "json", path: `office/${executionId}/prepared.json`,
    createdAt: new Date().toISOString(), sealedPayload: execution });
  const ticket = state.tracker.prepareOfficeLocalExecution(state.parent, state.producer,
    { executionId, preparedArtifactId: seal.id, preparedDigest: seal.contentSha256! });
  const record = state.store.getHostOfficeLocalExecution(executionId)!;
  state.prepared = true;
  const plan = Object.freeze({ executionId }) as OfficeLocalWritePlan;
  plans.set(plan, { ...state, prepared: true, ticket, execution, identityDigest: record.identityDigest,
    bytes, inputBytes, ledger, used: false });
  return plan;
}

/** Internal fixed writer access. A cloned plan, row, seal or serialized ticket is rejected. */
export function officeLocalWriteState(plan: OfficeLocalWritePlan): OfficeLocalWriteState {
  const state = plans.get(plan);
  if (!state) throw new Error("office_local_write_plan_invalid");
  return state;
}
