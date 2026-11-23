import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import {
  stageCoordinationRequestKey, stageCoordinationToolKey, stageCoordinationToolReceiptId,
  type WorkItemStageToolReceipt,
} from "../../work-item-stage-coordination.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { assertHistoricalAttemptSource, type HostAttemptReadScope } from "./host-attempt-read-scope.js";

const kind = "work_item_stage_tool_receipt";

export function readWorkItemStageToolSettlements(database: DatabaseSync, source: HostOperationSource, at: string,
  scope: HostAttemptReadScope): readonly WorkItemStageToolReceipt[] {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='app_server_state'").get()) return [];
  const prefix = source.runId + ":";
  const receipts: WorkItemStageToolReceipt[] = [];
  for (const row of database.prepare(`SELECT record_id,revision,payload_json,created_at FROM app_server_state
    WHERE workspace_id=? AND kind=? AND record_id>=? AND record_id<?`).iterate(DEFAULT_WORKSPACE_ID, kind, prefix, prefix + "\uffff")) {
    const receipt = readReceipt(database, row, source.runId, at);
    if (receipt.source.attemptId !== source.attemptId) {
      if (scope !== "exact_attempt") throw new Error("work_item_stage_tool_attempt_changed");
      assertHistoricalAttemptSource(database, source, receipt.source, at);
    } else if (!isDeepStrictEqual(receipt.source, source)) {
      throw new Error("work_item_stage_tool_attempt_changed");
    }
    receipts.push(receipt);
  }
  return receipts;
}

export function verifyWorkItemStageToolRequest(database: DatabaseSync, source: HostOperationSource, toolCallId: string,
  args: unknown, at: string): boolean {
  const row = database.prepare("SELECT record_id,revision,payload_json,created_at FROM app_server_state WHERE workspace_id=? AND kind=? AND record_id=?")
    .get(DEFAULT_WORKSPACE_ID, kind, stageCoordinationToolReceiptId(source.runId, source.attemptId, toolCallId));
  if (!row) return false;
  const receipt = readReceipt(database, row, source.runId, at);
  return isDeepStrictEqual(receipt.source, source) && receipt.requestDigest === digestHarnessToolValue(args);
}

function readReceipt(database: DatabaseSync, row: Record<string, SQLOutputValue>, runId: string, at: string): WorkItemStageToolReceipt {
  const reject = (): never => { throw new Error("work_item_stage_tool_receipt_unverified"); };
  const receipt = JSON.parse(String(row.payload_json)) as WorkItemStageToolReceipt | null;
  if (!receipt || !receipt.source || receipt.source.runId !== runId || row.revision !== 1
    || typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) || row.created_at > at
    || typeof receipt.toolCallId !== "string" || !receipt.toolCallId || !/^[0-9a-f]{64}$/u.test(receipt.requestDigest)
    || row.record_id !== stageCoordinationToolReceiptId(runId, receipt.source.attemptId, receipt.toolCallId)) return reject();
  const owner = database.prepare(`SELECT step.to_participant_id FROM run_sessions r
    JOIN work_units unit ON unit.id=r.work_unit_id AND unit.linked_run_id=r.id
    JOIN work_unit_attempts attempt ON attempt.id=? AND attempt.work_unit_id=unit.id
    JOIN channel_workflow_steps step ON step.id=r.workflow_step_id AND step.workspace_id=unit.workspace_id
    JOIN app_server_state link ON link.workspace_id=step.workspace_id AND link.kind='work_item_workflow' AND link.record_id=step.workflow_id
    WHERE r.id=? AND unit.id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?
      AND attempt.effective_runner_id='pi' AND step.id=?
      AND json_extract(link.payload_json,'$.binding.workItemId')=?`).get(receipt.source.attemptId, runId,
    receipt.source.workUnitId, receipt.source.runtimeInstanceId, receipt.source.fencingToken, receipt.stepId, receipt.workItemId);
  if (!owner) return reject();
  const { outcome } = receipt;
  if (outcome?.status === "recorded") {
    const evidence = database.prepare(`SELECT id FROM work_item_evidence WHERE workspace_id=? AND work_item_id=? AND id=?
      AND actor_id=? AND idempotency_key=? AND visibility='participants' AND created_at<=?`)
      .get(DEFAULT_WORKSPACE_ID, receipt.workItemId, outcome.recordId, owner.to_participant_id!,
        stageCoordinationRequestKey(runId, receipt.source.attemptId, stageCoordinationToolKey(receipt.toolCallId)), row.created_at);
    if (!evidence) return reject();
  } else if (!(outcome?.status === "read" || outcome?.status === "rejected" && typeof outcome.code === "string" && outcome.code)) {
    return reject();
  }
  return receipt;
}
