import type {
  AdmitHostOperationInput, HostOperationEvidenceRef, HostOperationRecord, HostOperationSettlementInput,
  HostOperationSource, HostOperationTicket,
} from "../../host-operation-journal-types.js";
import {
  assertHostOperationLineage, hostOperationDomainIdentity, hostOperationFailure, hostOperationText,
  hostOperationTimestamp, readHostOperation, readSourceHostOperations, sameHostOperationSource,
  verifyHostOperationSafe, type StoredHostOperation,
} from "./host-operation-journal-evidence.js";
import { isCapturedCancelledRunOwner, isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { HostMediaExecutionRecord } from "../../host-media-operation-types.js";
import { HostOfficeLocalJournalGate } from "./host-office-local-journal-gate.js";
import { assertHostLaunchPreflight } from "./host-launch-preflight.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";

interface TicketState {
  readonly source: HostOperationSource;
  launchClaimed: boolean;
  /** Callback/COMMIT failure cannot be reclassified as an operation that never launched. */
  uncertainLaunch: boolean;
  noStartClosed: boolean;
  noStartReceiptDigest?: string;
  settlementSignature?: string;
}
const kinds = new Set(["command", "file_mutation", "mcp", "plugin", "media", "host_capability",
  "approval", "permission", "approval_review", "hydration", "sdk_tool", "cleanup"]);

/**
 * Host-only durable admission and exact executor binding. All mutations use the
 * same SQLite write lock as source validation. A row left admitted after a crash
 * is a blocker, never evidence of no physical effect; replay creates no ticket.
 */
export class SqliteHostOperationJournalStore {
  private readonly tickets = new WeakMap<HostOperationTicket, TicketState>();
  /** Memory-only lifecycle closure of original Office roles, independent of persisted settlement intent. */
  private readonly closedOfficeOperations = new Set<string>();
  /** V2 original close forbids cleanup effects below either role without changing the V1 cleanup contract. */
  private readonly closedDirectoryOfficeEffects = new Set<string>();
  private readonly closeDatabase: () => void;
  private readonly rollbackDatabase: () => void;
  readonly officeLocal: HostOfficeLocalJournalGate;
  constructor(private readonly context: SqliteStoreContext) {
    // Retain the original native close before an executor can wrap the public
    // method. A failed rollback must invalidate every shared SQL reference.
    this.closeDatabase = context.database.close.bind(context.database);
    const exec = context.database.exec.bind(context.database);
    this.rollbackDatabase = () => { exec("ROLLBACK"); };
    this.officeLocal = new HostOfficeLocalJournalGate(context, {
      ticket: ticket => this.requireTicket(ticket),
      operation: (ticket, state) => this.requireOperation(ticket, state),
      owner: (source, cleanup) => this.assertOwner(source, cleanup),
      forward: source => this.assertForwardAdmission(source),
      parents: operation => this.assertParentsActive(operation),
      closeOffice: (parent, producer) => { this.closedOfficeOperations.add(parent); this.closedOfficeOperations.add(producer); },
      closeDirectoryOffice: (parent, producer) => {
        this.closedOfficeOperations.add(parent); this.closedOfficeOperations.add(producer);
        this.closedDirectoryOfficeEffects.add(parent); this.closedDirectoryOfficeEffects.add(producer);
      },
      synchronous: callback => this.assertSyncCallback(callback),
      synchronousResult: result => this.assertSyncResult(result),
      transaction: callback => this.transaction(callback),
    });
  }

  admitHostOperation(input: AdmitHostOperationInput): HostOperationTicket {
    const operationId = input.operationId, source = Object.freeze({ ...input.source }), kind = input.kind;
    const toolCallId = input.toolCallId, parentOperationId = input.parentOperationId, producerId = input.producerId;
    const admittedAt = input.admittedAt ?? new Date().toISOString();
    if (!hostOperationText(operationId) || !hostOperationText(toolCallId) || !kinds.has(kind)
      || (parentOperationId === undefined) !== (producerId === undefined)
      || (parentOperationId !== undefined && (!hostOperationText(parentOperationId) || !hostOperationText(producerId)))) {
      return hostOperationFailure("host_operation_invalid_admission");
    }
    hostOperationTimestamp(admittedAt);
    this.transaction(() => {
      this.assertOwner(source, false);
      this.assertForwardAdmission(source);
      if (readHostOperation(this.context.database, operationId)) return hostOperationFailure("host_operation_already_admitted");
      const duplicate = parentOperationId
        ? this.context.database.prepare("SELECT 1 FROM host_operations WHERE parent_operation_id=? AND kind=? AND producer_id=?")
          .get(parentOperationId, kind, producerId!)
        : this.context.database.prepare("SELECT 1 FROM host_operations WHERE attempt_id=? AND kind=? AND tool_call_id=? AND parent_operation_id IS NULL")
          .get(source.attemptId, kind, toolCallId);
      if (duplicate) return hostOperationFailure("host_operation_already_admitted");
      if (parentOperationId) {
        const parent = readHostOperation(this.context.database, parentOperationId);
        if (!parent || !sameHostOperationSource(parent.source, source) || parent.toolCallId !== toolCallId
          || !["admitted","launched"].includes(parent.phase) || hostOperationTimestamp(parent.admittedAt) > hostOperationTimestamp(admittedAt)) {
          return hostOperationFailure("host_operation_invalid_parent");
        }
        this.assertOfficeForwardOpen(parent);
      }
      this.context.database.prepare(`INSERT INTO host_operations(operation_id,schema_version,run_id,work_unit_id,
        attempt_id,runtime_instance_id,fencing_token,kind,tool_call_id,parent_operation_id,producer_id,phase,admitted_at)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,'admitted',?)`).run(operationId, source.runId, source.workUnitId, source.attemptId,
          source.runtimeInstanceId, source.fencingToken, kind, toolCallId, parentOperationId ?? null, producerId ?? null, admittedAt);
    });
    const ticket = Object.freeze({ operationId }) as HostOperationTicket;
    this.tickets.set(ticket, { source, launchClaimed: false, uncertainLaunch: false, noStartClosed: false });
    return ticket;
  }

  bindHostOperationEvidence(ticket: HostOperationTicket, input: HostOperationEvidenceRef): HostOperationRecord {
    const state = this.requireTicket(ticket);
    const evidence: HostOperationEvidenceRef = { kind: input.kind, id: input.id };
    return this.transaction(() => {
      this.assertOwner(state.source, true);
      const operation = this.requireOperation(ticket, state);
      if (operation.evidenceRef) {
        if (operation.evidenceRef.kind !== evidence.kind || operation.evidenceRef.id !== evidence.id) {
          return hostOperationFailure("host_operation_binding_conflict");
        }
        if (hostOperationDomainIdentity(this.context.database, operation, evidence, false) !== operation.domainIdentityDigest) {
          return hostOperationFailure("host_operation_evidence_invalid");
        }
        return this.verifiedRecord(operation);
      }
      if (operation.phase !== "admitted" || state.launchClaimed || state.settlementSignature) return hostOperationFailure("host_operation_binding_too_late");
      if (this.context.database.prepare("SELECT 1 FROM host_operations WHERE evidence_kind=? AND evidence_id=?")
        .get(evidence.kind, evidence.id)) return hostOperationFailure("host_operation_evidence_already_bound");
      const identity = hostOperationDomainIdentity(this.context.database, operation, evidence, true);
      const updated = this.context.database.prepare(`UPDATE host_operations SET evidence_kind=?,evidence_id=?,
        domain_identity_digest=?,revision=revision+1 WHERE operation_id=? AND revision=? AND phase='admitted' AND evidence_id IS NULL`)
        .run(evidence.kind, evidence.id, identity, ticket.operationId, operation.revision);
      if (updated.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
      return this.requireOperation(ticket, state);
    });
  }

  launchHostOperation<T>(ticket: HostOperationTicket, launch: () => T, assertMayLaunch?: () => void): T {
    const state = this.requireTicket(ticket);
    if (state.launchClaimed || state.settlementSignature) return hostOperationFailure("host_operation_already_launched");
    this.assertSyncCallback(launch);
    let entered = false;
    try {
      return this.transaction(() => {
        this.assertOwner(state.source, false);
        this.assertForwardAdmission(state.source);
        const operation = this.requireOperation(ticket, state);
        this.assertGenericEffectScope(operation);
        if (operation.phase !== "admitted") return hostOperationFailure("host_operation_already_launched");
        this.assertParentsActive(operation);
        // Policy/source gates may refuse without creating a launch marker or
        // consuming either live capability. Never reset a claimed launch.
        assertHostLaunchPreflight(this.context.database, assertMayLaunch);
        const launchedAt = new Date().toISOString();
        if (hostOperationTimestamp(launchedAt) < hostOperationTimestamp(operation.admittedAt)) return hostOperationFailure("host_operation_invalid_timestamp");
        const updated = this.context.database.prepare(`UPDATE host_operations SET phase='launched',launched_at=?,
          revision=revision+1 WHERE operation_id=? AND revision=? AND phase='admitted'`)
          .run(launchedAt, ticket.operationId, operation.revision);
        if (updated.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
        state.launchClaimed = true; // Survives rollback or COMMIT failure after an actual effect.
        entered = true;
        return readSqliteWithinTransaction(this.context.database, launch);
      });
    } catch (error) {
      if (entered) state.uncertainLaunch = true;
      throw error;
    }
  }

  /** Forward writes respect required-input closure; bounded rollback uses only the original source. */
  continueHostOperationEffect<T>(ticket: HostOperationTicket, effect: () => T, mode: "forward" | "cleanup" = "forward"): T {
    const state = this.requireTicket(ticket);
    if ((mode !== "forward" && mode !== "cleanup") || !state.launchClaimed || state.settlementSignature) {
      return hostOperationFailure("host_operation_not_launched");
    }
    this.assertSyncCallback(effect);
    let entered = false;
    try {
      return this.transaction(() => {
        this.assertOwner(state.source, mode === "cleanup");
        if (mode === "forward") this.assertForwardAdmission(state.source);
        const operation = this.requireOperation(ticket, state);
        this.assertGenericEffectScope(operation);
        // A failed launch COMMIT may have rolled the durable marker back to admitted.
        // Only its original live ticket can perform cleanup; forward launch remains forbidden.
        if (operation.phase !== "launched" && !(mode === "cleanup" && state.uncertainLaunch && operation.phase === "admitted")) {
          return hostOperationFailure("host_operation_not_launched");
        }
        if (mode === "forward" && state.uncertainLaunch) return hostOperationFailure("host_operation_launch_unknown");
        this.assertParentsActive(operation, mode === "cleanup");
        entered = true;
        return readSqliteWithinTransaction(this.context.database, effect);
      });
    } catch (error) {
      if (entered) state.uncertainLaunch = true;
      throw error;
    }
  }

  settleHostOperation(ticket: HostOperationTicket, input: HostOperationSettlementInput): HostOperationRecord {
    const state = this.requireTicket(ticket);
    const kind = input.kind, settledAt = input.settledAt ?? new Date().toISOString();
    const code = kind === "unknown_outcome" ? input.code : undefined;
    if (!["known_no_start","file_completed","unknown_outcome", "media_response_completed", "media_remote_terminal", "media_chain_completed",
      "office_local_chain_completed", "office_local_binary_completed"].includes(kind)
      || (kind === "unknown_outcome" && !hostOperationText(code))) return hostOperationFailure("host_operation_invalid_settlement");
    hostOperationTimestamp(settledAt);
    const signature = JSON.stringify({ kind, settledAt, code });
    if (state.settlementSignature && state.settlementSignature !== signature) return hostOperationFailure("host_operation_settlement_conflict");
    return this.transaction(() => {
      const operation = this.requireOperation(ticket, state);
      // Office success/no-start must never be split across independent journal
      // transactions or borrowed from the old patch verifier. Unknown is still a blocker.
      if (kind !== "unknown_outcome" && (kind === "office_local_chain_completed" || kind === "office_local_binary_completed"
        || operation.evidenceRef?.kind === "office_local_chain_execution" || operation.evidenceRef?.kind === "office_local_binary_execution")) {
        return hostOperationFailure("host_office_local_pair_settlement_required");
      }
      if (operation.settlementSignature) {
        if (operation.settlementSignature !== signature) return hostOperationFailure("host_operation_settlement_conflict");
        return this.verifiedRecord(operation);
      }
      if (hostOperationTimestamp(settledAt) < hostOperationTimestamp(operation.launchedAt ?? operation.admittedAt)) {
        return hostOperationFailure("host_operation_invalid_timestamp");
      }
      if (kind === "known_no_start" || kind === "file_completed") {
        assertHostOperationLineage(this.context.database, state.source);
        if (!isCurrentRunExecutionOwner(this.context, state.source.runId, state.source, true)
          && !isCapturedCancelledRunOwner(this.context, state.source.runId, state.source)) {
          return hostOperationFailure("host_operation_stale_owner");
        }
      } else if (kind !== "unknown_outcome") this.assertOwner(state.source, true);
      if (kind === "known_no_start" && (state.launchClaimed || operation.phase !== "admitted")) {
        return hostOperationFailure("host_operation_launched_no_start");
      }
      if (kind !== "known_no_start" && kind !== "unknown_outcome"
        && (state.uncertainLaunch || !state.launchClaimed || operation.phase !== "launched")) {
        return hostOperationFailure("host_operation_launch_unknown");
      }
      const candidate: StoredHostOperation = { ...operation, phase: kind === "unknown_outcome" ? "unknown_outcome" : "safe",
        settledAt, settlementKind: kind, settlementSignature: signature, ...(code ? { code } : {}) };
      const evidenceDigest = kind === "unknown_outcome" ? undefined : verifyHostOperationSafe(this.context.database, candidate);
      const updated = this.context.database.prepare(`UPDATE host_operations SET phase=?,settled_at=?,settlement_kind=?,
        evidence_digest=?,settlement_signature=?,code=?,revision=revision+1 WHERE operation_id=? AND revision=? AND phase IN ('admitted','launched')`)
        .run(candidate.phase, settledAt, kind, evidenceDigest ?? null, signature, code ?? null, ticket.operationId, operation.revision);
      if (updated.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
      const result = this.verifiedRecord(this.requireOperation(ticket, state));
      // A failed COMMIT leaves the previous blocker; the capability cannot change its intended terminal outcome.
      state.settlementSignature = signature;
      return result;
    });
  }

  /** A safe read is a reverified fact, never a serialized execution capability. */
  getHostOperation(operationId: string): HostOperationRecord | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const operation = readHostOperation(this.context.database, operationId);
      return operation ? this.verifiedRecord(operation) : undefined;
    });
  }
  listHostOperationBlockers(source: HostOperationSource, stoppedAt?: string): HostOperationRecord[] {
    const captured = { ...source };
    return readSqliteSnapshot(this.context.database, () => readHostOperationBlockers(this.context.database, captured, stoppedAt,
      hostAttemptReadScopeForSource(this.context.database, captured)));
  }

  /** Internal Media facts preparation, with both original private capabilities under one writer lock. */
  prepareMediaExecutionFacts(parentTicket: HostOperationTicket, transportTicket: HostOperationTicket,
    prepare: (parent: HostOperationRecord, transport: HostOperationRecord) => HostMediaExecutionRecord,
    executionId?: string): HostMediaExecutionRecord {
    const parentState = this.requireTicket(parentTicket), transportState = this.requireTicket(transportTicket);
    this.assertSyncCallback(prepare);
    return this.transaction(() => {
      this.assertOwner(parentState.source, false); this.assertForwardAdmission(parentState.source);
      const [parent, transport] = this.requireMediaPair(parentTicket, parentState, transportTicket, transportState);
      if (executionId && parent.evidenceRef?.id === executionId && transport.evidenceRef?.id === executionId) {
        return hostOperationFailure("host_media_execution_already_prepared");
      }
      if (parent.phase !== "admitted" || transport.phase !== "admitted" || parentState.launchClaimed || transportState.launchClaimed
        || parent.evidenceRef || transport.evidenceRef) return hostOperationFailure("host_media_preparation_too_late");
      const result = this.assertSyncResult(prepare(parent, transport));
      for (const [operation, kind] of [[parent, "media_chain_execution"], [transport, "media_transport_execution"]] as const) {
        const evidence: HostOperationEvidenceRef = { kind, id: result.executionId };
        const identity = hostOperationDomainIdentity(this.context.database, operation, evidence, true);
        const updated = this.context.database.prepare(`UPDATE host_operations SET evidence_kind=?,evidence_id=?,
          domain_identity_digest=?,revision=revision+1 WHERE operation_id=? AND revision=? AND phase='admitted' AND evidence_id IS NULL`)
          .run(kind, result.executionId, identity, operation.operationId, operation.revision);
        if (updated.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
      }
      return result;
    });
  }

  /** Original capabilities may append observations after forward admission closes, never after settlement. */
  recordMediaExecutionFacts<T>(parentTicket: HostOperationTicket, transportTicket: HostOperationTicket, mutation: () => T): T {
    const parentState = this.requireTicket(parentTicket), transportState = this.requireTicket(transportTicket);
    this.assertSyncCallback(mutation);
    return this.transaction(() => {
      this.assertOwner(parentState.source, true);
      const [parent, transport] = this.requireMediaPair(parentTicket, parentState, transportTicket, transportState);
      if (parentState.settlementSignature || transportState.settlementSignature
        || !["admitted", "launched"].includes(parent.phase) || !["admitted", "launched"].includes(transport.phase)) {
        return hostOperationFailure("host_media_operation_settled");
      }
      return mutation();
    });
  }

  /** Internal preparation writes for an existing generation; never marks or repeats a physical launch. */
  mutateMediaExecutionFacts<T>(parentTicket: HostOperationTicket, transportTicket: HostOperationTicket, mutation: () => T): T {
    const parentState = this.requireTicket(parentTicket), transportState = this.requireTicket(transportTicket);
    this.assertSyncCallback(mutation);
    return this.transaction(() => {
      this.assertOwner(parentState.source, false); this.assertForwardAdmission(parentState.source);
      const [parent, transport] = this.requireMediaPair(parentTicket, parentState, transportTicket, transportState);
      if (parentState.uncertainLaunch || transportState.uncertainLaunch) return hostOperationFailure("host_media_launch_unknown");
      if (parentState.settlementSignature || transportState.settlementSignature
        || !["admitted", "launched"].includes(parent.phase) || !["admitted", "launched"].includes(transport.phase)) {
        return hostOperationFailure("host_media_operation_settled");
      }
      return mutation();
    });
  }

  /** Internal typed member launch. Facts are written before the actual send, never inside a read-only effect callback. */
  launchMediaExecutionMember<T>(parentTicket: HostOperationTicket, transportTicket: HostOperationTicket,
    beforeSend: () => void, send: () => T): T {
    const parentState = this.requireTicket(parentTicket), transportState = this.requireTicket(transportTicket);
    this.assertSyncCallback(beforeSend); this.assertSyncCallback(send);
    let entered = false;
    try {
      return this.transaction(() => {
        this.assertOwner(parentState.source, false); this.assertForwardAdmission(parentState.source);
        const [parent, transport] = this.requireMediaPair(parentTicket, parentState, transportTicket, transportState);
        if (parentState.uncertainLaunch || transportState.uncertainLaunch) return hostOperationFailure("host_media_launch_unknown");
        if (parentState.settlementSignature || transportState.settlementSignature
          || !["admitted", "launched"].includes(parent.phase) || !["admitted", "launched"].includes(transport.phase)) {
          return hostOperationFailure("host_media_operation_settled");
        }
        this.assertParentsActive(transport);
        this.assertSyncResult(beforeSend());
        this.assertOwner(parentState.source, false); this.assertForwardAdmission(parentState.source);
        const launchedAt = new Date().toISOString();
        for (const operation of [parent, transport]) {
          if (operation.phase === "launched") continue;
          if (hostOperationTimestamp(launchedAt) < hostOperationTimestamp(operation.admittedAt)) return hostOperationFailure("host_operation_invalid_timestamp");
          const updated = this.context.database.prepare(`UPDATE host_operations SET phase='launched',launched_at=?,revision=revision+1
            WHERE operation_id=? AND revision=? AND phase='admitted'`).run(launchedAt, operation.operationId, operation.revision);
          if (updated.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
        }
        // Both latches survive rollback: an entered child send is an entered parent chain, never no-start.
        parentState.launchClaimed = true; transportState.launchClaimed = true; entered = true;
        return readSqliteWithinTransaction(this.context.database, send);
      });
    } catch (error) {
      if (entered) { parentState.uncertainLaunch = true; transportState.uncertainLaunch = true; }
      throw error;
    }
  }

  private requireMediaPair(parentTicket: HostOperationTicket, parentState: TicketState,
    transportTicket: HostOperationTicket, transportState: TicketState): readonly [StoredHostOperation, StoredHostOperation] {
    const parent = this.requireOperation(parentTicket, parentState), transport = this.requireOperation(transportTicket, transportState);
    if (parent.kind !== "media" || transport.kind !== "media" || parent.parentOperationId
      || transport.parentOperationId !== parent.operationId || transport.producerId !== "media-http-chain"
      || parent.toolCallId !== transport.toolCallId || !sameHostOperationSource(parent.source, transport.source)) {
      return hostOperationFailure("host_media_invalid_journal_pair");
    }
    return [parent, transport];
  }

  private verifiedRecord(operation: StoredHostOperation): HostOperationRecord {
    assertHostOperationLineage(this.context.database, operation.source);
    if (operation.phase === "safe" && verifyHostOperationSafe(this.context.database, operation) !== operation.evidenceDigest) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    return operation;
  }
  /** Office physical effects must enter the original pair's typed effect roster, including cleanup. */
  private assertGenericEffectScope(operation: HostOperationRecord): void {
    if (operation.evidenceRef?.kind === "office_local_chain_execution"
      || operation.evidenceRef?.kind === "office_local_binary_execution") {
      return hostOperationFailure("host_office_local_pair_effect_required");
    }
  }
  /** No new work below a locally closed Office role; independent settlement of already reserved children remains valid. */
  private assertOfficeForwardOpen(operation: HostOperationRecord): void {
    if (this.closedOfficeOperations.size === 0) return;
    let current = operation, depth = 0;
    for (;;) {
      if (this.closedOfficeOperations.has(current.operationId)) return hostOperationFailure("host_office_local_execution_closed");
      if (!current.parentOperationId) return;
      const parent = readHostOperation(this.context.database, current.parentOperationId);
      if (++depth > 128 || !parent || !sameHostOperationSource(parent.source, operation.source)) {
        return hostOperationFailure("host_operation_invalid_parent");
      }
      current = parent;
    }
  }
  private assertParentsActive(operation: HostOperationRecord, cleanup = false): void {
    let current = operation, depth = 0;
    if (this.closedOfficeOperations.has(current.operationId)) return hostOperationFailure("host_office_local_execution_closed");
    while (current.parentOperationId) {
      if (this.closedDirectoryOfficeEffects.has(current.parentOperationId)
        || !cleanup && this.closedOfficeOperations.has(current.parentOperationId)) return hostOperationFailure("host_office_local_execution_closed");
      const parent = readHostOperation(this.context.database, current.parentOperationId);
      if (++depth > 128 || !parent || !sameHostOperationSource(parent.source, operation.source)
        || !["admitted","launched"].includes(parent.phase)) return hostOperationFailure("host_operation_invalid_parent");
      current = parent;
    }
  }
  private requireTicket(ticket: HostOperationTicket): TicketState {
    const state = this.tickets.get(ticket);
    return state ?? hostOperationFailure("host_operation_invalid_ticket");
  }
  private requireOperation(ticket: HostOperationTicket, state: TicketState): StoredHostOperation {
    const operation = readHostOperation(this.context.database, ticket.operationId);
    if (!operation || !sameHostOperationSource(operation.source, state.source)) return hostOperationFailure("host_operation_journal_corrupt");
    return operation;
  }
  private assertOwner(source: HostOperationSource, cleanup: boolean): void {
    assertHostOperationLineage(this.context.database, source);
    if (!isCurrentRunExecutionOwner(this.context, source.runId, source, cleanup)) return hostOperationFailure("host_operation_stale_owner");
  }
  private assertForwardAdmission(source: HostOperationSource): void {
    for (const row of this.context.database.prepare(`SELECT tool_input_json FROM user_input_requests
      WHERE source_run_id=? AND source_attempt_id=? AND status IN ('pending','answered')`).iterate(source.runId, source.attemptId)) {
      let input: unknown;
      try { input = JSON.parse(String(row.tool_input_json)); } catch { return hostOperationFailure("host_operation_admission_closed"); }
      if (!input || typeof input !== "object" || Array.isArray(input)
        || (input as Record<string, unknown>).waitMode !== "optional") return hostOperationFailure("host_operation_admission_closed");
    }
  }
  private assertSyncCallback(callback: unknown): void {
    if (typeof callback !== "function" || Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
      return hostOperationFailure("host_operation_effect_must_be_synchronous");
    }
  }
  private assertSyncResult<T>(result: T): T {
    if (result && (typeof result === "object" || typeof result === "function")
      && typeof Reflect.get(result, "then") === "function") {
      // Observe the rejection even for a plain function that returned a Promise.
      // Reject before COMMIT or an actual send; a void wrapper must not hide it.
      void Promise.resolve(result as unknown as PromiseLike<unknown>).catch(() => undefined);
      return hostOperationFailure("host_operation_effect_must_be_synchronous");
    }
    return result;
  }
  private transaction<T>(operation: () => T): T {
    // BEGIN outside the catch: failure here never gives us ownership of a
    // caller's existing transaction, so we must not roll it back or close it.
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = this.assertSyncResult(operation()); this.context.database.exec("COMMIT"); return result; }
    catch (error) {
      try { this.context.database.exec("ROLLBACK"); }
      catch (rollbackError) {
        const failures: unknown[] = [error, rollbackError];
        if (isNativeNoActiveRollback(rollbackError)) {
          // A wrapped exec can reproduce the exact native error shape without
          // ending the transaction. Confirm using the original connection
          // executor; only its no-active result permits COMMIT-return-loss retry.
          let completed = false;
          try { this.rollbackDatabase(); }
          catch (confirmationError) {
            completed = isNativeNoActiveRollback(confirmationError);
            if (!completed) failures.push(confirmationError);
          }
          if (completed) throw error;
        }
        try { this.context.database.close(); } catch (closeError) { failures.push(closeError); }
        if (this.context.database.isOpen) {
          try { this.closeDatabase(); } catch (closeError) { failures.push(closeError); }
        }
        throw new AggregateError(failures, "host_operation_transaction_quarantined", { cause: error });
      }
      throw error;
    }
  }
}

/** Match the actual Node SQLite ROLLBACK error, never arbitrary matching prose. */
function isNativeNoActiveRollback(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return detail.code === "ERR_SQLITE_ERROR" && detail.errcode === 1 && detail.errstr === "SQL logic error"
    && detail.message === "cannot rollback - no transaction is active";
}

/** Caller-owned write transaction, used by both yield and answer-delivery claim. */
export function readHostOperationBlockers(database: SqliteStoreContext["database"], source: HostOperationSource,
  stoppedAt?: string, scope: import("./host-attempt-read-scope.js").HostAttemptReadScope = "whole_run"): HostOperationRecord[] {
  if (stoppedAt) hostOperationTimestamp(stoppedAt);
  const operations = readSourceHostOperations(database, source, scope, stoppedAt);
  for (const operation of operations) {
    if (operation.parentOperationId) {
      const parent = readHostOperation(database, operation.parentOperationId);
      if (!parent || !sameHostOperationSource(parent.source, source) || parent.toolCallId !== operation.toolCallId) {
        return hostOperationFailure("host_operation_invalid_parent");
      }
    }
    if (stoppedAt && hostOperationTimestamp(operation.admittedAt) > hostOperationTimestamp(stoppedAt)) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    if (operation.phase === "safe" && verifyHostOperationSafe(database, operation, stoppedAt) !== operation.evidenceDigest) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
  }
  return operations.filter(operation => operation.phase !== "safe");
}
