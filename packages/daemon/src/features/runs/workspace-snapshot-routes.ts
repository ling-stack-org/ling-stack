import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { captureWorkspaceSnapshot, createWorkspaceSnapshotRestoreAnchor, createWorkspaceSnapshotUserRestoreAnchor, garbageCollectWorkspaceSnapshots, isWorkspaceSnapshotRestoreActive, previewWorkspaceSnapshot, queueWorkspaceSnapshotRestore, reconcileWorkspaceSnapshotRestore, WorkspaceSnapshotRestoreError } from "./workspace-snapshot-restore.js";

export function parseWorkspaceSnapshotRoute(pathname: string):
  | { readonly kind: "collection" }
  | { readonly kind: "capture" }
  | { readonly kind: "detail"; readonly snapshotId: string }
  | { readonly kind: "anchor"; readonly snapshotId?: string }
  | { readonly kind: "confirmation"; readonly snapshotId?: string; readonly confirmationId?: string }
  | { readonly kind: "confirmation-resolve"; readonly confirmationId: string }
  | { readonly kind: "restore"; readonly snapshotId?: string }
  | { readonly kind: "restore-detail"; readonly restoreRequestId: string }
  | undefined {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 2 && parts[0] === "workspace" && parts[1] === "snapshots") return { kind: "collection" };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[2] === "capture") return { kind: "capture" };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[2] === "anchors") return { kind: "anchor" };
  if (parts.length === 4 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[3] === "anchors") return { kind: "anchor", snapshotId: parts[2] };
  if (parts.length === 4 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[3] === "confirmations") return { kind: "confirmation", snapshotId: parts[2] };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshot-confirmations") return { kind: "confirmation", confirmationId: parts[2] };
  if (parts.length === 4 && parts[0] === "workspace" && parts[1] === "snapshot-confirmations" && parts[3] === "confirm") return { kind: "confirmation-resolve", confirmationId: parts[2] };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[2] === "restore") return { kind: "restore" };
  if (parts.length === 4 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[3] === "restore") return { kind: "restore", snapshotId: parts[2] };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshot-restores") return { kind: "restore-detail", restoreRequestId: parts[2] };
  if (parts.length === 3 && parts[0] === "workspace" && parts[1] === "snapshots") return { kind: "detail", snapshotId: parts[2] };
  if (parts.length === 4 && parts[0] === "workspace" && parts[1] === "snapshots" && parts[2] === "restore") return { kind: "restore-detail", restoreRequestId: parts[3] };
  return undefined;
}

export async function handleWorkspaceSnapshotRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: NonNullable<ReturnType<typeof parseWorkspaceSnapshotRoute>>,
  config?: ResolvedDaemonConfig,
): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) { writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required." }); return; }
  const store = storeRegistry.getStore(cwd);
  try {
    if (route.kind === "collection" && request.method === "GET") {
      writeJson(response, 200, { cwd: store.paths.cwd, snapshots: store.listWorkspaceSnapshotManifests({ workspaceId: DEFAULT_WORKSPACE_ID }), restoreUiEnabled: config?.workspaceSnapshots.restoreUiEnabled === true && config.workspaceSnapshots.captureEnabled === true && config.workspaceSnapshots.restoreEnabled === true });
      return;
    }
    if (route.kind === "collection" && request.method === "POST") {
      if (config && !config.workspaceSnapshots.captureEnabled) { writeJson(response, 404, { error: "snapshot_capture_disabled", message: "Workspace snapshot capture is disabled by feature flag." }); return; }
      const body = await optionalBody(request);
      if (config?.workspaceSnapshots.gcEnabled) await garbageCollectWorkspaceSnapshots(store, config.workspaceSnapshots);
      const result = await captureWorkspaceSnapshot(store, cwd, { workspaceId: DEFAULT_WORKSPACE_ID, ttlMs: readPositiveInt(body?.ttlMs), maxEntries: config?.workspaceSnapshots.maxEntries, maxBytes: config?.workspaceSnapshots.maxBytes, maxFileBytes: config?.workspaceSnapshots.maxFileBytes, maxSnapshots: config?.workspaceSnapshots.maxSnapshots, captureKind: body?.captureKind === "compaction_boundary" ? "compaction_boundary" : "user_restore_point", sourceTurnId: typeof body?.sourceTurnId === "string" ? body.sourceTurnId : undefined, sourceRunId: typeof body?.sourceRunId === "string" ? body.sourceRunId : undefined, sourceCheckpointId: typeof body?.sourceCheckpointId === "string" ? body.sourceCheckpointId : undefined });
      writeJson(response, 201, result);
      return;
    }
    if (route.kind === "detail" && request.method === "GET") {
      const manifest = store.getWorkspaceSnapshotManifest(route.snapshotId);
      if (!manifest) { writeJson(response, 404, { error: "snapshot_not_found" }); return; }
      writeJson(response, 200, await previewWorkspaceSnapshot(store, cwd, route.snapshotId));
      return;
    }
    if (route.kind === "capture" && request.method === "POST") {
      if (config && !config.workspaceSnapshots.captureEnabled) { writeJson(response, 404, { error: "snapshot_capture_disabled", message: "Workspace snapshot capture is disabled by feature flag." }); return; }
      const body = await optionalBody(request);
      if (config?.workspaceSnapshots.gcEnabled) await garbageCollectWorkspaceSnapshots(store, config.workspaceSnapshots);
      const result = await captureWorkspaceSnapshot(store, cwd, { workspaceId: DEFAULT_WORKSPACE_ID, ttlMs: readPositiveInt(body?.ttlMs), maxEntries: config?.workspaceSnapshots.maxEntries, maxBytes: config?.workspaceSnapshots.maxBytes, maxFileBytes: config?.workspaceSnapshots.maxFileBytes, maxSnapshots: config?.workspaceSnapshots.maxSnapshots, captureKind: body?.captureKind === "compaction_boundary" ? "compaction_boundary" : "user_restore_point", sourceTurnId: typeof body?.sourceTurnId === "string" ? body.sourceTurnId : undefined, sourceRunId: typeof body?.sourceRunId === "string" ? body.sourceRunId : undefined, sourceCheckpointId: typeof body?.sourceCheckpointId === "string" ? body.sourceCheckpointId : undefined });
      writeJson(response, 201, result);
      return;
    }
    if (route.kind === "anchor" && request.method === "POST") {
      if (config && !config.workspaceSnapshots.restoreEnabled) { writeJson(response, 404, { error: "snapshot_restore_disabled", message: "Workspace snapshot restore is disabled by feature flag." }); return; }
      if (route.snapshotId) {
        const anchor = await createWorkspaceSnapshotUserRestoreAnchor(store, cwd, route.snapshotId);
        writeJson(response, 201, anchor);
        return;
      }
      const body = await readBody(request);
      const anchor = await createWorkspaceSnapshotRestoreAnchor(store, body as unknown as Parameters<RunStore["createWorkspaceSnapshotRestoreAnchor"]>[0]);
      writeJson(response, 201, anchor);
      return;
    }
    if (route.kind === "confirmation" && route.snapshotId && request.method === "POST") {
      if (config && !config.workspaceSnapshots.restoreEnabled) { writeJson(response, 404, { error: "snapshot_restore_disabled", message: "Workspace snapshot restore is disabled by feature flag." }); return; }
      const body = await readBody(request);
      const confirmation = store.createSnapshotRestoreConfirmation({ ...(body as unknown as Parameters<RunStore["createSnapshotRestoreConfirmation"]>[0]), snapshotId: route.snapshotId, workspaceId: DEFAULT_WORKSPACE_ID, createdAt: new Date().toISOString() });
      writeJson(response, 201, confirmation);
      return;
    }
    if (route.kind === "confirmation" && route.confirmationId && request.method === "GET") {
      const confirmation = store.getSnapshotRestoreConfirmation(route.confirmationId);
      if (!confirmation) { writeJson(response, 404, { error: "confirmation_not_found" }); return; }
      writeJson(response, 200, confirmation);
      return;
    }
    if (route.kind === "confirmation-resolve" && request.method === "POST") {
      if (config && !config.workspaceSnapshots.restoreEnabled) { writeJson(response, 404, { error: "snapshot_restore_disabled", message: "Workspace snapshot restore is disabled by feature flag." }); return; }
      const body = await readBody(request);
      const state = body.state === "confirmed" || body.state === "denied" || body.state === "expired" ? body.state : undefined;
      if (!state) { writeJson(response, 422, { error: "confirmation_state_invalid" }); return; }
      const confirmation = store.resolveSnapshotRestoreConfirmation(route.confirmationId, state, new Date().toISOString());
      if (!confirmation) { writeJson(response, 404, { error: "confirmation_not_found" }); return; }
      writeJson(response, 200, confirmation);
      return;
    }
    if (route.kind === "restore" && request.method === "POST") {
      if (config && !config.workspaceSnapshots.restoreEnabled) { writeJson(response, 404, { error: "snapshot_restore_disabled", message: "Workspace snapshot restore is disabled by feature flag." }); return; }
      const body = await readBody(request);
      if (typeof body.confirmationId !== "string" || !body.confirmationId.trim()) { writeJson(response, 409, { error: "confirmation_required", message: "A durable local-user restore confirmation is required." }); return; }
      const restore = await queueWorkspaceSnapshotRestore(store, cwd, { ...(body as unknown as Parameters<typeof queueWorkspaceSnapshotRestore>[2]), ...(route.snapshotId ? { snapshotId: route.snapshotId } : {}) });
      writeJson(response, restore.state === "committed" ? 200 : 202, restore);
      return;
    }
    if (route.kind === "restore-detail" && request.method === "GET") {
      const restore = store.getSnapshotRestoreRequest(route.restoreRequestId);
      if (!restore) { writeJson(response, 404, { error: "restore_not_found" }); return; }
      const reconciled = ["requested", "validating", "fenced", "staged", "committing", "verifying"].includes(restore.state) && !(await isWorkspaceSnapshotRestoreActive(cwd))
        ? await reconcileWorkspaceSnapshotRestore(store, cwd, restore.id)
        : restore;
      writeJson(response, 200, reconciled);
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    const status = error instanceof WorkspaceSnapshotRestoreError ? error.statusCode : 400;
    writeJson(response, status, { error: error instanceof WorkspaceSnapshotRestoreError ? error.code : "snapshot_request_invalid", message: error instanceof Error ? error.message : String(error) });
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request, 256_000);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkspaceSnapshotRestoreError(400, "invalid_json_body", "Snapshot request body must be a JSON object.");
  return body as Record<string, unknown>;
}
async function optionalBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try { return await readBody(request); } catch (error) { if (error instanceof Error && /required|valid JSON/iu.test(error.message)) return undefined; throw error; }
}
function readPositiveInt(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined; }
