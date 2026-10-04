import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import { HostOperationJournalError, type HostOperationRecord } from "../../host-operation-journal-types.js";
import { hostOperationTimestamp, readHostOperation, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { readOfficeLocalEffects, readOfficeLocalExecution, validateOfficeLocalObservation } from "./host-office-local-records.js";
import { verifyOfficeLocalReplay } from "./host-office-local-replay.js";
import { readOfficeLocalTerminal } from "./host-office-local-terminal-records.js";

function invalid(): never { throw new HostOperationJournalError("host_office_local_evidence_invalid"); }

/** The two original journal roles share an execution, never the same evidence scope. */
function scopedExecution(database: DatabaseSync, operation: HostOperationRecord): HostOfficeLocalExecutionRecord {
  const evidence = operation.evidenceRef;
  if (!evidence || !["office_local_chain_execution", "office_local_binary_execution"].includes(evidence.kind)) return invalid();
  const execution = readOfficeLocalExecution(database, evidence.id);
  if (!execution || !sameHostOperationSource(operation.source, execution.source) || operation.toolCallId !== execution.toolCallId) return invalid();
  if (evidence.kind === "office_local_chain_execution") {
    if (operation.operationId !== execution.parentOperationId || operation.kind !== "mcp"
      || operation.parentOperationId !== undefined || operation.producerId !== undefined) return invalid();
  } else if (operation.operationId !== execution.producerOperationId || operation.kind !== "file_mutation"
    || operation.parentOperationId !== execution.parentOperationId || operation.producerId !== "office-local-binary") return invalid();
  return execution;
}

/** Bind the exact original source, pair and role before any effect descriptor or terminal exists. */
export function hostOfficeOperationDomainIdentity(database: DatabaseSync, operation: HostOperationRecord, binding: boolean): string {
  const execution = scopedExecution(database, operation);
  if (binding && (operation.phase !== "admitted" || operation.launchedAt
    || database.prepare("SELECT 1 FROM host_office_local_effects WHERE execution_id=? LIMIT 1").get(execution.executionId)
    || database.prepare("SELECT 1 FROM host_office_local_terminals WHERE execution_id=?").get(execution.executionId))) return invalid();
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, executionIdentityDigest: execution.identityDigest,
    source: execution.source, toolCallId: execution.toolCallId, parentOperationId: execution.parentOperationId,
    producerOperationId: execution.producerOperationId });
}

/**
 * Consume only sealed SQLite history. Failed/unknown/unconfirmed and no-start
 * claims are not published receipts, and verification never opens a current FD.
 * Generic journal recursion separately fans in every reserved nested producer.
 */
export function verifyHostOfficeReceipt(database: DatabaseSync, operation: HostOperationRecord): string {
  const execution = scopedExecution(database, operation);
  const expectedSettlement = operation.evidenceRef!.kind === "office_local_chain_execution"
    ? "office_local_chain_completed" : "office_local_binary_completed";
  if (operation.settlementKind !== expectedSettlement || !operation.launchedAt || !operation.settledAt) return invalid();
  const pair = [
    { operation: readHostOperation(database, execution.parentOperationId), kind: "office_local_chain_execution" },
    { operation: readHostOperation(database, execution.producerOperationId), kind: "office_local_binary_execution" },
  ] as const;
  const launchTimes: number[] = [hostOperationTimestamp(operation.launchedAt)];
  for (const member of pair) {
    const original = member.operation;
    if (!original || !original.launchedAt || original.evidenceRef?.kind !== member.kind
      || original.evidenceRef.id !== execution.executionId
      || hostOfficeOperationDomainIdentity(database, original, false) !== original.domainIdentityDigest) return invalid();
    launchTimes.push(hostOperationTimestamp(original.launchedAt));
  }
  const terminal = readOfficeLocalTerminal(database, execution);
  if (!terminal || hostOperationTimestamp(terminal.sealedAt) > hostOperationTimestamp(operation.settledAt)) return invalid();
  const launchedAt = Math.max(...launchTimes);
  const effects = readOfficeLocalEffects(database, execution).map(effect => {
    const observation = effect.observationArtifactId
      ? validateOfficeLocalObservation(database, execution, effect, effect.observationArtifactId) : null;
    // Callback entry precedes the journal launch marker in the fixed gate. The
    // actual native call, not enteredAt, must follow both original launch marks.
    if (!observation || observation.native.state !== "returned"
      || hostOperationTimestamp(observation.native.calledAt) < launchedAt) return invalid();
    return { effect, observation };
  });
  const replay = verifyOfficeLocalReplay({ execution, terminal, effects });
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, executionIdentityDigest: execution.identityDigest,
    source: execution.source, toolCallId: execution.toolCallId, parentOperationId: execution.parentOperationId,
    producerOperationId: execution.producerOperationId, terminalArtifactId: terminal.terminalArtifactId,
    terminalDigest: terminal.terminalDigest, effectSetDigest: terminal.effectSetDigest,
    effectCount: terminal.effectCount, sealedAt: terminal.sealedAt, replay });
}
