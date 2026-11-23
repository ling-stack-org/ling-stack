import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWorkspaceRegistryStore, resolveUserConfigPaths, type WorkspaceRegistryEntry } from "@ling-stack/core";
import type { DeviceStorageScanJob, DeviceStorageScope, DeviceStorageSnapshot } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../../config.js";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../../shared/local-workspace-access.js";
import { readJsonBody } from "../../../shared/request.js";
import { writeJson } from "../../../shared/response.js";
import { listManagedWorktrees } from "../../workspaces/worktree-management.js";
import { scanOwnedStorage } from "./scanner.js";

interface ScanEntry { readonly cwd: string; readonly controller: AbortController; job: DeviceStorageScanJob }
const jobs = new Map<string, ScanEntry>();

export async function handleDeviceStorageScans(request: IncomingMessage, response: ServerResponse, url: URL,
  config: ResolvedDaemonConfig, stores: RunStoreRegistry): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) { writeJson(response, 400, { error: "bad_request" }); return; }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: stores, cwd })) return;
  if (url.pathname === "/device-storage/scans" && request.method === "POST") {
    const body = await readJsonBody(request, config.maxBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => key !== "scope") || !["all", "current"].includes(String((body as { scope?: unknown }).scope))) {
      writeJson(response, 400, { error: "bad_request" }); return;
    }
    const scope = (body as { scope: DeviceStorageScope }).scope;
    for (const entry of jobs.values()) if (entry.cwd === cwd && entry.job.status === "scanning") entry.controller.abort();
    if ([...jobs.values()].filter(entry => entry.job.status === "scanning").length >= 2) { writeJson(response, 429, { error: "scan_busy" }); return; }
    const id = randomUUID(), controller = new AbortController();
    const entry: ScanEntry = { cwd, controller, job: { id, status: "scanning" } };
    jobs.set(id, entry);
    void scanForWorkspace(stores, cwd, scope, controller.signal).then(snapshot => {
      entry.job = { id, status: controller.signal.aborted ? "cancelled" : snapshot.complete ? "complete" : "partial", snapshot };
    }).catch(() => { entry.job = { id, status: "partial" }; });
    if (jobs.size > 20) for (const [key, old] of jobs) { if (old.job.status !== "scanning") { jobs.delete(key); if (jobs.size <= 20) break; } }
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
  const registry = createWorkspaceRegistryStore();
  const registered: WorkspaceRegistryEntry[] = [];
  try {
    let cursor = "";
    for (;;) {
      const page = registry.listWorkspaces(cursor, 500);
      registered.push(...page);
      if (page.length < 500 || registered.length >= 5_000) break;
      cursor = page.at(-1)!.workspaceId;
    }
  } finally { registry.close(); }
  const selected = scope === "all" ? registered : registered.filter(item => item.canonicalCwd === cwd);
  if (!selected.some(item => item.canonicalCwd === cwd)) throw new Error("workspace_not_registered");
  const workspaceRoots = selected.map(item => item.stateRoot);
  const worktreeRoots: string[] = [];
  let worktreeInventoryIncomplete = registered.length >= 5_000;
  for (const workspace of selected) {
    if (signal.aborted) break;
    if (!existsSync(workspace.stateRoot) || !existsSync(workspace.canonicalCwd)) { worktreeInventoryIncomplete = true; continue; }
    try {
      const inventory = await listManagedWorktrees(stores.getStore(workspace.canonicalCwd), workspace.canonicalCwd);
      worktreeRoots.push(...inventory.entries.filter(item => item.status === "ready" || item.status === "missing").map(item => item.path));
      worktreeRoots.push(...(inventory.snapshots ?? []).filter(item => item.state !== "restored").map(item => item.snapshotPath));
    } catch { worktreeInventoryIncomplete = true; }
  }
  return scanOwnedStorage({ scope, userRoot: scope === "all" ? resolveUserConfigPaths().rootDir : undefined,
    workspaceRoots, worktreeRoots, worktreeInventoryIncomplete }, { signal });
}
