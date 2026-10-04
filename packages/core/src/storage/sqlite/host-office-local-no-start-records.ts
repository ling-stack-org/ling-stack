import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import type { HostOfficeLocalNoStartReceipt } from "../../host-office-local-no-start-types.js";
import { hostOperationTimestamp, readHostOperation, sameHostOperationSource,
  verifyHostOperationSafe } from "./host-operation-journal-evidence.js";
import { officeLocalFailure, readOfficeLocalEffects, readOfficeLocalExecution } from "./host-office-local-records.js";
import { readOfficeLocalTerminal } from "./host-office-local-terminal-records.js";

type NoStartPayload = Omit<HostOfficeLocalNoStartReceipt, "receiptDigest">;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (left: unknown, right: unknown): boolean => digestHarnessToolValue(left) === digestHarnessToolValue(right);
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Re-read the original prepared seal; a caller's structural execution clone is not an identity source. */
function originalExecution(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord): HostOfficeLocalExecutionRecord {
  if (!execution || !text(execution.executionId)) return officeLocalFailure();
  const original = readOfficeLocalExecution(database, execution.executionId);
  if (!original || !same(original, execution)) return officeLocalFailure();
  return original;
}

/** Every descendant must carry its own committed, public-verified no-start evidence. */
function requiredDescendants(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord,
  closedAt: string): HostOfficeLocalNoStartReceipt["requiredDescendants"] {
  const closedTime = hostOperationTimestamp(closedAt), visited = new Set([execution.parentOperationId]);
  const pending = [{ operationId: execution.parentOperationId, depth: 0 }];
  const result: { operationId: string; evidenceDigest: string }[] = [];
  let foundProducer = false;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 128) return officeLocalFailure();
    const children = database.prepare("SELECT operation_id FROM host_operations WHERE parent_operation_id=? ORDER BY operation_id")
      .all(current.operationId);
    for (const row of children) {
      if (!text(row.operation_id) || visited.has(row.operation_id)) return officeLocalFailure();
      visited.add(row.operation_id);
      const child = readHostOperation(database, row.operation_id);
      if (!child || child.parentOperationId !== current.operationId || !sameHostOperationSource(child.source, execution.source)
        || child.toolCallId !== execution.toolCallId || hostOperationTimestamp(child.admittedAt) > closedTime) return officeLocalFailure();
      pending.push({ operationId: child.operationId, depth: current.depth + 1 });
      if (child.operationId === execution.producerOperationId) {
        if (current.operationId !== execution.parentOperationId) return officeLocalFailure();
        foundProducer = true;
        continue;
      }
      if (child.phase !== "safe" || child.settlementKind !== "known_no_start" || child.launchedAt
        || !child.settledAt || !digest(child.evidenceDigest) || hostOperationTimestamp(child.settledAt) > closedTime
        || verifyHostOperationSafe(database, child, closedAt) !== child.evidenceDigest) return officeLocalFailure();
      result.push({ operationId: child.operationId, evidenceDigest: child.evidenceDigest });
    }
  }
  if (!foundProducer) return officeLocalFailure();
  return result.sort((left, right) => left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0);
}

/** This is an exclusion check, not authority inferred from admitted rows or an empty effects list. */
function historicalPayload(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord,
  closedAt: string): NoStartPayload {
  const original = originalExecution(database, execution), closedTime = hostOperationTimestamp(closedAt);
  if (closedTime < hostOperationTimestamp(original.preparedAt)) return officeLocalFailure();
  for (const id of [original.parentOperationId, original.producerOperationId]) {
    const operation = readHostOperation(database, id);
    if (!operation || operation.launchedAt || !["admitted", "safe"].includes(operation.phase)
      || (operation.phase === "safe" && (operation.settlementKind !== "known_no_start" || !operation.settledAt
        || hostOperationTimestamp(operation.settledAt) < closedTime))) return officeLocalFailure();
  }
  const effects = readOfficeLocalEffects(database, original).map(effect => {
    if (effect.enteredAt !== undefined || effect.observationArtifactId !== undefined
      || hostOperationTimestamp(effect.preparedAt) > closedTime) return officeLocalFailure();
    return { ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest };
  });
  const terminal = readOfficeLocalTerminal(database, original);
  if (terminal && (terminal.publicationEntered || terminal.outcome !== "failed"
    || hostOperationTimestamp(terminal.completedAt) > closedTime || hostOperationTimestamp(terminal.sealedAt) > closedTime
    || terminal.resources.some(resource => resource.origin !== "member_read" || resource.state !== "closed"))) return officeLocalFailure();
  return {
    schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_no_start_v1",
    executionId: original.executionId, executionIdentityDigest: original.identityDigest, source: { ...original.source },
    parentOperationId: original.parentOperationId, producerOperationId: original.producerOperationId, toolCallId: original.toolCallId,
    preparedArtifactId: original.preparedArtifactId, preparedDigest: original.preparedDigest,
    effects, requiredDescendants: requiredDescendants(database, original, closedAt), closedAt,
  };
}

