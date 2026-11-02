import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, statfs, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { workflowGit } from "./managed-worktrees.js";

export class WorkflowGitError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}

export interface WorkflowGitRepository {
  readonly root: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly head: string;
  readonly branchRef: string;
  readonly configurationDigest: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly commonDevice: string;
  readonly commonInode: string;
  readonly dirty: boolean;
}

export interface WorkflowGitWorktreeScope {
  readonly roundId: string;
  readonly stepId: string;
  readonly generation: number;
  readonly worktreeId: string;
  readonly executionRoot: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly worktreeRoot: string;
  readonly repository: WorkflowGitRepository;
}

export interface WorkflowGitWorktreeReceipt {
  readonly worktreeId: string;
  readonly executionRoot: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly commonDir: string;
  readonly rootDevice: string;
  readonly rootInode: string;
}

/** Target identity frozen before approval, not proof of OS isolation or permission to apply. */
export function workflowGitRepositoryBasisDigest(repository: WorkflowGitRepository): string {
  return `wgr1_${createHash("sha256").update(JSON.stringify({
    root: repository.root, commonDir: repository.commonDir, gitDir: repository.gitDir,
    head: repository.head, branchRef: repository.branchRef, configurationDigest: repository.configurationDigest,
    rootDevice: repository.rootDevice, rootInode: repository.rootInode,
    commonDevice: repository.commonDevice, commonInode: repository.commonInode, dirty: repository.dirty,
  })).digest("hex")}`;
}

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const lockName = "ling-workflow-git.lock";
const ongoing = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_START"];
const unsafeConfiguration = /^(?:include\.|includeif\.|filter\.|credential\.|diff\..*\.(?:command|textconv)$|merge\..*\.driver$|core\.(?:sshcommand|gitproxy|fsmonitor)$|extensions\.worktreeconfig$)/u;
const requireGit: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowGitError(code);
};

/** Repository facts only, never a Runner isolation capability or an apply permit. */
export async function inspectWorkflowGitRepository(root: string, options: { readonly allowDirtyCandidate?: boolean } = {}): Promise<WorkflowGitRepository> {
  requireGit(isAbsolute(root), "workflow_git_root_invalid");
  const canonical = await realpath(root);
  requireGit(canonical === resolve(root) && (await lstat(root)).isDirectory(), "workflow_git_root_not_canonical");
  const text = async (args: readonly string[]) => decode((await workflowGit(root, args)).stdout).trim();
  requireGit(await text(["rev-parse", "--show-toplevel"]) === canonical, "workflow_git_root_not_checkout");
  const commonDir = await realpath(await text(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const gitDir = await realpath(await text(["rev-parse", "--absolute-git-dir"]));
  const head = await text(["rev-parse", "--verify", "HEAD^{commit}"]);
  requireGit(oid.test(head), "workflow_git_head_invalid");
  let branchRef: string;
  try { branchRef = await text(["symbolic-ref", "--quiet", "HEAD"]); }
  catch (cause) { throw new WorkflowGitError("workflow_git_target_detached", { cause }); }
  requireGit(branchRef.startsWith("refs/heads/") && !/[\x00-\x20\x7f]/u.test(branchRef), "workflow_git_target_branch_invalid");
  for (const name of ongoing) requireGit(!await present(join(gitDir, name)), "workflow_git_operation_in_progress");
  const configuration = (await workflowGit(root, ["config", "--local", "--no-includes", "--null", "--list"])).stdout;
  for (const entry of decode(configuration).split("\0").filter(Boolean)) {
    const key = entry.split("\n", 1)[0].toLowerCase();
    requireGit(!unsafeConfiguration.test(key), "workflow_git_custom_configuration_unsupported");
  }
  requireGit(!await present(join(commonDir, "info", "grafts")) && !await present(join(commonDir, "shallow")),
    "workflow_git_incomplete_history_unsupported");
  await inspectWorkflowGitTree(root, head);
  const infoAttributes = join(commonDir, "info", "attributes");
  if (await present(infoAttributes)) rejectCustomAttributes(decode(await boundedFile(infoAttributes)));
  const dirty = (await workflowGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.length !== 0;
  requireGit(!dirty || options.allowDirtyCandidate === true, "workflow_git_target_dirty");
  const rootStat = await lstat(root, { bigint: true }), commonStat = await lstat(commonDir, { bigint: true });
  requireGit(rootStat.isDirectory() && commonStat.isDirectory(), "workflow_git_repository_identity_changed");
  return { root: canonical, commonDir, gitDir, head, branchRef, dirty,
    configurationDigest: createHash("sha256").update(configuration).digest("hex"),
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), commonDevice: String(commonStat.dev), commonInode: String(commonStat.ino) };
}

export async function inspectWorkflowGitTree(root: string, commit: string): Promise<void> {
  requireGit(oid.test(commit), "workflow_git_commit_invalid");
  const tree = decode((await workflowGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout);
  const names = new Map<string, string>(), entries = tree.split("\0").filter(Boolean);
  requireGit(entries.length <= 10000, "workflow_git_tree_budget_exceeded");
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), header = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
    requireGit(tab > 0 && ["100644", "100755"].includes(header[0]) && header[1] === "blob" && oid.test(header[2]),
      "workflow_git_special_file_unsupported");
    requireGit(safeWorkflowGitPath(path), "workflow_git_path_unsupported");
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      requireGit(!names.has(folded) || names.get(folded) === prefix, "workflow_git_ambiguous_case_path");
      names.set(folded, prefix);
    }
    if (path.split("/").at(-1) === ".gitattributes") {
      const bytes = (await workflowGit(root, ["cat-file", "blob", header[2]])).stdout;
      requireGit(bytes.length <= 1024 * 1024, "workflow_git_attributes_budget_exceeded");
      rejectCustomAttributes(decode(bytes));
    }
  }
}

