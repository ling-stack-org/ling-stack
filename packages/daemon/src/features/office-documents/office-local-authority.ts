import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HostOfficeLocalFormat, HostOfficeLocalMember, HostOfficeLocalPrepared, HostOfficeLocalSettlement,
  HostOfficeLocalTicket, RunStore, HostOfficeLocalDirectoryPreparedV2 } from "@ling-stack/core";
import { HOST_OFFICE_LOCAL_PROTOCOL, HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
  HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH } from "@ling-stack/core";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import type { McpBroker } from "../../context.js";
import type { AttemptHostOperationHandle, AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { findHostOfficeLocalFactory } from "../mcp/broker.js";
import { McpHostAdmissionError } from "../mcp/host-operation.js";
import { assertMcpResultAuthorityCurrent, type McpResultAuthority } from "../mcp/result-authority.js";
import type { PreparedOfficeArtifact } from "./office-artifact-preparation.js";
import { captureOfficeLocalSnapshot, copyOfficeLocalSnapshotBytes, revalidateOfficeLocalSnapshot,
  type OfficeLocalReadSnapshot } from "./office-local-snapshot.js";
import { officeBytesDigest, OfficeLocalMemberLedger } from "./office-local-members.js";
import { projectOfficeLocalDirectoryGraph } from "./office-local-directory-graph.js";
import { isOwnedOfficeLocalNativeRuntime, type OfficeLocalNativeRuntime, type OfficeLocalNativeBootstrapInput,
  type OfficeLocalNativeTypedScope } from "./office-local-native-runtime.js";

declare const reservationBrand: unique symbol;
declare const planBrand: unique symbol;
declare const directoryPlanBrand: unique symbol;
export interface OfficeLocalReservation { readonly [reservationBrand]: true }
export interface OfficeLocalWritePlan { readonly executionId: string; readonly [planBrand]: true }
export interface OfficeLocalDirectoryWritePlan { readonly executionId: string; readonly [directoryPlanBrand]: true }
interface OfficeLocalMcpForwardAuthority {
  readonly authority: McpResultAuthority;
  readonly originalBroker: McpBroker;
  readonly factory: McpBroker;
  readonly signal?: AbortSignal;
  readonly store: RunStore;
  readonly workspacePath: string;
}
interface ReservationState {
  readonly tracker: AttemptHostOperationTracker;
  readonly store: RunStore;
  readonly parent: AttemptHostOperationHandle;
  readonly producer: AttemptHostOperationHandle;
  readonly toolCallId: string;
  readonly workspacePath: string;
  /** Shared by the original reservation and plan; never copy the closure bit. */
  readonly lifecycle: { closed: boolean; preparationClaimed: boolean; readStarted: boolean };
  /** Only a successful return from this reservation's original reader proves its closes returned. */
  completedSnapshot?: OfficeLocalReadSnapshot;
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
interface DirectoryBootstrap {
  readonly runtime: OfficeLocalNativeRuntime;
  readonly scope: OfficeLocalNativeTypedScope;
  readonly binding: OfficeLocalNativeBootstrapInput;
}
export interface OfficeLocalDirectoryWriteState extends ReservationState, DirectoryBootstrap {
  readonly ticket: HostOfficeLocalTicket;
  readonly prepared: true;
  readonly execution: HostOfficeLocalDirectoryPreparedV2;
  readonly identityDigest: string;
  readonly bytes: Buffer;
  used: boolean;
}
const directoryBootstrapClaims = new WeakSet<ReservationState>();
const directoryBootstraps = new WeakMap<ReservationState, DirectoryBootstrap>();
const directoryPlans = new WeakMap<OfficeLocalDirectoryWritePlan, OfficeLocalDirectoryWriteState>();
/** Not exposed by officeLocalWriteState: an internal state holder cannot drop or replace this fence. */
const mcpForwardAuthorities = new WeakMap<ReservationState, OfficeLocalMcpForwardAuthority>();

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
    lifecycle: { closed: false, preparationClaimed: false, readStarted: false }, prepared: false });
  return reservation;
}

/** Recheck captured source before reading input, not merely before the subsequent write. */
export function assertOfficeLocalReservation(reservation: OfficeLocalReservation): void {
  const state = reservations.get(reservation);
  if (!state || state.lifecycle.closed) throw new Error("office_local_reservation_closed");
  if (state.prepared || state.lifecycle.preparationClaimed) throw new Error("office_local_reservation_invalid");
  state.tracker.executorGroup.assertAdmissionOpen();
  if (!state.store.isCurrentRunExecutionOwner(state.tracker.source.runId, state.tracker.source)) throw new Error("office_local_source_obsolete");
  assertMcpForwardAuthority(state);
}

