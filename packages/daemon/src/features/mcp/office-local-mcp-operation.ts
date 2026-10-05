import { digestHarnessToolValue, type RunStore } from "@ling-stack/core";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker, McpBrokerOptions } from "../../context.js";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import type { OfficeLocalArtifactToolName } from "../office-documents/office-artifact-preparation.js";
import { bindOfficeLocalMcpForwardAuthority, blockOfficeLocalReservation, closeOfficeLocalReservation, reserveOfficeLocalWriter,
  settleOfficeLocalReservationNoStart, type OfficeLocalReservation } from "../office-documents/office-local-authority.js";
import { executeReservedOfficeLocalArtifact } from "../office-documents/office-local-execution.js";
import { findHostOfficeLocalFactory } from "./broker.js";
import { McpHostAdmissionError } from "./host-operation.js";
import { assertMcpResultAuthorityCurrent, type McpResultAuthority } from "./result-authority.js";

declare const officeOperationBrand: unique symbol;
/** Independent Host capability; it is not a generic MCP transport operation. */
export interface HostOfficeLocalMcpOperation { readonly [officeOperationBrand]: true }
interface OfficeOperationState {
  readonly broker: McpBroker;
  readonly factory: McpBroker;
  readonly tracker: AttemptHostOperationTracker;
  readonly store: RunStore;
  readonly reservation: OfficeLocalReservation;
  readonly workspaceCwd: string;
  readonly toolCallId: string;
  readonly toolName: OfficeLocalArtifactToolName;
  readonly originalInput: unknown;
  readonly ownedInput: unknown;
  readonly signal?: AbortSignal;
  readonly approval: string;
  authority?: McpResultAuthority;
  started: boolean;
  finished: boolean;
}
const operations = new WeakMap<HostOfficeLocalMcpOperation, OfficeOperationState>();
const localTools = new Set<string>(["office_create_workbook", "office_edit_workbook", "office_create_document",
  "office_edit_document", "office_create_presentation", "office_edit_presentation"]);
export function isOfficeLocalArtifactToolName(value: string): value is OfficeLocalArtifactToolName { return localTools.has(value); }
const reject = (): never => { throw new McpHostAdmissionError("mcp_host_admission_unsupported", "The original fixed Office factory and captured Host capability are required."); };
function stateFor(operation: HostOfficeLocalMcpOperation): OfficeOperationState {
  return operations.get(operation) ?? reject();
}

/** Reserve the original pair before callbacks/awaits; no input capability or arbitrary executor is accepted. */
export function reserveHostOfficeLocalMcpOperation(input: {
  readonly broker: McpBroker; readonly tracker: AttemptHostOperationTracker; readonly store: RunStore;
  readonly workspaceCwd: string; readonly toolCallId: string; readonly toolName: OfficeLocalArtifactToolName;
  readonly input: unknown; readonly signal?: AbortSignal; readonly approval: string;
}): HostOfficeLocalMcpOperation {
  const factory = findHostOfficeLocalFactory(input.broker, OFFICE_DOCUMENTS_MCP_SERVER_ID, input.toolName, input.workspaceCwd) ?? reject();
  const reservation = reserveOfficeLocalWriter(input.tracker, input.store, input.toolCallId, input.workspaceCwd);
  try {
    const ownedInput = structuredClone(input.input), operation = Object.freeze({}) as HostOfficeLocalMcpOperation;
    operations.set(operation, { ...input, factory, reservation, originalInput: input.input, ownedInput, started: false, finished: false });
    return operation;
  } catch (error) {
    try { settleOfficeLocalReservationNoStart(reservation); }
    catch (settlementError) {
      try { blockOfficeLocalReservation(reservation); } catch { /* Original blockers remain. */ }
      throw new AggregateError([error, settlementError], "office_local_settlement_unconfirmed");
    }
    throw error;
  }
}

/** Bind the permission revision once, before execution; data cannot substitute for the original scope. */
export function bindHostOfficeLocalMcpAuthority(operation: HostOfficeLocalMcpOperation, authority: McpResultAuthority): void {
  const state = stateFor(operation);
  if (state.finished || state.started || state.authority || authority.serverId !== OFFICE_DOCUMENTS_MCP_SERVER_ID
    || authority.rawName !== state.toolName) reject();
  assertMcpResultAuthorityCurrent(state.store, authority);
  const ownedAuthority: McpResultAuthority = structuredClone(authority);
  if (ownedAuthority.bundledActivation) Object.freeze(ownedAuthority.bundledActivation);
  Object.freeze(ownedAuthority);
  bindOfficeLocalMcpForwardAuthority(state.reservation, { authority: ownedAuthority, originalBroker: state.broker,
    factory: state.factory, signal: state.signal });
  state.authority = ownedAuthority;
}

