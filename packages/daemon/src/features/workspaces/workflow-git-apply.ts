import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { workflowGit } from "./managed-worktrees.js";
import { WorkflowGitError, inspectWorkflowGitRepository, inspectWorkflowGitTree, safeWorkflowGitPath,
  withWorkflowGitRepositoryLock, workflowGitRepositoryBasisDigest, type WorkflowGitRepository } from "./workflow-git-repository.js";

export interface WorkflowGitApplyTarget {
  readonly expectedRepository: WorkflowGitRepository;
  readonly expectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
}

/** Journal data only. Neither this snapshot nor an observation grants apply authority. */
export interface WorkflowGitApplyIntent extends WorkflowGitApplyTarget { readonly expectedBasisDigest: string }

export interface WorkflowGitApplyObservation {
  readonly state: "expected" | "candidate" | "diverged" | "unavailable";
  readonly verifiedClean: boolean;
  readonly basisDigest?: string;
  readonly repository?: WorkflowGitRepository;
  readonly head?: string;
  readonly tree?: string;
  readonly code?: string;
}

export interface WorkflowGitApplyReceipt {
  readonly intent: WorkflowGitApplyIntent;
  readonly repository: WorkflowGitRepository;
  readonly head: string;
  readonly tree: string;
  readonly basisDigest: string;
}

export interface WorkflowGitApplyInput extends WorkflowGitApplyTarget {
  /** Host coordinator rechecks its current scope, owner/fence, validation and approval. */
  readonly assertCurrentAuthority: () => void;
  readonly beforeApply: (intent: WorkflowGitApplyIntent) => void | Promise<void>;
  readonly afterApply: (receipt: WorkflowGitApplyReceipt) => void | Promise<void>;
}

export type WorkflowGitApplyResult =
  | { readonly status: "applied"; readonly receipt: WorkflowGitApplyReceipt }
  | { readonly status: "blocked"; readonly code: string; readonly observation?: WorkflowGitApplyObservation; readonly cause?: unknown }
  | { readonly status: "unknown"; readonly code: string; readonly observation: WorkflowGitApplyObservation; readonly cause?: unknown };

interface TreeEntry { readonly mode: string; readonly oid: string; readonly path: string }
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const maxFileBytes = 1024 * 1024, maxTreeBytes = 4 * 1024 * 1024;
const requireApply: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowGitError(code);
};

