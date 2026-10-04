import type { HostOperationSettlementInput } from "../../host-operation-journal-types.js";
import type { HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import {
  hostOperationDomainIdentity, hostOperationFailure, hostOperationTimestamp, readHostOperation,
  readSourceHostOperations, sameHostOperationSource, verifyHostOperationSafe,
  verifyHostOperationSettlementCandidate, type StoredHostOperation,
} from "./host-operation-journal-evidence.js";
import type { OfficeJournalTicketState } from "./host-office-local-journal-gate.js";
import type { SqliteStoreContext } from "./store-context.js";

interface OfficeSettlementPair {
  readonly parent: StoredHostOperation;
  readonly producer: StoredHostOperation;
  readonly states: readonly [OfficeJournalTicketState, OfficeJournalTicketState];
}
const signature = (kind: HostOperationSettlementInput["kind"], settledAt: string): string => JSON.stringify({ kind, settledAt });

/** Caller owns BEGIN IMMEDIATE and the original live-ticket/owner checks; never nests transactions. */
export function settleOfficeLocalJournalPair(context: SqliteStoreContext, pair: OfficeSettlementPair,
  settledAt: string): HostOfficeLocalSettlement {
  const { database } = context, { parent, producer, states } = pair;
  const at = hostOperationTimestamp(settledAt);
  const parentSignature = signature("office_local_chain_completed", settledAt);
  const producerSignature = signature("office_local_binary_completed", settledAt);
  for (const [row, state, expected] of [[parent, states[0], parentSignature], [producer, states[1], producerSignature]] as const) {
    if (state.settlementSignature && state.settlementSignature !== expected
      || row.settlementSignature && row.settlementSignature !== expected) return hostOperationFailure("host_operation_settlement_conflict");
    if (at < hostOperationTimestamp(row.launchedAt ?? row.admittedAt)) return hostOperationFailure("host_operation_invalid_timestamp");
  }
  if (parent.evidenceRef?.kind !== "office_local_chain_execution" || producer.evidenceRef?.kind !== "office_local_binary_execution"
    || parent.evidenceRef.id !== producer.evidenceRef.id) return hostOperationFailure("host_office_local_invalid_journal_pair");
  const verified = (row: StoredHostOperation): StoredHostOperation => {
    if (verifyHostOperationSafe(database, row) !== row.evidenceDigest) return hostOperationFailure("host_operation_evidence_invalid");
    return row;
  };
  if (parent.phase === "safe" && producer.phase === "safe") return { parent: verified(parent), producer: verified(producer) };
  if (parent.phase !== "launched" || producer.phase !== "launched"
    || states.some(state => !state.launchClaimed || state.uncertainLaunch)) return hostOperationFailure("host_office_local_launch_unknown");

  const candidate = (row: StoredHostOperation, kind: HostOperationSettlementInput["kind"], intent: string): StoredHostOperation => ({
    ...row, phase: "safe", settledAt, settlementKind: kind, settlementSignature: intent,
  });
  const producerCandidate = candidate(producer, "office_local_binary_completed", producerSignature);
  // Prove all other reserved children before latching an intent. A pending child must
  // remain retryable with a later timestamp after its own facts have actually closed.
  const children = readSourceHostOperations(database, parent.source).filter(row => row.parentOperationId === parent.operationId);
  for (const child of children) {
    if (child.operationId === producer.operationId) continue;
    if (!sameHostOperationSource(child.source, parent.source) || child.toolCallId !== parent.toolCallId
      || verifyHostOperationSafe(database, child, settledAt) !== child.evidenceDigest) return hostOperationFailure("host_operation_evidence_invalid");
  }
  const producerDigest = verifyHostOperationSettlementCandidate(database, producerCandidate);
  if (hostOperationDomainIdentity(database, parent, parent.evidenceRef, false) !== parent.domainIdentityDigest) {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  // Once SQL settlement begins, rollback/COMMIT-return loss cannot change the terminal
  // intent. These live latches deliberately survive the caller's transaction rollback.
  states[0].settlementSignature = parentSignature; states[1].settlementSignature = producerSignature;
  const write = (row: StoredHostOperation, kind: HostOperationSettlementInput["kind"], intent: string, digest: string): StoredHostOperation => {
    const changed = database.prepare(`UPDATE host_operations SET phase='safe',settled_at=?,settlement_kind=?,
      evidence_digest=?,settlement_signature=?,code=NULL,revision=revision+1
      WHERE operation_id=? AND revision=? AND phase='launched'`).run(settledAt, kind, digest, intent, row.operationId, row.revision);
    if (changed.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
    return readHostOperation(database, row.operationId) ?? hostOperationFailure("host_operation_journal_corrupt");
  };
  const producerResult = write(producer, "office_local_binary_completed", producerSignature, producerDigest);
  const parentCandidate = candidate(parent, "office_local_chain_completed", parentSignature);
  // The generic verifier rereads every required child and its immutable receipt while
  // the producer's safe update is still invisible outside this same write transaction.
  const parentDigest = verifyHostOperationSettlementCandidate(database, parentCandidate);
  const parentResult = write(parent, "office_local_chain_completed", parentSignature, parentDigest);
  // No role is a public-safe receipt until both writes exist under this same
  // transaction. Reverify the committed-shape whole pair before COMMIT.
  return { parent: verified(parentResult), producer: verified(producerResult) };
}
