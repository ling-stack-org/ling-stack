import type { HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import type { HostOfficeLocalDirectoryExecutionRecordV2 } from "../../host-office-local-directory-v2-types.js";
import { hostOperationFailure, readHostOperation, verifyHostOperationSafe, verifyHostOperationSettlementCandidate,
  type StoredHostOperation } from "./host-operation-journal-evidence.js";
import type { OfficeJournalTicketState } from "./host-office-local-journal-gate.js";
import { officeDirectoryCertificateFactsV2, readOfficeDirectoryCertificateV2,
  type OfficeDirectoryCertificateIssuerV2 } from "./host-office-local-directory-v2-certificate.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface OfficeDirectorySettlementPairV2 {
  readonly parent: StoredHostOperation;
  readonly producer: StoredHostOperation;
  readonly states: readonly [OfficeJournalTicketState, OfficeJournalTicketState];
}
/** Owns no transaction or capability issuance. Caller has verified the original ticket and closed Host claim under BEGIN IMMEDIATE. */
export function settleOfficeDirectoryPairV2(context: SqliteStoreContext, pair: OfficeDirectorySettlementPairV2,
  execution: HostOfficeLocalDirectoryExecutionRecordV2, issuer: OfficeDirectoryCertificateIssuerV2,
  settledAt: string, liveIntent: { settledAt?: string }): HostOfficeLocalSettlement {
  const { database } = context, { parent, producer, states } = pair;
  const parentIntent = JSON.stringify({ kind: "office_local_chain_completed", settledAt });
  const producerIntent = JSON.stringify({ kind: "office_local_binary_completed", settledAt });
  for (const [row, state, intent] of [[parent, states[0], parentIntent], [producer, states[1], producerIntent]] as const) {
    if (row.settlementSignature && row.settlementSignature !== intent
      || state.settlementSignature && state.settlementSignature !== intent) return hostOperationFailure("host_operation_settlement_conflict");
  }
  const verified = (row: StoredHostOperation): StoredHostOperation => {
    if (verifyHostOperationSafe(database, row) !== row.evidenceDigest) return hostOperationFailure("host_operation_evidence_invalid");
    return row;
  };
  if (parent.phase === "safe" && producer.phase === "safe") {
    readOfficeDirectoryCertificateV2(database, execution, parent, producer, settledAt);
    return { parent: verified(parent), producer: verified(producer) };
  }
  if (parent.phase !== "launched" || producer.phase !== "launched"
    || states.some(state => !state.launchClaimed || state.uncertainLaunch || state.noStartClosed)) {
    return hostOperationFailure("host_office_local_launch_unknown");
  }
  const certificate = officeDirectoryCertificateFactsV2(database, execution, parent, producer, settledAt);
  if (liveIntent.settledAt && liveIntent.settledAt !== settledAt) return hostOperationFailure("host_operation_settlement_conflict");
  // Intent survives certificate/pair rollback and COMMIT-return loss. A later child cannot replace this clock.
  states[0].settlementSignature = parentIntent; states[1].settlementSignature = producerIntent;
  liveIntent.settledAt = settledAt;
  issuer.insert(certificate);
  const candidate = (row: StoredHostOperation, kind: "office_local_chain_completed" | "office_local_binary_completed", intent: string): StoredHostOperation =>
    ({ ...row, phase: "safe", settledAt, settlementKind: kind, settlementSignature: intent });
  const write = (row: StoredHostOperation, kind: "office_local_chain_completed" | "office_local_binary_completed", intent: string): StoredHostOperation => {
    const digest = verifyHostOperationSettlementCandidate(database, candidate(row, kind, intent));
    if (database.prepare(`UPDATE host_operations SET phase='safe',settled_at=?,settlement_kind=?,evidence_digest=?,
      settlement_signature=?,code=NULL,revision=revision+1 WHERE operation_id=? AND revision=? AND phase='launched'`)
      .run(settledAt, kind, digest, intent, row.operationId, row.revision).changes !== 1) return hostOperationFailure("host_operation_cas_conflict");
    return readHostOperation(database, row.operationId) ?? hostOperationFailure("host_operation_journal_corrupt");
  };
  const producerResult = write(producer, "office_local_binary_completed", producerIntent);
  const parentResult = write(parent, "office_local_chain_completed", parentIntent);
  return { parent: verified(parentResult), producer: verified(producerResult) };
}
