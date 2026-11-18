import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeRerunTargetCancellationResponseV1, NodeRerunTargetStopResponseV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { observePreparedNodeRerunExecution } from "./node-rerun-local-execution.js";
import { finalizeDispatchedNodeRerunTargetStop } from "./node-rerun-stop.js";

/** Cancel only a never-dispatched target under its captured Host fence. */
export async function handleCancelNodeRerunTarget(
  request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runId: string, recordId: string,
  runtimeSupervisor?: Pick<RuntimeSupervisor, "getHostCapacityAdmission">,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun target cancellation requires POST." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }
  let body: unknown;
  try { body = await readJsonBody(request, maxBodyBytes); }
  catch {
    writeJson(response, 400, { error: "node_rerun_cancellation_invalid_request", message: "The node rerun cancellation request is invalid." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    writeJson(response, 400, { error: "node_rerun_cancellation_invalid_request", message: "The node rerun cancellation request must be an empty object." });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_cancellation_unavailable", message: "Node rerun cancellation requires an initialized workspace Store." });
      return;
    }
    const record = store.getNodeRerunIntent(recordId);
    if (!record || record.intent.source.runId !== runId) {
      writeJson(response, 404, { error: "node_rerun_intent_not_found", message: "The node rerun intent was not found under the source Run." });
      return;
    }
    const target = store.getNodeRerunTarget(recordId);
    if (!target) {
      writeJson(response, 404, { error: "node_rerun_target_not_found", message: "The node rerun intent has no prepared target." });
      return;
    }
    const capacity = runtimeSupervisor?.getHostCapacityAdmission(store)?.getAttemptReference({
      workspaceId: target.workspaceId, source: { runId: target.runId, ...target.fence },
    });
    if (capacity?.dispatched) {
      const admission = runtimeSupervisor?.getHostCapacityAdmission(store);
      if (admission) {
        const recovered = finalizeDispatchedNodeRerunTargetStop({
          store,
          target,
          capacity: admission,
          capacityReference: capacity.reference,
          now: new Date().toISOString(),
        });
        if (recovered.status === "cancelled") {
          const output: NodeRerunTargetStopResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_stop_response",
            target, runId: target.runId, stopStatus: "already_requested", executionAuthorized: false };
          writeJson(response, 202, output);
          return;
        }
      }
      const result = store.requestDispatchedNodeRerunTargetStop({ recordId, sourceFence: target.fence, now: new Date().toISOString() });
      if (result.status === "blocked") {
        writeJson(response, 409, { error: result.code, message: "The dispatched node rerun target cannot enter its stop boundary." });
        return;
      }
      const requested = activeRuns.requestStop(target.runId, {
        kind: "user_cancel", actor: "local-user", reason: "node_rerun_target_cancel_requested",
      });
      if (!requested && admission) {
        const recovered = finalizeDispatchedNodeRerunTargetStop({
          store,
          target,
          capacity: admission,
          capacityReference: capacity.reference,
          now: new Date().toISOString(),
        });
        if (recovered.status === "cancelled") {
          const output: NodeRerunTargetStopResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_stop_response",
            target, runId: target.runId, stopStatus: "already_requested", executionAuthorized: false };
          writeJson(response, 202, output);
          return;
        }
      }
      const output: NodeRerunTargetStopResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_stop_response",
        target, runId: target.runId,
        stopStatus: requested ? result.status === "duplicate" ? "already_requested" : "requested" : "awaiting_recovery",
        executionAuthorized: false };
      writeJson(response, 202, output);
      return;
    }
    const result = store.cancelPreparedNodeRerunTarget({ recordId, sourceFence: target.fence, now: new Date().toISOString(),
      observeLocalExecution: candidate => observePreparedNodeRerunExecution(activeRuns, candidate) });
    if (result.status === "blocked") {
      writeJson(response, 409, { error: result.code, message: "The node rerun target has not established a never-dispatched boundary." });
      return;
    }
    try {
      runtimeSupervisor?.getHostCapacityAdmission(store)?.releaseNodeRerunNoDispatch?.({ workspaceId: target.workspaceId,
        recordId, now: new Date().toISOString() });
    } catch {
      console.warn("node_rerun_capacity_release_incomplete: cancellation remains committed and the release outbox is retained");
    }
    const output: NodeRerunTargetCancellationResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_cancellation_response",
      cancellation: result.cancellation, executionAuthorized: false };
    writeJson(response, 200, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_cancellation_unavailable", message: "The Host could not cancel a consistent node rerun target." });
  }
}
