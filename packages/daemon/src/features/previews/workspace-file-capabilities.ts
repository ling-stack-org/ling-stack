import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type {
  ExecutionAction,
  RunArtifact,
  RunStore,
} from "@ling-stack/core";
import type {
  WorkspaceFileCapability,
  WorkspaceFileCapabilityRequest,
  WorkspaceFileCapabilityScope,
  WorkspaceFileCapabilityTarget,
} from "@ling-stack/contracts";
import { listExecutionActions } from "../runs/execution-actions.js";
import { resolveArtifactContentPath } from "../runs/artifacts.js";
import {
  resolveWorkspaceFileTarget,
  WorkspaceFileTargetError,
} from "./workspace-file-preview.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;

export class WorkspaceFileCapabilityError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WorkspaceFileCapabilityError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface WorkspaceFileCapabilityResource {
  readonly kind: "file" | "artifact";
  readonly contentPath: string;
  readonly displayPath: string;
  readonly artifactId?: string;
}

export interface WorkspaceFileCapabilityGrant extends WorkspaceFileCapability {
  readonly cwd: string;
  readonly resource: WorkspaceFileCapabilityResource;
}

/**
 * Process-local Host grants. Grants are intentionally not persisted: creating a
 * new daemon instance creates a new epoch and invalidates every old capability.
 */
export class WorkspaceFileCapabilityRegistry {
  readonly daemonEpoch = randomUUID();
  private readonly grants = new Map<string, WorkspaceFileCapabilityGrant>();

  issue(input: WorkspaceFileCapabilityRequest, stores: RunStoreRegistry, now = new Date()): WorkspaceFileCapability {
    this.prune(now);
    const normalized = normalizeIssueInput(input);
    const store = stores.getStore(normalized.cwd);
    const resource = resolveAuthorizedResource(store, normalized);
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + clampTtl(input.ttlMs)).toISOString();
    const capability: WorkspaceFileCapabilityGrant = {
      capabilityId: `wscap_${randomUUID()}`,
      capabilityTarget: normalized.capabilityTarget,
      refId: normalized.refId,
      displayPath: resource.displayPath,
      scope: normalized.scope,
      issuedAt,
      expiresAt,
      daemonEpoch: this.daemonEpoch,
      cwd: normalized.cwd,
      resource,
    };
    this.grants.set(capability.capabilityId, capability);
    return publicCapability(capability);
  }

  redeem(
    capabilityId: string,
    scope: WorkspaceFileCapabilityScope,
    stores: RunStoreRegistry,
    options: { readonly capabilityTarget?: WorkspaceFileCapabilityTarget; readonly now?: Date } = {},
  ): WorkspaceFileCapabilityGrant {
    const now = options.now ?? new Date();
    this.prune(now);
    const grant = this.grants.get(capabilityId);
    if (!grant) {
      throw new WorkspaceFileCapabilityError(403, "workspace_file_capability_invalid", "Workspace file capability is invalid or expired.");
    }
    if (grant.daemonEpoch !== this.daemonEpoch || Date.parse(grant.expiresAt) <= now.getTime()) {
      this.grants.delete(capabilityId);
      throw new WorkspaceFileCapabilityError(403, "workspace_file_capability_expired", "Workspace file capability is invalid or expired.");
    }
    if (options.capabilityTarget && grant.capabilityTarget !== options.capabilityTarget) {
      throw new WorkspaceFileCapabilityError(403, "workspace_file_capability_target_mismatch", "Workspace file capability target does not match the requested operation.");
    }
    assertScopeEqual(grant.scope, scope);
    // Re-run the durable lineage, permission and realpath checks on every use.
    const store = stores.getStore(grant.cwd);
    const current = resolveAuthorizedResource(store, {
      cwd: grant.cwd,
      capabilityTarget: grant.capabilityTarget,
      refId: grant.refId,
      scope: grant.scope,
    });
    if (current.contentPath !== grant.resource.contentPath || current.displayPath !== grant.resource.displayPath) {
      throw new WorkspaceFileCapabilityError(403, "workspace_file_capability_stale", "Workspace file capability no longer matches the current workspace resource.");
    }
    return grant;
  }

  invalidateAll(): void {
    this.grants.clear();
  }

  private prune(now: Date): void {
    const nowMs = now.getTime();
    for (const [id, grant] of this.grants) {
      if (Date.parse(grant.expiresAt) <= nowMs) this.grants.delete(id);
    }
  }
}

