import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import type {
  WorkspaceFileCapabilityPreviewRequest,
  WorkspaceFileCapabilityRequest,
} from "@ling-stack/contracts";
import { readJsonBody } from "../../shared/request.js";
import { isAllowedLocalOrigin } from "../../shared/local-workspace-access.js";
import { writeJson } from "../../shared/response.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import {
  WorkspaceFileCapabilityError,
  WorkspaceFileCapabilityRegistry,
} from "./workspace-file-capabilities.js";
import { buildArtifactPreview, buildWorkspaceFilePreview } from "./content-preview.js";
import { buildWorkspaceChangeReview } from "../runs/workspace-change-review.js";

export async function handlePostWorkspaceFileCapabilityIssue(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  stores: RunStoreRegistry,
  capabilities: WorkspaceFileCapabilityRegistry,
): Promise<void> {
  try {
    const input = await readJsonBody(request, maxBodyBytes) as Partial<WorkspaceFileCapabilityRequest>;
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!allowCapabilityRequest(request, response, stores, cwd)) return;
    const capability = capabilities.issue(input as WorkspaceFileCapabilityRequest, stores);
    writeJson(response, 200, { cwd, capability });
  } catch (error) {
    writeCapabilityError(response, error, "workspace_file_capability_issue_failed");
  }
}

export async function handlePostWorkspaceFileCapabilityPreview(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  stores: RunStoreRegistry,
  capabilities: WorkspaceFileCapabilityRegistry,
): Promise<void> {
  try {
    const input = await readJsonBody(request, maxBodyBytes) as Partial<WorkspaceFileCapabilityPreviewRequest>;
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!allowCapabilityRequest(request, response, stores, cwd)) return;
    if (typeof input.capabilityId !== "string" || !input.scope) throw new WorkspaceFileCapabilityError(400, "bad_request", "capabilityId and scope are required.");
    const grant = capabilities.redeem(input.capabilityId, input.scope, stores, { capabilityTarget: undefined });
    const maxBytes = input.maxBytes;
    const line = input.line;
    const preview = grant.resource.kind === "artifact"
      ? buildArtifactPreview({
        artifact: stores.getStore(grant.cwd).getArtifact(grant.resource.artifactId!)!,
        contentPath: grant.resource.contentPath,
        maxBytes,
      })
      : await buildWorkspaceFilePreview({
        contentPath: grant.resource.contentPath,
        displayPath: grant.resource.displayPath,
        maxBytes,
        focusLine: line,
      });
    writeJson(response, 200, preview);
  } catch (error) {
    writeCapabilityError(response, error, "workspace_file_capability_preview_failed");
  }
}

/** Redeem the existing grant and return only its file, never the enclosing run's other paths. */
export async function handlePostWorkspaceFileCapabilityChanges(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  stores: RunStoreRegistry,
  capabilities: WorkspaceFileCapabilityRegistry,
): Promise<void> {
  try {
    const input = await readJsonBody(request, maxBodyBytes) as Partial<WorkspaceFileCapabilityPreviewRequest>;
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!allowCapabilityRequest(request, response, stores, cwd)) return;
    if (typeof input.capabilityId !== "string" || !input.scope) throw new WorkspaceFileCapabilityError(400, "bad_request", "capabilityId and scope are required.");
    const grant = capabilities.redeem(input.capabilityId, input.scope, stores, { capabilityTarget: "open_file" });
    if (grant.cwd !== realpathSync(cwd) || grant.resource.kind !== "file") throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Capability workspace does not match the request.");
    const store = stores.getStore(grant.cwd);
    const run = store.getRun(grant.scope.runId);
    if (!run || realpathSync(run.cwd) !== grant.cwd) throw new WorkspaceFileCapabilityError(403, "missing_lineage", "Run was not found in the capability workspace.");
    const review = buildWorkspaceChangeReview(store, { scope: { kind: "run", id: run.id }, runs: [run], threadId: grant.scope.threadId, workspaceId: grant.scope.workspaceId });
    const path = grant.resource.displayPath.replace(/\\/gu, "/");
    const file = review.files.find(item => item.path === path);
    if (file?.state === "exact") { writeJson(response, 200, { state: "exact", revision: review.revision, file }); return; }
    if (!file && review.state === "exact" && review.coveredPaths.includes(path)) { writeJson(response, 200, { state: "exact", revision: review.revision }); return; }
    writeJson(response, 200, { state: "unavailable", revision: review.revision, unavailableReason: file?.unavailableReason ?? review.unavailableReason });
  } catch (error) {
    writeCapabilityError(response, error, "workspace_file_capability_changes_failed");
  }
}

function allowCapabilityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  stores: RunStoreRegistry,
  cwd: string,
): boolean {
  if (!isAllowedLocalOrigin(request.headers.origin)) {
    writeJson(response, 403, { error: "forbidden_origin", message: "Workspace file capabilities are only available from local Ling Stack pages." });
    return false;
  }
  if (!cwd || !stores.isTrustedWorkspaceRoot(cwd)) {
    writeJson(response, 403, { error: "workspace_not_trusted", message: "Workspace file capabilities are limited to daemon-known workspaces." });
    return false;
  }
  return true;
}

function writeCapabilityError(response: ServerResponse, error: unknown, fallbackCode: string): void {
  const capabilityError = error instanceof WorkspaceFileCapabilityError ? error : undefined;
  writeJson(response, capabilityError?.statusCode ?? 400, {
    error: capabilityError?.code ?? fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  });
}
