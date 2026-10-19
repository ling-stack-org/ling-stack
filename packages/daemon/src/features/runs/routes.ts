import { closeSync, constants, createReadStream, fstatSync, openSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ApprovalDecisionUnavailableError,
  approvalStatuses,
  approvalToolDecisions,
  defaultApprovalToolDecisions,
  isApprovalGrantDecisionKind,
  syncExternalWorkActionForApproval,
  type ApprovalPolicyUpdateInput,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalToolDecision,
  type MediaJob,
  type RunEventEnvelope,
  type RunStore,
  type RunStatus,
  type RunTool,
  type ResolveApprovalRequestInput,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { ExecutionCancellationRequest } from "@ling-stack/contracts";
import { parseExecutionCancellationRequest } from "../../shared/cancellation-request.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { HttpError } from "../../errors.js";
import { readJsonBody, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray } from "../../shared/validation.js";
import { expireStaleApproval, expireStalePendingApprovals } from "./approvals.js";
import { reconcileApprovalPostCommitEffects } from "./approval-postcommit-effects.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { buildArtifactPreview } from "../previews/content-preview.js";
import { inferArtifactContentType, MAX_ARTIFACT_RANGE_BYTES, MAX_ARTIFACT_TRANSFER_BYTES, readArtifactContentRange, resolveArtifactContentPath } from "./artifacts.js";
import { listExecutionActions } from "./execution-actions.js";
import { readNativeArtifactContent } from "../../runtime/adapters/native-artifact-files.js";
import { parseRunRequest, type RunRequest } from "./schemas.js";
import { isApprovalCommandRuleProposalCurrent } from "./approval-command-rules.js";
import { isPrivateHostRecoveryArtifact, projectPublicRunEventEnvelope, toPublicArtifactMetadata } from "./public-artifacts.js";

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
        teammateId: url.searchParams.get("teammateId") ?? undefined,
        workflowStepId: url.searchParams.get("workflowStepId") ?? undefined,
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

  const events = store.listEvents(runId, { afterSeq, limit }).map(projectPublicRunEventEnvelope);
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
    artifacts: store.listArtifacts(runId).filter(artifact => !isPrivateHostRecoveryArtifact(artifact)).map(toPublicArtifactMetadata),
  });
}

export function handleGetArtifact(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const cwd = requireArtifactWorkspaceCwd(response, url);
  if (!cwd) return;
  const lookup = storeRegistry.findStoreForArtifact(artifactId, cwd);
  if (!lookup || isPrivateHostRecoveryArtifact(lookup.artifact)) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }
  if (!authorizeArtifactLineage(lookup.store, lookup.artifact, url, cwd)) {
    writeJson(response, 404, { error: "artifact_not_found", message: "Artifact was not found in the requested workspace lineage." });
    return;
  }

  writeJson(response, 200, {
    artifact: toPublicArtifactMetadata(lookup.artifact),
  });
}