/** Host-only mechanism, not an approval API. Persisted intent reconciliation belongs to the coordinator. */
export async function applyWorkflowGitFastForward(input: WorkflowGitApplyInput): Promise<WorkflowGitApplyResult> {
  let attempted = false, requiresReconciliation = false, observation: WorkflowGitApplyObservation | undefined;
  try {
    const intent = snapshotTarget(input);
    const { assertCurrentAuthority, beforeApply, afterApply } = input;
    requireApply([assertCurrentAuthority, beforeApply, afterApply].every(value => typeof value === "function"),
      "workflow_git_apply_callbacks_required");
    const checkAuthority = () => {
      let returned: unknown;
      try { returned = assertCurrentAuthority(); }
      catch (cause) { throw new WorkflowGitError("workflow_git_apply_authority_rejected", { cause }); }
      // Consume rejected async checks without ever awaiting them as authority.
      if (returned instanceof Promise) void returned.catch(() => undefined);
      else if (returned && typeof (returned as { then?: unknown }).then === "function") {
        void Promise.resolve(returned).catch(() => undefined);
      }
      requireApply(returned === undefined, "workflow_git_apply_authority_must_be_synchronous");
    };
    return await withWorkflowGitRepositoryLock<WorkflowGitApplyResult>(intent.expectedRepository, async () => {
      checkAuthority();
      observation = await observeLocked(intent);
      if (observation.head === intent.candidateCommit) {
        requiresReconciliation = true;
        return { status: "unknown", code: "workflow_git_apply_requires_reconciliation", observation };
      }
      requireExpected(observation);
      await inspectCandidate(intent);
      checkAuthority();
      try { requireApply(await beforeApply(intent) === undefined, "workflow_git_apply_intent_return_invalid"); }
      catch (cause) { throw new WorkflowGitError("workflow_git_apply_intent_failed", { cause }); }

      // Persistence can yield or revoke authority. Repeat the complete target check under the same lock.
      observation = await observeLocked(intent);
      if (observation.head === intent.candidateCommit) {
        requiresReconciliation = true;
        return { status: "unknown", code: "workflow_git_apply_requires_reconciliation", observation };
      }
      requireExpected(observation);
      await inspectCandidate(intent);
      checkAuthority();
      attempted = true;
      try {
        await workflowGit(intent.expectedRepository.root,
          ["merge", "--ff-only", "--no-edit", "--no-autostash", intent.candidateCommit]);
        observation = await observeLocked(intent);
        requireApply(observation.state === "candidate" && observation.verifiedClean && observation.repository,
          "workflow_git_apply_receipt_mismatch");
        checkAuthority();
        const receipt: WorkflowGitApplyReceipt = Object.freeze({ intent, repository: observation.repository,
          head: observation.head!, tree: observation.tree!, basisDigest: observation.basisDigest! });
        try { requireApply(await afterApply(receipt) === undefined, "workflow_git_apply_receipt_return_invalid"); }
        catch (cause) { throw new WorkflowGitError("workflow_git_apply_receipt_failed", { cause }); }
        return { status: "applied", receipt };
      } catch (cause) {
        observation = await observeLocked(intent);
        return { status: "unknown", code: codeOf(cause, "workflow_git_apply_effect_uncertain"), observation, cause };
      }
    });
  } catch (cause) {
    const code = codeOf(cause, "workflow_git_apply_preflight_failed");
    return attempted || requiresReconciliation ? { status: "unknown", code, observation: observation ?? unavailable(code), cause }
      : { status: "blocked", code, observation, cause };
  }
}

/** Read-only physical evidence. Even a clean exact candidate requires a matching durable Host intent. */
export async function observeWorkflowGitApply(target: WorkflowGitApplyTarget): Promise<WorkflowGitApplyObservation> {
  try {
    const snapshot = snapshotTarget(target);
    return await withWorkflowGitRepositoryLock(snapshot.expectedRepository, () => observeLocked(snapshot));
  } catch (cause) { return unavailable(codeOf(cause, "workflow_git_apply_observation_failed")); }
}

function snapshotTarget(target: WorkflowGitApplyTarget): WorkflowGitApplyIntent {
  requireApply(target && target.expectedRepository && objectId.test(target.expectedHead)
    && objectId.test(target.candidateCommit) && objectId.test(target.candidateTree)
    && target.expectedHead.length === target.candidateCommit.length && target.expectedHead.length === target.candidateTree.length
    && target.expectedRepository.head === target.expectedHead && target.expectedRepository.dirty === false,
  "workflow_git_apply_scope_invalid");
  requireApply(target.candidateCommit !== target.expectedHead, "workflow_git_apply_candidate_not_successor");
  const hostState = target.expectedRepository.hostState;
  return Object.freeze({ expectedRepository: Object.freeze({ ...target.expectedRepository,
    ...(hostState ? { hostState: Object.freeze({ ...hostState }) } : {}) }), expectedHead: target.expectedHead,
    candidateCommit: target.candidateCommit, candidateTree: target.candidateTree,
    expectedBasisDigest: workflowGitRepositoryBasisDigest(target.expectedRepository) });
}

