import type { HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import {
  hostOperationDomainIdentity, hostOperationFailure, hostOperationTimestamp, readHostOperation,
  sameHostOperationSource, verifyHostOperationSafe, verifyHostOperationSettlementCandidate,
  type StoredHostOperation,
} from "./host-operation-journal-evidence.js";
import type { OfficeJournalTicketState } from "./host-office-local-journal-gate.js";
import { readOfficeLocalExecution } from "./host-office-local-records.js";
import {
  createOfficeLocalNoStartReceipt, insertOfficeLocalNoStartReceipt, readOfficeLocalNoStartReceipt,
} from "./host-office-local-no-start-records.js";
import type { SqliteStoreContext } from "./store-context.js";

interface OfficeNoStartPair {
  readonly parent: StoredHostOperation;
  readonly producer: StoredHostOperation;
  readonly states: readonly [OfficeJournalTicketState, OfficeJournalTicketState];
}

/** Every original descendant is required, including children below the binary role; IDs alone are not proof. */
function requiredNoStartDescendants(context: SqliteStoreContext, pair: OfficeNoStartPair, settledAt: string): {
  readonly operationId: string; readonly evidenceDigest: string;
}[] {
  const { database } = context, { parent, producer } = pair;
  const seen = new Set<string>([parent.operationId]);
  const required: { operationId: string; evidenceDigest: string }[] = [];
  const visit = (operationId: string, depth: number): void => {
    if (depth > 128) return hostOperationFailure("host_operation_evidence_invalid");
    const ids = database.prepare("SELECT operation_id FROM host_operations WHERE parent_operation_id=? ORDER BY operation_id")
      .all(operationId);
    for (const item of ids) {
      const id = String(item.operation_id), child = readHostOperation(database, id);
      if (!child || seen.has(id) || !sameHostOperationSource(child.source, parent.source)
        || child.toolCallId !== parent.toolCallId) return hostOperationFailure("host_operation_evidence_invalid");
      seen.add(id);
      if (id !== producer.operationId) {
        if (child.phase !== "safe" || child.settlementKind !== "known_no_start" || child.launchedAt || !child.evidenceDigest
          || verifyHostOperationSafe(database, child, settledAt) !== child.evidenceDigest) return hostOperationFailure("host_operation_evidence_invalid");
        required.push({ operationId: id, evidenceDigest: child.evidenceDigest });
      }
      visit(id, depth + 1);
    }
  };
  visit(parent.operationId, 0);
  if (!seen.has(producer.operationId)) return hostOperationFailure("host_office_local_invalid_journal_pair");
  return required.sort((left, right) => left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0);
}

/**
 * The caller owns BEGIN IMMEDIATE, original live tickets, owner checks and irreversible lifecycle closure.
 * An admitted row, empty effect set, failed terminal or caller assertion never substitutes for those latches.
 * Receipt INSERT and both original known-no-start roles become visible only in this one transaction.
 */
export function settleOfficeLocalNoStartPair(context: SqliteStoreContext, pair: OfficeNoStartPair,
  settledAt: string): HostOfficeLocalSettlement {
  const { database } = context, { parent, producer, states } = pair;
  const at = hostOperationTimestamp(settledAt), intent = JSON.stringify({ kind: "known_no_start", settledAt });
  for (const [row, state] of [[parent, states[0]], [producer, states[1]]] as const) {
    if (state.settlementSignature && state.settlementSignature !== intent
      || row.settlementSignature && row.settlementSignature !== intent) return hostOperationFailure("host_operation_settlement_conflict");
    if (at < hostOperationTimestamp(row.admittedAt)) return hostOperationFailure("host_operation_invalid_timestamp");
    if (!state.noStartClosed || state.launchClaimed || state.uncertainLaunch || row.launchedAt) {
      return hostOperationFailure("host_office_local_launch_unknown");
    }
  }
  if (parent.evidenceRef?.kind !== "office_local_chain_execution" || producer.evidenceRef?.kind !== "office_local_binary_execution"
    || parent.evidenceRef.id !== producer.evidenceRef.id) return hostOperationFailure("host_office_local_invalid_journal_pair");
  const verified = (row: StoredHostOperation): StoredHostOperation => {
    if (row.settlementKind !== "known_no_start" || verifyHostOperationSafe(database, row) !== row.evidenceDigest) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    return row;
  };
  const execution = readOfficeLocalExecution(database, parent.evidenceRef.id)
    ?? hostOperationFailure("host_office_local_evidence_invalid");
  const sameReceiptClaim = (receiptDigest: string): void => {
    if (states.some(state => state.noStartReceiptDigest !== receiptDigest)) return hostOperationFailure("host_operation_settlement_conflict");
  };
  if (parent.phase === "safe" && producer.phase === "safe") {
    const receipt = readOfficeLocalNoStartReceipt(database, execution) ?? hostOperationFailure("host_office_local_evidence_invalid");
    sameReceiptClaim(receipt.receiptDigest);
    return { parent: verified(parent), producer: verified(producer) };
  }
  if (parent.phase !== "admitted" || producer.phase !== "admitted") return hostOperationFailure("host_office_local_launch_unknown");
  for (const row of [parent, producer]) {
    if (hostOperationDomainIdentity(database, row, row.evidenceRef!, false) !== row.domainIdentityDigest) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
  }
  // Validate the complete fan-in before creating or retaining a settlement claim.
  // Existing children can still independently close after the Office lifecycle closes.
  const required = requiredNoStartDescendants(context, pair, settledAt);
  const existing = readOfficeLocalNoStartReceipt(database, execution);
  if (existing && existing.closedAt !== settledAt) return hostOperationFailure("host_operation_settlement_conflict");
  if (existing) sameReceiptClaim(existing.receiptDigest);
  const receipt = existing ?? createOfficeLocalNoStartReceipt(database, execution, settledAt, required);
  if (hostOperationTimestamp(receipt.closedAt) > at) return hostOperationFailure("host_operation_invalid_timestamp");
  if (states.some(state => state.noStartReceiptDigest && state.noStartReceiptDigest !== receipt.receiptDigest)) {
    return hostOperationFailure("host_operation_settlement_conflict");
  }
  // Pure prevalidation above may fail with a later child clock. Only starting
  // SQL settlement freezes this exact time, and these claims survive rollback.
  states[0].settlementSignature = intent; states[1].settlementSignature = intent;
  states[0].noStartReceiptDigest = receipt.receiptDigest; states[1].noStartReceiptDigest = receipt.receiptDigest;
  insertOfficeLocalNoStartReceipt(database, receipt);
  const candidate = (row: StoredHostOperation): StoredHostOperation => ({
    ...row, phase: "safe", settledAt, settlementKind: "known_no_start", settlementSignature: intent,
  });
  const write = (row: StoredHostOperation, evidenceDigest: string): StoredHostOperation => {
    const changed = database.prepare(`UPDATE host_operations SET phase='safe',settled_at=?,settlement_kind='known_no_start',
      evidence_digest=?,settlement_signature=?,code=NULL,revision=revision+1
      WHERE operation_id=? AND revision=? AND phase='admitted' AND launched_at IS NULL`)
      .run(settledAt, evidenceDigest, intent, row.operationId, row.revision);
    if (changed.changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
    return readHostOperation(database, row.operationId) ?? hostOperationFailure("host_operation_journal_corrupt");
  };
  const producerResult = write(producer, verifyHostOperationSettlementCandidate(database, candidate(producer)));
  const parentResult = write(parent, verifyHostOperationSettlementCandidate(database, candidate(parent)));
  // No receipt-shaped candidate is public safety before both canonical rows exist.
  return { parent: verified(parentResult), producer: verified(producerResult) };
}
