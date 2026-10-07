import type { HostOperationSource, HostOperationTicket } from "../../host-operation-journal-types.js";
import { hostOperationDomainIdentity, hostOperationFailure, sameHostOperationSource, type StoredHostOperation } from "./host-operation-journal-evidence.js";
import type { HostOfficeLocalExecutionRecord, HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import type { SealHostOfficeLocalTerminalInput } from "../../host-office-local-terminal-types.js";
import { readOfficeLocalExecution } from "./host-office-local-records.js";
import { readOfficeLocalTerminal } from "./host-office-local-terminal-records.js";
import { settleOfficeLocalJournalPair } from "./host-office-local-journal-settlement.js";
import { settleOfficeLocalNoStartPair } from "./host-office-local-no-start-settlement.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertOfficeDirectoryCloseRosterReadyV2 } from "./host-office-local-directory-v2-close-roster.js";
import type { OfficeDirectorySettlementPairV2 } from "./host-office-local-directory-v2-settlement.js";

/** Internal journal state, never exported as an execution capability. */
export interface OfficeJournalTicketState {
  readonly source: HostOperationSource;
  launchClaimed: boolean;
  uncertainLaunch: boolean;
  noStartClosed: boolean;
  /** Retained before receipt INSERT; a rollback cannot substitute different exclusion facts at the same clock. */
  noStartReceiptDigest?: string;
  settlementSignature?: string;
}
/** The Store passes its actual private state reference, never a caller's settlement input or proof. */
interface OfficeSettlementLiveState {
  readonly entered: ReadonlyMap<string, string>;
  readonly uncertainLaunch: boolean;
  readonly writerObservationStarted: boolean;
  readonly sealClaim?: SealHostOfficeLocalTerminalInput;
  noStartClosed: boolean;
}
interface JournalAuthority {
  ticket(ticket: HostOperationTicket): OfficeJournalTicketState;
  operation(ticket: HostOperationTicket, state: OfficeJournalTicketState): StoredHostOperation;
  owner(source: HostOperationSource, cleanup: boolean): void;
  forward(source: HostOperationSource): void;
  parents(operation: StoredHostOperation): void;
  closeOffice(parentOperationId: string, producerOperationId: string): void;
  closeDirectoryOffice(parentOperationId: string, producerOperationId: string): void;
  synchronous(callback: unknown): void;
  synchronousResult<T>(result: T): T;
  transaction<T>(callback: () => T): T;
}

/** Office pair enforcement, factored away from the already-large generic journal. */
export class HostOfficeLocalJournalGate {
  constructor(private readonly context: SqliteStoreContext, private readonly authority: JournalAuthority) {}

  prepare<T extends { readonly executionId: string }>(parent: HostOperationTicket, producer: HostOperationTicket,
    callback: (parent: StoredHostOperation, producer: StoredHostOperation) => T): T {
    this.authority.synchronous(callback);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer);
      this.authority.owner(pair.parent.source, false); this.authority.forward(pair.parent.source);
      if (pair.parent.phase !== "admitted" || pair.producer.phase !== "admitted" || pair.parent.evidenceRef || pair.producer.evidenceRef
        || pair.states.some(state => state.launchClaimed || state.uncertainLaunch)) return hostOperationFailure("host_office_local_preparation_too_late");
      const execution = this.authority.synchronousResult(callback(pair.parent, pair.producer));
      for (const [row, kind] of [[pair.parent, "office_local_chain_execution"], [pair.producer, "office_local_binary_execution"]] as const) {
        const evidence = { kind, id: execution.executionId } as const;
        const identity = hostOperationDomainIdentity(this.context.database, row, evidence, true);
        const changed = this.context.database.prepare(`UPDATE host_operations SET evidence_kind=?,evidence_id=?,
          domain_identity_digest=?,revision=revision+1 WHERE operation_id=? AND revision=? AND phase='admitted' AND evidence_id IS NULL`)
          .run(kind, evidence.id, identity, row.operationId, row.revision);
        if (changed.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
      }
      return execution;
    });
  }

  /** A receipt may release both roles only through this original live pair and owner. */
  settle(parent: HostOperationTicket, producer: HostOperationTicket, live: OfficeSettlementLiveState,
    settledAt?: string): HostOfficeLocalSettlement {
    const retained = this.authority.ticket(parent).settlementSignature;
    const at = settledAt ?? (retained ? JSON.parse(retained).settledAt as string : new Date().toISOString());
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer, true);
      this.authority.owner(pair.parent.source, true);
      const officeEntered = live.entered.size !== 0, journalEntered = pair.states.every(state => state.launchClaimed);
      if (live.uncertainLaunch || pair.states.some(state => state.uncertainLaunch)
        || officeEntered !== journalEntered || pair.states.some(state => state.launchClaimed) !== journalEntered) {
        return hostOperationFailure("host_office_local_launch_unknown");
      }
      if (!officeEntered) {
        if (pair.parent.evidenceRef?.kind !== "office_local_chain_execution"
          || pair.producer.evidenceRef?.kind !== "office_local_binary_execution"
          || pair.parent.evidenceRef.id !== pair.producer.evidenceRef.id
          || pair.parent.launchedAt || pair.producer.launchedAt) return hostOperationFailure("host_office_local_invalid_journal_pair");
        // Closing is not a receipt claim. It deliberately survives failed child
        // validation without pinning an obsolete receipt/settlement timestamp.
        live.noStartClosed = true;
        for (const state of pair.states) state.noStartClosed = true;
        this.authority.closeOffice(pair.parent.operationId, pair.producer.operationId);
        if (live.writerObservationStarted || live.sealClaim) {
          const execution = readOfficeLocalExecution(this.context.database, pair.parent.evidenceRef.id);
          const terminal = execution && readOfficeLocalTerminal(this.context.database, execution);
          if (!terminal || !live.sealClaim) return hostOperationFailure("host_office_local_terminal_missing");
          if (terminal.terminalArtifactId !== live.sealClaim.terminalArtifactId
            || terminal.terminalDigest !== live.sealClaim.terminalDigest) return hostOperationFailure("host_office_local_terminal_claim_conflict");
        }
        return settleOfficeLocalNoStartPair(this.context, pair, at);
      }
      if (live.noStartClosed || pair.states.some(state => state.noStartClosed)) return hostOperationFailure("host_office_local_execution_closed");
      return settleOfficeLocalJournalPair(this.context, pair, at);
    });
  }

  /** Dedicated original-claim persistence reconciliation, not a general closed-lifecycle write gate. */
  sealTerminal<T>(parent: HostOperationTicket, producer: HostOperationTicket, callback: () => T): T {
    this.authority.synchronous(callback);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer, true);
      this.authority.owner(pair.parent.source, true);
      if ([pair.parent, pair.producer].some(row => !["admitted", "launched"].includes(row.phase))
        || pair.states.some(state => state.settlementSignature || state.noStartReceiptDigest)) {
        return hostOperationFailure("host_operation_settlement_conflict");
      }
      return this.authority.synchronousResult(callback());
    });
  }

  mutate<T>(parent: HostOperationTicket, producer: HostOperationTicket, callback: () => T, observation: boolean): T {
    this.authority.synchronous(callback);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer);
      this.authority.owner(pair.parent.source, observation);
      if (!observation) {
        this.authority.forward(pair.parent.source);
        if (pair.states.some(state => state.uncertainLaunch)) return hostOperationFailure("host_office_local_launch_unknown");
      }
      return callback();
    });
  }

  /** Original V2 close only. Child/native preflight precedes the irreversible admission latch. */
  closeDirectoryWindow<T>(parent: HostOperationTicket, producer: HostOperationTicket,
    assertReady: () => void, close: () => T): T {
    this.authority.synchronous(assertReady); this.authority.synchronous(close);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer, true);
      this.authority.owner(pair.parent.source, true);
      if ([pair.parent, pair.producer].some(row => !["admitted", "launched"].includes(row.phase))
        || pair.states.some(state => state.noStartClosed || state.settlementSignature || state.noStartReceiptDigest)
        || pair.parent.evidenceRef?.kind !== "office_local_chain_execution"
        || pair.producer.evidenceRef?.kind !== "office_local_binary_execution"
        || pair.parent.evidenceRef.id !== pair.producer.evidenceRef.id) return hostOperationFailure("host_office_local_invalid_journal_pair");
      readSqliteWithinTransaction(this.context.database, () => {
        for (const row of [pair.parent, pair.producer]) {
          if (hostOperationDomainIdentity(this.context.database, row, row.evidenceRef!, false) !== row.domainIdentityDigest) {
            return hostOperationFailure("host_operation_evidence_invalid");
          }
        }
        assertOfficeDirectoryCloseRosterReadyV2(this.context.database, pair.parent, pair.producer, new Date().toISOString());
        this.authority.synchronousResult(assertReady());
      });
      return readSqliteWithinTransaction(this.context.database, () => {
        // A failed read-window setup has not entered physical closure. Once
        // this callback starts, both original admissions close before Host JS.
        this.authority.closeDirectoryOffice(pair.parent.operationId, pair.producer.operationId);
        return close();
      });
    });
  }

  /** Dedicated V2 pair gate. Only original live state may issue the certificate; no generic settlement DTO is accepted. */
  settleDirectory<T>(parent: HostOperationTicket, producer: HostOperationTicket,
    assertReady: (pair: OfficeDirectorySettlementPairV2, settledAt: string) => void,
    settle: (pair: OfficeDirectorySettlementPairV2, settledAt: string) => T): T {
    this.authority.synchronous(assertReady); this.authority.synchronous(settle);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer, true);
      this.authority.owner(pair.parent.source, false);
      const retained = pair.states[0].settlementSignature;
      const settledAt = retained ? JSON.parse(retained).settledAt as string : new Date().toISOString();
      if (pair.states.some(state => state.noStartClosed || state.noStartReceiptDigest || !state.launchClaimed || state.uncertainLaunch)
        || pair.parent.evidenceRef?.kind !== "office_local_chain_execution"
        || pair.producer.evidenceRef?.kind !== "office_local_binary_execution"
        || pair.parent.evidenceRef.id !== pair.producer.evidenceRef.id) return hostOperationFailure("host_office_local_invalid_journal_pair");
      readSqliteWithinTransaction(this.context.database, () => {
        for (const row of [pair.parent, pair.producer]) {
          if (hostOperationDomainIdentity(this.context.database, row, row.evidenceRef!, false) !== row.domainIdentityDigest) {
            return hostOperationFailure("host_operation_evidence_invalid");
          }
        }
        assertOfficeDirectoryCloseRosterReadyV2(this.context.database, pair.parent, pair.producer, settledAt);
        this.authority.synchronousResult(assertReady(pair, settledAt));
      });
      // Revalidate the owner after the fixed read-only endpoint returns and before any SQL issuance.
      this.authority.owner(pair.parent.source, false);
      return this.authority.synchronousResult(settle(pair, settledAt));
    });
  }

  effect<T>(parent: HostOperationTicket, producer: HostOperationTicket, beforeEffect: () => void,
    effect: () => T, mode: "forward" | "cleanup"): T {
    this.authority.synchronous(beforeEffect); this.authority.synchronous(effect);
    let entered = false;
    // Resolve live tickets before opening the transaction; copied/foreign tickets never reach a callback.
    const states = [this.authority.ticket(parent), this.authority.ticket(producer)] as const;
    try {
      return this.authority.transaction(() => {
        const pair = this.pair(parent, producer);
        this.authority.owner(pair.parent.source, mode === "cleanup");
        if (mode === "forward") {
          this.authority.forward(pair.parent.source);
          if (states.some(state => state.uncertainLaunch)) return hostOperationFailure("host_office_local_launch_unknown");
        } else if (mode !== "cleanup" || states.some(state => !state.launchClaimed)) {
          return hostOperationFailure("host_office_local_cleanup_not_entered");
        }
        this.authority.parents(pair.producer);
        this.authority.synchronousResult(beforeEffect());
        // Preparation is allowed to write facts, but cannot replace the source
        // or close admission between our first check and the actual syscall.
        this.authority.owner(pair.parent.source, mode === "cleanup");
        if (mode === "forward") this.authority.forward(pair.parent.source);
        const current = this.pair(parent, producer);
        this.authority.parents(current.producer);
        const at = new Date().toISOString();
        for (const row of [current.parent, current.producer]) {
          if (row.phase === "admitted") this.context.database.prepare(`UPDATE host_operations SET phase='launched',
            launched_at=?,revision=revision+1 WHERE operation_id=? AND phase='admitted'`).run(at, row.operationId);
        }
        return readSqliteWithinTransaction(this.context.database, () => {
          entered = true;
          for (const state of states) state.launchClaimed = true;
          return effect();
        });
      });
    } catch (error) {
      if (entered) for (const state of states) state.uncertainLaunch = true;
      throw error;
    }
  }

  private pair(parentTicket: HostOperationTicket, producerTicket: HostOperationTicket, allowSettled = false) {
    const states = [this.authority.ticket(parentTicket), this.authority.ticket(producerTicket)] as const;
    const parent = this.authority.operation(parentTicket, states[0]), producer = this.authority.operation(producerTicket, states[1]);
    if (!allowSettled && states.some(state => state.noStartClosed)) return hostOperationFailure("host_office_local_execution_closed");
    if (parent.kind !== "mcp" || parent.parentOperationId || producer.kind !== "file_mutation"
      || producer.parentOperationId !== parent.operationId || producer.producerId !== "office-local-binary"
      || parent.toolCallId !== producer.toolCallId || !sameHostOperationSource(parent.source, producer.source)
      || !allowSettled && states.some(state => !!state.settlementSignature)
      || !(allowSettled ? ["admitted", "launched", "safe"] : ["admitted", "launched"]).includes(parent.phase)
      || !(allowSettled ? ["admitted", "launched", "safe"] : ["admitted", "launched"]).includes(producer.phase)) {
      return hostOperationFailure("host_office_local_invalid_journal_pair");
    }
    return { parent, producer, states };
  }
}