async function observeLocked(target: WorkflowGitApplyTarget): Promise<WorkflowGitApplyObservation> {
  let repository: WorkflowGitRepository | undefined, head: string | undefined, tree: string | undefined;
  try {
    repository = Object.freeze(await inspectWorkflowGitRepository(target.expectedRepository.root, { allowDirtyCandidate: true,
      hostStateRoot: target.expectedRepository.hostState?.root }));
    head = repository.head;
    tree = await gitText(repository.root, ["rev-parse", "--verify", `${head}^{tree}`]);
    requireApply(objectId.test(tree), "workflow_git_apply_tree_invalid");
    requireApply(sameIdentity(target.expectedRepository, repository), "workflow_git_apply_repository_basis_changed");
    await inspectMetadata(repository);
    const entries = await readTree(repository.root, head);
    const blobs = await readTextBlobs(repository.root, entries);
    await inspectCleanTarget(repository, entries, blobs);
    // Re-read the facts after raw file capture; a changing checkout is not clean evidence.
    const after = await inspectWorkflowGitRepository(repository.root, { allowDirtyCandidate: true, hostStateRoot: repository.hostState?.root });
    requireApply(sameIdentity(repository, after) && after.head === head && !after.dirty,
      "workflow_git_apply_target_changed_during_observation");
    return Object.freeze({ state: head === target.expectedHead ? "expected"
      : head === target.candidateCommit && tree === target.candidateTree ? "candidate" : "diverged",
    verifiedClean: true, basisDigest: workflowGitRepositoryBasisDigest(repository), repository, head, tree });
  } catch (cause) {
    return Object.freeze({ state: "unavailable", verifiedClean: false, repository, head, tree,
      code: codeOf(cause, "workflow_git_apply_observation_failed") });
  }
}

function requireExpected(observation: WorkflowGitApplyObservation): void {
  requireApply(observation.verifiedClean, observation.code ?? "workflow_git_apply_target_not_clean");
  requireApply(observation.state === "expected", "workflow_git_apply_head_changed");
}

async function inspectCandidate(target: WorkflowGitApplyTarget): Promise<void> {
  const root = target.expectedRepository.root;
  requireApply(await gitText(root, ["rev-parse", "--verify", `${target.candidateCommit}^{commit}`]) === target.candidateCommit
    && await gitText(root, ["rev-parse", "--verify", `${target.candidateCommit}^{tree}`]) === target.candidateTree,
  "workflow_git_apply_candidate_mismatch");
  try { await workflowGit(root, ["merge-base", "--is-ancestor", target.expectedHead, target.candidateCommit]); }
  catch (cause) { throw new WorkflowGitError("workflow_git_apply_candidate_not_descendant", { cause }); }
  await inspectWorkflowGitTree(root, target.candidateCommit);
  const candidate = await readTree(root, target.candidateCommit);
  requireApply(!target.expectedRepository.hostState || !candidate.some(entry => isHostStatePath(entry.path)),
    "workflow_git_apply_candidate_touches_host_state");
  // Case-only renames are aliases of before paths on common target filesystems.
  rejectCaseAliases([...await readTree(root, target.expectedHead), ...candidate]);
  await readTextBlobs(root, candidate);
}

async function inspectMetadata(repository: WorkflowGitRepository): Promise<void> {
  const dotGit = await lstat(join(repository.root, ".git"));
  requireApply(dotGit.isDirectory() || dotGit.isFile() && dotGit.nlink === 1, "workflow_git_apply_metadata_unsafe");
  for (const path of [join(repository.commonDir, "config"), join(repository.gitDir, "HEAD"), join(repository.gitDir, "index")]) {
    const stat = await lstat(path);
    requireApply(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "workflow_git_apply_metadata_unsafe");
  }
  for (const path of [
    ...["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "AUTO_MERGE", "MERGE_AUTOSTASH",
      "rebase-apply", "rebase-merge", "sequencer", "BISECT_START", "BISECT_LOG", "index.lock", "HEAD.lock"].map(name => join(repository.gitDir, name)),
    ...["config.lock", "packed-refs.lock", `${repository.branchRef}.lock`].map(name => join(repository.commonDir, name)),
  ]) requireApply(!await present(path), "workflow_git_operation_in_progress");
  for (const name of ["alternates", "http-alternates"]) requireApply(!await present(join(repository.commonDir, "objects", "info", name)),
    "workflow_git_apply_alternate_objects_unsupported");
  const config = decode((await workflowGit(repository.root, ["config", "--local", "--no-includes", "--null", "--list"])).stdout);
  for (const entry of config.split("\0").filter(Boolean)) {
    const key = entry.split("\n", 1)[0].toLowerCase();
    requireApply(!/^(?:gpg\.|merge\.verifysignatures$|branch\..*\.mergeoptions$|diff\.external$|core\.(?:sparsecheckout|sparsecheckoutcone|splitindex)$|index\.sparse$)/u.test(key),
      "workflow_git_apply_configuration_unsupported");
  }
}

