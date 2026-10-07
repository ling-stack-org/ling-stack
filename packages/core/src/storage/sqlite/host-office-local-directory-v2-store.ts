import type { HostOperationTicket } from "../../host-operation-journal-types.js";
import type { PrepareHostOfficeLocalInput, HostOfficeLocalTicket } from "../../host-office-local-types.js";
import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryCommittedPairV2, HostOfficeLocalDirectoryExecutionRecordV2, HostOfficeLocalDirectoryEffectRecordV2, PrepareHostOfficeLocalDirectoryEffectV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeLocalDirectoryTerminalRecordV2 } from "../../host-office-local-directory-v2-terminal-types.js";
import type { SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import { hostOperationFailure, readHostOperation, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { readOfficeLocalSeal } from "./host-office-local-records.js";
import { validateOfficeLocalDirectoryPreparedV2 } from "./host-office-local-directory-v2-prepared.js";
import { validateOfficeLocalDirectoryEffectV2 } from "./host-office-local-directory-v2-effects.js";
import { assertOfficeDirectoryWorkspaceV2, officeDirectoryEffectDigestV2, officeDirectoryIdentityDigestV2,
  readOfficeLocalDirectoryEffectsV2, readOfficeLocalDirectoryExecutionV2, validateOfficeLocalDirectoryObservationV2 } from "./host-office-local-directory-v2-records.js";
import { readOfficeLocalDirectoryTerminalV2, validateOfficeLocalDirectoryTerminalSealV2 } from "./host-office-local-directory-v2-terminal.js";
import { validateOfficeDirectoryHistoryV2 } from "./host-office-local-directory-v2-history.js";
import { directoryV2Failure, v2Digest, v2Exact, v2Object, v2Text, v2Timestamp } from "./host-office-local-directory-v2-validation.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteHostOperationJournalStore } from "./host-operation-journal-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { CapturedOriginalOfficeHostBridge, OriginalOfficeDirectoryAuthorityV2 } from "../../original-office-host-bridge.js";
import { OfficeDirectoryScopeBindingV2 } from "./host-office-local-directory-v2-authority.js";
import { OfficeDirectoryWindowCloseClaimV2, assertOfficeDirectoryNativeCloseReadyV2 } from "./host-office-local-directory-v2-close-claim.js";
import { OfficeDirectoryCertificateIssuerV2 } from "./host-office-local-directory-v2-certificate.js";
import { settleOfficeDirectoryPairV2 } from "./host-office-local-directory-v2-settlement.js";
import { OfficeDirectoryCommittedPairReaderV2, readOriginalOfficeDirectoryCommittedPairV2 } from "./host-office-local-directory-v2-committed-pair.js";

interface DirectoryTicketStateV2 {
  readonly parent: HostOperationTicket;
  readonly producer: HostOperationTicket;
  readonly entered: Map<string, string>;
  readonly scopeAuthority: OfficeDirectoryScopeBindingV2;
  readonly closeClaim: OfficeDirectoryWindowCloseClaimV2;
  uncertainLaunch: boolean;
  closeSessionEntered: boolean;
  sealClaim?: SealHostOfficeLocalTerminalInput;
  committedHandle?: HostOfficeLocalDirectoryCommittedPairV2;
  originalCloseClaim?: HostOfficeLocalDirectoryCloseClaimV2;
  settledAt?: string;
}
/** Versioned facts store under the same original journal gate. No scope issuer or independent settlement authority. */
export class SqliteHostOfficeLocalDirectoryV2Store {
  private readonly tickets = new WeakMap<HostOfficeLocalTicket, DirectoryTicketStateV2>();
  #issuer: OfficeDirectoryCertificateIssuerV2;
  #committedReader: OfficeDirectoryCommittedPairReaderV2;
  constructor(private readonly context: SqliteStoreContext, private readonly journal: SqliteHostOperationJournalStore,
    private readonly originalHostBridge?: CapturedOriginalOfficeHostBridge, private readonly owner: object = journal) {
    this.#issuer = new OfficeDirectoryCertificateIssuerV2(context.database);
    this.#committedReader = new OfficeDirectoryCommittedPairReaderV2(context.database, owner);
  }

  prepare(parent: HostOperationTicket, producer: HostOperationTicket, input: PrepareHostOfficeLocalInput): HostOfficeLocalTicket {
    const captured = JSON.parse(JSON.stringify(input)) as unknown;
    if (!v2Object(captured) || !v2Exact(captured, ["executionId", "preparedArtifactId", "preparedDigest"])
      || !v2Text(captured.executionId) || !v2Text(captured.preparedArtifactId) || !v2Digest(captured.preparedDigest)) return directoryV2Failure();
    this.journal.officeLocal.prepare(parent, producer, (parentRow, producerRow) => {
      const seal = readOfficeLocalSeal(this.context.database, String(captured.preparedArtifactId), parentRow.source.runId);
      const prepared = validateOfficeLocalDirectoryPreparedV2(seal.payload);
      assertOfficeDirectoryWorkspaceV2(this.context.database, prepared);
      if (prepared.executionId !== captured.executionId || seal.hash !== captured.preparedDigest || prepared.parentOperationId !== parentRow.operationId
        || prepared.producerOperationId !== producerRow.operationId || prepared.toolCallId !== parentRow.toolCallId || !sameHostOperationSource(prepared.source, parentRow.source)
        || v2Timestamp(prepared.preparedAt) < Math.max(v2Timestamp(parentRow.admittedAt), v2Timestamp(producerRow.admittedAt))
        || v2Timestamp(seal.createdAt) < v2Timestamp(prepared.preparedAt)) return directoryV2Failure();
      const identityDigest = officeDirectoryIdentityDigestV2(prepared, String(captured.preparedArtifactId), seal.hash);
      this.context.database.prepare(`INSERT INTO host_office_local_directory_v2_executions(execution_id,schema_version,protocol,run_id,work_unit_id,
        attempt_id,runtime_instance_id,fencing_token,parent_operation_id,producer_operation_id,tool_call_id,tool_name,prepared_artifact_id,prepared_digest,identity_digest,prepared_at)
        VALUES(?,2,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(prepared.executionId, prepared.protocol, prepared.source.runId, prepared.source.workUnitId, prepared.source.attemptId,
          prepared.source.runtimeInstanceId, prepared.source.fencingToken, parent.operationId, producer.operationId, prepared.toolCallId, prepared.toolName,
          String(captured.preparedArtifactId), seal.hash, identityDigest, prepared.preparedAt);
      return this.execution(prepared.executionId);
    });
    const ticket = Object.freeze({ executionId: String(captured.executionId) }) as HostOfficeLocalTicket;
    this.tickets.set(ticket, { parent, producer, entered: new Map(), scopeAuthority: new OfficeDirectoryScopeBindingV2(this.context, this.originalHostBridge),
      closeClaim: new OfficeDirectoryWindowCloseClaimV2(this.originalHostBridge),
      uncertainLaunch: false, closeSessionEntered: false });
    return ticket;
  }
  bindScopeAuthority(ticket: HostOfficeLocalTicket, authority: OriginalOfficeDirectoryAuthorityV2): void {
    const state = this.ticket(ticket);
    state.scopeAuthority.assertAuthorityOwned(authority);
    const assertAdmission = (): void => {
      if (state.entered.size || state.uncertainLaunch || state.closeSessionEntered || state.sealClaim) {
        return hostOperationFailure("host_office_local_scope_binding_closed");
      }
      state.scopeAuthority.assertUnbound();
    };
    assertAdmission();
    try {
      this.journal.officeLocal.mutate(state.parent, state.producer, () => {
        assertAdmission();
        state.scopeAuthority.bind(authority, this.execution(ticket.executionId));
      }, false);
    } catch (error) { state.scopeAuthority.invalidateIfEntered(); throw error; }
  }
  retireBridge(): void { this.originalHostBridge?.retire(); }
  closeWindow(ticket: HostOfficeLocalTicket): HostOfficeLocalDirectoryCloseClaimV2 {
    const state = this.ticket(ticket);
    state.closeClaim.assertNotReenter();
    let execution: HostOfficeLocalDirectoryExecutionRecordV2, authority: OriginalOfficeDirectoryAuthorityV2;
    return this.journal.officeLocal.closeDirectoryWindow(state.parent, state.producer, () => {
      execution = this.execution(ticket.executionId);
      authority = state.scopeAuthority.requireBound(execution);
      assertOfficeDirectoryNativeCloseReadyV2(this.context.database, execution, state.entered, state.sealClaim);
    }, () => state.closeClaim.close(execution!, authority!));
  }
  /** Issue only from the original live ticket. COMMIT-return loss reconciles the retained pair intent, never native effects. */
  settle(ticket: HostOfficeLocalTicket): HostOfficeLocalDirectoryCommittedPairV2 {
    const state = this.ticket(ticket), execution = this.execution(ticket.executionId);
    if (state.committedHandle && state.originalCloseClaim) {
      state.closeClaim.assertClaimOwned(state.originalCloseClaim);
      readOriginalOfficeDirectoryCommittedPairV2(this.owner, state.committedHandle, state.originalCloseClaim,
        { executionId: execution.executionId, source: execution.source,
          parentOperationId: execution.parentOperationId, producerOperationId: execution.producerOperationId });
      return state.committedHandle;
    }
    if (state.originalCloseClaim && state.settledAt) {
      const retainedAt = state.settledAt;
      // An acknowledged SQL shape can survive COMMIT-return loss after Host proof retires.
      // Only this original ticket's retained intent may reconcile it; no current/Host/FD call.
      const committed = readSqliteSnapshot(this.context.database, () => {
        const parent = readHostOperation(this.context.database, state.parent.operationId);
        const producer = readHostOperation(this.context.database, state.producer.operationId);
        if (!parent || !producer) return hostOperationFailure("host_operation_journal_corrupt");
        if (parent.phase !== "safe" && producer.phase !== "safe") return false;
        if (parent.phase !== "safe" || producer.phase !== "safe" || parent.settledAt !== retainedAt
          || producer.settledAt !== retainedAt
          || parent.settlementSignature !== JSON.stringify({ kind: "office_local_chain_completed", settledAt: retainedAt })
          || producer.settlementSignature !== JSON.stringify({ kind: "office_local_binary_completed", settledAt: retainedAt })) {
          return hostOperationFailure("host_operation_settlement_conflict");
        }
        this.#issuer.assertCommittedIntent(execution.executionId, retainedAt);
        return true;
      });
      if (committed) {
        state.closeClaim.assertClaimOwned(state.originalCloseClaim);
        state.committedHandle = this.#committedReader.issue(ticket, execution, state.closeClaim, state.originalCloseClaim);
        return state.committedHandle;
      }
    }
    this.journal.officeLocal.settleDirectory(state.parent, state.producer, () => {
      const current = this.execution(ticket.executionId);
      if (state.uncertainLaunch || state.entered.size === 0) return hostOperationFailure("host_office_local_launch_unknown");
      assertOfficeDirectoryNativeCloseReadyV2(this.context.database, current, state.entered, state.sealClaim);
      const authority = state.scopeAuthority.requireBound(current);
      // This only consumes the already-issued original closure. It cannot enter close or reconstruct an FD.
      state.originalCloseClaim = state.closeClaim.assertClosed(current, authority);
    }, (pair, settledAt) => settleOfficeDirectoryPairV2(this.context, pair, this.execution(ticket.executionId), this.#issuer, settledAt, state));
    if (!state.originalCloseClaim) return hostOperationFailure("host_office_local_close_claim_invalid");
    // Separate committed read window after transaction return; no in-transaction candidate can escape as a handle.
    state.committedHandle = this.#committedReader.issue(ticket, this.execution(ticket.executionId), state.closeClaim, state.originalCloseClaim);
    return state.committedHandle;
  }
  prepareEffect(ticket: HostOfficeLocalTicket, input: PrepareHostOfficeLocalDirectoryEffectV2): HostOfficeLocalDirectoryEffectRecordV2 {
    const state = this.mutable(ticket), captured: unknown = JSON.parse(JSON.stringify(input));
    if (state.closeSessionEntered) return hostOperationFailure("host_office_local_execution_closed");
    const cleanup = v2Object(captured) && captured.mode === "cleanup";
    if (state.uncertainLaunch && !cleanup) return hostOperationFailure("host_office_local_launch_unknown");
    return this.journal.officeLocal.mutate(state.parent, state.producer, () => {
      this.mutable(ticket);
      const execution = this.execution(ticket.executionId), effect = validateOfficeLocalDirectoryEffectV2(execution, captured), previous = readOfficeLocalDirectoryEffectsV2(this.context.database, execution);
      if (effect.ordinal !== previous.length || !cleanup && previous.some(item => !item.observationArtifactId)) return directoryV2Failure();
      const entries = previous.map(item => ({ effect: item, observation: item.observationArtifactId ? validateOfficeLocalDirectoryObservationV2(this.context.database, execution, item, item.observationArtifactId) : null }));
      const last = entries.at(-1);
      if (last && v2Timestamp(effect.preparedAt) < v2Timestamp(last.observation?.completedAt ?? last.effect.preparedAt)) return directoryV2Failure();
      if (!cleanup && last && (last.observation?.native.state !== "returned" || !last.observation.native.result.success || last.observation.host.state !== "returned")) return hostOperationFailure("host_office_local_directory_v2_forward_blocked");
      if (cleanup && state.entered.size === 0) return hostOperationFailure("host_office_local_cleanup_not_entered");
      const resources = validateOfficeDirectoryHistoryV2(entries);
      if ("nativeLifetimeId" in effect && (resources.get(effect.resourceSlotId)?.fact.lifetimeId !== effect.nativeLifetimeId
        || resources.get(effect.resourceSlotId)?.fact.state !== "retained")) return directoryV2Failure();
      if (effect.kind === "write_file" && resources.get(effect.resourceSlotId)?.fact.bytesWritten !== String(effect.offset)) return directoryV2Failure();
      if ((effect.kind === "create_directory" || effect.kind === "create_file") && (resources.has(effect.resourceSlotId)
        || resources.get(effect.parentResourceSlotId)?.fact.lifetimeId !== effect.parentNativeLifetimeId || resources.get(effect.parentResourceSlotId)?.fact.state !== "retained")) return directoryV2Failure();
      if (effect.kind === "install_tree" && (resources.get(effect.sourceParentResourceSlotId)?.fact.lifetimeId !== effect.sourceParentNativeLifetimeId
        || resources.get(effect.destinationParentResourceSlotId)?.fact.lifetimeId !== effect.destinationParentNativeLifetimeId)) return directoryV2Failure();
      this.context.database.prepare("INSERT INTO host_office_local_directory_v2_effects(effect_id,execution_id,ordinal,descriptor_json,effect_digest) VALUES(?,?,?,?,?)")
        .run(effect.effectId, execution.executionId, effect.ordinal, JSON.stringify(effect), officeDirectoryEffectDigestV2(execution, effect));
      return readOfficeLocalDirectoryEffectsV2(this.context.database, execution).at(-1)!;
    }, cleanup);
  }
  launchEffect<T>(ticket: HostOfficeLocalTicket, effectId: string, callback: () => T): T {
    const state = this.mutable(ticket);
    if (state.closeSessionEntered) return hostOperationFailure("host_office_local_execution_closed");
    if (typeof callback !== "function" || Object.prototype.toString.call(callback) === "[object AsyncFunction]") return hostOperationFailure("host_operation_effect_must_be_synchronous");
    if (state.entered.has(effectId)) return hostOperationFailure("host_office_local_effect_already_entered");
    const effect = readOfficeLocalDirectoryEffectsV2(this.context.database, this.execution(ticket.executionId)).find(item => item.effectId === effectId);
    if (!effect || effect.enteredAt || effect.observationArtifactId) return directoryV2Failure();
    if (state.uncertainLaunch && effect.mode !== "cleanup") return hostOperationFailure("host_office_local_launch_unknown");
    const enteredAt = new Date().toISOString(); let entered = false;
    try {
      return this.journal.officeLocal.effect(state.parent, state.producer, () => {
        this.mutable(ticket);
        const current = readOfficeLocalDirectoryEffectsV2(this.context.database, this.execution(ticket.executionId)).find(item => item.effectId === effectId);
        if (!current || current.effectDigest !== effect.effectDigest || current.enteredAt || current.observationArtifactId
          || v2Timestamp(enteredAt) < v2Timestamp(effect.preparedAt)) return directoryV2Failure();
        if (this.context.database.prepare("UPDATE host_office_local_directory_v2_effects SET entered_at=?,revision=revision+1 WHERE effect_id=? AND entered_at IS NULL AND observation_artifact_id IS NULL")
          .run(enteredAt, effectId).changes !== 1) return directoryV2Failure();
      }, () => { this.mutable(ticket); entered = true; state.entered.set(effectId, enteredAt);
        if (effect.kind === "close_session") state.closeSessionEntered = true;
        return callback(); }, effect.mode);
    } catch (error) { if (entered) state.uncertainLaunch = true; throw error; }
  }
  recordObservation(ticket: HostOfficeLocalTicket, effectId: string, artifactId: string): HostOfficeLocalDirectoryEffectRecordV2 {
    const state = this.mutable(ticket);
    return this.journal.officeLocal.mutate(state.parent, state.producer, () => {
      this.mutable(ticket);
      const execution = this.execution(ticket.executionId);
      let effect = readOfficeLocalDirectoryEffectsV2(this.context.database, execution).find(item => item.effectId === effectId);
      if (!effect) return directoryV2Failure();
      if (!effect.enteredAt && state.entered.has(effectId)) {
        this.context.database.prepare("UPDATE host_office_local_directory_v2_effects SET entered_at=?,revision=revision+1 WHERE effect_id=? AND entered_at IS NULL").run(state.entered.get(effectId)!, effectId);
        effect = readOfficeLocalDirectoryEffectsV2(this.context.database, execution).find(item => item.effectId === effectId)!;
      }
      validateOfficeLocalDirectoryObservationV2(this.context.database, execution, effect, artifactId);
      if (effect.observationArtifactId) {
        if (effect.observationArtifactId !== artifactId) return directoryV2Failure();
        return effect;
      }
      if (this.context.database.prepare("UPDATE host_office_local_directory_v2_effects SET observation_artifact_id=?,revision=revision+1 WHERE effect_id=? AND observation_artifact_id IS NULL")
        .run(artifactId, effectId).changes !== 1) return directoryV2Failure();
      return readOfficeLocalDirectoryEffectsV2(this.context.database, execution).find(item => item.effectId === effectId)!;
    }, true);
  }
  getExecution(id: string): HostOfficeLocalDirectoryExecutionRecordV2 | undefined {
    return readSqliteSnapshot(this.context.database, () => readOfficeLocalDirectoryExecutionV2(this.context.database, id));
  }
  listEffects(id: string): HostOfficeLocalDirectoryEffectRecordV2[] {
    return readSqliteSnapshot(this.context.database, () => readOfficeLocalDirectoryEffectsV2(this.context.database, this.execution(id)));
  }
  sealTerminal(ticket: HostOfficeLocalTicket, input: SealHostOfficeLocalTerminalInput): HostOfficeLocalDirectoryTerminalRecordV2 {
    const state = this.ticket(ticket), captured: unknown = JSON.parse(JSON.stringify(input));
    if (state.closeClaim.entered) return hostOperationFailure("host_office_local_execution_closed");
    state.scopeAuthority.assertMutable();
    if (!v2Object(captured) || !v2Exact(captured, ["terminalArtifactId", "terminalDigest"]) || !v2Text(captured.terminalArtifactId) || !v2Digest(captured.terminalDigest)) return directoryV2Failure();
    const claim = captured as unknown as SealHostOfficeLocalTerminalInput;
    return this.journal.officeLocal.sealTerminal(state.parent, state.producer, () => {
      if (state.sealClaim && !((state.sealClaim.terminalArtifactId === claim.terminalArtifactId) && state.sealClaim.terminalDigest === claim.terminalDigest)) return hostOperationFailure("host_office_local_terminal_claim_conflict");
      const execution = this.execution(ticket.executionId), terminal = validateOfficeLocalDirectoryTerminalSealV2(this.context.database, execution, claim), existing = readOfficeLocalDirectoryTerminalV2(this.context.database, execution);
      if (existing && (existing.terminalArtifactId !== claim.terminalArtifactId || existing.terminalDigest !== claim.terminalDigest)) return hostOperationFailure("host_office_local_terminal_claim_conflict");
      state.sealClaim ??= Object.freeze({ ...claim });
      if (!existing) this.context.database.prepare(`INSERT INTO host_office_local_directory_v2_terminals(execution_id,schema_version,protocol,execution_identity_digest,
        terminal_artifact_id,terminal_digest,effect_set_digest,effect_count,sealed_at) VALUES(?,2,?,?,?,?,?,?,?)`).run(execution.executionId, execution.protocol,
          execution.identityDigest, terminal.terminalArtifactId, terminal.terminalDigest, terminal.effectSetDigest, terminal.effectCount, terminal.sealedAt);
      return readOfficeLocalDirectoryTerminalV2(this.context.database, execution) ?? directoryV2Failure();
    });
  }
  getTerminal(id: string): HostOfficeLocalDirectoryTerminalRecordV2 | undefined {
    return readSqliteSnapshot(this.context.database, () => { const execution = this.getExecution(id); return execution ? readOfficeLocalDirectoryTerminalV2(this.context.database, execution) : undefined; });
  }
  private execution(id: string): HostOfficeLocalDirectoryExecutionRecordV2 { return readOfficeLocalDirectoryExecutionV2(this.context.database, id) ?? directoryV2Failure(); }
  private ticket(ticket: HostOfficeLocalTicket): DirectoryTicketStateV2 { return this.tickets.get(ticket) ?? hostOperationFailure("host_office_local_invalid_ticket"); }
  private mutable(ticket: HostOfficeLocalTicket): DirectoryTicketStateV2 {
    const state = this.ticket(ticket); state.scopeAuthority.assertMutable();
    if (state.closeClaim.entered) return hostOperationFailure("host_office_local_execution_closed");
    if (state.sealClaim) return hostOperationFailure("host_office_local_execution_sealed"); return state;
  }
}
