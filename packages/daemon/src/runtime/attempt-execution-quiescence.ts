import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeAttemptFenceV1 } from "@ling-stack/core";

/** Captured dispatch identity. Never replace it with the successor's active fence. */
export interface AttemptExecutionSource extends RuntimeAttemptFenceV1 { readonly runId: string }
export type HostExecutorKind = "command" | "file_mutation" | "mcp" | "plugin" | "media" | "host_capability"
  | "approval" | "permission" | "approval_review" | "hydration" | "sdk_tool" | "cleanup";
export interface UserInputRequiredIdentity {
  readonly kind: "user_input_required";
  readonly requestId: string;
  readonly requestVersion: number;
}
const hostCallTicketBrand: unique symbol = Symbol("HostCallTicket");
/** Runtime membership, not this structural type or its id, grants access to a ticket. */
export interface HostCallTicket {
  readonly [hostCallTicketBrand]: true;
  readonly id: string;
  readonly source: AttemptExecutionSource;
  readonly kind: HostExecutorKind;
  readonly toolCallId: string;
  readonly parentId?: string;
  readonly producerId?: string;
}
interface SettlementBase {
  readonly schemaVersion: 1;
  readonly source: AttemptExecutionSource;
  readonly operationId: string;
  /** Durable Host fact, independently checked by the executor-specific verifier. */
  readonly evidenceRef: string;
  readonly settledAt: string;
}
/** No SDK callback, elapsed deadline, transport close or leader exit is a settlement. */
export type HostExecutorSettlement = SettlementBase & (
  | { readonly kind: "known_no_start" }
  | { readonly kind: "completed_persisted" | "confirmed_stop";
      readonly physicalScope: "entire_operation"; readonly effects: "none" | "persisted" }
  | { readonly kind: "unknown_outcome"; readonly code: string }
);
export interface HostExecutorBlocker {
  readonly source: AttemptExecutionSource;
  readonly operationId: string;
  readonly kind: HostExecutorKind;
  readonly toolCallId: string;
  readonly parentId?: string;
  readonly producerId?: string;
  readonly state: "unsettled" | "unknown_outcome";
  readonly code: string;
  readonly evidenceRef?: string;
  /** False also covers a failed durable write; either value continues to block. */
  readonly durablyRecorded: boolean;
  readonly settlement?: HostExecutorSettlement;
}
export interface HostExecutorOperationSnapshot {
  readonly ticket: HostCallTicket;
  readonly state: "admitted" | "launched" | "settled" | "blocked";
  readonly settlement?: HostExecutorSettlement;
}
export interface AttemptExecutorSnapshot {
  readonly source: AttemptExecutionSource;
  readonly admission: "open" | "closed";
  readonly requiredInput?: UserInputRequiredIdentity;
  readonly operations: readonly HostExecutorOperationSnapshot[];
}
interface ClosedDrainBase {
  readonly source: AttemptExecutionSource;
  readonly requiredInput: UserInputRequiredIdentity;
}
export type HostExecutorDrainResult = ClosedDrainBase & (
  | { readonly status: "settled"; readonly operations: readonly HostExecutorOperationSnapshot[] }
  | { readonly status: "blocked"; readonly reason: "unknown_outcome" | "observation_timeout";
      readonly blockers: readonly HostExecutorBlocker[] }
);
export interface AttemptExecutorGroupOptions {
  readonly source: AttemptExecutionSource;
  /** Synchronous Host ownership lookup of the captured source, never a model callback. */
  readonly isCurrentExecutionOwner: (source: AttemptExecutionSource) => boolean;
  /** Must independently verify the durable fact and whole-operation physical/effect scope. */
  readonly verifySettlement: (ticket: HostCallTicket, proof: HostExecutorSettlement) => boolean;
  /** Must commit this unknown fact synchronously, returning true only after durable success. */
  readonly persistBlockedOperation: (blocker: HostExecutorBlocker) => boolean;
}
export class AttemptExecutionQuiescenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = "AttemptExecutionQuiescenceError";
  }
}
interface Operation {
  readonly ticket: HostCallTicket;
  launched: boolean;
  verifyingSettlement: boolean;
  settlement?: HostExecutorSettlement;
  durablyRecorded: boolean;
}
const kinds = new Set<HostExecutorKind>(["command", "file_mutation", "mcp", "plugin", "media", "host_capability",
  "approval", "permission", "approval_review", "hydration", "sdk_tool", "cleanup"]);
const sourceKeys = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
const settlementKeys = ["schemaVersion", "source", "operationId", "kind", "evidenceRef", "settledAt"] as const;

/**
 * One dispatch's Host-only admission and quiescence barrier. It does not cancel,
 * release leases, consult ActiveRunRegistry, observe process exits or infer stop.
 * Executor adapters must reserve every background producer before closeAdmission
 * and persist/verify each final fact. The Core transaction is a second barrier.
 */