async function inspectCleanTarget(repository: WorkflowGitRepository, entries: readonly TreeEntry[], blobs: ReadonlyMap<string, Buffer>): Promise<void> {
  const root = repository.root;
  const status = nulRecords((await workflowGit(root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).stdout);
  requireApply(!repository.dirty && status.every(entry => repository.hostState && entry.startsWith("!! ")
    && (entry.slice(3) === ".ling-stack/" || entry.slice(3).startsWith(".ling-stack/")))
    && (!repository.hostState || !entries.some(entry => isHostStatePath(entry.path))),
  "workflow_git_target_dirty");
  for (const entry of nulRecords((await workflowGit(root, ["ls-files", "-v", "-z"])).stdout)) {
    requireApply(entry.startsWith("H "), "workflow_git_apply_index_flags_unsupported");
  }
  const indexed = nulRecords((await workflowGit(root, ["ls-files", "--stage", "-z"])).stdout);
  requireApply(indexed.length === entries.length, "workflow_git_apply_index_mismatch");
  const expected = new Map(entries.map(entry => [entry.path, entry]));
  const seenIndex = new Set<string>();
  for (const record of indexed) {
    const tab = record.indexOf("\t"), header = record.slice(0, tab).split(" "), path = record.slice(tab + 1), entry = expected.get(path);
    requireApply(tab > 0 && entry && !seenIndex.has(path) && header.length === 3 && header[2] === "0"
      && header[0] === entry.mode && header[1] === entry.oid, "workflow_git_apply_index_mismatch");
    seenIndex.add(path);
  }
  const directories = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const seen = new Set<string>();
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const child of await readdir(join(root, directory))) {
      if (!directory && child === ".git") continue;
      if (!directory && child === ".ling-stack" && repository.hostState) continue;
      const path = directory ? `${directory}/${child}` : child;
      requireApply(++visited <= 20000 && safeWorkflowGitPath(path), "workflow_git_apply_worktree_path_unsupported");
      const absolute = join(root, path), stat = await lstat(absolute);
      if (stat.isDirectory()) {
        requireApply(directories.has(path) && await realpath(absolute) === absolute, "workflow_git_target_dirty");
        await walk(path);
      } else {
        requireApply(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7000) === 0,
          "workflow_git_apply_worktree_file_unsupported");
        const entry = expected.get(path);
        requireApply(entry && ((stat.mode & 0o111) !== 0) === (entry.mode === "100755"), "workflow_git_target_dirty");
        requireApply(await realpath(absolute) === absolute && (await readRegularFile(absolute)).equals(blobs.get(entry.oid)!),
          "workflow_git_apply_raw_content_mismatch");
        seen.add(path);
      }
    }
  };
  await walk("");
  requireApply(seen.size === entries.length, "workflow_git_target_dirty");
}

function isHostStatePath(path: string): boolean { return path.split("/", 1)[0].normalize("NFC").toLowerCase() === ".ling-stack"; }

async function readTree(root: string, commit: string): Promise<readonly TreeEntry[]> {
  const records = nulRecords((await workflowGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout);
  requireApply(records.length <= 10000, "workflow_git_tree_budget_exceeded");
  const entries: TreeEntry[] = [], paths = new Set<string>();
  for (const record of records) {
    const tab = record.indexOf("\t"), header = record.slice(0, tab).split(" "), path = record.slice(tab + 1);
    requireApply(tab > 0 && header.length === 3 && ["100644", "100755"].includes(header[0]) && header[1] === "blob"
      && objectId.test(header[2]) && safeWorkflowGitPath(path), "workflow_git_special_file_unsupported");
    requireApply(!paths.has(path), "workflow_git_apply_tree_duplicate_path");
    paths.add(path);
    entries.push({ mode: header[0], oid: header[2], path });
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) requireApply(!paths.has(parts.slice(0, i).join("/")), "workflow_git_apply_tree_path_collision");
  }
  rejectCaseAliases(entries);
  return entries;
}

