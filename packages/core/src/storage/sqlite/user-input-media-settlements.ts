import type { DatabaseSync } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { readHostMediaExecution } from "./host-media-operation-records.js";
import { readHostOperation, sameHostOperationSource, verifyHostOperationSafe } from "./host-operation-journal-evidence.js";
import { assertHistoricalAttemptSource, type HostAttemptReadScope } from "./host-attempt-read-scope.js";

/** Each source-owned child needs its exact independently reverified receipt. Business status is never enough. */
export function readUserInputMediaSettlements(database: DatabaseSync, source: HostOperationSource,
  stoppedAt: string, scope: HostAttemptReadScope = "whole_run"): ReadonlyMap<string, string> {
  return readUserInputMediaSettlementsByAttempt(database, source, stoppedAt, scope).get(source.attemptId) ?? new Map();
}

/** Preserve original receipt ownership for validators of a multi-Attempt tool log. */
export function readUserInputMediaSettlementsByAttempt(database: DatabaseSync, source: HostOperationSource,
  stoppedAt: string, scope: HostAttemptReadScope = "whole_run"): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const reject = (): never => { throw new UserInputStoreError("not_quiescent"); };
  const result = new Map<string, Map<string, string>>();
  for (const child of database.prepare(`SELECT id,linked_media_job_id,active_attempt_id FROM work_units WHERE kind='media_job'
    AND ((owner_type='conversation_run' AND owner_id=?) OR linked_run_id=?) ORDER BY id`).iterate(source.runId, source.runId)) {
    const bindings = database.prepare("SELECT execution_id FROM host_media_executions WHERE media_child_work_unit_id=?").all(child.id!);
    if (bindings.length !== 1) return reject();
    const execution = readHostMediaExecution(database, String(bindings[0]!.execution_id));
    if (!execution || execution.mediaJobId !== child.linked_media_job_id) return reject();
    const historical = !sameHostOperationSource(execution.source, source);
    if (historical) {
      if (scope !== "exact_attempt") return reject();
      assertHistoricalAttemptSource(database, source, execution.source, stoppedAt);
    }
    if (!execution.childFence || (child.active_attempt_id !== null && child.active_attempt_id !== execution.childFence.attemptId)
      || database.prepare("SELECT 1 FROM work_unit_attempts WHERE work_unit_id=? AND id<>? LIMIT 1")
        .get(child.id!, execution.childFence.attemptId)) return reject();
    const parent = readHostOperation(database, execution.parentOperationId), transport = readHostOperation(database, execution.transportOperationId);
    if (!parent || !transport || parent.phase !== "safe" || transport.phase !== "safe"
      || parent.evidenceRef?.kind !== "media_chain_execution" || transport.evidenceRef?.kind !== "media_transport_execution"
      || parent.evidenceRef.id !== execution.executionId || transport.evidenceRef.id !== execution.executionId
      || verifyHostOperationSafe(database, parent, stoppedAt) !== parent.evidenceDigest
      || verifyHostOperationSafe(database, transport, stoppedAt) !== transport.evidenceDigest) return reject();
    const own = result.get(execution.source.attemptId) ?? new Map<string, string>();
    if (own.has(execution.toolCallId)) return reject();
    own.set(execution.toolCallId, execution.toolName);
    result.set(execution.source.attemptId, own);
  }
  return result;
}
