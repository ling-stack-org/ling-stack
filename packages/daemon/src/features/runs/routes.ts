import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  approvalStatuses,
  approvalToolDecisions,
  defaultApprovalToolDecisions,
  syncExternalWorkActionForApproval,
  type ApprovalPolicyUpdateInput,
  type ApprovalStatus,
  type ApprovalToolDecision,
  type RunEventEnvelope,
  type RunStore,
  type RunStatus,
  type RunTool,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { HttpError } from "../../errors.js";
import { readJsonBody, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray } from "../../shared/validation.js";
import {
  appendApprovalDecisionEvent,
  expireStaleApproval,
  expireStalePendingApprovals,
} from "./approvals.js";
import { inferArtifactContentType, resolveArtifactContentPath } from "./artifacts.js";
import { parseRunRequest, type RunRequest } from "./schemas.js";

export async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  executeRun: (runRequest: RunRequest) => Promise<string | undefined>,
): Promise<void> {
  let runRequest: RunRequest;
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    runRequest = parseRunRequest(body);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await executeRun(runRequest);
}

export function handleListRuns(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, {
      error: "bad_request",
      message: "cwd query parameter is required",
    });
    return;
  }

  try {
    const limit = readOptionalIntegerQuery(url, "limit", 1);
    const status = readOptionalRunStatusQuery(url);
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      runs: store.listRuns({
        limit,
        status,
        threadId: url.searchParams.get("threadId") ?? undefined,
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleGetRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, run);
}

export function handleGetRunEvents(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  let afterSeq: number | undefined;
  let limit: number | undefined;
  try {
    afterSeq = readOptionalIntegerQuery(url, "afterSeq", 0);
    limit = readOptionalIntegerQuery(url, "limit", 1);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  const events = store.listEvents(runId, { afterSeq, limit });
  const lastEvent = events.at(-1);
  writeJson(response, 200, {
    runId,
    events,
    nextSeq: lastEvent ? lastEvent.seq + 1 : (afterSeq ?? 0) + 1,
  });
}

export function handleListRunArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    runId,
    artifacts: store.listArtifacts(runId),
  });
}

export function handleGetArtifact(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    artifact: lookup.artifact,
  });
}

