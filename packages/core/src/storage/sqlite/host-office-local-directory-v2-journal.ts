import type { DatabaseSync } from "node:sqlite";
import type { HostOperationRecord } from "../../host-operation-journal-types.js";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationFailure, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { readOfficeLocalDirectoryExecutionV2 } from "./host-office-local-directory-v2-records.js";
import { directoryV2Failure } from "./host-office-local-directory-v2-validation.js";

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
/** Public/candidate safety is deliberately unavailable until full replay and original canonical/scope proof are implemented. */
export function verifyHostOfficeDirectoryReceiptV2(): never {
  return hostOperationFailure("host_office_local_directory_v2_safe_unavailable");
}
