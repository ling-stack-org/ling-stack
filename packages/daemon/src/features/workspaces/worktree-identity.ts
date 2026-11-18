import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChannelWorkspaceBinding, LingStackRuntimePaths, ManagedWorktreeIdentity } from "@ling-stack/core";
import { isolatedGit, resolveGitRepoRoot, safeGitBranchSegment, type GitRepositoryResolutionErrorCode } from "./managed-worktrees.js";

export type ManagedWorktreeOwner =
  | { readonly kind: "channel"; readonly id: string; readonly boundPath?: string }
  | { readonly kind: "teammate"; readonly id: string; readonly teammateId: string };

export function managedOwnerBranch(owner: ManagedWorktreeOwner): string {
  return owner.kind === "channel" ? `ling/channel-${owner.id}`
    : `ling/teammate-${safeGitBranchSegment(owner.teammateId)}-${safeGitBranchSegment(owner.id)}`;
}

export function managedOwnerPath(root: string, owner: ManagedWorktreeOwner): string {
  return owner.kind === "channel" ? resolve(root, "channels", owner.id) : resolve(root, "teammates", owner.teammateId, owner.id);
}

type WorktreeSource =
  | { readonly ok: true; readonly repoRoot: string; readonly identity?: ManagedWorktreeIdentity }
  | { readonly ok: false; readonly code: GitRepositoryResolutionErrorCode | "worktree_owner_mismatch"; readonly message: string };

/** Legacy bindings must match the daemon's layout and the owner's source checkout. */
export async function resolveWorktreeSource(
  paths: LingStackRuntimePaths, owner: ManagedWorktreeOwner, binding?: ChannelWorkspaceBinding,
): Promise<WorktreeSource> {
  const mismatch = { ok: false, code: "worktree_owner_mismatch", message: "工作树与记录的仓库、目录或分支不符。" } as const;
  if (binding?.mode === "managed_worktree") {
    if (binding.branchName !== managedOwnerBranch(owner) || !binding.worktreePath
      || binding.executionPath !== binding.worktreePath) return mismatch;
    const identity = binding.worktreeIdentity;
    if (identity) {
      try {
        if (await realpath(identity.repoRoot) !== identity.repoRoot
          || await gitCommonDirectory(identity.repoRoot) !== identity.gitCommonDir) return mismatch;
      } catch { return mismatch; }
      return { ok: true, repoRoot: identity.repoRoot, identity };
    }
    if (binding.worktreePath !== managedOwnerPath(paths.worktreesDir, owner)) return mismatch;
  }
  const source = await resolveGitRepoRoot(owner.kind === "channel" ? owner.boundPath ?? paths.cwd : paths.cwd);
  return source.ok ? { ok: true, repoRoot: await realpath(source.repoRoot) } : source;
}

async function gitCommonDirectory(path: string): Promise<string> {
  const { stdout } = await isolatedGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpath(stdout.trimEnd());
}

/** The source repository's registration must identify this exact linked checkout. */
export async function assertOwnedLinkedWorktree(
  repoRoot: string, path: string, branchName: string, expected?: Pick<ManagedWorktreeIdentity, "gitCommonDir" | "gitDir">,
): Promise<ManagedWorktreeIdentity> {
  const mismatch = (): Error => new Error("Worktree repository, branch or identity does not match its owner");
  if (!(await lstat(path)).isDirectory() || !branchName) throw mismatch();
  const [canonicalRoot, targetPath, common, targetCommon] = await Promise.all([
    realpath(repoRoot), realpath(path), gitCommonDirectory(repoRoot), gitCommonDirectory(path),
  ]);
  const [gitDir, top, listing] = await Promise.all([
    isolatedGit(path, ["rev-parse", "--absolute-git-dir"]).then(({ stdout }) => realpath(stdout.trimEnd())),
    isolatedGit(path, ["rev-parse", "--show-toplevel"]).then(({ stdout }) => realpath(stdout.trimEnd())),
    isolatedGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]).then(({ stdout }) => stdout),
  ]);
  if (common !== targetCommon || top !== targetPath || dirname(gitDir) !== join(common, "worktrees")
    || expected && (gitDir !== expected.gitDir || common !== expected.gitCommonDir)) throw mismatch();
  let matches = 0;
  for (const entry of listing.split("\0\0")) {
    const [location, ...attributes] = entry.split("\0");
    if (!location?.startsWith("worktree ") || !attributes.includes(`branch refs/heads/${branchName}`)
      || attributes.some((attribute) => attribute === "prunable" || attribute.startsWith("prunable "))) continue;
    if (await realpath(location.slice("worktree ".length)).catch(() => undefined) === targetPath) matches++;
  }
  if (matches !== 1) throw mismatch();
  return { repoRoot: canonicalRoot, gitCommonDir: common, gitDir };
}