function rejectCaseAliases(entries: readonly TreeEntry[]): void {
  const names = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      requireApply(!names.has(folded) || names.get(folded) === prefix, "workflow_git_ambiguous_case_path");
      names.set(folded, prefix);
    }
  }
}

async function readTextBlobs(root: string, entries: readonly TreeEntry[]): Promise<ReadonlyMap<string, Buffer>> {
  const ids = [...new Set(entries.map(entry => entry.oid))], blobs = new Map<string, Buffer>();
  if (!ids.length) return blobs;
  const input = Buffer.from(`${ids.join("\n")}\n`);
  const sizes = decode((await workflowGit(root, ["cat-file", "--batch-check"], { input })).stdout).trimEnd().split("\n");
  requireApply(sizes.length === ids.length, "workflow_git_apply_blob_invalid");
  let total = 0;
  for (let i = 0; i < sizes.length; i++) {
    const [id, type, rawSize] = sizes[i].split(" "), size = Number(rawSize);
    requireApply(id === ids[i] && type === "blob" && /^\d+$/u.test(rawSize) && Number.isSafeInteger(size)
      && size <= maxFileBytes && (total += size) <= maxTreeBytes, "workflow_git_apply_blob_budget_exceeded");
  }
  const output = (await workflowGit(root, ["cat-file", "--batch"], { input })).stdout;
  let offset = 0;
  for (let i = 0; i < ids.length; i++) {
    const end = output.indexOf(10, offset);
    requireApply(end >= offset && decode(output.subarray(offset, end)) === sizes[i], "workflow_git_apply_blob_invalid");
    const size = Number(sizes[i].split(" ")[2]), start = end + 1, bytes = output.subarray(start, start + size);
    requireApply(bytes.length === size && output[start + size] === 10, "workflow_git_apply_blob_invalid");
    requireApply(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(decode(bytes)), "workflow_git_apply_binary_unsupported");
    blobs.set(ids[i], bytes);
    offset = start + size + 1;
  }
  requireApply(offset === output.length, "workflow_git_apply_blob_invalid");
  return blobs;
}

async function readRegularFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    requireApply(before.isFile() && before.nlink === 1n && before.size <= BigInt(maxFileBytes), "workflow_git_apply_worktree_file_unsupported");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    requireApply(count === Number(before.size) && before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && after.nlink === 1n && after.mode === before.mode
      && current.dev === after.dev && current.ino === after.ino && current.isFile() && current.nlink === 1n
      && current.size === after.size && current.mode === after.mode && current.mtimeNs === after.mtimeNs && current.ctimeNs === after.ctimeNs,
    "workflow_git_apply_file_changed_during_observation");
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}

function sameIdentity(expected: WorkflowGitRepository, actual: WorkflowGitRepository): boolean {
  // HEAD and dirtiness are observed separately so recovery can report the real candidate state.
  return workflowGitRepositoryBasisDigest(expected)
    === workflowGitRepositoryBasisDigest({ ...actual, head: expected.head, dirty: expected.dirty });
}
function unavailable(code: string): WorkflowGitApplyObservation { return { state: "unavailable", verifiedClean: false, code }; }
function codeOf(cause: unknown, fallback: string): string { return cause instanceof WorkflowGitError ? cause.code : fallback; }
async function gitText(root: string, args: readonly string[]): Promise<string> { return decode((await workflowGit(root, args)).stdout).trim(); }
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new WorkflowGitError("workflow_git_non_utf8_unsupported", { cause }); }
}
function nulRecords(bytes: Buffer): string[] {
  requireApply(!bytes.length || bytes.at(-1) === 0, "workflow_git_apply_records_invalid");
  return bytes.length ? decode(bytes.subarray(0, -1)).split("\0") : [];
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
