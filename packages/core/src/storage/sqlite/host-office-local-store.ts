import type { HostOperationTicket } from "../../host-operation-journal-types.js";
import type { HostOfficeLocalExecutionRecord, HostOfficeLocalEffectRecord, HostOfficeLocalTicket,
  PrepareHostOfficeLocalInput, PrepareHostOfficeLocalEffect, SettleHostOfficeLocalInput, HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import type { HostOfficeLocalTerminalRecord, SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import type { HostOfficeLocalNoStartReceipt } from "../../host-office-local-no-start-types.js";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationFailure, hostOperationTimestamp, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { officeLocalFailure, readOfficeLocalExecution, readOfficeLocalEffects, readOfficeLocalSeal,
  assertOfficeLocalWorkspace, validateOfficeLocalPrepared, validateOfficeLocalEffect, validateOfficeLocalObservation } from "./host-office-local-records.js";
import type { SqliteHostOperationJournalStore } from "./host-operation-journal-store.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readOfficeLocalTerminal, validateOfficeLocalTerminalSeal } from "./host-office-local-terminal-records.js";
import { readOfficeLocalNoStartReceipt } from "./host-office-local-no-start-records.js";

interface OfficeTicketState {
  readonly parent: HostOperationTicket;
  readonly producer: HostOperationTicket;
  readonly entered: Map<string, string>;
  uncertainLaunch: boolean;
  /** Irreversible before the fixed writer can retain even a read-only native resource. */
  writerObservationStarted: boolean;
  /** Lifecycle closure survives rejected fan-in, SQL rollback and lost returns; it is not a settlement intent. */
  noStartClosed: boolean;
  /** Irreversible local claim even when terminal INSERT/COMMIT fails or its return is lost. */
  sealClaim?: SealHostOfficeLocalTerminalInput;
}

/**
 * Store-owned binary preparation/effect facts. No result/manifest here releases
 * a barrier: final member verification and journal settlement are separate gates.
 * A failed syscall/COMMIT retains a local entered latch and can never be replayed.
 */
export class SqliteHostOfficeLocalStore {
  private readonly tickets = new WeakMap<HostOfficeLocalTicket, OfficeTicketState>();
  constructor(private readonly context: SqliteStoreContext, private readonly journal: SqliteHostOperationJournalStore) {}

  prepareHostOfficeLocalExecution(parent: HostOperationTicket, producer: HostOperationTicket,
    input: PrepareHostOfficeLocalInput): HostOfficeLocalTicket {
    const captured = Object.freeze({ executionId: input.executionId, preparedArtifactId: input.preparedArtifactId, preparedDigest: input.preparedDigest });
    this.journal.officeLocal.prepare(parent, producer, (parentRow, producerRow) => {
      const seal = readOfficeLocalSeal(this.context.database, captured.preparedArtifactId, parentRow.source.runId);
      const prepared = validateOfficeLocalPrepared(seal.payload);
      assertOfficeLocalWorkspace(this.context.database, prepared);
      if (prepared.executionId !== captured.executionId || seal.hash !== captured.preparedDigest
        || prepared.parentOperationId !== parentRow.operationId || prepared.producerOperationId !== producerRow.operationId
        || prepared.toolCallId !== parentRow.toolCallId || !sameHostOperationSource(prepared.source, parentRow.source)
        || hostOperationTimestamp(prepared.preparedAt) < Math.max(hostOperationTimestamp(parentRow.admittedAt), hostOperationTimestamp(producerRow.admittedAt))
        || hostOperationTimestamp(seal.createdAt) < hostOperationTimestamp(prepared.preparedAt)) return officeLocalFailure();
      const identityDigest = digestHarnessToolValue({ prepared, preparedArtifactId: captured.preparedArtifactId, preparedDigest: seal.hash });
      this.context.database.prepare(`INSERT INTO host_office_local_executions(execution_id,schema_version,protocol,run_id,
        work_unit_id,attempt_id,runtime_instance_id,fencing_token,parent_operation_id,producer_operation_id,tool_call_id,
        tool_name,prepared_artifact_id,prepared_digest,identity_digest,prepared_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(prepared.executionId, prepared.protocol, prepared.source.runId, prepared.source.workUnitId, prepared.source.attemptId,
          prepared.source.runtimeInstanceId, prepared.source.fencingToken, parent.operationId, producer.operationId, prepared.toolCallId,
          prepared.toolName, captured.preparedArtifactId, seal.hash, identityDigest, prepared.preparedAt);
      return this.requireExecution(prepared.executionId);
    });
    const ticket = Object.freeze({ executionId: captured.executionId }) as HostOfficeLocalTicket;
    this.tickets.set(ticket, { parent, producer, entered: new Map(), uncertainLaunch: false,
      writerObservationStarted: false, noStartClosed: false });
    return ticket;
  }

  /** Original-owner forward admission before any writer observation; rollback cannot erase this latch. */
  beginHostOfficeLocalWriterObservation(ticket: HostOfficeLocalTicket): void {
    const state = this.requireMutableTicket(ticket);
    this.journal.officeLocal.mutate(state.parent, state.producer, () => {
      this.requireMutableTicket(ticket);
      if (state.writerObservationStarted) return hostOperationFailure("host_office_local_observation_already_started");
      state.writerObservationStarted = true;
    }, false);
  }

  prepareHostOfficeLocalEffect(ticket: HostOfficeLocalTicket, input: PrepareHostOfficeLocalEffect): HostOfficeLocalEffectRecord {
    const state = this.requireMutableTicket(ticket);
    // Getters/deep copies execute before the owner lock, never between admission and syscall.
    const captured: unknown = JSON.parse(JSON.stringify(input));
    const observation = (captured as { mode?: unknown } | null)?.mode === "cleanup";
    if (state.uncertainLaunch && !observation) return hostOperationFailure("host_office_local_launch_unknown");
    return this.journal.officeLocal.mutate(state.parent, state.producer, () => {
      this.requireMutableTicket(ticket);
      const execution = this.requireExecution(ticket.executionId), effect = validateOfficeLocalEffect(execution, captured);
      const previous = readOfficeLocalEffects(this.context.database, execution);
      if (effect.ordinal !== previous.length || (!observation && previous.some(row => !row.observationArtifactId))) return officeLocalFailure();
      const last = previous.at(-1);
      if (last && hostOperationTimestamp(effect.preparedAt) < hostOperationTimestamp(last.preparedAt)) return officeLocalFailure();
      if (last?.observationArtifactId) {
        const completed = validateOfficeLocalObservation(this.context.database, execution, last, last.observationArtifactId);
        if (hostOperationTimestamp(effect.preparedAt) < hostOperationTimestamp(completed.completedAt)) return officeLocalFailure();
      }
      if (observation && state.entered.size === 0) return hostOperationFailure("host_office_local_cleanup_not_entered");
      const effectDigest = digestHarnessToolValue({ executionIdentityDigest: execution.identityDigest, effect });
      this.context.database.prepare(`INSERT INTO host_office_local_effects(effect_id,execution_id,ordinal,descriptor_json,effect_digest)
        VALUES(?,?,?,?,?)`).run(effect.effectId, execution.executionId, effect.ordinal, JSON.stringify(effect), effectDigest);
      return readOfficeLocalEffects(this.context.database, execution).at(-1)!;
    }, observation);
  }

  launchHostOfficeLocalEffect<T>(ticket: HostOfficeLocalTicket, effectId: string, effect: () => T): T {
    const state = this.requireMutableTicket(ticket);
    if (typeof effect !== "function" || Object.prototype.toString.call(effect) === "[object AsyncFunction]") {
      return hostOperationFailure("host_operation_effect_must_be_synchronous");
    }
    if (state.entered.has(effectId)) return hostOperationFailure("host_office_local_effect_already_entered");
    const row = this.listHostOfficeLocalEffects(ticket.executionId).find(item => item.effectId === effectId);
    if (!row || row.enteredAt || row.observationArtifactId) return officeLocalFailure();
    if (state.uncertainLaunch && row.mode !== "cleanup") return hostOperationFailure("host_office_local_launch_unknown");
    let entered = false;
    const enteredAt = new Date().toISOString();
    try {
      return this.journal.officeLocal.effect(state.parent, state.producer, () => {
        this.requireMutableTicket(ticket);
        const current = readOfficeLocalEffects(this.context.database, this.requireExecution(ticket.executionId)).find(item => item.effectId === effectId);
        if (!current || current.effectDigest !== row.effectDigest || current.enteredAt || current.observationArtifactId) return officeLocalFailure();
        if (hostOperationTimestamp(enteredAt) < hostOperationTimestamp(row.preparedAt)) return officeLocalFailure();
        const changed = this.context.database.prepare(`UPDATE host_office_local_effects SET entered_at=?,revision=revision+1
          WHERE effect_id=? AND entered_at IS NULL AND observation_artifact_id IS NULL`).run(enteredAt, effectId);
        if (changed.changes !== 1) return officeLocalFailure();
      }, () => { this.requireMutableTicket(ticket); entered = true; state.entered.set(effectId, enteredAt); return effect(); }, row.mode);
    } catch (error) {
      if (entered) state.uncertainLaunch = true;
      throw error;
    }
  }

  recordHostOfficeLocalObservation(ticket: HostOfficeLocalTicket, effectId: string, artifactId: string): HostOfficeLocalEffectRecord {
    const state = this.requireMutableTicket(ticket);
    return this.journal.officeLocal.mutate(state.parent, state.producer, () => {
      this.requireMutableTicket(ticket);
      const execution = this.requireExecution(ticket.executionId);
      let effect = readOfficeLocalEffects(this.context.database, execution).find(item => item.effectId === effectId);
      if (!effect) return officeLocalFailure();
      // A rollback is not no-start. Restore only this actual live ticket's retained entered fact, not an ID from disk.
      if (!effect.enteredAt && state.entered.has(effectId)) {
        this.context.database.prepare(`UPDATE host_office_local_effects SET entered_at=?,revision=revision+1
          WHERE effect_id=? AND entered_at IS NULL`).run(state.entered.get(effectId)!, effectId);
        effect = readOfficeLocalEffects(this.context.database, execution).find(item => item.effectId === effectId)!;
      }
      validateOfficeLocalObservation(this.context.database, execution, effect, artifactId);
      if (effect.observationArtifactId) {
        if (effect.observationArtifactId !== artifactId) return officeLocalFailure();
        return effect;
      }
      const changed = this.context.database.prepare(`UPDATE host_office_local_effects SET observation_artifact_id=?,revision=revision+1
        WHERE effect_id=? AND observation_artifact_id IS NULL`).run(artifactId, effectId);
      if (changed.changes !== 1) return officeLocalFailure();
      return readOfficeLocalEffects(this.context.database, execution).find(item => item.effectId === effectId)!;
    }, true);
  }

  getHostOfficeLocalExecution(id: string): HostOfficeLocalExecutionRecord | undefined {
    return readSqliteSnapshot(this.context.database, () => readOfficeLocalExecution(this.context.database, id));
  }
  listHostOfficeLocalEffects(id: string): HostOfficeLocalEffectRecord[] {
    return readSqliteSnapshot(this.context.database, () => readOfficeLocalEffects(this.context.database, this.requireExecution(id)));
  }
  /** Seal complete captured facts under the original live pair; a terminal is not a journal settlement. */
  sealHostOfficeLocalTerminal(ticket: HostOfficeLocalTicket, input: SealHostOfficeLocalTerminalInput): HostOfficeLocalTerminalRecord {
    const state = this.requireTicket(ticket);
    const captured: unknown = JSON.parse(JSON.stringify(input));
    if (!captured || typeof captured !== "object" || Array.isArray(captured)
      || Object.keys(captured).length !== 2 || !Object.hasOwn(captured, "terminalArtifactId") || !Object.hasOwn(captured, "terminalDigest")) return officeLocalFailure();
    const claim = captured as SealHostOfficeLocalTerminalInput;
    if (typeof claim.terminalArtifactId !== "string" || claim.terminalArtifactId.length === 0 || claim.terminalArtifactId.length > 4096
      || claim.terminalArtifactId.includes("\0") || typeof claim.terminalDigest !== "string" || !/^[a-f0-9]{64}$/.test(claim.terminalDigest)) return officeLocalFailure();
    // Closed execution admits only reconciliation of the exact pre-existing
    // seal claim, never new resource observations, artifacts or writer effects.
    if (state.noStartClosed && (!state.sealClaim
      || state.sealClaim.terminalArtifactId !== claim.terminalArtifactId
      || state.sealClaim.terminalDigest !== claim.terminalDigest)) return hostOperationFailure("host_office_local_execution_closed");
    // No persisted-row fast path: even an identical retry must pass original live tickets, current owner and pair checks.
    return this.journal.officeLocal.sealTerminal(state.parent, state.producer, () => {
      if (state.sealClaim && (state.sealClaim.terminalArtifactId !== claim.terminalArtifactId
        || state.sealClaim.terminalDigest !== claim.terminalDigest)) return hostOperationFailure("host_office_local_terminal_claim_conflict");
      const execution = this.requireExecution(ticket.executionId);
      const terminal = validateOfficeLocalTerminalSeal(this.context.database, execution, claim);
      const existing = readOfficeLocalTerminal(this.context.database, execution);
      if (existing && (existing.terminalArtifactId !== claim.terminalArtifactId || existing.terminalDigest !== claim.terminalDigest)) {
        return hostOperationFailure("host_office_local_terminal_claim_conflict");
      }
      // Lock before INSERT/COMMIT, never release on rollback, and never manufacture a new claim after an uncertain return.
      state.sealClaim ??= Object.freeze({ terminalArtifactId: claim.terminalArtifactId, terminalDigest: claim.terminalDigest });
      if (existing) return existing;
      this.context.database.prepare(`INSERT INTO host_office_local_terminals(execution_id,schema_version,protocol,
        execution_identity_digest,terminal_artifact_id,terminal_digest,effect_set_digest,effect_count,sealed_at)
        VALUES(?,1,?,?,?,?,?,?,?)`).run(execution.executionId, terminal.protocol, execution.identityDigest,
          terminal.terminalArtifactId, terminal.terminalDigest, terminal.effectSetDigest, terminal.effectCount, terminal.sealedAt);
      return readOfficeLocalTerminal(this.context.database, execution) ?? officeLocalFailure();
    });
  }
  getHostOfficeLocalTerminal(id: string): HostOfficeLocalTerminalRecord | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const execution = readOfficeLocalExecution(this.context.database, id);
      return execution ? readOfficeLocalTerminal(this.context.database, execution) : undefined;
    });
  }
  /** Independently reverified sealed history only; neither this getter nor its record creates a live capability. */
  getHostOfficeLocalNoStartReceipt(id: string): HostOfficeLocalNoStartReceipt | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const execution = readOfficeLocalExecution(this.context.database, id);
      if (!execution) return undefined;
      const receipt = readOfficeLocalNoStartReceipt(this.context.database, execution);
      if (!receipt) return undefined;
      // The internal reader also serves settlement candidates. Public history
      // requires both committed canonical roles and their complete safe verifier.
      for (const operationId of [execution.parentOperationId, execution.producerOperationId]) {
        const operation = this.journal.getHostOperation(operationId);
        if (!operation || operation.phase !== "safe" || operation.settlementKind !== "known_no_start") return officeLocalFailure();
      }
      return receipt;
    });
  }
  /** Original live entry facts select the branch; caller booleans or a failed manifest never issue no-start authority. */
  settleHostOfficeLocalExecution(ticket: HostOfficeLocalTicket, input: SettleHostOfficeLocalInput = {}): HostOfficeLocalSettlement {
    const state = this.requireTicket(ticket), settledAt = input.settledAt;
    if (state.entered.size !== 0 || state.uncertainLaunch) {
      if (!state.sealClaim) return hostOperationFailure("host_office_local_terminal_missing");
      if (state.uncertainLaunch) return hostOperationFailure("host_office_local_launch_unknown");
    }
    // Pass the actual WeakMap-owned state, not a snapshot or caller assertion.
    // The journal closes it together with its original roles under the write lock.
    return this.journal.officeLocal.settle(state.parent, state.producer, state, settledAt);
  }
  private requireExecution(id: string): HostOfficeLocalExecutionRecord {
    return readOfficeLocalExecution(this.context.database, id) ?? officeLocalFailure();
  }
  private requireTicket(ticket: HostOfficeLocalTicket): OfficeTicketState {
    return this.tickets.get(ticket) ?? hostOperationFailure("host_office_local_invalid_ticket");
  }
  private requireMutableTicket(ticket: HostOfficeLocalTicket): OfficeTicketState {
    const state = this.requireTicket(ticket);
    if (state.noStartClosed) return hostOperationFailure("host_office_local_execution_closed");
    if (state.sealClaim) return hostOperationFailure("host_office_local_execution_sealed");
    return state;
  }
}
