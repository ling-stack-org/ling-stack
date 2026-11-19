import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeRerunTargetDispatchResponseV1, NodeRerunTargetResponseV1 } from "@ling-stack/contracts";
import type { RunSession, RunStore, SecretResolver } from "@ling-stack/core";
import { rebindPreparedPiTaskInput } from "@ling-stack/runner-pi";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { McpBroker } from "../../context.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { readStoredRunnerExecution } from "./existing-run-request.js";
import { observeNodeRerunAdmission } from "./node-rerun-observation.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "./prepared-runner-input.js";
import { createDetachedRunExecutionSink, executeNodeRerunTargetRequest, type ExecuteRunRequestOptions, type RunExecutionSink } from "./orchestrator.js";

/** Read and rebind only the persisted SDK assembly. No mutable context selection or Provider work. */
export function prepareNodeRerunTargetExecution(store: Pick<RunStore, "getWorkUnitAttempt">,
  source: RunSession, attemptId: string, taskId: string): PreparedRunnerInput | undefined {
  const attempt = store.getWorkUnitAttempt(attemptId);
  const execution = readStoredRunnerExecution(source);
  if (!execution || !attempt || attempt.workUnitId !== source.workUnitId || execution.runnerId !== "pi"
    || attempt.effectiveRunnerId !== execution.runnerId || execution.input.provider.provider !== source.providerName
    || execution.input.provider.model !== source.providerModel || execution.preparedInput.model.provider !== source.providerName
    || execution.preparedInput.model.id !== source.providerModel) return undefined;
  const task = { ...execution.input.task, id: taskId };
  try {
    return readPreparedRunnerInput({ ...execution, input: { ...execution.input, task },
      preparedInput: rebindPreparedPiTaskInput(execution.preparedInput, execution.input.task, task) }, { cwd: source.cwd, task });
  } catch { return undefined; }
}

/** Explicit preparation consumes one local decision; it does not authorize or schedule execution. */
export async function handleNodeRerunTarget(
  request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runtimeSupervisor: RuntimeSupervisor,
  runId: string, recordId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun target preparation requires POST." });
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
    writeJson(response, 400, { error: "node_rerun_target_invalid_request", message: "The node rerun target request is invalid." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    writeJson(response, 400, { error: "node_rerun_target_invalid_request", message: "The node rerun target request must be an empty object." });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_target_unavailable", message: "Node rerun targets require an initialized workspace Store." });
      return;
    }
    const record = store.getNodeRerunIntent(recordId);
    if (!record || record.intent.source.runId !== runId) {
      writeJson(response, 404, { error: "node_rerun_intent_not_found", message: "The node rerun intent was not found under the source Run." });
      return;
    }
    const runtime = runtimeSupervisor.getRuntimeForWorkspace(store.paths.cwd, store, record.workspaceId);
    const now = new Date().toISOString();
    const result = store.prepareNodeRerunTarget({ recordId, runtimeInstanceId: runtime.runtimeInstanceId, now,
      revalidate: intent => observeNodeRerunAdmission({ store, activeRuns, intent, now }),
      prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(store, source, record.intent.source.attemptId, taskId) });
    if (result.status === "blocked") {
      writeJson(response, 409, { error: result.code, message: "The node rerun target cannot be prepared from the current source and approval." });
      return;
    }
    const output: NodeRerunTargetResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_response",
      target: result.target, executionAuthorized: false };
    storeRegistry.rememberRun(result.target.runId, store);
    writeJson(response, result.status === "created" ? 201 : 200, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_target_unavailable", message: "The Host could not prepare a consistent node rerun target." });
  }
}