export class AttemptExecutorGroup {
  readonly #source: AttemptExecutionSource;
  readonly #isCurrentExecutionOwner: AttemptExecutorGroupOptions["isCurrentExecutionOwner"];
  readonly #verifySettlement: AttemptExecutorGroupOptions["verifySettlement"];
  readonly #persistBlockedOperation: AttemptExecutorGroupOptions["persistBlockedOperation"];
  readonly #operations = new Map<HostCallTicket, Operation>();
  readonly #operationKeys = new Set<string>();
  readonly #waiters = new Set<() => void>();
  #requiredInput?: UserInputRequiredIdentity;

  constructor(options: AttemptExecutorGroupOptions) {
    this.#source = readSource(options.source, "Invalid captured execution source.");
    if (typeof options.isCurrentExecutionOwner !== "function" || typeof options.verifySettlement !== "function"
      || typeof options.persistBlockedOperation !== "function") {
      fail("invalid_host_hooks", "Synchronous Host ownership, settlement and persistence hooks are required.");
    }
    this.#isCurrentExecutionOwner = options.isCurrentExecutionOwner;
    this.#verifySettlement = options.verifySettlement;
    this.#persistBlockedOperation = options.persistBlockedOperation;
  }

  get source(): AttemptExecutionSource { return this.#source; }

  isAdmissionOpen(): boolean {
    if (this.#requiredInput) return false;
    return this.#isCurrentExecutionOwner(this.#source) === true && this.#requiredInput === undefined;
  }

  /** Synchronous ownership/admission guard for Host question creation and other authority writes. */
  assertAdmissionOpen(): void {
    this.#assertAdmission();
    this.#assertCurrentOwner();
    this.#assertAdmission();
  }

  /** Synchronous reservation before any await, preparation or effect dispatch. */
  beginHostCall(kind: HostExecutorKind, toolCallId: string): HostCallTicket {
    this.#assertAdmission();
    this.#validateOperationIdentity(kind, toolCallId);
    this.#assertCurrentOwner();
    this.#assertAdmission();
    return this.#register(kind, toolCallId, JSON.stringify([kind, toolCallId]));
  }

  /** Reserve a producer before its parent dispatch can spawn it, not after callback return. */
  registerProducer(parent: HostCallTicket, kind: HostExecutorKind, producerId: string): HostCallTicket {
    const operation = this.#operation(parent);
    this.#assertAdmission();
    this.#assertUnsettled(operation);
    this.#validateOperationIdentity(kind, producerId);
    this.#assertCurrentOwner();
    this.#assertAdmission();
    this.#assertUnsettled(operation);
    return this.#register(kind, parent.toolCallId, JSON.stringify([parent.id, kind, producerId]), parent.id, producerId);
  }

  /** Lock synchronously in the same required-question callback; never reopen this group. */
  closeAdmission(reason: UserInputRequiredIdentity): void {
    const captured = readRequiredIdentity(reason);
    if (this.#requiredInput && !isDeepStrictEqual(this.#requiredInput, captured)) {
      fail("different_request", "Admission is already closed for a different required request.");
    }
    this.#requiredInput ??= captured;
    this.#notify();
  }

  /**
   * Revalidate after awaits, immediately before actual dispatch. Atomic Host
   * journal adapters may use this inside their synchronous launch transaction;
   * otherwise use launchHostEffect to avoid introducing a check/dispatch await.
   */
  assertMayLaunch(ticket: HostCallTicket): void {
    const operation = this.#operation(ticket);
    this.#assertUnsettled(operation);
    this.#assertAdmission();
    this.#assertCurrentOwner();
    this.#assertUnsettled(operation);
    this.#assertAdmission();
  }

  /** Promise success/failure and thrown dispatch errors intentionally leave the ticket unsettled. */
  launchHostEffect<T>(ticket: HostCallTicket, launch: () => T): T {
    this.assertMayLaunch(ticket);
    const operation = this.#operation(ticket);
    if (operation.launched) fail("already_launched", "This operation has already entered its effect launch.");
    if (typeof launch !== "function") fail("invalid_launch", "A synchronous Host launch callback is required.");
    operation.launched = true;
    return launch();
  }

  /**
   * Settle from Host-owned facts only. Unknown outcomes remain immutable durable
   * blockers; an exact failed-persistence retry may record them, but a different
   * proof cannot upgrade them into a safe stop or release this barrier.
   */
  settleHostCall(ticket: HostCallTicket, proof: HostExecutorSettlement): void {
    const operation = this.#operation(ticket);
    if (operation.verifyingSettlement) fail("settlement_in_progress", "Settlement verification is already in progress.");
    const captured = readSettlement(proof);
    if (!isDeepStrictEqual(captured.source, this.#source)) fail("settlement_source", "Settlement source does not match this captured attempt.");
    if (captured.operationId !== ticket.id) fail("settlement_operation", "Settlement operation does not match its Host ticket.");
    if (operation.settlement) {
      if (!isDeepStrictEqual(operation.settlement, captured)) fail("different_settlement", "A different settlement cannot replace the original fact.");
      if (captured.kind === "unknown_outcome" && !operation.durablyRecorded) this.#persistUnknown(operation);
      return;
    }
    if (captured.kind === "known_no_start" && operation.launched) {
      fail("launched_no_start", "An entered effect launch cannot be relabeled as known no-start.");
    }
    if (captured.kind === "unknown_outcome") {
      operation.settlement = captured;
      this.#notify();
      this.#persistUnknown(operation);
      return;
    }
    operation.verifyingSettlement = true;
    try {
      if (this.#verifySettlement(ticket, captured) !== true) fail("unverified_settlement", "Unverified Host settlement cannot prove quiescence.");
      operation.settlement = captured;
      operation.durablyRecorded = true;
    } finally {
      operation.verifyingSettlement = false;
    }
    this.#notify();
  }

  getSnapshot(): AttemptExecutorSnapshot {
    return Object.freeze({ source: this.#source, admission: this.#requiredInput ? "closed" : "open",
      ...(this.#requiredInput ? { requiredInput: this.#requiredInput } : {}), operations: this.#operationSnapshots() });
  }

  /** Wait only for this closed attempt's explicit facts; unknown returns blocked immediately. */
  drain(): Promise<HostExecutorDrainResult> { return this.observeDrain(); }

  /** An observation deadline is not cancellation, settlement or permission to release producers. */
  async observeDrain(timeoutMs?: number): Promise<HostExecutorDrainResult> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) {
      throw new RangeError("Drain timeout must be a finite non-negative timer duration.");
    }
    if (!this.#requiredInput) fail("admission_open", "Cannot drain while Host admission is open.");
    const ready = this.#drainResult(false);
    if (ready) return ready;
    if (timeoutMs === 0) return this.#drainResult(true)!;
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: HostExecutorDrainResult): void => {
        this.#waiters.delete(onChange);
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      const onChange = (): void => {
        const result = this.#drainResult(false);
        if (result) finish(result);
      };
      this.#waiters.add(onChange);
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(this.#drainResult(true)!), timeoutMs);
    });
  }

  #assertAdmission(): void {
    if (this.#requiredInput) fail("admission_closed", "Host executor admission is closed for required input.");
  }
  #assertCurrentOwner(): void {
    if (this.#isCurrentExecutionOwner(this.#source) !== true) fail("stale_owner", "Stale execution owner cannot admit or launch work.");
  }
  #validateOperationIdentity(kind: HostExecutorKind, id: string): void {
    if (!kinds.has(kind) || !isIdentifier(id)) fail("invalid_operation", "Invalid Host executor operation identity.");
  }
  #register(kind: HostExecutorKind, toolCallId: string, key: string, parentId?: string, producerId?: string): HostCallTicket {
    if (this.#operationKeys.has(key)) fail("duplicate_operation", "Duplicate Host operation identity cannot be admitted.");
    const ticket: HostCallTicket = Object.freeze({ [hostCallTicketBrand]: true as const, id: `host_operation_${randomUUID()}`,
      source: this.#source, kind, toolCallId, ...(parentId ? { parentId, producerId } : {}) });
    this.#operationKeys.add(key);
    this.#operations.set(ticket, { ticket, launched: false, verifyingSettlement: false, durablyRecorded: false });
    return ticket;
  }
  #operation(ticket: HostCallTicket): Operation {
    const operation = this.#operations.get(ticket);
    if (!operation) fail("invalid_ticket", "Invalid Host ticket: it was not issued by this attempt group.");
    return operation;
  }
  #assertUnsettled(operation: Operation): void {
    if (operation.verifyingSettlement) fail("settlement_in_progress", "Settlement verification is in progress for this operation.");
    if (operation.settlement) fail("settled_operation", "A settled operation cannot launch or register producers.");
  }
  #persistUnknown(operation: Operation): void {
    operation.verifyingSettlement = true;
    try {
      if (this.#persistBlockedOperation(this.#blocker(operation)) !== true) {
        fail("blocked_persistence", "Blocked operation persistence did not confirm a durable fact.");
      }
      operation.durablyRecorded = true;
    } finally {
      operation.verifyingSettlement = false;
      this.#notify();
    }
  }
  #operationSnapshots(): readonly HostExecutorOperationSnapshot[] {
    return Object.freeze([...this.#operations.values()].map(operation => Object.freeze({ ticket: operation.ticket,
      state: operation.settlement ? operation.settlement.kind === "unknown_outcome" ? "blocked" as const : "settled" as const
        : operation.launched ? "launched" as const : "admitted" as const,
      ...(operation.settlement ? { settlement: operation.settlement } : {}) })));
  }
  #blocker(operation: Operation): HostExecutorBlocker {
    const { ticket, settlement } = operation;
    const unknown = settlement?.kind === "unknown_outcome";
    return Object.freeze({ source: this.#source, operationId: ticket.id, kind: ticket.kind, toolCallId: ticket.toolCallId,
      ...(ticket.parentId ? { parentId: ticket.parentId, producerId: ticket.producerId } : {}),
      state: unknown ? "unknown_outcome" : "unsettled", code: unknown ? settlement.code : "settlement_pending",
      durablyRecorded: operation.durablyRecorded,
      ...(settlement ? { evidenceRef: settlement.evidenceRef, settlement } : {}) });
  }
  #drainResult(observationExpired: boolean): HostExecutorDrainResult | undefined {
    const blockers = [...this.#operations.values()].filter(operation => !operation.settlement || operation.settlement.kind === "unknown_outcome")
      .map(operation => this.#blocker(operation));
    const base = { source: this.#source, requiredInput: this.#requiredInput! };
    if (blockers.length === 0) return Object.freeze({ ...base, status: "settled", operations: this.#operationSnapshots() });
    const unknown = blockers.some(blocker => blocker.state === "unknown_outcome");
    if (unknown || observationExpired) return Object.freeze({ ...base, status: "blocked",
      reason: unknown ? "unknown_outcome" : "observation_timeout", blockers: Object.freeze(blockers) });
    return undefined;
  }
  #notify(): void { for (const waiter of [...this.#waiters]) waiter(); }
}

function fail(code: string, message: string): never { throw new AttemptExecutionQuiescenceError(`attempt_execution_${code}`, message); }
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,512}$/u.test(value);
}
/** Read own data fields only, rejecting extra keys/accessors before evaluating any payload. */
function readRecord(value: unknown, keys: readonly string[], code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) fail(code, message);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field)) fail(code, message);
    copy[key] = field.value;
  }
  return copy;
}
function readSource(value: unknown, message: string): AttemptExecutionSource {
  const fields = readRecord(value, sourceKeys, "invalid_source", message);
  if (!sourceKeys.every(key => isIdentifier(fields[key])) || !/^(0|[1-9][0-9]*)$/u.test(fields.fencingToken as string)) {
    fail("invalid_source", message);
  }
  return Object.freeze(fields) as unknown as AttemptExecutionSource;
}
function readRequiredIdentity(value: unknown): UserInputRequiredIdentity {
  const fields = readRecord(value, ["kind", "requestId", "requestVersion"], "invalid_request", "Invalid required input request identity.");
  if (fields.kind !== "user_input_required" || !isIdentifier(fields.requestId)
    || !Number.isSafeInteger(fields.requestVersion) || (fields.requestVersion as number) < 1) {
    fail("invalid_request", "Invalid required input request identity.");
  }
  return Object.freeze(fields) as unknown as UserInputRequiredIdentity;
}
function readSettlement(value: unknown): HostExecutorSettlement {
  const message = "Invalid Host executor settlement: only closed, whole-operation Host facts are accepted.";
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_settlement", message);
  const field = Object.getOwnPropertyDescriptor(value, "kind");
  if (!field || !("value" in field)) fail("invalid_settlement", message);
  const kind: unknown = field.value;
  const extra = kind === "known_no_start" ? [] : kind === "completed_persisted" || kind === "confirmed_stop" ? ["physicalScope", "effects"]
    : kind === "unknown_outcome" ? ["code"] : undefined;
  if (!extra) fail("invalid_settlement", message);
  const fields = readRecord(value, [...settlementKeys, ...extra], "invalid_settlement", message);
  if (fields.schemaVersion !== 1 || !isIdentifier(fields.operationId) || !isIdentifier(fields.evidenceRef)
    || typeof fields.settledAt !== "string" || !Number.isFinite(Date.parse(fields.settledAt))
    || new Date(fields.settledAt).toISOString() !== fields.settledAt) fail("invalid_settlement", message);
  if (kind === "completed_persisted" || kind === "confirmed_stop") {
    if (fields.physicalScope !== "entire_operation" || (fields.effects !== "none" && fields.effects !== "persisted")) fail("invalid_settlement", message);
  }
  if (kind === "unknown_outcome" && !isIdentifier(fields.code)) fail("invalid_settlement", message);
  fields.source = readSource(fields.source, "Invalid settlement source.");
  return Object.freeze(fields) as unknown as HostExecutorSettlement;
}
