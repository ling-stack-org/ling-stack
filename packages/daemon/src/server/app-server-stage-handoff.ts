import type { IncomingMessage, ServerResponse } from "node:http";
import { LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS, type LingAppServerStageHandoffParams,
  type LingAppServerStageHandoffReturnReason, type LingAppServerVerifyOperation, type LingAppServerVerifyPlanResult } from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration, readWorkflowStageHandoffReceipt, workflowStageHandoffId,
  type AppendWorkItemCollaborationResult, type RunStore, type WorkflowStageHandoffDecision,
} from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { workflowStepParticipantAvailable } from "../features/channels/workflow-participant-run-profile.js";
import { readWorkflowStepOutputPacketArtifact } from "../features/channels/workflow-step-packets.js";
import { readCompleteHandoffCandidate } from "../features/work-items/stage-handoff-candidates.js";
import type { ActiveRunRegistry } from "../runtime/active-runs.js";
import { continuationSourceReady } from "../runtime/continuation-source-barrier.js";
import { allowLocalWorkspaceRequest } from "../shared/local-workspace-access.js";
import { readJsonBody } from "../shared/request.js";
import { writeJson } from "../shared/response.js";
import { isRecord } from "../shared/validation.js";
import { AppServerCollaborationError } from "./app-server-collaboration.js";
import { appServerRecoveryFor } from "./app-server-recovery.js";