export function safeWorkflowGitPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[\x00-\x1f\x7f\\]/u.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== ".."
      && !/^\.git(?:$|[ .])/iu.test(part) && part === part.trimEnd());
}

/** Preallocate this identity before approval. No directory/ref mutation occurs. */
export async function planWorkflowGitWorktree(input: {
  readonly repository: WorkflowGitRepository;
  readonly worktreeRoot: string;
  readonly roundId: string;
  readonly stepId: string;
  readonly generation: number;
  readonly worktreeId?: string;
}): Promise<WorkflowGitWorktreeScope> {
  const worktreeId = input.worktreeId ?? randomUUID();
  requireGit([input.roundId, input.stepId, worktreeId].every(value => identifier.test(value))
    && Number.isSafeInteger(input.generation) && input.generation > 0 && oid.test(input.repository.head), "workflow_git_scope_invalid");
  requireGit(isAbsolute(input.worktreeRoot) && await realpath(input.worktreeRoot) === resolve(input.worktreeRoot),
    "workflow_git_worktree_root_not_canonical");
  requireGit((await lstat(input.worktreeRoot)).isDirectory() && outside(input.repository.root, input.worktreeRoot)
    && outside(input.repository.commonDir, input.worktreeRoot) && outside(input.worktreeRoot, input.repository.root),
  "workflow_git_worktree_root_overlaps_repository");
  const executionRoot = join(input.worktreeRoot, worktreeId);
  return { ...input, worktreeId, executionRoot, baseCommit: input.repository.head,
    branchRef: `refs/heads/ling/workflow/${input.roundId}/${input.stepId}/${input.generation}-${worktreeId}` };
}

/** No TTL stealing: an abandoned owner requires journal reconciliation before reuse. */
export async function withWorkflowGitRepositoryLock<T>(repository: WorkflowGitRepository, action: () => Promise<T>): Promise<T> {
  const current = await lstat(repository.commonDir, { bigint: true });
  requireGit(!current.isSymbolicLink() && current.isDirectory() && String(current.dev) === repository.commonDevice
    && String(current.ino) === repository.commonInode, "workflow_git_repository_identity_changed");
  const path = join(repository.commonDir, lockName), token = randomUUID();
  try { await mkdir(path, { mode: 0o700 }); }
  catch (cause) { throw new WorkflowGitError("workflow_git_repository_busy", { cause }); }
  const identity = await lstat(path, { bigint: true });
  // Failure before owner write intentionally retains an unexplained lock.
  const handle = await open(join(path, "owner.json"), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.sync(); }
  finally { await handle.close(); }
  try { return await action(); }
  finally {
    const after = await lstat(path, { bigint: true });
    requireGit(!after.isSymbolicLink() && after.dev === identity.dev && after.ino === identity.ino,
      "workflow_git_lock_release_uncertain");
    const owner = JSON.parse(decode(await boundedFile(join(path, "owner.json"))));
    requireGit(owner.token === token, "workflow_git_lock_release_uncertain");
    await unlink(join(path, "owner.json")); await rmdir(path);
  }
}