/** Bind only the original registered fixed factory and owned permission snapshot, never a caller guard. */
export function bindOfficeLocalMcpForwardAuthority(reservation: OfficeLocalReservation,
  input: { readonly authority: McpResultAuthority; readonly originalBroker: McpBroker;
    readonly factory: McpBroker; readonly signal?: AbortSignal }): void {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!;
  if (mcpForwardAuthorities.has(state) || state.lifecycle.readStarted) throw new Error("office_local_mcp_forward_binding_invalid");
  const authority: McpResultAuthority = structuredClone(input.authority);
  if (authority.bundledActivation) Object.freeze(authority.bundledActivation);
  Object.freeze(authority);
  if (authority.serverId !== OFFICE_DOCUMENTS_MCP_SERVER_ID || !authority.rawName
    || findHostOfficeLocalFactory(input.originalBroker, authority.serverId, authority.rawName, state.workspacePath) !== input.factory) {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "The original registered fixed Office factory is required.");
  }
  const frame = Object.freeze({ authority, originalBroker: input.originalBroker, factory: input.factory, signal: input.signal,
    store: state.store, workspacePath: state.workspacePath });
  assertMcpForwardAuthority(state, frame);
  mcpForwardAuthorities.set(state, frame);
}

/** Static per-effect fence; a plan cannot supply a callback or replace its original MCP frame. */
export function assertOfficeLocalWriteForwardAuthority(plan: OfficeLocalWritePlan): void {
  const state = officeLocalWriteState(plan);
  if (state.lifecycle.closed) throw new Error("office_local_write_closed");
  assertMcpForwardAuthority(state);
}

function assertMcpForwardAuthority(state: ReservationState, frame = mcpForwardAuthorities.get(state)): void {
  if (!frame) return; // Direct non-MCP fixed writers retain their existing Core-only authority.
  frame.signal?.throwIfAborted();
  if (findHostOfficeLocalFactory(frame.originalBroker, OFFICE_DOCUMENTS_MCP_SERVER_ID,
    frame.authority.rawName!, frame.workspacePath) !== frame.factory) {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "The captured Office factory chain is no longer current.");
  }
  assertMcpResultAuthorityCurrent(frame.store, frame.authority);
}

/** Exact original Host object identities, not matching source fields or reopened stores. */
export function assertOfficeLocalReservationBinding(reservation: OfficeLocalReservation,
  input: { readonly tracker: AttemptHostOperationTracker; readonly store: RunStore;
    readonly toolCallId: string; readonly workspaceCwd: string }): void {
  const state = reservations.get(reservation);
  if (!state || state.tracker !== input.tracker || state.store !== input.store || state.toolCallId !== input.toolCallId
    || state.workspacePath !== resolve(input.workspaceCwd)) throw new Error("office_local_reservation_invalid");
}

/** Irreversible local closure before settling a reservation or accepting a late serializer result. */
export function closeOfficeLocalReservation(reservation: OfficeLocalReservation): void {
  const state = reservations.get(reservation);
  if (!state) throw new Error("office_local_reservation_invalid");
  state.lifecycle.closed = true;
}

/**
 * Latch the original read before any native callback can reenter settlement.
 * A thrown capture cannot prove readonly resource closure, even with zero writes.
 * The exact successful snapshot is retained privately, not supplied as a boolean.
 */
export function captureOfficeLocalReservationSnapshot(reservation: OfficeLocalReservation,
  requestedPath: string, format: HostOfficeLocalFormat): OfficeLocalReadSnapshot {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!;
  if (state.lifecycle.readStarted) throw new Error("office_local_snapshot_already_entered");
  state.lifecycle.readStarted = true;
  const snapshot = captureOfficeLocalSnapshot(state.workspacePath, requestedPath, format, state.tracker.source);
  state.completedSnapshot = snapshot;
  assertOfficeLocalReservation(reservation);
  return snapshot;
}

/**
 * Close an unbound reservation using original tracker capabilities only. Before
 * a completed read, no-start is forbidden; a claimed preparation must use its
 * exact Office ticket instead. Required-input closure does not reopen admission.
 */