/** Verify the immutable factory chain at every delegation, not merely the requested tool string. */
export function assertHostOfficeLocalMcpAdmission(operation: HostOfficeLocalMcpOperation,
  broker: McpBroker, serverId: string, toolName: string): void {
  const state = stateFor(operation);
  if (state.finished || serverId !== OFFICE_DOCUMENTS_MCP_SERVER_ID || toolName !== state.toolName
    || findHostOfficeLocalFactory(state.broker, serverId, toolName, state.workspaceCwd) !== state.factory
    || findHostOfficeLocalFactory(broker, serverId, toolName, state.workspaceCwd) !== state.factory) reject();
}

/** Consumer fence after await; a completed physical receipt does not authorize stale projection. */
export function assertHostOfficeLocalMcpResultCurrent(operation: HostOfficeLocalMcpOperation): void {
  const state = stateFor(operation);
  assertHostOfficeLocalMcpAdmission(operation, state.broker, OFFICE_DOCUMENTS_MCP_SERVER_ID, state.toolName);
  state.signal?.throwIfAborted();
  state.tracker.executorGroup.assertAdmissionOpen();
  if (!state.store.isCurrentRunExecutionOwner(state.tracker.source.runId, state.tracker.source)) reject();
  const authority = state.authority ?? reject();
  assertMcpResultAuthorityCurrent(state.store, authority);
}

/** The only tracked owned dispatcher is this static six-tool byte executor. */
export async function executeHostOfficeLocalMcpOperation(operation: HostOfficeLocalMcpOperation, factory: McpBroker,
  options: McpBrokerOptions, toolName: string, toolInput: unknown): Promise<PiRunnerMcpToolCallResult> {
  const state = stateFor(operation);
  assertHostOfficeLocalMcpAdmission(operation, factory, OFFICE_DOCUMENTS_MCP_SERVER_ID, toolName);
  if (state.factory !== factory || state.started || !state.authority || options.hostOperation
    || options.officeLocalOperation !== operation || options.workspaceCwd !== state.workspaceCwd
    || options.runId !== state.tracker.source.runId || options.toolCallId !== state.toolCallId
    || options.signal !== state.signal || toolInput !== state.originalInput) reject();
  // Parameter construction can throw (cycle/BigInt/deep cloneable inputs). Until
  // the original coordinator is actually entered, finish owns genuine no-start.
  const executionInput = { tracker: state.tracker, store: state.store,
    toolCallId: state.toolCallId, workspaceCwd: state.workspaceCwd, toolName: state.toolName, input: state.ownedInput,
    requestDigest: digestHarnessToolValue({ toolName: state.toolName, input: state.ownedInput }),
    policyDigest: digestHarnessToolValue({ protocol: "ling-office-local-binary-v1", authority: state.authority, approval: state.approval }),
    signal: state.signal };
  state.started = true;
  const result = await executeReservedOfficeLocalArtifact(state.reservation, executionInput);
  assertHostOfficeLocalMcpResultCurrent(operation);
  // Physical receipts remain in Core. Preserve the existing tool result shape;
  // a serializable receipt or a tool callback never becomes execution authority.
  const { executionId: _executionId, settlement: _settlement, ...data } = result;
  const text = JSON.stringify({ toolName: state.toolName, data });
  if (text.length > 512 * 1024) throw new Error("office_documents_result_too_large");
  return { content: [{ type: "text", text }], details: data };
}

/** No generic transport finish and no inference from a callback result. */
export function finishHostOfficeLocalMcpOperation(operation: HostOfficeLocalMcpOperation): void {
  const state = stateFor(operation);
  if (state.finished) return;
  state.finished = true;
  closeOfficeLocalReservation(state.reservation);
  if (state.started) return; // The original coordinator alone handles its prepared ticket.
  try { settleOfficeLocalReservationNoStart(state.reservation); }
  catch (error) {
    try { blockOfficeLocalReservation(state.reservation); }
    catch (blockedError) { throw new AggregateError([error, blockedError], "office_local_settlement_unconfirmed"); }
    throw error;
  }
}