export function handleGetArtifactContent(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const cwd = requireArtifactWorkspaceCwd(response, url);
  if (!cwd) return;
  let offset: number | undefined;
  let requestedLimit: number | undefined;
  try {
    offset = readOptionalIntegerQuery(url, "offset", 0);
    requestedLimit = readOptionalIntegerQuery(url, "limit", 1);
    if ((offset !== undefined || requestedLimit !== undefined) && (requestedLimit ?? MAX_ARTIFACT_RANGE_BYTES) > MAX_ARTIFACT_RANGE_BYTES) {
      throw new Error(`limit must be less than or equal to ${MAX_ARTIFACT_RANGE_BYTES}`);
    }
  } catch (error) {
    writeJson(response, 416, {
      error: "artifact_range_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const lookup = storeRegistry.findStoreForArtifact(artifactId, cwd);
  if (!lookup || isPrivateHostRecoveryArtifact(lookup.artifact)) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }
  if (!authorizeArtifactLineage(lookup.store, lookup.artifact, url, cwd)) {
    writeJson(response, 404, { error: "artifact_not_found", message: "Artifact was not found in the requested workspace lineage." });
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
    const nativeContent = readNativeArtifactContent(lookup.store.paths.artifactsDir, lookup.artifact);
    const stats = nativeContent ? undefined : statSync(artifactPath);
    if (!nativeContent && !stats?.isFile()) {
      writeJson(response, 404, {
        error: "artifact_content_not_found",
        message: `Artifact content is not a file: ${lookup.artifact.id}`,
      });
      return;
    }

    const ranged = nativeContent
      ? (() => {
          const rangeOffset = offset ?? 0;
          if (rangeOffset > nativeContent.byteLength || (rangeOffset === nativeContent.byteLength && nativeContent.byteLength > 0)) {
            throw new Error("Artifact range offset exceeds content size.");
          }
          const rangeLimit = requestedLimit ?? (offset !== undefined ? MAX_ARTIFACT_RANGE_BYTES : nativeContent.byteLength || 1);
          const endExclusive = Math.min(nativeContent.byteLength, rangeOffset + rangeLimit);
          return {
            content: nativeContent.subarray(rangeOffset, endExclusive),
            offset: rangeOffset,
            endExclusive,
            sizeBytes: nativeContent.byteLength,
            partial: rangeOffset > 0 || endExclusive < nativeContent.byteLength,
          };
        })()
      : offset !== undefined || requestedLimit !== undefined
        ? readArtifactContentRange(artifactPath, offset ?? 0, requestedLimit ?? MAX_ARTIFACT_RANGE_BYTES)
        : undefined;
    if (!ranged) {
      if (stats!.size > MAX_ARTIFACT_TRANSFER_BYTES) {
        writeJson(response, 413, {
          error: "artifact_transfer_budget_exceeded",
          message: `Artifact is ${stats!.size} bytes; request a range of at most ${MAX_ARTIFACT_RANGE_BYTES} bytes.`,
        });
        return;
      }
      // Full-size media and downloads retain their existing HTTP contract, but
      // must not allocate the entire artifact in the daemon's event loop.
      const fd = openSync(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let sizeBytes: number;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) throw new Error(`Artifact content is not a file: ${lookup.artifact.id}`);
        sizeBytes = opened.size;
        if (sizeBytes === 0) {
          closeSync(fd);
          setCorsHeaders(response);
          response.writeHead(200, {
            "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
            "Content-Length": "0",
            "X-Content-Type-Options": "nosniff",
          });
          response.end();
          return;
        }
        const stream = createReadStream(artifactPath, { fd, autoClose: true, end: sizeBytes - 1, highWaterMark: 64 * 1024 });
        stream.once("error", () => response.destroy());
        response.once("close", () => stream.destroy());
        setCorsHeaders(response);
        response.writeHead(200, {
          "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
          "Content-Length": String(sizeBytes),
          "X-Content-Type-Options": "nosniff",
        });
        stream.pipe(response);
        return;
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
    const content = ranged.content;
    setCorsHeaders(response);
    response.writeHead(ranged.partial ? 206 : 200, {
      "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
      "Content-Length": String(content.byteLength),
      ...(ranged.content.byteLength > 0 ? {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${ranged.offset}-${ranged.endExclusive - 1}/${ranged.sizeBytes}`,
      } : {}),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidRange = message === "Artifact range offset exceeds content size.";
    writeJson(response, invalidRange ? 416 : 404, {
      error: invalidRange ? "artifact_range_invalid" : "artifact_content_not_found",
      message,
    });
  }
}

export function handleGetArtifactPreview(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const cwd = requireArtifactWorkspaceCwd(response, url);
  if (!cwd) return;
  const lookup = storeRegistry.findStoreForArtifact(artifactId, cwd);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }
  if (!authorizeArtifactLineage(lookup.store, lookup.artifact, url, cwd)) {
    writeJson(response, 404, { error: "artifact_not_found", message: "Artifact was not found in the requested workspace lineage." });
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
    const maxBytes = readOptionalIntegerQuery(url, "maxBytes", 1);
    writeJson(response, 200, buildArtifactPreview({
      artifact: lookup.artifact,
      contentPath: artifactPath,
      content: readNativeArtifactContent(lookup.store.paths.artifactsDir, lookup.artifact),
      maxBytes,
      imageUrl: lookup.artifact.type === "image" ? artifactContentUrl(url, lookup.artifact.id) : undefined,
    }));
  } catch (error) {
    writeJson(response, 404, {
      error: "artifact_preview_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function artifactContentUrl(url: URL, artifactId: string): string {
  const previewCwd = url.searchParams.get("cwd");
  const query = new URLSearchParams();
  if (previewCwd) {
    query.set("cwd", previewCwd);
  }
  return `${url.origin}/artifacts/${encodeURIComponent(artifactId)}/content${query.size > 0 ? `?${query.toString()}` : ""}`;
}

function requireArtifactWorkspaceCwd(response: ServerResponse, url: URL): string | undefined {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required for artifact access" });
    return undefined;
  }
  return cwd;
}

/**
 * Artifact ids are opaque references, not workspace capabilities. Requiring
 * the explicit workspace and checking every requested lineage prevents a
 * guessed id from resolving through another open workspace store.
 */
function authorizeArtifactLineage(store: RunStore, artifact: ReturnType<RunStore["getArtifact"]>, url: URL, cwd: string): boolean {
  if (!artifact || !workspaceContains(store.paths.cwd, cwd)) return false;
  const requestedRunId = url.searchParams.get("runId")?.trim();
  const requestedParticipantId = url.searchParams.get("participantId")?.trim();
  const requestedWorkflowStepId = url.searchParams.get("workflowStepId")?.trim();
  const requestedActionId = url.searchParams.get("actionId")?.trim();
  if (requestedRunId && artifact.runId !== requestedRunId) return false;
  if (!artifact.runId) return !requestedParticipantId && !requestedWorkflowStepId && !requestedActionId;
  const run = store.getRun(artifact.runId);
  if (!run || !workspaceContains(store.paths.cwd, run.cwd) || !workspaceContains(store.paths.cwd, cwd)) return false;
  if (requestedParticipantId && run.teammateId !== requestedParticipantId) {
    const action = listExecutionActions(store, { runId: run.id, complete: true }).find((candidate) =>
      candidate.participantId === requestedParticipantId && [...candidate.previewArtifactIds, ...candidate.resultArtifactIds].includes(artifact.id));
    if (!action) return false;
  }
  if (requestedWorkflowStepId && run.workflowStepId !== requestedWorkflowStepId) {
    const action = listExecutionActions(store, { runId: run.id, complete: true }).find((candidate) =>
      candidate.workflowStepId === requestedWorkflowStepId && [...candidate.previewArtifactIds, ...candidate.resultArtifactIds].includes(artifact.id));
    if (!action) return false;
  }
  if (requestedActionId) {
    const action = listExecutionActions(store, { runId: run.id, complete: true }).find((candidate) =>
      candidate.id === requestedActionId && [...candidate.previewArtifactIds, ...candidate.resultArtifactIds].includes(artifact.id));
    if (!action) return false;
  }
  return true;
}

function resolveWorkspacePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function workspaceContains(root: string, candidate: string): boolean {
  const normalizedRoot = resolveWorkspacePath(root);
  const normalizedCandidate = resolveWorkspacePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export async function handleCancelRunRequest(request: IncomingMessage, response: ServerResponse,
  config: ResolvedDaemonConfig, url: URL, storeRegistry: RunStoreRegistry, activeRuns: ActiveRunRegistry,
  runId: string, cancel: typeof import("./cancellation.js").ensureRunCancelled): Promise<void> {
  try {
    const input = parseExecutionCancellationRequest(await readOptionalJsonBody(request, config.maxBodyBytes));
    handleCancelRun(response, url, storeRegistry, activeRuns, runId, cancel, input);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
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
  ensureRunCancelled: typeof import("./cancellation.js").ensureRunCancelled,
  input: ExecutionCancellationRequest = {},
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
  let cancelled: ReturnType<typeof ensureRunCancelled>;
  try {
    cancelled = ensureRunCancelled({
      ...input,
      store,
      runId,
      taskId: run.taskId,
      startedAt: run.startedAt,
      reason: "user_requested",
      active: Boolean(activeRun),
      streamEnvelope: activeRun?.streamEnvelope,
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    writeJson(response, error.statusCode, { error: error.code, message: error.message });
    return;
  }
  if (!cancelled.inputWait) activeRun?.abortController.abort();

  writeJson(response, 200, {
    cancelled: true,
    active: !cancelled.inputWait && Boolean(activeRun),
    run: store.getRun(runId),
    event: cancelled.event,
    ...(cancelled.inputWait ? { inputWait: cancelled.inputWait } : {}),
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
  controlPlaneEvents?: ControlPlaneEventHub,
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
      cwd,
      controlPlaneEvents,
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
  controlPlaneEvents?: ControlPlaneEventHub,
  onApprovalResolved?: (input: { readonly cwd: string; readonly store: RunStore; readonly approval: ApprovalRequest; readonly now: string }) => MediaJob | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  expireStaleApproval(store, route.approvalId, controlPlaneEvents, cwd);
  const approval = store.getApprovalRequest(route.approvalId);
  if (!approval) {
    writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
    return;
  }

  if (!route.action && request.method === "GET") {
    writeJson(response, 200, {
      approval,
      ...(typeof store.listApprovalPostCommitEffects === "function"
        ? { postCommitEffects: store.listApprovalPostCommitEffects({ approvalId: approval.id }).map((effect) => ({
            approvalId: effect.approvalId,
            effectKind: effect.effectKind,
            ownerKind: effect.ownerKind,
            ownerId: effect.ownerId,
            status: effect.status,
            revision: effect.revision,
            attempts: effect.attempts,
            lastErrorCode: effect.lastErrorCode,
            updatedAt: effect.updatedAt,
          })) }
        : {}),
    });
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
    const decisionKind = route.action === "approve" && isRecord(body)
      ? readOptionalString(body, "decisionKind")
      : undefined;
    if (decisionKind !== undefined && !isApprovalGrantDecisionKind(decisionKind)) {
      writeJson(response, 400, { error: "bad_request", message: `Unsupported approval decision kind: ${decisionKind}` });
      return;
    }
    const proposedRuleFingerprint = isRecord(body) ? readOptionalString(body, "proposedRuleFingerprint") : undefined;
    if (decisionKind === "approve_command_rule") {
      if (!isApprovalCommandRuleProposalCurrent(approval)) {
        writeJson(response, 409, { error: "approval_command_rule_stale", message: "Approval command rule proposal is unavailable or stale." });
        return;
      }
      if (proposedRuleFingerprint !== approval.proposedCommandRule?.fingerprint) {
        writeJson(response, 409, { error: "approval_command_rule_fingerprint_mismatch", message: "Approval command rule fingerprint does not match the pending proposal." });
        return;
      }
    }
    const normalizedDecisionKind = decisionKind;
    const decision: ResolveApprovalRequestInput = {
      reason: isRecord(body) ? readOptionalString(body, "reason") : undefined,
      resolvedBy: "local-user" as const,
      ...(route.action === "approve" ? { decisionKind: normalizedDecisionKind ?? "approve_once" } : {}),
      ...(proposedRuleFingerprint ? { proposedRuleFingerprint } : {}),
    };
    const now = new Date().toISOString();
    const updated =
      route.action === "approve"
        ? store.approveApprovalRequest(route.approvalId, decision, now)
        : store.denyApprovalRequest(route.approvalId, decision, now);
    if (!updated) {
      writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
      return;
    }
    let postCommit: ReturnType<typeof reconcileApprovalPostCommitEffects> = { deferred: true };
    try {
      postCommit = reconcileApprovalPostCommitEffects({
        store, approval: updated, cwd, now, controlPlaneEvents,
        onOwnerResolved: () => onApprovalResolved?.({ cwd, store, approval: updated, now }),
      });
    } catch {
      // The approval decision has already committed. A read/claim failure in
      // the reconciliation ledger must never turn it into a false HTTP 400.
    }
    let outstandingEffects: readonly { approvalId: string; effectKind: string; ownerKind?: string; ownerId?: string; status: string; revision: number }[] = [];
    try {
      if (typeof store.listApprovalPostCommitEffects === "function") {
        outstandingEffects = store.listApprovalPostCommitEffects({ approvalId: updated.id })
          .filter((effect) => effect.status !== "completed")
          .map((effect) => ({
            approvalId: effect.approvalId,
            effectKind: effect.effectKind,
            ownerKind: effect.ownerKind,
            ownerId: effect.ownerId,
            status: effect.status,
            revision: effect.revision,
          }));
      }
    } catch { /* The durable ledger remains available to startup recovery. */ }
    writeJson(response, 200, {
      approval: updated,
      ...(postCommit.mediaJob ? { mediaJob: postCommit.mediaJob } : {}),
      ...(postCommit.deferred ? { postCommit: {
        status: "deferred", code: "approval_postcommit_reconciliation_required",
        ...(outstandingEffects.length ? { effects: outstandingEffects } : {}),
      } } : {}),
    });
  } catch (error) {
    if (error instanceof ApprovalDecisionUnavailableError) {
      writeJson(response, 409, { error: error.code, message: error.message });
      return;
    }
    const commandRuleConflict = error instanceof Error && error.message.includes("command rule");
    const staleExecution = error instanceof Error && error.message.includes("Approval execution no longer active");
    writeJson(response, commandRuleConflict || staleExecution ? 409 : 400, {
      error: error instanceof Error && error.message.includes("not pending")
        ? "approval_not_pending"
        : staleExecution ? "approval_execution_stale"
          : commandRuleConflict ? "approval_command_rule_conflict" : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleApprovalCommandRulesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval command rules` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const store = storeRegistry.getStore(cwd);
  writeJson(response, 200, { cwd, rules: store.listApprovalCommandRules() });
}

export function handleApprovalCommandRuleItem(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  ruleId: string,
): void {
  if (request.method !== "DELETE") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval command rules` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const rule = storeRegistry.getStore(cwd).revokeApprovalCommandRule(ruleId, new Date().toISOString());
  if (!rule) {
    writeJson(response, 404, { error: "approval_command_rule_not_found", message: `Active approval command rule not found: ${ruleId}` });
    return;
  }
  writeJson(response, 200, { rule });
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