export function settleOfficeLocalReservationNoStart(reservation: OfficeLocalReservation): HostOfficeLocalSettlement {
  const state = reservations.get(reservation);
  if (!state || state.prepared || state.lifecycle.preparationClaimed) throw new Error("office_local_reservation_invalid");
  state.lifecycle.closed = true;
  if (state.lifecycle.readStarted && !state.completedSnapshot) throw new Error("office_local_snapshot_unconfirmed");
  if (directoryBootstrapClaims.has(state)) {
    const bootstrap = directoryBootstraps.get(state);
    if (!bootstrap) throw new Error("office_local_directory_bootstrap_unconfirmed");
    // Before a native capture, the original Host readonly stage FDs still need
    // a real returned close. A failed bootstrap/close is never generic no-start.
    bootstrap.runtime.revokeScope(bootstrap.scope);
    bootstrap.runtime.closeStage(bootstrap.scope);
  }
  if (!state.store.isCurrentRunExecutionOwner(state.tracker.source.runId, state.tracker.source)) {
    throw new Error("office_local_source_obsolete");
  }
  // The unprepared roles are not an Office execution pair yet. Core verifies
  // the complete child roster before this original MCP parent may close.
  const producer = state.tracker.settleNoStart(state.producer);
  const parent = state.tracker.settleNoStart(state.parent);
  return { parent, producer };
}

