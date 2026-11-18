import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { openLocalDirectory } from "../../shared/local-path-open.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { actOnManagedWorktree, listManagedWorktrees, prepareManagedWorktreeInitialization, completeManagedWorktreeInitialization, WorktreeActionError } from "./worktree-management.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";
import { worktreeCleanupStatus } from "./worktree-retention.js";

export async function handleManagedWorktrees(request: IncomingMessage, response: ServerResponse,
  url: URL, config: ResolvedDaemonConfig, stores: RunStoreRegistry, desktopBridgeToken?: string): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) { writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" }); return; }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: stores, cwd })) return;
  if (url.pathname.startsWith("/worktrees/initialization/")) {
    const auth = desktopBridgeTokenStatus(request, desktopBridgeToken);
    if (auth !== "accepted") { writeJson(response, auth === "unavailable" ? 503 : 403, { error: auth === "unavailable" ? "desktop_bridge_unavailable" : "desktop_bridge_forbidden", message: "Desktop bridge authentication is required." }); return; }
    if (request.headers.origin !== undefined) { writeJson(response, 403, { error: "desktop_bridge_forbidden", message: "Browser requests cannot authorize setup scripts." }); return; }
  }
  try {
    const store = stores.getStore(cwd);
    if (url.pathname.startsWith("/worktrees/initialization/") && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid initialization request");
      const record = body as Record<string, unknown>;
      if (url.pathname === "/worktrees/initialization/prepare") {
        if (Object.keys(record).some((key) => !["ownerKind", "ownerId"].includes(key)) || (record.ownerKind !== "channel" && record.ownerKind !== "teammate") || typeof record.ownerId !== "string" || !record.ownerId.trim()) throw new Error("Invalid initialization owner");
        writeJson(response, 200, await prepareManagedWorktreeInitialization(store, cwd, { ownerKind: record.ownerKind, ownerId: record.ownerId })); return;
      }
      if (url.pathname === "/worktrees/initialization/complete") {
        if (Object.keys(record).some((key) => !["challengeId", "confirmed"].includes(key)) || typeof record.challengeId !== "string" || typeof record.confirmed !== "boolean") throw new Error("Invalid initialization confirmation");
        await completeManagedWorktreeInitialization(store, cwd, record.challengeId, record.confirmed);
        if (!record.confirmed) { response.writeHead(204).end(); return; }
        writeJson(response, 200, { ...await listManagedWorktrees(store, cwd), cleanup: worktreeCleanupStatus(store) }); return;
      }
    }
    if (url.pathname === "/worktrees" && request.method === "GET") {
      writeJson(response, 200, { ...await listManagedWorktrees(store, cwd), cleanup: worktreeCleanupStatus(store) }); return;
    }
    if (url.pathname === "/worktrees/actions" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Worktree action must be an object");
      const record = body as Record<string, unknown>;
      if ((record.ownerKind !== "channel" && record.ownerKind !== "teammate") || typeof record.ownerId !== "string" || !record.ownerId.trim()
        || !["open", "cleanup", "restore", "initialize", "pin", "unpin"].includes(String(record.action))
        || record.confirmed !== undefined && typeof record.confirmed !== "boolean"
        || record.snapshotId !== undefined && typeof record.snapshotId !== "string") throw new Error("Invalid worktree action");
      const path = await actOnManagedWorktree(store, cwd, { ownerKind: record.ownerKind, ownerId: record.ownerId,
        action: record.action as import("@ling-stack/contracts").ManagedWorktreeActionRequest["action"],
        confirmed: record.confirmed as boolean | undefined, snapshotId: record.snapshotId as string | undefined });
      if (record.action === "open") await openLocalDirectory(path);
      writeJson(response, 200, { ...await listManagedWorktrees(store, cwd), cleanup: worktreeCleanupStatus(store) }); return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: "Unsupported worktree request" });
  } catch (error) {
    writeJson(response, error instanceof WorktreeActionError ? 409 : 400, {
      error: error instanceof WorktreeActionError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
