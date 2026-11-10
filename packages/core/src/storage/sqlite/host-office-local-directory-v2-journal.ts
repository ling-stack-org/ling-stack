import type { DatabaseSync } from "node:sqlite";
import type { HostOperationRecord } from "../../host-operation-journal-types.js";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationFailure, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { readOfficeLocalDirectoryExecutionV2 } from "./host-office-local-directory-v2-records.js";
import { directoryV2Failure } from "./host-office-local-directory-v2-validation.js";
import { hostOperationTimestamp, readHostOperation, type StoredHostOperation } from "./host-operation-journal-evidence.js";
import { readOfficeDirectoryCertificateV2 } from "./host-office-local-directory-v2-certificate.js";
import type { OfficeLocalJournalVerificationMode } from "./host-office-local-journal-evidence.js";

/** Exact protocol-aware domain binding, using the original journal roles rather than a second authority. */
export function hostOfficeDirectoryOperationDomainIdentityV2(database: DatabaseSync, operation: HostOperationRecord, binding: boolean): string {
  const evidence = operation.evidenceRef;
  if (!evidence || !["office_local_chain_execution", "office_local_binary_execution"].includes(evidence.kind)) return directoryV2Failure();
  const execution = readOfficeLocalDirectoryExecutionV2(database, evidence.id);
  if (!execution || !sameHostOperationSource(operation.source, execution.source) || operation.toolCallId !== execution.toolCallId) return directoryV2Failure();
  if (evidence.kind === "office_local_chain_execution") {
    if (operation.operationId !== execution.parentOperationId || operation.kind !== "mcp" || operation.parentOperationId || operation.producerId) return directoryV2Failure();
  } else if (operation.operationId !== execution.producerOperationId || operation.kind !== "file_mutation"
    || operation.parentOperationId !== execution.parentOperationId || operation.producerId !== "office-local-binary") return directoryV2Failure();
  if (binding && (operation.phase !== "admitted" || operation.launchedAt
    || database.prepare("SELECT 1 FROM host_office_local_directory_v2_effects WHERE execution_id=? LIMIT 1").get(execution.executionId)
    || database.prepare("SELECT 1 FROM host_office_local_directory_v2_terminals WHERE execution_id=?").get(execution.executionId))) return directoryV2Failure();
  return digestHarnessToolValue({ protocol: execution.protocol, graph: execution.graph, scope: evidence.kind,
    executionIdentityDigest: execution.identityDigest, source: execution.source, toolCallId: execution.toolCallId,
    parentOperationId: execution.parentOperationId, producerOperationId: execution.producerOperationId });
}
/** Pure domain verification; generic fan-in separately traverses every child without an upward pair recursion. */
export function verifyHostOfficeDirectoryReceiptV2(database: DatabaseSync, operation: StoredHostOperation,
  mode: OfficeLocalJournalVerificationMode): string {
  const invalid = (): never => hostOperationFailure("host_office_local_evidence_invalid");
  // Preserve the native-only boundary for admitted/launched/failed-history callers.
  if (operation.phase !== "safe") return hostOperationFailure("host_office_local_directory_v2_safe_unavailable");
  const execution = operation.evidenceRef && readOfficeLocalDirectoryExecutionV2(database, operation.evidenceRef.id);
  const settlement = operation.evidenceRef?.kind === "office_local_chain_execution"
    ? "office_local_chain_completed" : "office_local_binary_completed";
  if (!execution || operation.phase !== "safe" || !operation.settledAt || !operation.launchedAt
    || operation.settlementKind !== settlement
    || operation.settlementSignature !== JSON.stringify({ kind: settlement, settledAt: operation.settledAt })
    || !["committed", "settlement_candidate"].includes(mode)) return invalid();
  const parent = readHostOperation(database, execution.parentOperationId), producer = readHostOperation(database, execution.producerOperationId);
  if (!parent || !producer) return invalid();
  for (const [row, evidence, kind] of [[parent, "office_local_chain_execution", "office_local_chain_completed"],
    [producer, "office_local_binary_execution", "office_local_binary_completed"]] as const) {
    if (!row.launchedAt || row.evidenceRef?.kind !== evidence || row.evidenceRef.id !== execution.executionId
      || hostOfficeDirectoryOperationDomainIdentityV2(database, row, false) !== row.domainIdentityDigest
      || hostOperationTimestamp(row.launchedAt) > hostOperationTimestamp(operation.settledAt)) return invalid();
    if (row.phase === "safe") {
      if (row.settlementKind !== kind || row.settledAt !== operation.settledAt
        || row.settlementSignature !== JSON.stringify({ kind, settledAt: operation.settledAt })) return invalid();
    } else if (mode !== "settlement_candidate" || row.phase !== "launched") return invalid();
    if (mode === "committed" && row.operationId === operation.operationId
      && digestHarnessToolValue(row) !== digestHarnessToolValue(operation)) return invalid();
  }
  const certificate = readOfficeDirectoryCertificateV2(database, execution, parent, producer, operation.settledAt);
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, protocol: execution.protocol,
    executionIdentityDigest: execution.identityDigest, certificateDigest: certificate.digest });
}
