import type { DatabaseSync } from "node:sqlite";
import { hostOperationFailure, hostOperationTimestamp, readHostOperation, sameHostOperationSource,
  verifyHostOperationSafe, type StoredHostOperation } from "./host-operation-journal-evidence.js";

/** Complete raw reserved roster, including descendants below the skipped producer role. No source-filtered omissions. */
export function assertOfficeDirectoryCloseRosterReadyV2(database: DatabaseSync,
  parent: StoredHostOperation, producer: StoredHostOperation, closedAt: string): void {
  const seen = new Set([parent.operationId]), closedTime = hostOperationTimestamp(closedAt);
  const required: StoredHostOperation[] = [];
  const visit = (operationId: string, depth: number): void => {
    if (depth > 128) return hostOperationFailure("host_operation_evidence_invalid");
    for (const item of database.prepare("SELECT operation_id FROM host_operations WHERE parent_operation_id=? ORDER BY operation_id").iterate(operationId)) {
      const id = String(item.operation_id), child = readHostOperation(database, id);
      if (!child || seen.has(id) || seen.size >= 1026 || child.parentOperationId !== operationId
        || !sameHostOperationSource(child.source, parent.source) || child.toolCallId !== parent.toolCallId
        || hostOperationTimestamp(child.admittedAt) > closedTime) return hostOperationFailure("host_operation_evidence_invalid");
      seen.add(id);
      if (id !== producer.operationId) required.push(child);
      visit(id, depth + 1);
    }
  };
  visit(parent.operationId, 0);
  if (!seen.has(producer.operationId)) return hostOperationFailure("host_office_local_invalid_journal_pair");
  // Bound the entire raw graph before invoking recursive evidence readers.
  for (const child of required) {
    if (child.phase !== "safe" || !child.evidenceDigest
      || verifyHostOperationSafe(database, child, closedAt) !== child.evidenceDigest) {
      return hostOperationFailure("host_office_local_required_child_not_ready");
    }
  }
}
