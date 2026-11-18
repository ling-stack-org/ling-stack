import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeRerunTargetReadinessResponseV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { observeNodeRerunAdmission } from "./node-rerun-observation.js";
import { readStoredRunnerExecution } from "./existing-run-request.js";
import { observePreparedNodeRerunExecution } from "./node-rerun-local-execution.js";

/** Revalidate an initialized target without acquiring capacity or issuing execution authority. */
export function handleGetNodeRerunTargetReadiness(request: IncomingMessage, response: ServerResponse, url: URL,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runId: string, recordId: string): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun readiness requires GET." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_readiness_unavailable", message: "Node rerun readiness requires an initialized workspace Store." });
      return;
    }
    const result = store.readSnapshot(() => {
      const record = store.getNodeRerunIntent(recordId);
      if (!record || record.intent.source.runId !== runId) return undefined;
      const now = new Date().toISOString();
      return store.readNodeRerunTargetReadiness({ recordId, now,
        revalidate: intent => observeNodeRerunAdmission({ store, activeRuns, intent, now }),
        observeLocalExecution: candidate => observePreparedNodeRerunExecution(activeRuns, candidate),
        validateExecution: candidate => Boolean(readStoredRunnerExecution(candidate)) });
    });
    if (!result) {
      writeJson(response, 404, { error: "node_rerun_target_not_found", message: "No prepared target was found under the source Run." });
      return;
    }
    const output: NodeRerunTargetReadinessResponseV1 = { schemaVersion: 1, kind: "node_rerun_target_readiness_response",
      readiness: result, executionAuthorized: false };
    writeJson(response, 200, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_readiness_unavailable", message: "The Host could not verify a consistent node rerun target." });
  }
}
