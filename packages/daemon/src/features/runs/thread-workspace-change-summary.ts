import type { LingThread, RunSession, RunStore } from "@ling-stack/core";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { writeJson } from "../../shared/response.js";
import { isPrivateWorkflowTurn, isWorkflowRunSession } from "./public-execution-snapshots.js";
import { buildWorkspaceChangeReview } from "./workspace-change-review.js";

export function handleGetThreadWorkspaceChangeSummary(
  request: IncomingMessage, response: ServerResponse, url: URL, registry: RunStoreRegistry, threadId: string,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed" }); return;
  }
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) { writeJson(response, 400, { error: "bad_request", message: "cwd is required" }); return; }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: registry, cwd })) return;
  const store = registry.getInitializedStore(cwd);
  if (!store) { writeJson(response, 404, { error: "workspace_not_loaded", message: "Open this project before reading its change summary." }); return; }
  const thread = store.getLingThread(threadId);
  if (!thread) { writeJson(response, 404, { error: "thread_not_found" }); return; }
  writeJson(response, 200, buildThreadWorkspaceChangeSummary(store, cwd, thread));
}

export function buildThreadWorkspaceChangeSummary(
  store: RunStore,
  cwd: string,
  thread: LingThread,
): ThreadWorkspaceChangeSummaryResponse {
  return store.readSnapshot(() => {
    const base = { cwd, threadId: thread.id };
    const turn = store.listLingTurns({ threadId: thread.id, orderBy: "createdAt", limit: 1 })[0];
    if (!turn || isPrivateWorkflowTurn(turn, thread)) return base;
    const links = store.listLingTurnRuns(turn.id);
    const runs = links.map((link) => store.getRun(link.runId))
      .filter((run): run is RunSession => Boolean(run));
    if (runs.some((run) => isWorkflowRunSession(run, store))) return base;
    const latest = { ...base, turn: { id: turn.id, status: turn.status } };
    if (runs.length === links.length && !runs.some((run) => store.listWorkspaceMutationRecords({ runId: run.id, limit: 1 }).length)) return latest;
    const review = buildWorkspaceChangeReview(store, {
      scope: { kind: "turn", id: turn.id }, runs, workspaceId: turn.workspaceId,
      threadId: thread.id, turnId: turn.id,
    });
    return {
      ...latest,
      review: {
        ...review,
        ...(runs.length !== links.length ? {
          state: review.files.length ? "partial" as const : "unavailable" as const,
          additions: undefined, deletions: undefined, unavailableReason: "A linked Run is missing from this Turn's recorded changes.",
        } : {}),
        files: review.files.map(({ diff: _diff, ...file }) => file),
      },
    };
  });
}
