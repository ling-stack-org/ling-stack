import type {
  HostMediaEffectRecord, HostMediaExecutionRecord, HostMediaExecutionTicket,
  PrepareHostMediaEffectInput, PrepareHostMediaExecutionInput,
} from "../../host-media-operation-types.js";
import type { HostOperationTicket } from "../../host-operation-journal-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { hostOperationFailure } from "./host-operation-journal-evidence.js";
import { SqliteHostOperationJournalStore } from "./host-operation-journal-store.js";
import { SqliteHostMediaFactsStore } from "./host-media-operation-facts.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { SqliteHostMediaReceiptStore } from "./host-media-receipt-store.js";
import type { HostMediaSubmissionExecutionProjection } from "../../host-media-receipt-types.js";
import { snapshotMediaSubmissionProjection } from "./host-media-submission-handle.js";

interface MediaTicketState {
  readonly parent: HostOperationTicket;
  readonly transport: HostOperationTicket;
  readonly enteredEffects: Set<string>;
  uncertainLaunch: boolean;
}

/**
 * Private capability layer, separate from SQL facts and the remote verifier.
 * Prepared facts never settle the journal safe. Fixed receipt writes and the
 * independent domain verifier must establish the complete exact scope first.
 */
export class SqliteHostMediaOperationStore {
  private readonly tickets = new WeakMap<HostMediaExecutionTicket, MediaTicketState>();
  private readonly facts: SqliteHostMediaFactsStore;
  private readonly receipts: SqliteHostMediaReceiptStore;
  constructor(private readonly context: SqliteStoreContext, private readonly journal: SqliteHostOperationJournalStore) {
    this.facts = new SqliteHostMediaFactsStore(context);
    this.receipts = new SqliteHostMediaReceiptStore(context);
  }

  prepareHostMediaExecution(parent: HostOperationTicket, transport: HostOperationTicket,
    input: PrepareHostMediaExecutionInput): HostMediaExecutionTicket {
    // Capture primitives before the writer gate. No accessor runs between owner validation and send.
    const snapshot: PrepareHostMediaExecutionInput = Object.freeze({ executionId: input.executionId, mediaJobId: input.mediaJobId,
      mediaChildWorkUnitId: input.mediaChildWorkUnitId, executionGenerationId: input.executionGenerationId,
      protocol: input.protocol, adapterId: input.adapterId, toolName: input.toolName, operation: input.operation,
      intentDigest: input.intentDigest, targetDigest: input.targetDigest, namespaceDigest: input.namespaceDigest,
      preparedRequestArtifactId: input.preparedRequestArtifactId, preparedRequestDigest: input.preparedRequestDigest, preparedAt: input.preparedAt });
    this.journal.prepareMediaExecutionFacts(parent, transport, (parentRow, transportRow) => this.facts.insertPreparedExecution({
      ...snapshot, source: parentRow.source, toolCallId: parentRow.toolCallId,
      parentOperationId: parentRow.operationId, transportOperationId: transportRow.operationId }), snapshot.executionId);
    const ticket = Object.freeze({ executionId: snapshot.executionId }) as HostMediaExecutionTicket;
    this.tickets.set(ticket, { parent, transport, enteredEffects: new Set(), uncertainLaunch: false });
    return ticket;
  }

  bindHostMediaChildExecution(ticket: HostMediaExecutionTicket, child: RuntimeAttemptFenceV1): HostMediaExecutionRecord {
    const state = this.requireTicket(ticket);
    const snapshot = Object.freeze({ workUnitId: child.workUnitId, attemptId: child.attemptId,
      runtimeInstanceId: child.runtimeInstanceId, fencingToken: child.fencingToken });
    return this.mutateBeforeForwardEffect(state, () => this.facts.bindChildExecution(ticket.executionId, snapshot, new Date().toISOString()));
  }

  prepareHostMediaEffect(ticket: HostMediaExecutionTicket, input: PrepareHostMediaEffectInput): HostMediaEffectRecord {
    const state = this.requireTicket(ticket);
    const snapshot = Object.freeze({ effectId: input.effectId, ordinal: input.ordinal, kind: input.kind, method: input.method,
      routeDigest: input.routeDigest, wireDigest: input.wireDigest, preparedAt: input.preparedAt });
    return this.mutateBeforeForwardEffect(state, () => this.facts.prepareEffect(ticket.executionId, snapshot));
  }