export function readStageHandoffParams(record: Record<string, unknown>, action: "accepted" | "returned"): LingAppServerStageHandoffParams {
  const invalid = () => new HttpError(400, "invalid_params", "Supply the current handoff revisions, decision and a bounded request key.");
  const readId = (value: unknown, limit = 256): string => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n\0]/u.test(value)) throw invalid();
    return value;
  };
  const required = (field: string, limit = 256) => readId(record[field], limit);
  const reason = record.reason as LingAppServerStageHandoffReturnReason | undefined;
  const detail = record.detail;
  const revision = record.expectedWorkItemRevision;
  const expectedCandidateDigest = record.expectedCandidateDigest;
  const previousHandoffId = record.previousHandoffId === undefined ? undefined : required("previousHandoffId");
  const rawVerification = record.verification;
  if (action === "returned" && (!reason || !LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS.includes(reason))
    || previousHandoffId !== undefined && action !== "accepted"
    || rawVerification !== undefined && (!isRecord(rawVerification) || !previousHandoffId || !expectedCandidateDigest)
    || action === "accepted" && reason !== undefined || detail !== undefined && (typeof detail !== "string" || detail.length > 1200)
    || expectedCandidateDigest !== undefined && (action !== "accepted" || typeof expectedCandidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expectedCandidateDigest))
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw invalid();
  return {
    workItemId: required("workItemId"), planRevision: required("planRevision"),
    sourceStepId: required("sourceStepId"), targetStepId: required("targetStepId"),
    expectedSourceRevision: required("expectedSourceRevision"), expectedTargetRevision: required("expectedTargetRevision"),
    idempotencyKey: required("idempotencyKey", 200), expectedWorkItemRevision: revision, reason, detail: detail?.trim(), expectedCandidateDigest,
    previousHandoffId,
    ...(isRecord(rawVerification) ? { verification: { operationId: readId(rawVerification.operationId), checkId: readId(rawVerification.checkId, 128) } } : {}),
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
    const { event, ...result } = await settleAppServerStageHandoff(store, input, body.action, context.activeRuns, new Date().toISOString());
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

export async function settleAppServerStageHandoff(
  store: RunStore, input: LingAppServerStageHandoffParams, action: "accepted" | "returned", activeRuns: ActiveRunRegistry, now: string,
): Promise<AppendWorkItemCollaborationResult> {
  const { workItemId, planRevision, sourceStepId, targetStepId, expectedSourceRevision, expectedTargetRevision, idempotencyKey,
    previousHandoffId, verification } = input;
  const item = store.getWorkItem(workItemId);
  if (!item) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
  const subject = { workItemId, planRevision, sourceStepId, sourceRevision: expectedSourceRevision, targetStepId };
  const replay = (): AppendWorkItemCollaborationResult | undefined => {
    const existing = readWorkflowStageHandoffReceipt(store, subject, previousHandoffId);
    if (!existing) return undefined;
    const { record, decision } = existing;
    if (record.idempotencyKey !== idempotencyKey) throw new AppServerCollaborationError("stale_revision", "This source revision already has a handoff decision.");
    if (record.action !== action || decision.targetRevision !== expectedTargetRevision
      || decision.reason !== input.reason || decision.detail !== input.detail || decision.candidateDigest !== input.expectedCandidateDigest
      || decision.verification?.operationId !== verification?.operationId || decision.verification?.checkId !== verification?.checkId) {
      throw new AppServerCollaborationError("idempotency_conflict", "The handoff key was used with a different decision.");
    }
    const revision = store.getWorkItem(workItemId)?.revision ?? item.revision;
    return { status: "replayed", record: { ...record, workItemRevision: revision }, workItemRevision: revision };
  };
  const prior = replay();
  if (prior) return prior;
  const returned = previousHandoffId ? readWorkflowStageHandoffReceipt(store, subject) : undefined;
  if (previousHandoffId && (action !== "accepted" || returned?.record.id !== previousHandoffId || returned.record.action !== "returned")) {
    throw new AppServerCollaborationError("stale_revision", "The previous handoff is not the return receipt for this source revision.");
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
  const requiresVerification = returned?.decision.reason === "required_check_incomplete" || returned?.decision.reason === "candidate_stale";
  if (requiresVerification && (!verification || !input.expectedCandidateDigest)) throw handoffVerificationRequired();
  const assertRepairEvidence = (): void => {
    if (verification && !hasCurrentHandoffVerification(store, input, sourceRun?.cwd, returned?.record.createdAt)) {
      throw handoffVerificationRequired();
    }
    if (returned?.decision.reason === "upstream_effect_unknown") {
      const unit = sourceRun?.workUnitId && store.getWorkUnit(sourceRun.workUnitId);
      if (!unit || !continuationSourceReady(store, unit, activeRuns, `work-item-handoff:${previousHandoffId}`, () => undefined)) {
        throw new HttpError(409, "resume_blocked", "The supplying Run still needs verified execution and effect settlement.");
      }
    }
  };
  if (input.expectedCandidateDigest && sourceRun) {
    const candidate = await readCompleteHandoffCandidate(sourceRun.cwd);
    const committed = replay();
    if (committed) return committed;
    if (candidate !== input.expectedCandidateDigest) throw new HttpError(409, "work_item_handoff_candidate_stale", "The supplying worktree's candidate changed.");
    const latestSource = store.getChannelWorkflowStep(sourceStepId);
    const latestTarget = store.getChannelWorkflowStep(targetStepId);
    if (latestSource?.updatedAt !== source.updatedAt || latestSource.runId !== source.runId
      || latestSource.metadata?.outputArtifactId !== artifactId || latestTarget?.updatedAt !== target.updatedAt
      || latestTarget.toParticipantId !== target.toParticipantId || latestTarget.status !== "queued") {
      throw new AppServerCollaborationError("stale_revision", "The handoff changed while capturing the candidate.");
    }
  }
  if (action === "accepted" && !workflowStepParticipantAvailable(store, target)) {
    throw new HttpError(409, "work_item_handoff_recipient_unavailable", "The assigned participant cannot currently receive the handoff.");
  }
  const payload: WorkflowStageHandoffDecision = {
    recipientId: target.toParticipantId, targetRevision: target.updatedAt, sourceArtifactId: artifactId, sourceRunId: sourceRun?.id,
    reason: input.reason, detail: input.detail, candidateDigest: input.expectedCandidateDigest,
    ...(verification ? { verification } : {}),
  };
  const result = appendWorkItemCollaboration(store, {
    id: workflowStageHandoffId(subject, previousHandoffId), workItemId, expectedWorkItemRevision: input.expectedWorkItemRevision,
    kind: "handoff", action, actorId: "local-user", idempotencyKey, payload, parentRecordId: previousHandoffId,
    ...(returned ? { assertCurrent: assertRepairEvidence } : {}),
    sourceRefs: [
      { type: "workflow_step", id: source.id, revision: source.updatedAt },
      { type: "workflow_step", id: target.id, revision: target.updatedAt },
      ...(artifactId ? [{ type: "artifact", id: artifactId }] : []),
      ...(input.expectedCandidateDigest ? [{ type: "candidate", id: input.expectedCandidateDigest, digest: input.expectedCandidateDigest }] : []),
      ...(verification ? [{ type: "verification", id: verification.operationId, revision: verification.checkId }] : []),
    ],
  }, now, store.paths.cwd);
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item changed before recording the handoff.");
  return result;
}

function hasCurrentHandoffVerification(store: RunStore, input: LingAppServerStageHandoffParams, sourceCwd: string | undefined,
  returnedAt: string | undefined): boolean {
  const verification = input.verification;
  if (!verification || !sourceCwd || !returnedAt) return false;
  const stored = store.getAppServerState("verify_operation", verification.operationId)?.payload as
    { readonly operation: LingAppServerVerifyOperation; readonly plan: LingAppServerVerifyPlanResult } | undefined;
  if (!stored) return false;
  const { operation, plan } = stored;
  const check = operation.checks.find(result => result.checkId === verification.checkId);
  const planned = plan.checks.find(recipe => recipe.checkId === verification.checkId);
  return operation.operationId === verification.operationId && operation.planId === plan.planId
    && operation.workItemId === input.workItemId && plan.workItemId === input.workItemId && plan.acceptedPlanRevision === input.planRevision
    && operation.status === "passed" && !!operation.completedAt && operation.completedAt >= returnedAt
    && operation.candidateDigest === input.expectedCandidateDigest && plan.candidate.candidateDigest === operation.candidateDigest
    && plan.candidate.workspaceId === sourceCwd && check?.status === "passed" && planned?.required === true
    && check.candidateDigest === operation.candidateDigest && check.recipeDigest === planned.recipeDigest && check.planRevision === plan.planRevision
    && !!check.verifierBasisRef && check.verifierBasisRef === planned.verifierBasisRef
    && !!check.coverageDigest && check.coverageDigest === planned.coverageDigest
    && check.producerRefs.length > 0 && JSON.stringify(check.producerRefs) === JSON.stringify(planned.producerRefs);
}

function handoffVerificationRequired(): HttpError {
  return new HttpError(409, "work_item_handoff_verification_required", "Supply a new required check from a trusted verifier for this Work Item, Plan and candidate.");
}