function normalizeIssueInput(input: WorkspaceFileCapabilityRequest): WorkspaceFileCapabilityRequest {
  if (!input || typeof input.cwd !== "string" || !input.cwd.trim()) {
    throw new WorkspaceFileCapabilityError(400, "bad_request", "cwd is required.");
  }
  if (!input.scope || !isNonEmpty(input.scope.workspaceId) || !isNonEmpty(input.scope.threadId)
    || !isNonEmpty(input.scope.runId) || !isNonEmpty(input.scope.actionId) || !isNonEmpty(input.scope.participantId)) {
    throw new WorkspaceFileCapabilityError(400, "bad_request", "workspace, thread, run, action and participant scope are required.");
  }
  if (input.capabilityTarget !== "open_file" && input.capabilityTarget !== "open_diff" && input.capabilityTarget !== "open_artifact") {
    throw new WorkspaceFileCapabilityError(400, "bad_request", "Unsupported workspace file capability target.");
  }
  if (!isNonEmpty(input.refId)) {
    throw new WorkspaceFileCapabilityError(400, "bad_request", "refId is required.");
  }
  return {
    cwd: realpathOrThrow(input.cwd.trim()),
    capabilityTarget: input.capabilityTarget,
    refId: input.refId.trim(),
    scope: {
      workspaceId: input.scope.workspaceId.trim(),
      threadId: input.scope.threadId.trim(),
      runId: input.scope.runId.trim(),
      actionId: input.scope.actionId.trim(),
      participantId: input.scope.participantId.trim(),
      ...(input.scope.workflowStepId?.trim() ? { workflowStepId: input.scope.workflowStepId.trim() } : {}),
    },
  };
}

