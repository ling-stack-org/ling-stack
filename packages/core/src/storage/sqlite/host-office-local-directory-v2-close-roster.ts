import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationFailure, hostOperationTimestamp, readHostOperation, sameHostOperationSource,
  verifyHostOperationSafe, type StoredHostOperation } from "./host-operation-journal-evidence.js";

/** Complete raw reserved roster, including descendants below the skipped producer role. No source-filtered omissions. */
export function assertOfficeDirectoryCloseRosterReadyV2(database: DatabaseSync,
  parent: StoredHostOperation, producer: StoredHostOperation, closedAt: string): void {
  const required = readOfficeDirectoryRawRosterV2(database, parent, producer, closedAt);
  for (const child of required) {
    if (child.operationId === producer.operationId) continue;
    if (child.phase !== "safe" || !child.evidenceDigest
      || verifyHostOperationSafe(database, child, closedAt) !== child.evidenceDigest) {
      return hostOperationFailure("host_office_local_required_child_not_ready");
    }
  }
}

/** Bounded complete topology, used by certificate reads without recursively entering pair verification. */
function readOfficeDirectoryRawRosterV2(database: DatabaseSync, parent: StoredHostOperation,
  producer: StoredHostOperation, closedAt: string): StoredHostOperation[] {
  const seen = new Set([parent.operationId]), closedTime = hostOperationTimestamp(closedAt);
  const required: StoredHostOperation[] = [];
  const visit = (ancestor: StoredHostOperation, depth: number): void => {
    if (depth > 128) return hostOperationFailure("host_operation_evidence_invalid");
    for (const item of database.prepare("SELECT operation_id FROM host_operations WHERE parent_operation_id=? ORDER BY operation_id").iterate(ancestor.operationId)) {
      const id = String(item.operation_id), child = readHostOperation(database, id);
      if (!child || seen.has(id) || seen.size >= 1026 || child.parentOperationId !== ancestor.operationId
        || !sameHostOperationSource(child.source, parent.source) || child.toolCallId !== parent.toolCallId
        || hostOperationTimestamp(child.admittedAt) < hostOperationTimestamp(ancestor.admittedAt)
        || hostOperationTimestamp(child.admittedAt) > closedTime) return hostOperationFailure("host_operation_evidence_invalid");
      seen.add(id);
      required.push(child);
      visit(child, depth + 1);
    }
  };
  visit(parent, 0);
  if (!seen.has(producer.operationId)) return hostOperationFailure("host_office_local_invalid_journal_pair");
  return required;
}

/** Pair final evidence digests are excluded to avoid certificate -> pair digest -> certificate cycles. */
export function officeDirectoryRawRosterDigestV2(database: DatabaseSync, parent: StoredHostOperation,
  producer: StoredHostOperation, settledAt: string): string {
  return digestHarnessToolValue(readOfficeDirectoryRawRosterV2(database, parent, producer, settledAt).map(child => {
    if (child.operationId === producer.operationId) return { operationId: child.operationId,
      parentOperationId: child.parentOperationId, producerId: child.producerId, kind: child.kind,
      admittedAt: child.admittedAt, launchedAt: child.launchedAt, domainIdentityDigest: child.domainIdentityDigest };
    if (child.phase !== "safe" || !child.evidenceDigest || !child.settledAt
      || hostOperationTimestamp(child.settledAt) > hostOperationTimestamp(settledAt)) {
      return hostOperationFailure("host_office_local_required_child_not_ready");
    }
    return child;
  }));
}
