import { createHash } from "node:crypto";
import { isRunProviderErrorDiagnostic, type LingAppServerStageRecoveryEvidence, type LingAppServerWorkflowStageProgress } from "@ling-stack/contracts";
import type { WorkItem } from "../../work-item-types.js";
import type { ChannelWorkflowStep } from "../../workspace-types.js";
import { parseJson, readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

type Blocker = NonNullable<LingAppServerWorkflowStageProgress["blocker"]>;

export function readWorkItemStageProgress(context: SqliteStoreContext, item: WorkItem, step: ChannelWorkflowStep, stageId: string,
  maxNoEvidenceContinuations: number | undefined): LingAppServerWorkflowStageProgress {
  const db = context.database;
  const change = db.prepare(`
    SELECT json_extract(link.payload_json,'$.binding.planId') AS plan_id, link.created_at AS linked_at
    FROM app_server_state link
    WHERE link.workspace_id=? AND link.kind='work_item_workflow' AND json_extract(link.payload_json,'$.binding.workItemId')=?
      AND (EXISTS (SELECT 1 FROM json_each(link.payload_json,'$.progressStageIds') WHERE value=?)
        OR (json_type(link.payload_json,'$.progressStageIds') IS NULL AND EXISTS (
          SELECT 1 FROM control_plane_events event
          JOIN json_each(event.data_json,'$.resolvedPlanChangeIds') resolved
          JOIN app_server_state change ON change.workspace_id=event.workspace_id AND change.kind='work_item_plan_change'
            AND json_extract(change.payload_json,'$.receipt.changeId')=resolved.value
          JOIN json_each(change.payload_json,'$.receipt.affectedStepIds') affected
          JOIN channel_workflow_steps predecessor ON predecessor.id=affected.value AND predecessor.workspace_id=event.workspace_id
          WHERE event.workspace_id=link.workspace_id AND event.entity_id=? AND event.action='work_item.workflow.linked'
            AND json_extract(event.data_json,'$.workflowId')=link.record_id
            AND json_extract(change.payload_json,'$.receipt.status')='pending'
            AND predecessor.workflow_id=json_extract(link.payload_json,'$.binding.previousWorkflowId')
            AND json_extract(predecessor.metadata_json,'$.planStageId')=?
        )))
    ORDER BY linked_at DESC, link.record_id DESC LIMIT 1
  `).get(item.workspaceId, item.id, stageId, item.id, stageId);
  let lastVerified: LingAppServerWorkflowStageProgress["lastVerified"] = change
    ? { kind: "plan_change_accepted", id: readString(change, "plan_id"), committedAt: readString(change, "linked_at") }
    : undefined;
  const planProgressAt = lastVerified?.committedAt ?? "";
  const recoveries = new Map<string, LingAppServerStageRecoveryEvidence>();
  if (step.metadata?.recoveryVerification && item.planRevision) {
    const receipts = db.prepare(`
      SELECT id, content FROM work_item_evidence
      WHERE workspace_id=? AND work_item_id=? AND kind='stage_recovery_ref' AND subject_revision=?
        AND created_at>? AND json_extract(content,'$.workflowStepId')=?
      ORDER BY sequence DESC
    `).iterate(item.workspaceId, item.id, item.planRevision, planProgressAt, step.id);
    for (const receipt of receipts) {
      const recovery = parseJson(readString(receipt, "content")) as LingAppServerStageRecoveryEvidence;
      if (recoveries.has(recovery.blockerId)) continue;
      recoveries.set(recovery.blockerId, recovery);
      if (recovery.committedAt > (lastVerified?.committedAt ?? "")) {
        lastVerified = { kind: "verification_passed", id: readString(receipt, "id"), ...recovery };
      }
    }
  }
  const history = db.prepare(`
    SELECT r.id, r.task_id, r.status, r.ended_at, r.provider_preset_id, r.provider_name, r.provider_model,
      t.id AS transition_id, t.created_at AS accepted_at,
      e.id AS failure_id, e.type AS failure_type,
      CASE WHEN e.type='loop_detected' THEN json_extract(e.data_json,'$.fingerprint') END AS loop_fingerprint,
      CASE WHEN e.type='run_error' THEN json_extract(e.data_json,'$.errorDiagnostic') END AS diagnostic
    FROM app_server_state link
    JOIN channel_workflow_steps s ON s.workspace_id=link.workspace_id AND s.workflow_id=link.record_id
    JOIN run_sessions r ON r.workflow_step_id=s.id AND r.channel_id=s.channel_id
    LEFT JOIN state_transition_events t ON t.id=(
      SELECT id FROM state_transition_events
      WHERE workspace_id=s.workspace_id AND entity_type='workflow_step' AND entity_id=s.id
        AND event='succeed' AND to_status='succeeded' AND reason='run:' || r.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    LEFT JOIN run_events e ON r.status='failed' AND e.id=(
      SELECT id FROM run_events WHERE run_id=r.id AND (type='loop_detected'
        OR (type='run_error' AND json_type(data_json,'$.errorDiagnostic')='object'))
      ORDER BY (type='loop_detected') DESC, seq DESC LIMIT 1
    )
    WHERE link.workspace_id=? AND link.kind='work_item_workflow' AND json_extract(link.payload_json,'$.binding.workItemId')=?
      AND json_extract(s.metadata_json,'$.planStageId')=? AND r.ended_at IS NOT NULL
      AND COALESCE(t.created_at,r.ended_at)>? AND ((r.status='succeeded' AND t.id IS NOT NULL) OR e.id IS NOT NULL)
    ORDER BY COALESCE(t.created_at,r.ended_at) DESC, r.id DESC
  `).iterate(item.workspaceId, item.id, stageId, planProgressAt);
  const blockers = new Map<string, Blocker>();
  const seenTasks = new Set<string>();
  for (const row of history) {
    if (row.status === "succeeded") {
      const committedAt = readString(row, "accepted_at");
      if (committedAt > (lastVerified?.committedAt ?? "")) {
        lastVerified = { kind: "stage_completed", id: readString(row, "transition_id"), committedAt };
      }
      break;
    }
    const taskId = readString(row, "task_id");
    if (seenTasks.has(taskId)) continue;
    seenTasks.add(taskId);
    const cause = readCause(row.failure_type, row.loop_fingerprint, readNullableString(row, "diagnostic"));
    if (!cause) continue;
    const provider = cause.kind === "provider" ? [row.provider_preset_id, row.provider_name, row.provider_model] : [];
    const id = createHash("sha256").update(JSON.stringify([item.id, stageId, cause.identity, provider])).digest("hex");
    const recovery = recoveries.get(id);
    if (recovery && (row.failure_id === recovery.failureEventId || readString(row, "ended_at") < recovery.failedAt)) continue;
    const prior = blockers.get(id);
    const failedStarts = (prior?.failedStarts ?? 0) + 1;
    const status = maxNoEvidenceContinuations !== undefined && failedStarts > maxNoEvidenceContinuations ? "stalled" : "observed";
    blockers.set(id, prior ? { ...prior, failedStarts, status } : { id, kind: cause.kind, code: cause.code, status, failedStarts,
      lastRunId: readString(row, "id"), sourceEventId: readString(row, "failure_id"), recoveryOwnerId: step.toParticipantId });
  }
  const blockersByRecency = [...blockers.values()];
  const blocker = blockersByRecency.find(entry => entry.status === "stalled") ?? blockersByRecency[0];
  return { lastVerified, blocker };
}

function readCause(type: unknown, fingerprint: unknown, diagnostic: string | undefined):
  { readonly kind: Blocker["kind"]; readonly code: string; readonly identity: string } | undefined {
  if (type === "loop_detected" && typeof fingerprint === "string" && /^[a-f0-9]{64}$/u.test(fingerprint)) {
    return { kind: "execution_loop", code: "execution_loop_detected", identity: `loop:${fingerprint}` };
  }
  if (!diagnostic) return undefined;
  const fact = parseJson(diagnostic);
  if (!isRunProviderErrorDiagnostic(fact) || ["unknown", "cancelled"].includes(fact.category)) return undefined;
  return { kind: "provider", code: fact.category, identity: JSON.stringify([fact.category, fact.code ?? fact.httpStatus ?? null]) };
}
