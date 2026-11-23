import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import type { WorkspaceChangeReviewPreviewRequest } from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { isAllowedLocalOrigin } from "../../shared/local-workspace-access.js";
import { writeJson } from "../../shared/response.js";
import { buildRunWorkspaceChangesResponse, buildTurnWorkspaceChangesResponse } from "../runs/workspace-change-recovery.js";
import { buildWorkflowWorkspaceChangesResponse } from "../channels/workflow-workspace-change-recovery.js";
import { resolveWorkspaceFileTarget } from "./workspace-file-preview.js";
import { buildWorkspaceFilePreview } from "./content-preview.js";

export async function handleWorkspaceReviewPreview(request: IncomingMessage, response: ServerResponse, maxBodyBytes: number, stores: RunStoreRegistry): Promise<void> {
  try {
    const input = await readJsonBody(request, maxBodyBytes) as Partial<WorkspaceChangeReviewPreviewRequest>;
    const { cwd, scope, revision, fileId } = input;
    if (!isAllowedLocalOrigin(request.headers.origin) || typeof cwd !== "string" || !stores.isTrustedWorkspaceRoot(cwd)) {
      writeJson(response, 403, { error: "workspace_not_trusted", message: "Workspace is not trusted." }); return;
    }
    if (!scope || !["run", "turn", "workflow"].includes(scope.kind) || typeof scope.id !== "string" || typeof revision !== "string" || typeof fileId !== "string") {
      writeJson(response, 400, { error: "bad_request", message: "Review scope, revision and file ID are required." }); return;
    }
    const store = scope.kind === "run" ? stores.findStoreForRun(scope.id, cwd) : scope.kind === "turn" ? stores.findStoreForTurn(scope.id, cwd) : stores.findStoreForWorkflow(scope.id, cwd);
    const run = scope.kind === "run" ? store?.getRun(scope.id) : undefined;
    const turn = scope.kind === "turn" ? store?.getLingTurn(scope.id) : undefined;
    const workflow = scope.kind === "workflow" ? store?.getChannelWorkflow(scope.id) : undefined;
    const result = store && run ? await buildRunWorkspaceChangesResponse(store, run)
      : store && turn ? await buildTurnWorkspaceChangesResponse(store, turn)
        : store && workflow ? await buildWorkflowWorkspaceChangesResponse(store, workflow) : undefined;
    const review = result?.review;
    if (!store || !result || !review || review.revision !== revision || review.scope.kind !== scope.kind || review.scope.id !== scope.id || review.runIds.length === 0) {
      writeJson(response, 409, { error: "review_unavailable", message: "Review is unavailable or has changed." }); return;
    }
    const root = realpathSync(result.cwd);
    const requestRoot = realpathSync(cwd);
    if ((requestRoot !== root && requestRoot !== realpathSync(store.paths.cwd)) || review.runIds.some(id => { const item = store.getRun(id); return !item || realpathSync(item.cwd) !== root; })) {
      writeJson(response, 403, { error: "workspace_mismatch", message: "Review workspace cannot be verified." }); return;
    }
    const matches = review.files.filter(file => file.id === fileId && file.state === "exact");
    if (matches.length !== 1 || review.files.filter(file => file.path === matches[0]?.path).length !== 1) {
      writeJson(response, 404, { error: "review_file_unavailable", message: "Review file is unavailable." }); return;
    }
    const target = resolveWorkspaceFileTarget(root, matches[0]!.path);
    writeJson(response, 200, await buildWorkspaceFilePreview({ contentPath: target.contentPath, displayPath: target.displayPath, maxBytes: 64 * 1024 }));
  } catch {
    writeJson(response, 404, { error: "review_file_unavailable", message: "Current file is unavailable." });
  }
}
