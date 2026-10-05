import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import { HostOperationJournalError, type HostOperationRecord } from "../../host-operation-journal-types.js";
import { hostOperationTimestamp, readHostOperation, sameHostOperationSource,
  type StoredHostOperation } from "./host-operation-journal-evidence.js";
import { readOfficeLocalEffects, readOfficeLocalExecution, validateOfficeLocalObservation } from "./host-office-local-records.js";
import { verifyOfficeLocalReplay } from "./host-office-local-replay.js";
import { readOfficeLocalTerminal } from "./host-office-local-terminal-records.js";
import { readOfficeLocalNoStartReceipt } from "./host-office-local-no-start-records.js";
import { hasOfficeDirectoryV2Execution } from "./host-office-local-directory-v2-records.js";
import { hostOfficeDirectoryOperationDomainIdentityV2, verifyHostOfficeDirectoryReceiptV2 } from "./host-office-local-directory-v2-journal.js";

function invalid(): never { throw new HostOperationJournalError("host_office_local_evidence_invalid"); }
export type OfficeLocalJournalVerificationMode = "committed" | "settlement_candidate";

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
  if (operation.evidenceRef && hasOfficeDirectoryV2Execution(database, operation.evidenceRef.id)) return hostOfficeDirectoryOperationDomainIdentityV2(database, operation, binding);
  const execution = scopedExecution(database, operation);
  if (binding && (operation.phase !== "admitted" || operation.launchedAt
    || database.prepare("SELECT 1 FROM host_office_local_effects WHERE execution_id=? LIMIT 1").get(execution.executionId)
    || database.prepare("SELECT 1 FROM host_office_local_terminals WHERE execution_id=?").get(execution.executionId))) return invalid();
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, executionIdentityDigest: execution.identityDigest,
    source: execution.source, toolCallId: execution.toolCallId, parentOperationId: execution.parentOperationId,
    producerOperationId: execution.producerOperationId });
}

/**
 * Consume only sealed SQLite history. Published and independently issued
 * no-start receipts stay separate; neither a failed manifest nor absent native
 * facts can certify no-start, and verification never opens a current FD.
 * This is a scoped domain digest, not an independent public-safe authority.
 * The generic public verifier separately checks both canonical journal receipts
 * and fans in every reserved nested/extra producer without recursing upward here.
 */
export function verifyHostOfficeReceipt(database: DatabaseSync, operation: StoredHostOperation,
  mode: OfficeLocalJournalVerificationMode = "committed"): string {
  if (operation.evidenceRef && hasOfficeDirectoryV2Execution(database, operation.evidenceRef.id)) return verifyHostOfficeDirectoryReceiptV2();
  const execution = scopedExecution(database, operation);
  if (operation.settlementKind === "known_no_start") return verifyOfficeNoStartReceipt(database, operation, execution, mode);
  const expectedSettlement = operation.evidenceRef!.kind === "office_local_chain_execution"
    ? "office_local_chain_completed" : "office_local_binary_completed";
  if (operation.phase !== "safe" || operation.settlementKind !== expectedSettlement || !operation.launchedAt || !operation.settledAt
    || operation.settlementSignature !== JSON.stringify({ kind: expectedSettlement, settledAt: operation.settledAt })
    || (mode !== "committed" && mode !== "settlement_candidate")) return invalid();
  const pair = [
    { operation: readHostOperation(database, execution.parentOperationId), kind: "office_local_chain_execution", settlement: "office_local_chain_completed" },
    { operation: readHostOperation(database, execution.producerOperationId), kind: "office_local_binary_execution", settlement: "office_local_binary_completed" },
  ] as const;
  const launchTimes: number[] = [hostOperationTimestamp(operation.launchedAt)];
  for (const member of pair) {
    const original = member.operation;
    if (!original || !original.launchedAt || original.evidenceRef?.kind !== member.kind
      || original.evidenceRef.id !== execution.executionId
      || hostOfficeOperationDomainIdentity(database, original, false) !== original.domainIdentityDigest) return invalid();
    if (original.phase === "safe") {
      if (original.settlementKind !== member.settlement || original.settledAt !== operation.settledAt
        || original.settlementSignature !== JSON.stringify({ kind: member.settlement, settledAt: operation.settledAt })) return invalid();
    } else if (mode !== "settlement_candidate" || original.phase !== "launched") return invalid();
    // A detached candidate or changed clock is never public committed history.
    // Candidate calculation is allowed only before the atomic pair write; it
    // still consumes the original pair's immutable scope and native launch marks.
    if (mode === "committed" && original.operationId === operation.operationId
      && digestHarnessToolValue(original) !== digestHarnessToolValue(operation)) return invalid();
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

/** Scoped historical no-start digest. Generic public verification still requires the canonical whole pair and every child. */
function verifyOfficeNoStartReceipt(database: DatabaseSync, operation: StoredHostOperation,
  execution: HostOfficeLocalExecutionRecord, mode: OfficeLocalJournalVerificationMode): string {
  if (operation.phase !== "safe" || operation.launchedAt || !operation.settledAt
    || operation.settlementSignature !== JSON.stringify({ kind: "known_no_start", settledAt: operation.settledAt })
    || (mode !== "committed" && mode !== "settlement_candidate")) return invalid();
  const receipt = readOfficeLocalNoStartReceipt(database, execution);
  if (!receipt || hostOperationTimestamp(receipt.closedAt) > hostOperationTimestamp(operation.settledAt)) return invalid();
  const pair = [
    { operation: readHostOperation(database, execution.parentOperationId), kind: "office_local_chain_execution" },
    { operation: readHostOperation(database, execution.producerOperationId), kind: "office_local_binary_execution" },
  ] as const;
  for (const member of pair) {
    const original = member.operation;
    if (!original || original.launchedAt || original.evidenceRef?.kind !== member.kind
      || original.evidenceRef.id !== execution.executionId
      || hostOfficeOperationDomainIdentity(database, original, false) !== original.domainIdentityDigest) return invalid();
    if (original.phase === "safe") {
      if (original.settlementKind !== "known_no_start" || original.settledAt !== operation.settledAt
        || original.settlementSignature !== JSON.stringify({ kind: "known_no_start", settledAt: operation.settledAt })) return invalid();
    } else if (mode !== "settlement_candidate" || original.phase !== "admitted") return invalid();
    if (mode === "committed" && original.operationId === operation.operationId
      && digestHarnessToolValue(original) !== digestHarnessToolValue(operation)) return invalid();
  }
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, executionIdentityDigest: execution.identityDigest,
    source: execution.source, toolCallId: execution.toolCallId, parentOperationId: execution.parentOperationId,
    producerOperationId: execution.producerOperationId, noStartReceipt: receipt });
}
