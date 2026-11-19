import type { IncomingMessage, ServerResponse } from "node:http";
import { parseNodeRerunIntentSubmission, type NodeRerunApprovalResponseV1, type NodeRerunIntentResponseV1, type NodeRerunIntentSubmissionV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { observeNodeRerunAdmission } from "./node-rerun-observation.js";

/** Prepare or read a durable intent without allocating execution or dispatch authority. */
export async function handleNodeRerunIntents(
  request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runId: string, recordId?: string,
): Promise<void> {
  if (request.method !== (recordId ? "GET" : "POST")) {
    writeJson(response, 405, { error: "method_not_allowed", message: "Unsupported node rerun intent method." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }
  let submission: NodeRerunIntentSubmissionV1 | undefined;
  if (!recordId) {
    try {
      submission = parseNodeRerunIntentSubmission(await readJsonBody(request, maxBodyBytes));
    } catch {
      writeJson(response, 400, { error: "node_rerun_intent_invalid_request", message: "The node rerun intent submission is invalid." });
      return;
    }
    if (submission.intent.source.runId !== runId) {
      writeJson(response, 409, { error: "node_rerun_source_identity_mismatch", message: "The URL Run and intent source Run do not match." });
      return;
    }
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_intent_unavailable", message: "Node rerun intents require an initialized workspace Store." });
      return;
    }
    if (!store.getRun(runId)) {
      writeJson(response, 404, { error: "node_rerun_source_not_found", message: "The source Run was not found in the initialized workspace Store." });
      return;
    }
    if (recordId) {
      const record = store.getNodeRerunIntent(recordId);
      if (!record || record.intent.source.runId !== runId) {
        writeJson(response, 404, { error: "node_rerun_intent_not_found", message: "The node rerun intent was not found under the source Run." });
        return;
      }
      const result: NodeRerunIntentResponseV1 = { schemaVersion: 1, kind: "node_rerun_intent_response", record, executionAuthorized: false };
      writeJson(response, 200, result);
      return;
    }
    const now = new Date().toISOString();
    const prepared = store.prepareNodeRerunIntent({ request: submission!, now,
      revalidate: intent => observeNodeRerunAdmission({ store, activeRuns, intent, now }) });
    if (prepared.status === "blocked" || prepared.status === "conflict") {
      writeJson(response, 409, { error: prepared.code, message: "The current node rerun intent cannot be prepared." });
      return;
    }
    const result: NodeRerunIntentResponseV1 = { schemaVersion: 1, kind: "node_rerun_intent_response",
      record: prepared.record, executionAuthorized: false };
    writeJson(response, prepared.status === "created" ? 201 : 200, result);
  } catch {
    writeJson(response, 503, { error: "node_rerun_intent_unavailable", message: "The Host could not read or prepare a consistent node rerun intent." });
  }
}

/** Create one fresh, independent approval for a prepared intent. */
export async function handleNodeRerunIntentApproval(
  request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number,
  storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry, runId: string, recordId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun approvals require POST." });
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
    writeJson(response, 400, { error: "node_rerun_approval_invalid_request", message: "The node rerun approval request is invalid." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    writeJson(response, 400, { error: "node_rerun_approval_invalid_request", message: "The node rerun approval request must be an empty object." });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_approval_unavailable", message: "Node rerun approvals require an initialized workspace Store." });
      return;
    }
    const intent = store.getNodeRerunIntent(recordId);
    if (!intent || intent.intent.source.runId !== runId) {
      writeJson(response, 404, { error: "node_rerun_intent_not_found", message: "The node rerun intent was not found under the source Run." });
      return;
    }
    const now = new Date().toISOString();
    const result = store.requestNodeRerunApproval({ recordId, now,
      revalidate: rerunIntent => observeNodeRerunAdmission({ store, activeRuns, intent: rerunIntent, now }) });
    if (result.status === "blocked") {
      writeJson(response, 409, { error: result.code, message: "The node rerun approval could not be prepared." });
      return;
    }
    const output: NodeRerunApprovalResponseV1 = {
      schemaVersion: 1,
      kind: "node_rerun_approval_response",
      record: intent,
      approval: result.approval,
      executionAuthorized: false,
    };
    writeJson(response, result.status === "created" ? 201 : 200, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_approval_unavailable", message: "The Host could not create a consistent node rerun approval." });
  }
}