/** Consume the dedicated Host gate and start exactly one prepared target. */
export async function handleDispatchNodeRerunTarget(
  request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runtimeSupervisor: RuntimeSupervisor,
  runnerRegistry: RunnerRegistry, secretResolver: SecretResolver, mcpBroker: McpBroker,
  runId: string, recordId: string, options: ExecuteRunRequestOptions = {},
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun target dispatch requires POST." });
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
    writeJson(response, 400, { error: "node_rerun_dispatch_invalid_request", message: "The node rerun dispatch request is invalid." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    writeJson(response, 400, { error: "node_rerun_dispatch_invalid_request", message: "The node rerun dispatch request must be an empty object." });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_dispatch_unavailable", message: "Node rerun dispatch requires an initialized workspace Store." });
      return;
    }
    const record = store.getNodeRerunIntent(recordId);
    const target = store.getNodeRerunTarget(recordId);
    if (!record || record.intent.source.runId !== runId) {
      writeJson(response, 404, { error: "node_rerun_intent_not_found", message: "The node rerun intent was not found under the source Run." });
      return;
    }
    if (!target) {
      writeJson(response, 404, { error: "node_rerun_target_not_found", message: "The node rerun intent has no prepared target." });
      return;
    }
    const source = { runId: target.runId, ...target.fence };
    const admission = runtimeSupervisor.getHostCapacityAdmission(store);
    const existing = admission?.getAttemptReference({ workspaceId: target.workspaceId, source });
    const durableDispatch = admission?.getDispatchedAttemptReference?.({ workspaceId: target.workspaceId, source });
    if (existing?.dispatched || durableDispatch) {
      const output: NodeRerunTargetDispatchResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_dispatch_response",
        target, runId: target.runId, dispatchStatus: "already_dispatched", executionAuthorized: true };
      writeJson(response, 200, output);
      return;
    }

    let failure: { readonly statusCode: number; readonly body: unknown } | undefined;
    const sink: RunExecutionSink = {
      ...createDetachedRunExecutionSink(),
      writeError(statusCode, errorBody) { failure = { statusCode, body: errorBody }; },
    };
    const startedRunId = await executeNodeRerunTargetRequest(
      { cwd, sourceRunId: runId, recordId }, sink, runnerRegistry, storeRegistry, activeRuns,
      runtimeSupervisor, secretResolver, mcpBroker, options,
    );
    const dispatchedTarget = store.getNodeRerunTarget(recordId);
    const current = admission?.getAttemptReference({ workspaceId: target.workspaceId, source });
    const durableDispatchAfterExecution = admission?.getDispatchedAttemptReference?.({ workspaceId: target.workspaceId, source });
    if (!startedRunId || !dispatchedTarget || (!current?.dispatched && !durableDispatchAfterExecution)) {
      // A concurrent receiver may have won the atomic dispatch gate after our
      // preparation failed. Re-read the receipt before exposing a conflict.
      if (dispatchedTarget && admission?.getAttemptReference({ workspaceId: dispatchedTarget.workspaceId,
        source: { runId: dispatchedTarget.runId, ...dispatchedTarget.fence } })?.dispatched) {
        const output: NodeRerunTargetDispatchResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_dispatch_response",
          target: dispatchedTarget, runId: dispatchedTarget.runId, dispatchStatus: "already_dispatched", executionAuthorized: true };
        writeJson(response, 200, output);
        return;
      }
      if (dispatchedTarget && admission?.getDispatchedAttemptReference?.({ workspaceId: dispatchedTarget.workspaceId,
        source: { runId: dispatchedTarget.runId, ...dispatchedTarget.fence } })) {
        const output: NodeRerunTargetDispatchResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_dispatch_response",
          target: dispatchedTarget, runId: dispatchedTarget.runId, dispatchStatus: "already_dispatched", executionAuthorized: true };
        writeJson(response, 200, output);
        return;
      }
      writeJson(response, failure?.statusCode ?? 409, failure?.body ?? {
        error: "node_rerun_dispatch_blocked", message: "The prepared node rerun target was not dispatched." });
      return;
    }
    const output: NodeRerunTargetDispatchResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_dispatch_response",
      target: dispatchedTarget, runId: startedRunId, dispatchStatus: "dispatched", executionAuthorized: true };
    writeJson(response, 202, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_dispatch_unavailable", message: "The Host could not dispatch a consistent node rerun target." });
  }
}
