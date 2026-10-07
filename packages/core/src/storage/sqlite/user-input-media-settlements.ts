import type { DatabaseSync } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { readHostMediaExecution } from "./host-media-operation-records.js";
import { readHostOperation, sameHostOperationSource, verifyHostOperationSafe } from "./host-operation-journal-evidence.js";

/** Each source-owned child needs its exact independently reverified receipt. Business status is never enough. */
export function readUserInputMediaSettlements(database: DatabaseSync, source: HostOperationSource,
  stoppedAt: string): ReadonlyMap<string, string> {
  const reject = (): never => { throw new UserInputStoreError("not_quiescent"); };
  const result = new Map<string, string>();
  for (const child of database.prepare(`SELECT id,linked_media_job_id,active_attempt_id FROM work_units WHERE kind='media_job'
    AND ((owner_type='conversation_run' AND owner_id=?) OR linked_run_id=?) ORDER BY id`).iterate(source.runId, source.runId)) {
    const bindings = database.prepare("SELECT execution_id FROM host_media_executions WHERE media_child_work_unit_id=?").all(child.id!);
    if (bindings.length !== 1) return reject();
    const execution = readHostMediaExecution(database, String(bindings[0]!.execution_id));
    if (!execution || !sameHostOperationSource(execution.source, source) || execution.mediaJobId !== child.linked_media_job_id) return reject();
    if (!execution.childFence || (child.active_attempt_id !== null && child.active_attempt_id !== execution.childFence.attemptId)
      || database.prepare("SELECT 1 FROM work_unit_attempts WHERE work_unit_id=? AND id<>? LIMIT 1")
        .get(child.id!, execution.childFence.attemptId)) return reject();
    const parent = readHostOperation(database, execution.parentOperationId), transport = readHostOperation(database, execution.transportOperationId);
    if (!parent || !transport || parent.phase !== "safe" || transport.phase !== "safe"
      || parent.evidenceRef?.kind !== "media_chain_execution" || transport.evidenceRef?.kind !== "media_transport_execution"
      || parent.evidenceRef.id !== execution.executionId || transport.evidenceRef.id !== execution.executionId
      || verifyHostOperationSafe(database, parent, stoppedAt) !== parent.evidenceDigest
      || verifyHostOperationSafe(database, transport, stoppedAt) !== transport.evidenceDigest) return reject();
    if (result.has(execution.toolCallId)) return reject();
    result.set(execution.toolCallId, execution.toolName);
  }
  return result;
}