  launchHostMediaEffect<T>(ticket: HostMediaExecutionTicket, effectId: string, send: () => T): T {
    const state = this.requireTicket(ticket);
    if (typeof send !== "function" || Object.prototype.toString.call(send) === "[object AsyncFunction]") {
      return hostOperationFailure("host_operation_effect_must_be_synchronous");
    }
    if (state.uncertainLaunch) return hostOperationFailure("host_media_launch_unknown");
    if (state.enteredEffects.has(effectId)) return hostOperationFailure("host_media_effect_already_launched");
    let entered = false;
    try {
      return this.journal.launchMediaExecutionMember(state.parent, state.transport,
        () => this.facts.markEffectLaunched(ticket.executionId, effectId, new Date().toISOString()),
        () => { state.enteredEffects.add(effectId); entered = true; return send(); });
    } catch (error) {
      if (entered) state.uncertainLaunch = true;
      throw error;
    }
  }

  getHostMediaExecution(id: string): HostMediaExecutionRecord | undefined {
    return readSqliteSnapshot(this.context.database, () => this.facts.getExecution(id));
  }
  listHostMediaEffects(id: string): HostMediaEffectRecord[] {
    return readSqliteSnapshot(this.context.database, () => this.facts.listEffects(id));
  }

  recordHostMediaResponse(ticket: HostMediaExecutionTicket, effectId: string, artifactId: string): HostMediaExecutionRecord {
    return this.record(ticket, () => this.receipts.recordResponse(ticket.executionId, effectId, artifactId));
  }
  recordHostMediaSubmission(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    return this.record(ticket, () => this.receipts.recordSubmission(ticket.executionId, artifactId));
  }
  recordHostMediaSubmissionAndExecutionHandle(ticket: HostMediaExecutionTicket, artifactId: string,
    projection: HostMediaSubmissionExecutionProjection): HostMediaExecutionRecord {
    this.requireTicket(ticket);
    // Capture JSON data before the owner lock; no caller accessor/callback runs in the journal transaction.
    const snapshot = snapshotMediaSubmissionProjection(projection);
    return this.record(ticket, () => this.receipts.recordSubmissionAndExecutionHandle(ticket.executionId, artifactId, snapshot));
  }
  recordHostMediaTerminal(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    return this.record(ticket, () => this.receipts.recordTerminal(ticket.executionId, artifactId));
  }
  recordHostMediaArtifactManifest(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    return this.record(ticket, () => this.receipts.recordManifest(ticket.executionId, artifactId));
  }
  finalizeHostMediaExecution(ticket: HostMediaExecutionTicket, artifactId: string): HostMediaExecutionRecord {
    return this.record(ticket, () => this.receipts.finalize(ticket.executionId, artifactId));
  }
  recordHostMediaEffectNoStart(ticket: HostMediaExecutionTicket, effectId: string, artifactId: string): HostMediaExecutionRecord {
    const state = this.requireTicket(ticket);
    if (state.uncertainLaunch || state.enteredEffects.has(effectId)) return hostOperationFailure("host_media_launch_unknown");
    return this.record(ticket, () => this.receipts.recordNoStart(ticket.executionId, effectId, artifactId));
  }
  private record<T>(ticket: HostMediaExecutionTicket, mutation: () => T): T {
    const state = this.requireTicket(ticket);
    return this.journal.recordMediaExecutionFacts(state.parent, state.transport, mutation);
  }

  private requireTicket(ticket: HostMediaExecutionTicket): MediaTicketState {
    return this.tickets.get(ticket) ?? hostOperationFailure("host_media_invalid_ticket");
  }
  private mutateBeforeForwardEffect<T>(state: MediaTicketState, mutation: () => T): T {
    if (state.uncertainLaunch) return hostOperationFailure("host_media_launch_unknown");
    // No actual effect: this pair check validates the original source and closure
    // without launching either operation or resetting a previous launch latch.
    return this.journal.mutateMediaExecutionFacts(state.parent, state.transport, mutation);
  }
}