function validateReceipt(value: unknown): HostOfficeLocalNoStartReceipt {
  if (!exact(value, ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest", "source",
    "parentOperationId", "producerOperationId", "toolCallId", "preparedArtifactId", "preparedDigest", "effects",
    "requiredDescendants", "closedAt", "receiptDigest"])
    || value.schemaVersion !== 1 || value.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || value.kind !== "office_local_no_start_v1"
    || ![value.executionId, value.parentOperationId, value.producerOperationId, value.toolCallId, value.preparedArtifactId].every(text)
    || value.parentOperationId === value.producerOperationId
    || ![value.executionIdentityDigest, value.preparedDigest, value.receiptDigest].every(digest)
    || !exact(value.source, ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"])
    || !Object.values(value.source).every(text) || !Array.isArray(value.effects) || value.effects.length > 1024
    || !Array.isArray(value.requiredDescendants)) return officeLocalFailure();
  const effectIds = new Set<string>();
  for (const [index, effect] of value.effects.entries()) {
    if (!exact(effect, ["ordinal", "effectId", "effectDigest"]) || effect.ordinal !== index
      || !text(effect.effectId) || effectIds.has(effect.effectId) || !digest(effect.effectDigest)) return officeLocalFailure();
    effectIds.add(effect.effectId);
  }
  let previous: string | undefined;
  for (const descendant of value.requiredDescendants) {
    if (!exact(descendant, ["operationId", "evidenceDigest"]) || !text(descendant.operationId) || !digest(descendant.evidenceDigest)
      || descendant.operationId === value.parentOperationId || descendant.operationId === value.producerOperationId
      || (previous !== undefined && previous >= descendant.operationId)) return officeLocalFailure();
    previous = descendant.operationId;
  }
  hostOperationTimestamp(value.closedAt);
  const { receiptDigest, ...payload } = value;
  if (digestHarnessToolValue(payload) !== receiptDigest) return officeLocalFailure();
  return value as unknown as HostOfficeLocalNoStartReceipt;
}

/** Construct only exact SQLite exclusion facts; original live closure is independently required by the caller's gate. */
export function createOfficeLocalNoStartReceipt(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord,
  closedAt: string, descendants: HostOfficeLocalNoStartReceipt["requiredDescendants"]): HostOfficeLocalNoStartReceipt {
  const payload = historicalPayload(database, execution, closedAt);
  if (!same(payload.requiredDescendants, descendants)) return officeLocalFailure();
  return validateReceipt({ ...payload, receiptDigest: digestHarnessToolValue(payload) });
}

/** Revalidate exact schema, digest, source, complete effects and complete descendant evidence on every read. */
export function readOfficeLocalNoStartReceipt(database: DatabaseSync,
  execution: HostOfficeLocalExecutionRecord): HostOfficeLocalNoStartReceipt | undefined {
  const original = originalExecution(database, execution);
  const row = database.prepare("SELECT * FROM host_office_local_no_start_receipts WHERE execution_id=?").get(original.executionId);
  if (!row) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.receipt_json)); } catch { return officeLocalFailure(); }
  const receipt = validateReceipt(parsed), payload = historicalPayload(database, original, receipt.closedAt);
  if (!same(receipt, { ...payload, receiptDigest: digestHarnessToolValue(payload) })
    || row.schema_version !== 1 || row.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || row.execution_id !== original.executionId
    || row.execution_identity_digest !== original.identityDigest || row.prepared_artifact_id !== original.preparedArtifactId
    || row.prepared_digest !== original.preparedDigest || row.receipt_digest !== receipt.receiptDigest
    || row.effect_set_digest !== digestHarnessToolValue(receipt.effects) || row.effect_count !== receipt.effects.length
    || row.descendant_set_digest !== digestHarnessToolValue(receipt.requiredDescendants)
    || row.descendant_count !== receipt.requiredDescendants.length || row.closed_at !== receipt.closedAt) return officeLocalFailure();
  return receipt;
}

/** Append an identical claim once; neither replacement nor a different retry clock may overwrite original history. */
export function insertOfficeLocalNoStartReceipt(database: DatabaseSync,
  input: HostOfficeLocalNoStartReceipt): HostOfficeLocalNoStartReceipt {
  const receipt = validateReceipt(input), execution = readOfficeLocalExecution(database, receipt.executionId);
  if (!execution) return officeLocalFailure();
  const expected = createOfficeLocalNoStartReceipt(database, execution, receipt.closedAt, receipt.requiredDescendants);
  if (!same(receipt, expected)) return officeLocalFailure();
  const existing = readOfficeLocalNoStartReceipt(database, execution);
  if (existing) {
    if (!same(existing, receipt)) return officeLocalFailure();
    return existing;
  }
  database.prepare(`INSERT INTO host_office_local_no_start_receipts(execution_id,schema_version,protocol,
    execution_identity_digest,prepared_artifact_id,prepared_digest,receipt_json,receipt_digest,
    effect_set_digest,effect_count,descendant_set_digest,descendant_count,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(receipt.executionId, receipt.schemaVersion, receipt.protocol, receipt.executionIdentityDigest,
      receipt.preparedArtifactId, receipt.preparedDigest, JSON.stringify(receipt), receipt.receiptDigest,
      digestHarnessToolValue(receipt.effects), receipt.effects.length, digestHarnessToolValue(receipt.requiredDescendants),
      receipt.requiredDescendants.length, receipt.closedAt);
  const stored = readOfficeLocalNoStartReceipt(database, execution);
  if (!stored || !same(stored, receipt)) return officeLocalFailure();
  return stored;
}