function resolveAuthorizedResource(
  store: RunStore,
  input: Pick<WorkspaceFileCapabilityRequest, "cwd" | "capabilityTarget" | "refId" | "scope">,
): WorkspaceFileCapabilityResource {
  const workspaceRoot = realpathOrThrow(store.paths.cwd);
  if (workspaceRoot !== input.cwd || store.paths.identity.workspaceId === "") {
    throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Workspace capability cwd does not match the active workspace.");
  }
  const thread = store.getLingThread(input.scope.threadId);
  if (!thread || thread.workspaceId !== input.scope.workspaceId) {
    throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Workspace capability thread scope is invalid.");
  }
  const run = store.getRun(input.scope.runId);
  if (!run) {
    throw new WorkspaceFileCapabilityError(403, "missing_lineage", "Workspace capability run was not found.");
  }
  const action = listExecutionActions(store, { runId: input.scope.runId, complete: true })
    .find((candidate) => candidate.id === input.scope.actionId);
  if (!action || action.workspaceId !== input.scope.workspaceId || action.runId !== input.scope.runId) {
    throw new WorkspaceFileCapabilityError(403, "missing_lineage", "Workspace capability action was not found in durable evidence.");
  }
  if (action.participantId !== input.scope.participantId) {
    throw new WorkspaceFileCapabilityError(403, "owner_conflict", "Workspace capability participant does not own the action.");
  }
  if ((action.workflowStepId?.trim() || undefined) !== input.scope.workflowStepId) {
    throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Workspace capability workflow step does not match the action.");
  }
  if (!actionBelongsToThread(store, action, input.scope.threadId)) {
    throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Workspace capability thread does not own the action evidence.");
  }

  const ref = findActionRef(action, input.refId);
  if (!ref) {
    throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested source ref is not attached to the durable action.");
  }
  if (input.capabilityTarget === "open_artifact" || (input.capabilityTarget === "open_diff" && ref.kind === "artifact")) {
    const artifactId = ref.kind === "artifact" ? ref.id : action.resultArtifactIds.includes(input.refId) || action.previewArtifactIds.includes(input.refId) ? input.refId : undefined;
    if (!artifactId) throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested ref is not a run artifact.");
    const artifact = store.getArtifact(artifactId);
    if (!artifact || artifact.runId !== input.scope.runId) {
      throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested artifact is not owned by the run.");
    }
    if (input.capabilityTarget === "open_diff" && artifact.type !== "diff") {
      throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested artifact is not diff evidence.");
    }
    const contentPath = resolveArtifactContentPath(store, artifact);
    ensureRegularFile(contentPath, "artifact_content_not_found");
    return { kind: "artifact", contentPath, displayPath: artifact.path, artifactId };
  }

  const path = ref.path ?? (ref.kind === "file" || ref.kind === "path" || ref.kind === "diff" ? ref.id : undefined);
  if (!path) throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested ref does not identify a workspace file.");
  if (input.capabilityTarget === "open_diff" && action.actionType !== "write" && action.actionType !== "edit" && !ref.kind.includes("diff")) {
    throw new WorkspaceFileCapabilityError(403, "missing_context_source", "The requested ref is not an editable file or diff evidence.");
  }
  try {
    const resolved = resolveWorkspaceFileTarget(workspaceRoot, path);
    return { kind: "file", contentPath: resolved.contentPath, displayPath: resolved.displayPath };
  } catch (error) {
    if (error instanceof WorkspaceFileTargetError) throw new WorkspaceFileCapabilityError(error.statusCode, error.code, error.message);
    throw error;
  }
}

function actionBelongsToThread(store: RunStore, action: ExecutionAction, threadId: string): boolean {
  if (action.threadId === threadId) return true;
  return action.sourceRefs.some((ref) => ref.kind === "conversation_item" && store.getConversationItem(ref.id)?.threadId === threadId);
}

function findActionRef(action: ExecutionAction, refId: string): { readonly kind: string; readonly id: string; readonly path?: string } | undefined {
  const source = action.sourceRefs.find((ref) => ref.id === refId || ref.path === refId);
  if (source) return source;
  const target = action.targetRefs.find((ref) => ref.id === refId || ref.path === refId || ref.label === refId);
  if (target) return { kind: target.type, id: target.id ?? target.path ?? target.label ?? refId, path: target.path };
  if (action.previewArtifactIds.includes(refId) || action.resultArtifactIds.includes(refId)) return { kind: "artifact", id: refId };
  return undefined;
}

function assertScopeEqual(left: WorkspaceFileCapabilityScope, right: WorkspaceFileCapabilityScope): void {
  const keys: readonly (keyof WorkspaceFileCapabilityScope)[] = ["workspaceId", "threadId", "runId", "actionId", "participantId", "workflowStepId"];
  if (keys.some((key) => (left[key] ?? "") !== (right[key] ?? ""))) {
    throw new WorkspaceFileCapabilityError(403, "scope_mismatch", "Workspace file capability scope does not match the current transcript.");
  }
}

function publicCapability(grant: WorkspaceFileCapabilityGrant): WorkspaceFileCapability {
  const { cwd: _cwd, resource: _resource, ...capability } = grant;
  return capability;
}

function clampTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TTL_MS;
  return Math.max(1_000, Math.min(Math.floor(value!), MAX_TTL_MS));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function realpathOrThrow(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new WorkspaceFileCapabilityError(404, "workspace_not_found", error instanceof Error ? error.message : String(error));
  }
}

function ensureRegularFile(path: string, code: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new WorkspaceFileCapabilityError(404, code, error instanceof Error ? error.message : String(error));
  }
}