/** Caller persists a create intent first. Failures retain possible physical effects. */
export async function createWorkflowGitWorktree(scope: WorkflowGitWorktreeScope,
  options: { readonly beforeCreate?: () => void } = {}): Promise<WorkflowGitWorktreeReceipt> {
  const planned = await planWorkflowGitWorktree(scope);
  requireGit(planned.executionRoot === scope.executionRoot && planned.branchRef === scope.branchRef
    && planned.baseCommit === scope.baseCommit, "workflow_git_scope_invalid");
  return withWorkflowGitRepositoryLock(scope.repository, async () => {
    const current = await inspectWorkflowGitRepository(scope.repository.root, { allowDirtyCandidate: scope.repository.dirty });
    requireGit(sameRepository(scope.repository, current), "workflow_git_repository_basis_changed");
    requireGit(!await present(scope.executionRoot) && !await workflowGitRefExists(scope.repository.root, scope.branchRef),
      "workflow_git_worktree_identity_exists");
    const registered = decode((await workflowGit(scope.repository.root, ["worktree", "list", "--porcelain", "-z"])).stdout);
    requireGit(registered.split("\0").filter(value => value.startsWith("worktree ")).length < 16,
      "workflow_git_worktree_budget_exceeded");
    const disk = await statfs(scope.worktreeRoot, { bigint: true });
    requireGit(disk.bavail * disk.bsize >= 64n * 1024n * 1024n, "workflow_git_disk_budget_exceeded");
    // The caller rechecks its persisted intent/fence in the physical launch stack.
    requireGit(options.beforeCreate?.() === undefined, "workflow_git_create_guard_invalid");
    await workflowGit(scope.repository.root, ["worktree", "add", "--no-track", "-b", scope.branchRef.slice("refs/heads/".length),
      "--", scope.executionRoot, scope.baseCommit]);
    return reconcileWorkflowGitWorktree(scope);
  });
}

export async function reconcileWorkflowGitWorktree(scope: WorkflowGitWorktreeScope): Promise<WorkflowGitWorktreeReceipt> {
  const observed = await inspectWorkflowGitRepository(scope.executionRoot);
  requireGit(observed.commonDir === scope.repository.commonDir && observed.head === scope.baseCommit
    && observed.branchRef === scope.branchRef && observed.commonDevice === scope.repository.commonDevice
    && observed.commonInode === scope.repository.commonInode, "workflow_git_worktree_receipt_mismatch");
  return { worktreeId: scope.worktreeId, executionRoot: scope.executionRoot, branchRef: scope.branchRef,
    baseCommit: scope.baseCommit, commonDir: observed.commonDir, rootDevice: observed.rootDevice, rootInode: observed.rootInode };
}

export async function workflowGitRefExists(root: string, ref: string): Promise<boolean> {
  requireGit(ref.startsWith("refs/") && !/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref), "workflow_git_ref_invalid");
  try { await workflowGit(root, ["show-ref", "--verify", "--quiet", ref]); return true; }
  catch (error) { if ((error as { readonly code?: unknown })?.code === 1) return false; throw error; }
}

function rejectCustomAttributes(text: string): void {
  requireGit(!text.includes("\0"), "workflow_git_attributes_unsupported");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    requireGit(!trimmed.startsWith("[attr]") && !trimmed.split(/\s+/u).slice(1).some(attribute =>
      /^(?:[!-]?(?:filter|merge|working-tree-encoding|ident))(?:=|$)/u.test(attribute)
      || /^eol=/u.test(attribute) && attribute !== "eol=lf"),
      "workflow_git_custom_attributes_unsupported");
  }
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new WorkflowGitError("workflow_git_non_utf8_unsupported", { cause }); }
}
async function boundedFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    requireGit(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024, "workflow_git_private_file_unsafe");
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    requireGit(count === stat.size, "workflow_git_private_file_changed"); return bytes.subarray(0, count);
  } finally { await file.close(); }
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function outside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
function sameRepository(a: WorkflowGitRepository, b: WorkflowGitRepository): boolean {
  return a.root === b.root && a.commonDir === b.commonDir && a.gitDir === b.gitDir && a.head === b.head && a.branchRef === b.branchRef
    && a.configurationDigest === b.configurationDigest && a.rootDevice === b.rootDevice && a.rootInode === b.rootInode
    && a.commonDevice === b.commonDevice && a.commonInode === b.commonInode && a.dirty === b.dirty;
}
