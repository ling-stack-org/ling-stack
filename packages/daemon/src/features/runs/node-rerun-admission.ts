import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createNodeRerunHostAdmissionPlanV1,
  parseNodeRerunIntent,
  type NodeRerunHostAdmissionResponseV1,
  type NodeRerunIntentV1,
} from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { observeNodeRerunAdmission } from "./node-rerun-observation.js";

/**
 * Read-only Host admission entry point. A successful response contains a
 * deterministic plan, while the plan itself never creates execution state or
 * authorizes Provider dispatch.
 */
export async function handlePostNodeRerunAdmission(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  maxBodyBytes: number,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for /runs/:id/node-rerun/admission`,
    });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }

  let intent: NodeRerunIntentV1;
  try {
    intent = parseNodeRerunIntent(await readJsonBody(request, maxBodyBytes));
  } catch {
    writeJson(response, 400, {
      error: "node_rerun_admission_invalid_request",
      message: "The node rerun admission request is invalid.",
    });
    return;
  }
  if (intent.source.runId !== runId) {
    writeJson(response, 409, {
      error: "node_rerun_source_identity_mismatch",
      message: "The URL Run and intent source Run do not match.",
    });
    return;
  }

  let store;
  try {
    store = storeRegistry.getInitializedStore(cwd);
  } catch {
    writeJson(response, 503, {
      error: "node_rerun_admission_unavailable",
      message: "Node rerun admission requires an initialized workspace Store.",
    });
    return;
  }
  if (!store) {
    writeJson(response, 503, {
      error: "node_rerun_admission_unavailable",
      message: "Node rerun admission requires an initialized workspace Store.",
    });
    return;
  }
  if (!store.getRun(runId)) {
    writeJson(response, 404, {
      error: "node_rerun_source_not_found",
      message: "The source Run was not found in the initialized workspace Store.",
    });
    return;
  }

  try {
    const observation = observeNodeRerunAdmission({ store, activeRuns, intent, now: new Date().toISOString() });
    const plan = observation.admission.decision === "eligible_for_host_admission" && observation.observed
      ? createNodeRerunHostAdmissionPlanV1({ intent, observed: observation.observed, admission: observation.admission })
      : null;
    const result: NodeRerunHostAdmissionResponseV1 = {
      schemaVersion: 1,
      kind: "node_rerun_host_admission_response",
      runId,
      admission: observation.admission,
      evaluationInvoked: observation.evaluationInvoked,
      plan,
    };
    writeJson(response, 200, result);
  } catch {
    writeJson(response, 409, {
      error: "node_rerun_admission_unavailable",
      message: "Node rerun admission could not produce a consistent Host plan.",
    });
  }
}
