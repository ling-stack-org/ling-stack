import { isDeepStrictEqual } from "node:util";
import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { RuntimeHostCapacityIntentRecord, RuntimeHostCapacityApprovalResumePendingInput,
  RuntimeHostCapacityUserInputPendingInput, PrepareRuntimeHostCapacityDelegationPendingResult } from "./runtime-host-capacity-types.js";
import type { HostRunCapacityStore } from "./storage/host-run-capacity-store.js";
import type { RuntimeHostCapacityJournal } from "./runtime-host-capacity-store-bridge.js";

export type ReserveRuntimeHostCapacityAttemptResult =
  | { readonly status: "reserved" | "duplicate"; readonly record: RuntimeHostCapacityIntentRecord }
  | { readonly status: "full" | "unconfigured" | "changed" | "retained" };

/** Each store commits before the next store is entered. Recovery observes receipts, never dispatches. */
export class RuntimeHostCapacityBridge {
  constructor(private readonly workspace: RuntimeHostCapacityJournal, private readonly host: HostRunCapacityStore) {}

  reserveApprovalResumePending(input: RuntimeHostCapacityApprovalResumePendingInput): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    return this.reservePending(this.workspace.prepareApprovalResumePending(input), input.now);
  }

  reserveUserInputContinuation(input: RuntimeHostCapacityUserInputPendingInput): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    return this.reservePending(this.workspace.prepareUserInputContinuation(input), input.now);
  }

  private reservePending(prepared: PrepareRuntimeHostCapacityDelegationPendingResult, now: string): ReserveRuntimeHostCapacityAttemptResult {
    if (prepared.status === "changed") return prepared;
    const reserved = this.host.reserve({ intent: prepared.record.intent, now });
    if (reserved.status === "full" || reserved.status === "unconfigured") return { status: reserved.status };
    if (!("reservation" in reserved) || reserved.status === "released") return { status: "changed" };
    const attached = this.workspace.attachReservation({ intentId: prepared.record.intent.intentId, reservation: reserved.reservation, now });
    if (attached.status === "changed") return { status: "retained" };
    return { status: reserved.status === "reserved" ? "reserved" : "duplicate", record: attached.record };
  }

  reserveAttempt(input: { readonly source: HostOperationSource; readonly now: string }): ReserveRuntimeHostCapacityAttemptResult {
    return this.reserveOrdinaryAttempt(input, false);
  }

  reserveExecution(input: { readonly source: HostOperationSource; readonly now: string }): ReserveRuntimeHostCapacityAttemptResult {
    return this.reserveOrdinaryAttempt(input, true);
  }

  private reserveOrdinaryAttempt(input: { readonly source: HostOperationSource; readonly now: string }, execution: boolean): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    const prepared = execution ? this.workspace.prepareExecution(input) : this.workspace.prepareAttempt(input);
    if (prepared.status === "changed") return prepared;
    const reserved = this.host.reserve({ intent: prepared.record.intent, now: input.now });
    if (reserved.status === "full" || reserved.status === "unconfigured") return { status: reserved.status };
    if (!("reservation" in reserved) || reserved.status === "released") return { status: "changed" };
    const attached = this.workspace.attachReservation({ intentId: prepared.record.intent.intentId,
      reservation: reserved.reservation, now: input.now });
    if (attached.status === "changed") return { status: "retained" };
    return { status: reserved.status === "reserved" ? "reserved" : "duplicate", record: attached.record };
  }

  reserveWorkflowStart(input: { readonly source: HostOperationSource; readonly now: string }): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    const prepared = this.workspace.prepareWorkflowStart(input);
    if (prepared.status === "changed") return prepared;
    const reserved = this.host.reserve({ intent: prepared.record.intent, now: input.now });
    if (reserved.status === "full" || reserved.status === "unconfigured") return { status: reserved.status };
    if (!("reservation" in reserved) || reserved.status === "released") return { status: "changed" };
    const attached = this.workspace.attachReservation({ intentId: prepared.record.intent.intentId,
      reservation: reserved.reservation, now: input.now });
    if (attached.status === "changed") return { status: "retained" };
    return { status: reserved.status === "reserved" ? "reserved" : "duplicate", record: attached.record };
  }

  reserveDelegationSpawn(input: { readonly source: HostOperationSource; readonly now: string }): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    const prepared = this.workspace.prepareDelegationSpawn(input);
    if (prepared.status === "changed") return prepared;
    const reserved = this.host.reserve({ intent: prepared.record.intent, now: input.now });
    if (reserved.status === "full" || reserved.status === "unconfigured") return { status: reserved.status };
    if (!("reservation" in reserved) || reserved.status === "released") return { status: "changed" };
    const attached = this.workspace.attachReservation({ intentId: prepared.record.intent.intentId,
      reservation: reserved.reservation, now: input.now });
    if (attached.status === "changed") return { status: "retained" };
    return { status: reserved.status === "reserved" ? "reserved" : "duplicate", record: attached.record };
  }

  reserveDelegationPending(input: { readonly admissionId: string; readonly now: string }): ReserveRuntimeHostCapacityAttemptResult {
    this.assertOutsideTransactions();
    const prepared = this.workspace.prepareDelegationPending(input);
    if (prepared.status === "changed") return prepared;
    const reserved = this.host.reserve({ intent: prepared.record.intent, now: input.now });
    if (reserved.status === "full" || reserved.status === "unconfigured") return { status: reserved.status };
    if (!("reservation" in reserved) || reserved.status === "released") return { status: "changed" };
    const attached = this.workspace.attachReservation({ intentId: prepared.record.intent.intentId,
      reservation: reserved.reservation, now: input.now });
    if (attached.status === "changed") return { status: "retained" };
    return { status: reserved.status === "reserved" ? "reserved" : "duplicate", record: attached.record };
  }

  /** An orphan Host reservation can be attached after cancellation, then revoked by the original journal. */
  observeReservation(intentId: string, now: string): RuntimeHostCapacityIntentRecord | undefined {
    this.assertOutsideTransactions();
    const record = this.workspace.getIntent(intentId);
    if (!record) return undefined;
    const reservation = this.host.getReservation(record.intent.workspaceKey, intentId);
    if (!reservation || !isDeepStrictEqual(record.intent, reservation.intent)) return undefined;
    if (reservation.state === "held") {
      const attached = this.workspace.attachReservation({ intentId, reservation, now });
      return attached.status === "changed" ? undefined : attached.record;
    }
    return this.workspace.acknowledgeRelease({ intentId, reservation, now }) ? this.workspace.getIntent(intentId) : undefined;
  }

  flushRelease(intentId: string, now: string): boolean {
    this.assertOutsideTransactions();
    const record = this.workspace.getIntent(intentId), outbox = this.workspace.getRelease(intentId);
    if (!record?.reservation || !outbox || outbox.reservationId !== record.reservation.reservationId
      || outbox.token !== record.reservation.token || outbox.createdAt > now) return false;
    const released = this.host.release({ reservationId: outbox.reservationId, token: outbox.token,
      intent: record.intent, kind: outbox.kind, proofDigest: outbox.proofDigest, now });
    return released.status !== "changed" && this.workspace.acknowledgeRelease({ intentId, reservation: released.reservation, now });
  }

  private assertOutsideTransactions(): void {
    this.workspace.assertOutsideTransaction();
    if (this.host.database.isTransaction === true) throw new Error("runtime_host_capacity.nested_handoff");
    if (this.host.database.isTransaction === undefined) {
      this.host.database.exec("BEGIN DEFERRED");
      this.host.database.exec("ROLLBACK");
    }
  }
}
