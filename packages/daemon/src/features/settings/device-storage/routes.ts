import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWorkspaceRegistryStore, resolveUserConfigPaths, type WorkspaceRegistryEntry } from "@ling-stack/core";
import type { DeviceStorageScanJob, DeviceStorageScope, DeviceStorageSnapshot } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../../config.js";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { allowLocalServiceRequest, allowLocalWorkspaceRequest } from "../../../shared/local-workspace-access.js";
import { readJsonBody } from "../../../shared/request.js";
import { writeJson } from "../../../shared/response.js";
import { listManagedWorktrees } from "../../workspaces/worktree-management.js";
import { scanOwnedStorage } from "./scanner.js";

interface ScanEntry { readonly cwd: string; readonly controller: AbortController; job: DeviceStorageScanJob; running: boolean }
const jobs = new Map<string, ScanEntry>();
const scanBudgetMs = 30_000;

export async function handleDeviceStorageScans(request: IncomingMessage, response: ServerResponse, url: URL,
  config: ResolvedDaemonConfig, stores: RunStoreRegistry): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) { writeJson(response, 400, { error: "bad_request" }); return; }
  if (!allowLocalServiceRequest(request, response)) return;
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: stores, cwd })) return;
  if (url.pathname === "/device-storage/scans" && request.method === "POST") {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const scope = (body as { scope?: unknown } | null)?.scope;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || (scope !== "all" && scope !== "current")) {
      writeJson(response, 400, { error: "bad_request" }); return;
    }
    for (const entry of jobs.values()) if (entry.cwd === cwd && entry.job.status === "scanning") entry.controller.abort();
    if ([...jobs.values()].filter(entry => entry.running).length >= 2) { writeJson(response, 429, { error: "scan_busy" }); return; }
    const id = randomUUID(), controller = new AbortController();
    const entry: ScanEntry = { cwd, controller, job: { id, status: "scanning" }, running: true };
    jobs.set(id, entry);
    void scanForWorkspace(stores, cwd, scope, controller.signal).then(snapshot => {
      entry.job = { id, status: controller.signal.aborted ? "cancelled" : snapshot.complete ? "complete" : "partial", snapshot };
    }).catch(() => { entry.job = { id, status: controller.signal.aborted ? "cancelled" : "partial" }; })
      .finally(() => { entry.running = false; });
    if (jobs.size > 20) for (const [key, old] of jobs) { if (!old.running) { jobs.delete(key); if (jobs.size <= 20) break; } }
    writeJson(response, 202, entry.job); return;
  }
  const match = /^\/device-storage\/scans\/([0-9a-f-]{36})$/u.exec(url.pathname);
  const entry = match ? jobs.get(match[1]!) : undefined;
  if (!entry || entry.cwd !== cwd) { writeJson(response, 404, { error: "scan_not_found" }); return; }
  if (request.method === "GET") { writeJson(response, 200, entry.job); return; }
  if (request.method === "DELETE") { entry.controller.abort(); entry.job = { ...entry.job, status: "cancelled" }; writeJson(response, 200, entry.job); return; }
  writeJson(response, 405, { error: "method_not_allowed" });
}

async function scanForWorkspace(stores: RunStoreRegistry, cwd: string, scope: DeviceStorageScope, signal: AbortSignal): Promise<DeviceStorageSnapshot> {
  const deadline = Date.now() + scanBudgetMs;
  const registry = createWorkspaceRegistryStore();
  const selected: WorkspaceRegistryEntry[] = [];
  let workspaceInventoryIncomplete = false;
  let worktreeInventoryIncomplete = false;
  try {
    const current = registry.getWorkspaceByCanonicalCwd(cwd);
    if (!current) throw new Error("workspace_not_registered");
    if (scope === "current") selected.push(current);
    else {
      let cursor = "";
      while (!signal.aborted && Date.now() < deadline) {
        const page = registry.listWorkspaces(cursor, 500);
        selected.push(...page);
        if (page.length < 500) break;
        if (selected.length >= 5_000) { workspaceInventoryIncomplete = true; break; }
        cursor = page.at(-1)!.workspaceId;
      }
      if (!selected.some(item => item.workspaceId === current.workspaceId)) selected.push(current);
    }
  } finally { registry.close(); }
  const workspaceRoots = selected.map(item => item.stateRoot);
  const worktreeRoots: string[] = [];
  for (const workspace of selected) {
    if (signal.aborted || Date.now() >= deadline) break;
    try {
      const [workspaceInfo, stateInfo] = await Promise.all([lstat(workspace.canonicalCwd), lstat(workspace.stateRoot)]);
      if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory() || stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
        worktreeInventoryIncomplete = true; continue;
      }
      await Promise.all([realpath(workspace.canonicalCwd), realpath(workspace.stateRoot)]);
      if (signal.aborted || Date.now() >= deadline) break;
      const store = stores.getInitializedStore(workspace.canonicalCwd);
      if (!store) { worktreeInventoryIncomplete = true; continue; }
      const inventory = await listManagedWorktrees(store, workspace.canonicalCwd);
      worktreeInventoryIncomplete ||= inventory.limitReached;
      for (const item of inventory.entries) {
        if (item.status === "blocked") worktreeInventoryIncomplete = true;
        if (item.status === "ready" || item.status === "missing") worktreeRoots.push(item.path);
      }
      worktreeRoots.push(...(inventory.snapshots ?? []).filter(item => item.state !== "restored").map(item => item.snapshotPath));
    } catch { worktreeInventoryIncomplete = true; }
  }
  return scanOwnedStorage({ scope, userRoot: scope === "all" ? resolveUserConfigPaths().rootDir : undefined,
    workspaceRoots, worktreeRoots, workspaceInventoryIncomplete, worktreeInventoryIncomplete },
  { signal, deadlineMs: Math.max(0, deadline - Date.now()) });
}