/** A closed unknown reservation never grants retry, resource cleanup or a safe receipt. */
export function blockOfficeLocalReservation(reservation: OfficeLocalReservation): void {
  const state = reservations.get(reservation);
  if (!state) throw new Error("office_local_reservation_invalid");
  state.lifecycle.closed = true;
  const errors: unknown[] = [];
  for (const handle of [state.producer, state.parent]) {
    try { state.tracker.markUnknown(handle, "office_local_reservation_unconfirmed"); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "office_local_reservation_unconfirmed");
}

/** Own all bytes/member identities before issuance. The serializer result is data, not a receipt. */
export function prepareOfficeLocalWrite(reservation: OfficeLocalReservation, snapshot: OfficeLocalReadSnapshot,
  artifact: PreparedOfficeArtifact, requestDigest: string, policyDigest: string): OfficeLocalWritePlan {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!;
  if (directoryBootstrapClaims.has(state)) throw new Error("office_local_protocol_mismatch");
  if (state.lifecycle.readStarted && snapshot !== state.completedSnapshot) throw new Error("office_local_preparation_invalid");
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
  const writeState: OfficeLocalWriteState = { ...state, prepared: true, ticket, execution, identityDigest: record.identityDigest,
    bytes, inputBytes, ledger, used: false };
  const frame = mcpForwardAuthorities.get(state);
  if (frame) mcpForwardAuthorities.set(writeState, frame);
  plans.set(plan, writeState);
  return plan;
}

/** Internal fixed writer access. A cloned plan, row, seal or serialized ticket is rejected. */
export function officeLocalWriteState(plan: OfficeLocalWritePlan): OfficeLocalWriteState {
  const state = plans.get(plan);
  if (!state) throw new Error("office_local_write_plan_invalid");
  return state;
}

/** Bootstrap the directory path only from the original reservation's fixed MCP factory frame. */
export function bootstrapOfficeLocalDirectoryScope(reservation: OfficeLocalReservation, runtime: OfficeLocalNativeRuntime): void {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!, frame = mcpForwardAuthorities.get(state);
  if (!frame || !isOwnedOfficeLocalNativeRuntime(runtime) || runtime.store !== state.store
    || directoryBootstrapClaims.has(state)) throw new Error("office_local_directory_bootstrap_invalid");
  const run = state.store.getRun(state.tracker.source.runId);
  if (!run) throw new Error("office_local_source_obsolete");
  const source = state.tracker.source;
  const binding: OfficeLocalNativeBootstrapInput = Object.freeze({ store: state.store, run,
    sourceFence: Object.freeze({ workUnitId: source.workUnitId, attemptId: source.attemptId,
      runtimeInstanceId: source.runtimeInstanceId, fencingToken: source.fencingToken }),
    originalBroker: frame.originalBroker, factory: frame.factory, rawName: frame.authority.rawName!, toolCallId: state.toolCallId });
  // Claim before Host readonly resource acquisition. A missing return cannot
  // justify a second bootstrap or the release of the original reserved pair.
  directoryBootstrapClaims.add(state);
  const scope = runtime.bootstrapStage(binding);
  directoryBootstraps.set(state, Object.freeze({ runtime, scope, binding }));
  runtime.assertScopeBinding(scope, binding);
}

/** Prepare a separate fixed v2 graph; neither a v1 plan nor a serialized scope reference can enter it. */
export function prepareOfficeLocalDirectoryWrite(reservation: OfficeLocalReservation, snapshot: OfficeLocalReadSnapshot,
  artifact: PreparedOfficeArtifact, requestDigest: string, policyDigest: string): OfficeLocalDirectoryWritePlan {
  assertOfficeLocalReservation(reservation);
  const state = reservations.get(reservation)!, bootstrap = directoryBootstraps.get(state);
  if (!bootstrap || snapshot !== state.completedSnapshot || !state.lifecycle.readStarted
    || snapshot.input.state !== "absent" || artifact.overwrite
    || (artifact.toolName !== "office_create_workbook" && artifact.toolName !== "office_create_document"
      && artifact.toolName !== "office_create_presentation")) throw new Error("office_local_preparation_invalid");
  const bytes = Buffer.from(artifact.bytes);
  revalidateOfficeLocalSnapshot(snapshot);
  if (!isDeepStrictEqual(snapshot.source, state.tracker.source) || snapshot.workspacePath !== state.workspacePath
    || snapshot.format !== artifact.format || resolve(state.workspacePath, artifact.requestedPath) !== snapshot.targetPath
    || bytes.length === 0 || bytes.length > 50 * 1024 * 1024) throw new Error("office_local_preparation_invalid");
  bootstrap.runtime.assertScopeBinding(bootstrap.scope, bootstrap.binding);
  const scopeFacts = bootstrap.runtime.scopeFacts(bootstrap.scope), executionId = randomUUID();
  const graph = projectOfficeLocalDirectoryGraph(snapshot, scopeFacts.stagePath, `tree-${executionId}`);
  const execution: HostOfficeLocalDirectoryPreparedV2 = { schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
    graph: HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH, executionId, source: state.tracker.source,
    parentOperationId: state.parent.operationId, producerOperationId: state.producer.operationId,
    toolCallId: state.toolCallId, toolName: artifact.toolName, format: artifact.format,
    workspacePath: state.workspacePath, targetPath: snapshot.targetPath, requestDigest, policyDigest,
    output: { bytesSha256: officeBytesDigest(bytes), sizeBytes: bytes.length }, ...graph,
    scopeRef: scopeFacts.scopeRef, preparedAt: new Date().toISOString() };
  assertMcpForwardAuthority(state);
  bootstrap.runtime.assertScopeBinding(bootstrap.scope, bootstrap.binding);
  state.lifecycle.preparationClaimed = true;
  const seal = state.store.createArtifact({ runId: state.tracker.source.runId, type: "json", path: `office/${executionId}/prepared-v2.json`,
    createdAt: new Date().toISOString(), sealedPayload: execution });
  const ticket = state.tracker.prepareOfficeLocalDirectoryExecutionV2(state.parent, state.producer,
    { executionId, preparedArtifactId: seal.id, preparedDigest: seal.contentSha256! });
  const record = state.store.getHostOfficeLocalDirectoryExecutionV2(executionId);
  if (!record) throw new Error("office_local_preparation_unconfirmed");
  state.prepared = true;
  const plan = Object.freeze({ executionId }) as OfficeLocalDirectoryWritePlan;
  const writeState: OfficeLocalDirectoryWriteState = { ...state, ...bootstrap, prepared: true, ticket, execution,
    identityDigest: record.identityDigest, bytes, used: false };
  const frame = mcpForwardAuthorities.get(state)!;
  mcpForwardAuthorities.set(writeState, frame);
  directoryPlans.set(plan, writeState);
  return plan;
}

/** Internal live frame access only. Persisted rows, scopeRefs and cloned plans never restore it. */
export function officeLocalDirectoryWriteState(plan: OfficeLocalDirectoryWritePlan): OfficeLocalDirectoryWriteState {
  const state = directoryPlans.get(plan);
  if (!state) throw new Error("office_local_directory_plan_invalid");
  return state;
}

/** Recheck both original factory/permission and real Host scope at the actual native callback boundary. */
export function assertOfficeLocalDirectoryWriteForwardAuthority(plan: OfficeLocalDirectoryWritePlan): void {
  const state = officeLocalDirectoryWriteState(plan);
  if (state.lifecycle.closed) throw new Error("office_local_write_closed");
  assertMcpForwardAuthority(state);
  state.runtime.assertScopeBinding(state.scope, state.binding);
}