export function handleGetArtifactContent(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  let artifactPath: string;
  try {
    artifactPath = resolveArtifactContentPath(lookup.store, lookup.artifact);
  } catch (error) {
    writeJson(response, 403, {
      error: "artifact_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const stats = statSync(artifactPath);
    if (!stats.isFile()) {
      writeJson(response, 404, {
        error: "artifact_content_not_found",
        message: `Artifact content is not a file: ${lookup.artifact.id}`,
      });
      return;
    }

    const content = readFileSync(artifactPath);
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
      "Content-Length": String(content.byteLength),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    writeJson(response, 404, {
      error: "artifact_content_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleCancelRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
  ensureRunCancelled: (input: {
    readonly store: RunStore;
    readonly runId: string;
    readonly taskId: string;
    readonly startedAt?: string;
    readonly reason: string;
    readonly active: boolean;
    readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
  }) => { readonly event?: RunEventEnvelope },
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!store || !run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (run.status === "cancelled") {
    writeJson(response, 200, { cancelled: true, active: false, run });
    return;
  }

  if (isTerminalRunStatus(run.status)) {
    writeJson(response, 409, {
      error: "run_not_cancellable",
      message: `Run ${runId} is already ${run.status}.`,
      run,
    });
    return;
  }

  const activeRun = activeRuns.get(runId);
  const cancelled = ensureRunCancelled({
    store,
    runId,
    taskId: run.taskId,
    startedAt: run.startedAt,
    reason: "user_requested",
    active: Boolean(activeRun),
    streamEnvelope: activeRun?.streamEnvelope,
  });
  activeRun?.abortController.abort();

  writeJson(response, 200, {
    cancelled: true,
    active: Boolean(activeRun),
    run: store.getRun(runId),
    event: cancelled.event,
  });
}

export async function handleApprovalPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, { cwd, policy: store.getApprovalPolicy() });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const policy = store.updateApprovalPolicy(parseApprovalPolicyUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { cwd, policy });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval policy` });
}

export function handleApprovalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /approvals` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    expireStalePendingApprovals(store, {
      runId: url.searchParams.get("runId") ?? undefined,
      mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
      externalWorkActionId: url.searchParams.get("externalWorkActionId") ?? undefined,
      workflowStepId: url.searchParams.get("workflowStepId") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      approvals: store.listApprovalRequests({
        status: readOptionalApprovalStatusQuery(url),
        runId: url.searchParams.get("runId") ?? undefined,
        mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
        externalWorkActionId: url.searchParams.get("externalWorkActionId") ?? undefined,
        workflowStepId: url.searchParams.get("workflowStepId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleApprovalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly approvalId: string; readonly action?: "approve" | "deny" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  expireStaleApproval(store, route.approvalId);
  const approval = store.getApprovalRequest(route.approvalId);
  if (!approval) {
    writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
    return;
  }

  if (!route.action && request.method === "GET") {
    writeJson(response, 200, { approval });
    return;
  }

  if (!route.action) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval requests` });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval decisions` });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const decision = { reason: isRecord(body) ? readOptionalString(body, "reason") : undefined, resolvedBy: "local-user" as const };
    const now = new Date().toISOString();
    const updated =
      route.action === "approve"
        ? store.approveApprovalRequest(route.approvalId, decision, now)
        : store.denyApprovalRequest(route.approvalId, decision, now);
    if (!updated) {
      writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
      return;
    }
    appendApprovalDecisionEvent(store, updated);
    syncExternalWorkActionForApproval(store, updated, now);
    writeJson(response, 200, { approval: updated });
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error && error.message.includes("not pending") ? "approval_not_pending" : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseApprovalPolicyUpdateInput(value: unknown): ApprovalPolicyUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Approval policy update must be a JSON object");
  }
  const input: ApprovalPolicyUpdateInput = {
    toolDecisions: readOptionalApprovalToolDecisions(value, "toolDecisions"),
    allowedWritePaths: readOptionalStringArray(value, "allowedWritePaths")?.map((path) => path.trim()),
  };
  validateApprovalPolicyUpdateInput(input);
  return input;
}

function validateApprovalPolicyUpdateInput(input: ApprovalPolicyUpdateInput): void {
  if (input.allowedWritePaths?.some((path) => path.trim().length === 0)) {
    throw new Error("allowedWritePaths must not contain empty paths");
  }
}

function readOptionalApprovalToolDecisions(
  record: Record<string, unknown>,
  key: string,
): Partial<Record<RunTool, ApprovalToolDecision>> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }

  const result: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  const validTools = Object.keys(defaultApprovalToolDecisions) as RunTool[];
  for (const [tool, decision] of Object.entries(value)) {
    if (!validTools.includes(tool as RunTool)) {
      throw new Error(`${key}.${tool} is not a supported tool`);
    }
    if (typeof decision !== "string" || !approvalToolDecisions.includes(decision as ApprovalToolDecision)) {
      throw new Error(`${key}.${tool} must be one of: ${approvalToolDecisions.join(", ")}`);
    }
    result[tool as RunTool] = decision as ApprovalToolDecision;
  }
  return result;
}

function readOptionalApprovalStatusQuery(url: URL): ApprovalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!approvalStatuses.includes(value as ApprovalStatus)) {
    throw new Error(`status must be one of: ${approvalStatuses.join(", ")}`);
  }
  return value as ApprovalStatus;
}

function readOptionalRunStatusQuery(url: URL): RunStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].includes(value)) {
    throw new Error("status must be one of: queued, running, waiting_for_approval, succeeded, failed, cancelled");
  }
  return value as RunStatus;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
