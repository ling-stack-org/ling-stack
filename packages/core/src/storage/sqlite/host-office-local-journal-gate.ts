import type { HostOperationSource, HostOperationTicket } from "../../host-operation-journal-types.js";
import { hostOperationFailure, sameHostOperationSource, type StoredHostOperation } from "./host-operation-journal-evidence.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Internal journal state, never exported as an execution capability. */
export interface OfficeJournalTicketState {
  readonly source: HostOperationSource;
  launchClaimed: boolean;
  uncertainLaunch: boolean;
  settlementSignature?: string;
}
interface JournalAuthority {
  ticket(ticket: HostOperationTicket): OfficeJournalTicketState;
  operation(ticket: HostOperationTicket, state: OfficeJournalTicketState): StoredHostOperation;
  owner(source: HostOperationSource, cleanup: boolean): void;
  forward(source: HostOperationSource): void;
  parents(operation: StoredHostOperation): void;
  synchronous(callback: unknown): void;
  synchronousResult<T>(result: T): T;
  transaction<T>(callback: () => T): T;
}

/** Office pair enforcement, factored away from the already-large generic journal. */
export class HostOfficeLocalJournalGate {
  constructor(private readonly context: SqliteStoreContext, private readonly authority: JournalAuthority) {}

  prepare<T>(parent: HostOperationTicket, producer: HostOperationTicket,
    callback: (parent: StoredHostOperation, producer: StoredHostOperation) => T): T {
    this.authority.synchronous(callback);
    return this.authority.transaction(() => {
      const pair = this.pair(parent, producer);
      this.authority.owner(pair.parent.source, false); this.authority.forward(pair.parent.source);
      if (pair.parent.phase !== "admitted" || pair.producer.phase !== "admitted"
        || pair.states.some(state => state.launchClaimed || state.uncertainLaunch)) return hostOperationFailure("host_office_local_preparation_too_late");
      return callback(pair.parent, pair.producer);
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

  private pair(parentTicket: HostOperationTicket, producerTicket: HostOperationTicket) {
    const states = [this.authority.ticket(parentTicket), this.authority.ticket(producerTicket)] as const;
    const parent = this.authority.operation(parentTicket, states[0]), producer = this.authority.operation(producerTicket, states[1]);
    if (parent.kind !== "mcp" || parent.parentOperationId || producer.kind !== "file_mutation"
      || producer.parentOperationId !== parent.operationId || producer.producerId !== "office-local-binary"
      || parent.toolCallId !== producer.toolCallId || !sameHostOperationSource(parent.source, producer.source)
      || states.some(state => !!state.settlementSignature)
      || !["admitted", "launched"].includes(parent.phase) || !["admitted", "launched"].includes(producer.phase)) {
      return hostOperationFailure("host_office_local_invalid_journal_pair");
    }
    return { parent, producer, states };
  }
}
