import type { IncomingMessage, ServerResponse } from "node:http";
import { LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS, type LingAppServerStageHandoffParams,
  type LingAppServerStageHandoffReturnReason } from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration, readWorkflowStageHandoff, workflowStageHandoffId,
  type RunStore, type WorkflowStageHandoffDecision,
} from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { readWorkflowStepOutputPacketArtifact } from "../features/channels/workflow-step-packets.js";
import { allowLocalWorkspaceRequest } from "../shared/local-workspace-access.js";
import { readJsonBody } from "../shared/request.js";
import { writeJson } from "../shared/response.js";
import { isRecord } from "../shared/validation.js";
import { AppServerCollaborationError } from "./app-server-collaboration.js";
import { appServerRecoveryFor } from "./app-server-recovery.js";

export function readStageHandoffParams(record: Record<string, unknown>, action: "accepted" | "returned"): LingAppServerStageHandoffParams {
  const invalid = () => new HttpError(400, "invalid_params", "Supply the current handoff revisions, decision and a bounded request key.");
  const required = (field: string, limit = 256): string => {
    const value = record[field];
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n\0]/u.test(value)) throw invalid();
    return value;
  };
  const reason = record.reason as LingAppServerStageHandoffReturnReason | undefined;
  const detail = record.detail;
  const revision = record.expectedWorkItemRevision;
  if (action === "returned" && (!reason || !LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS.includes(reason))
    || action === "accepted" && reason !== undefined || detail !== undefined && (typeof detail !== "string" || detail.length > 1200)
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw invalid();
  return {
    workItemId: required("workItemId"), planRevision: required("planRevision"),
    sourceStepId: required("sourceStepId"), targetStepId: required("targetStepId"),
    expectedSourceRevision: required("expectedSourceRevision"), expectedTargetRevision: required("expectedTargetRevision"),
    idempotencyKey: required("idempotencyKey", 200), expectedWorkItemRevision: revision, reason, detail: detail?.trim(),
  };
}

export async function handleWorkItemStageHandoff(
  request: IncomingMessage, response: ServerResponse, url: URL, context: DaemonContext, workItemId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required" });
    return;
  }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: context.storeRegistry, cwd })) return;
  const store = context.storeRegistry.getInitializedStore(cwd);
  if (!store) {
    writeJson(response, 404, { error: "workspace_not_loaded" });
    return;
  }
  try {
    if (context.activeRuns.isShuttingDown()) throw new HttpError(503, "server_draining", "The daemon is shutting down.");
    const body = await readJsonBody(request, 16 * 1024);
    if (!isRecord(body) || body.action !== "accepted" && body.action !== "returned") {
      throw new HttpError(400, "invalid_params", "Accept or return the stage handoff.");
    }
    const input = readStageHandoffParams({ ...body, workItemId }, body.action);
    if (body.action === "accepted") appServerRecoveryFor(context.config, store)?.assertReady();
    const { event, ...result } = settleAppServerStageHandoff(store, input, body.action, new Date().toISOString());
    if (event) {
      context.controlPlaneEvents.publish(event);
      if (body.action === "accepted") context.taskSupervisor.poke(store.paths.cwd);
    }
    writeJson(response, 200, result);
  } catch (error) {
    if (error instanceof HttpError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
    } else if (error instanceof AppServerCollaborationError) {
      const status = error.code === "work_item_not_found" ? 404 : error.code === "invalid_params" ? 400 : 409;
      writeJson(response, status, { error: error.code, message: error.message });
    } else {
      throw error;
    }
  }
}

export function settleAppServerStageHandoff(
  store: RunStore, input: LingAppServerStageHandoffParams, action: "accepted" | "returned", now: string,
) {
  const { workItemId, planRevision, sourceStepId, targetStepId, expectedSourceRevision, expectedTargetRevision, idempotencyKey } = input;
  const item = store.getWorkItem(workItemId);
  if (!item) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
  const subject = { workItemId, planRevision, sourceStepId, sourceRevision: expectedSourceRevision, targetStepId };
  const existing = readWorkflowStageHandoff(store, subject);
  if (existing) {
    const { record, decision } = existing;
    if (record.idempotencyKey !== idempotencyKey) throw new AppServerCollaborationError("stale_revision", "This source revision already has a handoff decision.");
    if (record.action !== action || decision.targetRevision !== expectedTargetRevision
      || decision.reason !== input.reason || decision.detail !== input.detail) {
      throw new AppServerCollaborationError("idempotency_conflict", "The handoff key was used with a different decision.");
    }
    return { status: "replayed" as const, record: { ...record, workItemRevision: item.revision }, workItemRevision: item.revision };
  }

  const source = store.getChannelWorkflowStep(sourceStepId);
  const target = store.getChannelWorkflowStep(targetStepId);
  if (item.revision !== input.expectedWorkItemRevision || item.planRevision !== planRevision
    || !item.workflowId || !source || !target || source.workflowId !== item.workflowId || target.workflowId !== item.workflowId
    || !target.metadata?.requiredPlanHandoffStepIds?.includes(sourceStepId)
    || source.updatedAt !== expectedSourceRevision || target.updatedAt !== expectedTargetRevision || target.status !== "queued") {
    throw new AppServerCollaborationError("stale_revision", "The accepted Plan, supplying stage or receiving stage changed.");
  }
  if (store.getWorkItemWorkflowAdmissionBlocker(item.workflowId) || item.holds.some(hold => hold.blocksNewAdmission
    && (hold.workflowStepIds?.includes(sourceStepId) || hold.workflowStepIds?.includes(targetStepId)))) {
    throw new HttpError(409, "resume_blocked", "The Work Item is not ready to settle this handoff.");
  }
  if (source.status !== "succeeded") throw new HttpError(409, "resume_blocked", "The supplying stage needs an accepted result.");
  const artifactId = source.metadata?.outputArtifactId;
  const sourceRun = source.runId ? store.getRun(source.runId) : undefined;
  const packet = artifactId ? readWorkflowStepOutputPacketArtifact({ store, artifactId }) : undefined;
  if (action === "accepted" && (sourceRun?.status !== "succeeded" || sourceRun.workflowStepId !== source.id
    || packet?.workflowId !== source.workflowId || packet.workflowStepId !== source.id || packet.runId !== sourceRun.id)) {
    throw new HttpError(409, "resume_blocked", "The supplying stage needs a current result packet from its original Run.");
  }
  const payload: WorkflowStageHandoffDecision = {
    recipientId: target.toParticipantId, targetRevision: target.updatedAt, sourceArtifactId: artifactId, sourceRunId: sourceRun?.id,
    reason: input.reason, detail: input.detail,
  };
  const result = appendWorkItemCollaboration(store, {
    id: workflowStageHandoffId(subject), workItemId, expectedWorkItemRevision: input.expectedWorkItemRevision,
    kind: "handoff", action, actorId: "local-user", idempotencyKey, payload,
    sourceRefs: [
      { type: "workflow_step", id: source.id, revision: source.updatedAt },
      { type: "workflow_step", id: target.id, revision: target.updatedAt },
      ...(artifactId ? [{ type: "artifact", id: artifactId }] : []),
    ],
  }, now, store.paths.cwd);
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item changed before recording the handoff.");
  return result;
}
