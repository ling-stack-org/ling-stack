import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSqliteNodeRerunStore, toRuntimeAttemptFence, type NodeRerunSubmission, type RunStore } from "@ling-stack/core";
import { createNodeRerunHostAdmissionPlanV1, parseNodeRerunIntent } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readWorkUnitStopEvidence } from "../../runtime/work-unit-stop-evidence.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { observeNodeRerunAdmission, readExternalEffectStatus } from "./node-rerun-observation.js";

/** Observation and successor materialization share the Host writer transaction. */
export function submitNodeRerun(store: RunStore, activeRuns: ActiveRunRegistry, body: unknown, now = new Date().toISOString()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "node_rerun_request_invalid", "A submission object is required.");
  const request = body as Record<string, unknown>;
  const intent = parseNodeRerunIntent(request.intent);
  if (typeof request.planFingerprint !== "string" || request.planFingerprint.length > 160) throw new HttpError(400, "node_rerun_plan_required", "The reviewed admission plan fingerprint is required.");
  return createSqliteNodeRerunStore(store).submit({ intent, planFingerprint: request.planFingerprint, now, authorize() {
    const observation = observeNodeRerunAdmission({ store, activeRuns, intent, now });
    if (observation.admission.decision !== "eligible_for_host_admission" || !observation.observed) throw new Error("node_rerun_admission_blocked");
    const plan = createNodeRerunHostAdmissionPlanV1({ intent, observed: observation.observed, admission: observation.admission });
    if (plan.planFingerprint !== request.planFingerprint) throw new Error("node_rerun_plan_stale");
    const run = store.getRun(intent.source.runId)!, sourceStep = store.getChannelWorkflowStep(run.workflowStepId!)!;
    const workflow = store.getChannelWorkflow(sourceStep.workflowId)!;
    const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
    const invalidated = new Set([intent.source.nodeId, ...intent.source.dependencyClosure.downstreamNodeIds]);
    if (!["succeeded", "failed", "cancelled", "blocked"].includes(workflow.status)) throw new Error("node_rerun_workflow_not_quiescent");
    if (!workflow.metadata?.workflowGraph || workflow.metadata.templateCompilation || workflow.metadata.requiredParticipantManifest
      || workflow.metadata.sourceIntentDecisionId) throw new Error("node_rerun_workflow_profile_unsupported");
    for (const step of steps) {
      if (!step.metadata?.graphNodeId || step.metadata.safetyPlan || step.metadata.isolationScopePlan || step.metadata.delegatedRequirement
        || step.metadata.executionPlan || step.metadata.templateCompilationPin) throw new Error("node_rerun_workflow_profile_unsupported");
      const reused = !invalidated.has(step.metadata.graphNodeId);
      if (reused ? !["succeeded", "skipped"].includes(step.status) : !["succeeded", "failed", "cancelled", "skipped", "blocked", "queued"].includes(step.status))
        throw new Error("node_rerun_workflow_not_quiescent");
      if (store.listApprovalRequests({ workflowStepId: step.id, status: "pending", limit: 1 }).length) throw new Error("node_rerun_pending_approval");
      if (!step.runId) {
        if (step.taskId || reused && step.status !== "skipped") throw new Error("node_rerun_lineage_missing");
        continue;
      }
      const sourceRun = store.getRun(step.runId), unit = sourceRun?.workUnitId ? store.getWorkUnit(sourceRun.workUnitId) : undefined;
      if (!sourceRun || !unit || unit.linkedRunId !== sourceRun.id || !["succeeded", "failed", "cancelled"].includes(sourceRun.status)) throw new Error("node_rerun_workflow_not_quiescent");
      const attempts = store.listWorkUnitAttempts(unit.id);
      if (!attempts.length) throw new Error("node_rerun_lineage_missing");
      const stop = readWorkUnitStopEvidence(store, unit, attempts, activeRuns);
      if (stop.attempts.some(attempt => attempt.effects !== "settled" || attempt.localExecution !== "drained")) throw new Error("node_rerun_effect_unsettled");
      for (const attempt of attempts) {
        const effects = readExternalEffectStatus(store, { runId: sourceRun.id, ...toRuntimeAttemptFence(attempt) }, sourceRun.cwd, now);
        if (effects === "unknown" || effects === "pending" || !reused && effects !== "none") throw new Error("node_rerun_effect_unsettled");
      }
    }
    return { workflow, steps };
  } });
}

/** Reused immutable evidence must still match before any successor step dispatch. */
export function assertNodeRerunReuseCurrent(store: RunStore, submission: NodeRerunSubmission): void {
  for (const step of submission.steps.filter(step => step.reused)) {
    const source = store.getChannelWorkflowStep(step.sourceStepId);
    if (!source || createHash("sha256").update(JSON.stringify(source)).digest("hex") !== step.sourceStepDigest
      || step.artifactPins.some(pin => store.getArtifact(pin.id)?.contentSha256 !== pin.sha256)) throw new Error("node_rerun_reuse_stale");
  }
}

export async function handleNodeRerunSubmission(request: IncomingMessage, response: ServerResponse, url: URL,
  maxBodyBytes: number, stores: RunStoreRegistry, activeRuns: ActiveRunRegistry, runId: string, poke: (cwd: string) => void): Promise<void> {
  if (request.method !== "POST" && request.method !== "GET") { writeJson(response, 405, { error: "method_not_allowed" }); return; }
  try {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "cwd_required", "cwd is required.");
    const store = stores.getInitializedStore(cwd);
    if (!store) throw new HttpError(503, "node_rerun_store_unavailable", "An initialized workspace is required.");
    if (!store.getRun(runId)) throw new HttpError(404, "run_not_found", "The source Run was not found.");
    if (request.method === "GET") {
      const key = url.searchParams.get("idempotencyKey");
      const submission = key ? createSqliteNodeRerunStore(store).getByKey(key) : undefined;
      writeJson(response, 200, { submission: submission?.sourceRunId === runId ? submission : null }); return;
    }
    const body = await readJsonBody(request, maxBodyBytes) as Record<string, unknown>;
    if (parseNodeRerunIntent(body?.intent).source.runId !== runId) throw new HttpError(409, "node_rerun_source_identity_mismatch", "URL and intent source must match.");
    const result = submitNodeRerun(store, activeRuns, body);
    poke(cwd);
    writeJson(response, result.duplicate ? 200 : 202, result);
  } catch (error) {
    const code = error instanceof HttpError ? error.code : error instanceof Error && /^node_rerun_[a-z_]+$/.test(error.message) ? error.message : "node_rerun_request_invalid";
    writeJson(response, error instanceof HttpError ? error.statusCode : code === "node_rerun_request_invalid" ? 400 : 409, { error: code });
  }
}
