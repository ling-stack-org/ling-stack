import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type {
  LingAppServerWorktreeCleanupParams,
  LingAppServerWorktreeCleanupPreview,
  LingAppServerWorktreeCleanupResult,
  LingAppServerWorktreeCreateParams,
  LingAppServerWorktreeResult,
  LingAppServerWorktreeTarget,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { createManagedWorktreeBinding } from "../features/channels/workspace.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { createManagedDirectWorktreeBinding } from "../features/teammates/direct-workspace.js";
import { resolveWorktreeSource } from "../features/workspaces/worktree-identity.js";
import {
  actOnManagedWorktreeLocked,
  findManagedTeammateWorktreeOwner,
  readManagedWorktreeEntry,
  WorktreeActionError,
} from "../features/workspaces/worktree-management.js";
import { coordinateWorktreeMutation } from "../features/workspaces/worktree-mutation.js";
import { listWorktreeSnapshots, recoverWorktreeOperations, WORKTREE_FENCE_PREFIX } from "../features/workspaces/worktree-recovery.js";

export async function createAppServerWorktree(
  store: RunStore, target: LingAppServerWorktreeCreateParams,
): Promise<LingAppServerWorktreeResult> {
  return coordinateWorktreeMutation(store, async () => {
    const cwd = store.paths.cwd;
    store.assertWorkspaceSnapshotFence(cwd);
    const owner = await boundOwner(store, target);
    if (target.baseBranch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/u.test(target.baseBranch)) {
      throw new HttpError(400, "invalid_params", "Supply a branch name or commit for the worktree base.");
    }
    const existingBase = owner.record.workspaceBinding?.baseBranch;
    if (existingBase && target.baseBranch && existingBase !== target.baseBranch) {
      throw new WorktreeActionError("worktree_conflict", "The existing worktree is bound to a different base.");
    }
    const policy = store.getWorkspaceSettings().worktreePolicy;
    if (owner.kind === "channel") {
      const result = await createManagedWorktreeBinding(owner.record, cwd, store.paths, target.baseBranch, policy, store);
      if (!result.ok) throw new WorktreeActionError(result.code, result.message);
      store.updateChannel(owner.record.id, { workspaceBinding: result.binding }, result.binding.updatedAt);
    } else {
      const result = await createManagedDirectWorktreeBinding(owner.record, cwd, store.paths, target.baseBranch, policy, store);
      if (!result.ok) throw new WorktreeActionError(result.code, result.message);
      store.updateTeammateDirectThreadWorkspace(owner.record.id, result.binding, result.binding.updatedAt);
    }
    return { cwd, entry: await readManagedWorktreeEntry(store, target) };
  });
}

export async function refreshAppServerWorktree(
  store: RunStore, target: LingAppServerWorktreeTarget,
): Promise<LingAppServerWorktreeResult> {
  await boundOwner(store, target);
  return { cwd: store.paths.cwd, entry: await readManagedWorktreeEntry(store, target) };
}

export async function previewAppServerWorktreeCleanup(
  store: RunStore, target: LingAppServerWorktreeTarget,
): Promise<LingAppServerWorktreeCleanupPreview> {
  const owner = await boundOwner(store, target);
  const cwd = store.paths.cwd;
  const entry = await readManagedWorktreeEntry(store, target);
  if (entry.status !== "ready" || entry.inUse) {
    throw new WorktreeActionError("worktree_conflict", "The worktree must be ready and idle before cleanup.");
  }
  const directory = await lstat(entry.path, { bigint: true });
  const candidate = await captureCodeAssessmentSnapshot(entry.path, { type: "working_tree" });
  if (candidate.coverage !== "complete") {
    throw new WorktreeActionError("worktree_conflict", "Cleanup requires a candidate with complete coverage.");
  }
  const expectedRevision = createHash("sha256").update(JSON.stringify([
    cwd, entry.ownerKind, entry.ownerId, entry.path, entry.branchName, owner.record.workspaceBinding?.updatedAt,
    directory.dev.toString(), directory.ino.toString(), candidate.digest,
  ])).digest("hex");
  return { cwd, entry, expectedRevision };
}

export async function cleanupAppServerWorktree(
  store: RunStore, target: LingAppServerWorktreeCleanupParams,
): Promise<LingAppServerWorktreeCleanupResult> {
  return coordinateWorktreeMutation(store, async () => {
    if (target.confirmed !== true) throw new HttpError(400, "worktree_confirmation_required", "Confirm the worktree cleanup preview.");
    if (!/^[a-f0-9]{64}$/u.test(target.expectedRevision)) throw new HttpError(400, "invalid_params", "A valid cleanup preview revision is required.");
    await recoverWorktreeOperations(store);
    const archiveId = WORKTREE_FENCE_PREFIX + target.expectedRevision.slice(0, 36);
    const findArchive = async () => (await listWorktreeSnapshots(store.paths)).find(item => item.id === archiveId
      && item.ownerKind === target.ownerKind && item.ownerId === target.ownerId && item.state === "archived");
    const prior = await findArchive();
    if (prior) {
      const refreshed = await refreshAppServerWorktree(store, target);
      return { ...refreshed, snapshot: prior };
    }
    const preview = await previewAppServerWorktreeCleanup(store, target);
    if (target.expectedRevision !== preview.expectedRevision) {
      throw new WorktreeActionError("stale_revision", "The worktree changed since cleanup was previewed.");
    }
    await actOnManagedWorktreeLocked(store, preview.cwd, { ...target, action: "cleanup", archiveId });
    const snapshot = await findArchive();
    if (!snapshot) throw new WorktreeActionError("unknown_outcome", "The cleanup recovery snapshot could not be confirmed.");
    return { cwd: preview.cwd, entry: await readManagedWorktreeEntry(store, target), snapshot };
  });
}

async function boundOwner(store: RunStore, { ownerKind, ownerId }: LingAppServerWorktreeTarget) {
  if (ownerKind === "channel") {
    const record = store.getChannel(ownerId);
    if (!record) throw new WorktreeActionError("worktree_not_found", "The channel worktree owner was not found.");
    const source = await resolveWorktreeSource(store.paths, { kind: ownerKind, id: record.id, boundPath: record.boundPath }, record.workspaceBinding);
    await assertBoundSource(store.paths.cwd, source);
    return { kind: ownerKind, record } as const;
  }
  const record = findManagedTeammateWorktreeOwner(store, ownerId);
  if (!record) throw new WorktreeActionError("worktree_not_found", "The teammate worktree owner was not found.");
  const source = await resolveWorktreeSource(store.paths, { kind: ownerKind, id: record.id, teammateId: record.teammateId }, record.workspaceBinding);
  await assertBoundSource(store.paths.cwd, source);
  return { kind: ownerKind, record } as const;
}

async function assertBoundSource(cwd: string, source: Awaited<ReturnType<typeof resolveWorktreeSource>>) {
  if (!source.ok) throw new WorktreeActionError(source.code, source.message);
  if (source.repoRoot !== await realpath(cwd)) {
    throw new WorktreeActionError("workspace_binding_invalid", "The worktree repository differs from the connection workspace.");
  }
}
