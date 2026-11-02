import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { workflowGit } from "./managed-worktrees.js";
import { WorkflowGitError, inspectWorkflowGitRepository, planWorkflowGitWorktree, reconcileWorkflowGitWorktree,
  withWorkflowGitRepositoryLock, workflowGitRepositoryBasisDigest,
  type WorkflowGitWorktreeReceipt, type WorkflowGitWorktreeScope } from "./workflow-git-repository.js";

export interface WorkflowGitCleanupRef { readonly ref: string; readonly commit: string }

/** Physical identities only. Terminal/quiescent eligibility and durable cleanup authority belong to the Host. */
export interface WorkflowGitCleanupTarget {
  readonly scope: WorkflowGitWorktreeScope;
  readonly creationReceipt: WorkflowGitWorktreeReceipt;
  readonly retainedRefs: readonly WorkflowGitCleanupRef[];
}

export interface WorkflowGitCleanupObservation {
  readonly state: "removed" | "present" | "unknown";
  readonly executionRoot: string;
  readonly worktreeId: string;
  readonly branchRef: string;
  readonly commonDir: string;
  readonly retainedRefs: readonly WorkflowGitCleanupRef[];
  readonly pathPresent?: boolean;
  readonly registered?: boolean;
  readonly verifiedClean: boolean;
  readonly retainedRefsVerified: boolean;
  readonly worktree?: WorkflowGitWorktreeReceipt;
  readonly code?: string;
}

export interface WorkflowGitCleanupInput extends WorkflowGitCleanupTarget {
  /** Recheck current durable owner/fence, terminal evidence and retention policy synchronously. */
  readonly assertCurrentAuthority: () => void;
  /** Persist a newly created exact intent; existing/pending intents must throw for Host reconciliation. */
  readonly beforeRemove: () => void | Promise<void>;
  /** Persist this call's verified removal only; failure never triggers rollback or journal replay. */
  readonly afterRemove: (observation: WorkflowGitCleanupObservation) => void | Promise<void>;
}

export type WorkflowGitCleanupResult =
  | { readonly status: "removed"; readonly observation: WorkflowGitCleanupObservation }
  | { readonly status: "blocked"; readonly code: string; readonly observation?: WorkflowGitCleanupObservation; readonly cause?: unknown }
  | { readonly status: "unknown"; readonly code: string; readonly observation: WorkflowGitCleanupObservation; readonly cause?: unknown };

interface Registration { readonly fields: ReadonlyMap<string, string>; readonly path: string }
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const requireCleanup: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowGitError(code);
};

/** Host-only no-force mechanism. An observation, receipt or caller boolean is never durable authority. */
export async function cleanupWorkflowGitWorktree(input: WorkflowGitCleanupInput): Promise<WorkflowGitCleanupResult> {
  let attempted = false, needsReconciliation = false, observation: WorkflowGitCleanupObservation | undefined;
  try {
    const target = snapshotTarget(input);
    const { assertCurrentAuthority, beforeRemove, afterRemove } = input;
    requireCleanup([assertCurrentAuthority, beforeRemove, afterRemove].every(value => typeof value === "function"),
      "workflow_git_cleanup_callbacks_required");
    const checkAuthority = () => {
      let returned: unknown;
      try { returned = assertCurrentAuthority(); }
      catch (cause) { throw new WorkflowGitError("workflow_git_cleanup_authority_rejected", { cause }); }
      if (returned && typeof (returned as { then?: unknown }).then === "function") {
        void Promise.resolve(returned).catch(() => undefined);
      }
      requireCleanup(returned === undefined, "workflow_git_cleanup_authority_must_be_synchronous");
    };
    return await withWorkflowGitRepositoryLock<WorkflowGitCleanupResult>(target.scope.repository, async () => {
      observation = await observeLocked(target);
      if (observation.pathPresent === false) {
        needsReconciliation = true;
        return { status: "unknown", code: "workflow_git_cleanup_requires_reconciliation", observation };
      }
      requirePresent(observation);
      checkAuthority();
      try { requireCleanup(await beforeRemove() === undefined, "workflow_git_cleanup_intent_return_invalid"); }
      catch (cause) { throw new WorkflowGitError("workflow_git_cleanup_intent_failed", { cause }); }

      // Journal persistence can yield or change the physical identity. Recheck everything under the same lock.
      observation = await observeLocked(target);
      if (observation.pathPresent === false) {
        needsReconciliation = true;
        return { status: "unknown", code: "workflow_git_cleanup_requires_reconciliation", observation };
      }
      requirePresent(observation);
      checkAuthority();
      // Caller code may change files. No Host callback runs after this final ignored-inclusive inspection.
      observation = await observeLocked(target);
      if (observation.pathPresent === false) {
        needsReconciliation = true;
        return { status: "unknown", code: "workflow_git_cleanup_requires_reconciliation", observation };
      }
      requirePresent(observation);
      attempted = true;
      try {
        await workflowGit(target.scope.repository.root, ["worktree", "remove", "--", target.scope.executionRoot]);
        observation = await observeLocked(target);
        requireCleanup(observation.state === "removed" && observation.pathPresent === false && observation.registered === false
          && observation.retainedRefsVerified, "workflow_git_cleanup_removal_unconfirmed");
        checkAuthority();
        try { requireCleanup(await afterRemove(observation) === undefined, "workflow_git_cleanup_receipt_return_invalid"); }
        catch (cause) { throw new WorkflowGitError("workflow_git_cleanup_receipt_failed", { cause }); }
        return { status: "removed", observation };
      } catch (cause) {
        observation = await observeLocked(target);
        return { status: "unknown", code: codeOf(cause, "workflow_git_cleanup_effect_uncertain"), observation, cause };
      }
    });
  } catch (cause) {
    const code = codeOf(cause, attempted ? "workflow_git_cleanup_effect_uncertain" : "workflow_git_cleanup_preflight_failed");
    return attempted || needsReconciliation
      ? { status: "unknown", code, observation: observation ?? unavailable(input, code), cause }
      : { status: "blocked", code, observation, cause };
  }
}

/** Read-only evidence for Host reconciliation, including missing directories. Never removes or writes a receipt. */
export async function observeWorkflowGitCleanup(target: WorkflowGitCleanupTarget): Promise<WorkflowGitCleanupObservation> {
  try {
    const snapshot = snapshotTarget(target);
    return await withWorkflowGitRepositoryLock(snapshot.scope.repository, () => observeLocked(snapshot));
  } catch (cause) {
    return unavailable(target, codeOf(cause, "workflow_git_cleanup_observation_failed"));
  }
}

function snapshotTarget(input: WorkflowGitCleanupTarget): WorkflowGitCleanupTarget {
  const scope = input?.scope, receipt = input?.creationReceipt;
  requireCleanup(scope && scope.repository && receipt && objectId.test(scope.baseCommit)
    && scope.repository.head === scope.baseCommit && [scope.executionRoot, scope.worktreeRoot,
      scope.repository.root, scope.repository.commonDir, scope.repository.gitDir].every(path =>
      typeof path === "string" && isAbsolute(path) && path === resolve(path)), "workflow_git_cleanup_scope_invalid");
  requireCleanup(receipt.worktreeId === scope.worktreeId && receipt.executionRoot === scope.executionRoot
    && receipt.branchRef === scope.branchRef && receipt.baseCommit === scope.baseCommit
    && receipt.commonDir === scope.repository.commonDir
    && [receipt.rootDevice, receipt.rootInode].every(value => typeof value === "string" && /^\d+$/u.test(value)),
  "workflow_git_cleanup_creation_receipt_mismatch");
  requireCleanup(Array.isArray(input.retainedRefs) && input.retainedRefs.length > 0, "workflow_git_cleanup_retained_refs_required");
  const seen = new Set<string>();
  const retainedRefs = input.retainedRefs.map(value => {
    requireCleanup(value && typeof value.ref === "string" && value.ref.startsWith("refs/")
      && !/[\x00-\x20\x7f]/u.test(value.ref) && value.ref !== scope.branchRef && !seen.has(value.ref)
      && typeof value.commit === "string" && objectId.test(value.commit) && value.commit.length === scope.baseCommit.length,
    "workflow_git_cleanup_retained_ref_invalid");
    seen.add(value.ref);
    return Object.freeze({ ref: value.ref, commit: value.commit });
  });
  const hostState = scope.repository.hostState;
  return Object.freeze({ scope: Object.freeze({ ...scope, repository: Object.freeze({ ...scope.repository,
    ...(hostState ? { hostState: Object.freeze({ ...hostState }) } : {}) }) }),
  creationReceipt: Object.freeze({ ...receipt }), retainedRefs: Object.freeze(retainedRefs) });
}

async function observeLocked(target: WorkflowGitCleanupTarget): Promise<WorkflowGitCleanupObservation> {
  const { scope, creationReceipt, retainedRefs } = target;
  let pathPresent: boolean | undefined, registered: boolean | undefined, retainedRefsVerified = false;
  try {
    const planned = await planWorkflowGitWorktree(scope);
    requireCleanup(planned.executionRoot === scope.executionRoot && planned.branchRef === scope.branchRef
      && planned.baseCommit === scope.baseCommit, "workflow_git_cleanup_scope_invalid");
    const expected = scope.repository;
    requireCleanup(await realpath(expected.commonDir) === expected.commonDir, "workflow_git_cleanup_repository_changed");
    const current = await inspectWorkflowGitRepository(expected.root, { allowDirtyCandidate: true, hostStateRoot: expected.hostState?.root });
    // Cleanup after merge may observe a new target HEAD or user WIP, but never a different repository/configuration.
    requireCleanup(workflowGitRepositoryBasisDigest(expected) === workflowGitRepositoryBasisDigest({ ...current,
      head: expected.head, dirty: expected.dirty }), "workflow_git_cleanup_repository_changed");
    const entries = await registrations(expected.root);
    const matches = entries.filter(entry => entry.path === scope.executionRoot);
    registered = matches.length !== 0;
    const rootStat = await lstat(scope.executionRoot, { bigint: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    pathPresent = rootStat !== undefined;
    const branchMatches = entries.filter(entry => entry.fields.get("branch") === scope.branchRef);
    requireCleanup(matches.length <= 1 && branchMatches.length === matches.length
      && branchMatches.every(entry => entry.path === scope.executionRoot), "workflow_git_cleanup_registration_mismatch");
    await verifyRef(expected.root, { ref: scope.branchRef, commit: scope.baseCommit });
    for (const ref of retainedRefs) await verifyRef(expected.root, ref);
    retainedRefsVerified = true;
    if (!rootStat && !registered) return Object.freeze({ state: "removed", ...observationIdentity(target),
      pathPresent: false, registered: false, verifiedClean: false, retainedRefsVerified });
    requireCleanup(rootStat, "workflow_git_cleanup_worktree_missing");
    requireCleanup(rootStat.isDirectory() && !rootStat.isSymbolicLink() && await realpath(scope.executionRoot) === scope.executionRoot,
      "workflow_git_cleanup_worktree_not_canonical");
    requireCleanup(String(rootStat.dev) === creationReceipt.rootDevice && String(rootStat.ino) === creationReceipt.rootInode,
      "workflow_git_cleanup_worktree_identity_changed");
    const entry = matches[0];
    requireCleanup(matches.length === 1 && entry && entries[0] !== entry && !entry.fields.has("bare")
      && !entry.fields.has("detached") && entry.fields.get("HEAD") === scope.baseCommit && entry.fields.get("branch") === scope.branchRef,
    "workflow_git_cleanup_registration_mismatch");
    requireCleanup(!entry.fields.has("locked") && !entry.fields.has("prunable"), "workflow_git_cleanup_registration_unavailable");
    await verifyRegistrationLink(scope);
    const receipt = await reconcileWorkflowGitWorktree(scope);
    requireCleanup(receipt.rootDevice === creationReceipt.rootDevice && receipt.rootInode === creationReceipt.rootInode,
      "workflow_git_cleanup_worktree_identity_changed");
    requireCleanup((await workflowGit(scope.executionRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).stdout.length === 0,
    "workflow_git_cleanup_worktree_dirty");
    requireCleanup(decode((await workflowGit(scope.executionRoot, ["ls-files", "-v", "-z"])).stdout)
      .split("\0").filter(Boolean).every(entry => entry.startsWith("H ")), "workflow_git_cleanup_index_flags_unsupported");
    return Object.freeze({ state: "present", ...observationIdentity(target), pathPresent: true, registered: true,
      verifiedClean: true, retainedRefsVerified, worktree: Object.freeze(receipt) });
  } catch (cause) {
    return Object.freeze({ state: "unknown", ...observationIdentity(target), pathPresent, registered,
      verifiedClean: false, retainedRefsVerified, code: codeOf(cause, "workflow_git_cleanup_observation_failed") });
  }
}

async function verifyRegistrationLink(scope: WorkflowGitWorktreeScope): Promise<void> {
  const gitDir = decode((await workflowGit(scope.executionRoot, ["rev-parse", "--absolute-git-dir"])).stdout).trim();
  requireCleanup(dirname(gitDir) === join(scope.repository.commonDir, "worktrees") && await realpath(gitDir) === gitDir
    && (await lstat(gitDir)).isDirectory(), "workflow_git_cleanup_registration_mismatch");
  const dotGit = join(scope.executionRoot, ".git");
  requireCleanup(await metadataText(dotGit) === `gitdir: ${gitDir}\n`
    && await metadataText(join(gitDir, "gitdir")) === `${dotGit}\n`, "workflow_git_cleanup_registration_mismatch");
}

async function metadataText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    requireCleanup(stat.isFile() && stat.nlink === 1 && stat.size <= 16384, "workflow_git_cleanup_registration_mismatch");
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    requireCleanup(count === stat.size, "workflow_git_cleanup_registration_mismatch");
    return decode(bytes.subarray(0, count));
  } finally { await file.close(); }
}

async function verifyRef(root: string, expected: WorkflowGitCleanupRef): Promise<void> {
  try {
    await workflowGit(root, ["check-ref-format", expected.ref]);
    const output = decode((await workflowGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      expected.ref])).stdout);
    requireCleanup(output === `${expected.ref}\0${expected.commit}\0commit\0\n`, "workflow_git_cleanup_retained_ref_changed");
  } catch (cause) { throw new WorkflowGitError("workflow_git_cleanup_retained_ref_changed", { cause }); }
}

async function registrations(root: string): Promise<readonly Registration[]> {
  const text = decode((await workflowGit(root, ["worktree", "list", "--porcelain", "-z"])).stdout);
  requireCleanup(text.endsWith("\0\0"), "workflow_git_cleanup_registration_invalid");
  return text.slice(0, -2).split("\0\0").map(record => {
    const fields = new Map<string, string>();
    for (const field of record.split("\0")) {
      const split = field.indexOf(" "), key = split < 0 ? field : field.slice(0, split), value = split < 0 ? "" : field.slice(split + 1);
      requireCleanup(key && !fields.has(key), "workflow_git_cleanup_registration_invalid");
      fields.set(key, value);
    }
    const path = fields.get("worktree");
    requireCleanup(path && isAbsolute(path), "workflow_git_cleanup_registration_invalid");
    return { path, fields };
  });
}

function requirePresent(observation: WorkflowGitCleanupObservation): void {
  requireCleanup(observation.state === "present" && observation.verifiedClean && observation.retainedRefsVerified,
    observation.code ?? "workflow_git_cleanup_worktree_unavailable");
}
function observationIdentity(target: WorkflowGitCleanupTarget) {
  return { executionRoot: target?.scope?.executionRoot ?? "", worktreeId: target?.scope?.worktreeId ?? "",
    branchRef: target?.scope?.branchRef ?? "", commonDir: target?.scope?.repository?.commonDir ?? "",
    retainedRefs: Object.freeze((Array.isArray(target?.retainedRefs) ? target.retainedRefs : [])
      .filter(value => typeof value?.ref === "string" && typeof value?.commit === "string")
      .map(value => Object.freeze({ ref: value.ref, commit: value.commit }))) };
}
function unavailable(target: WorkflowGitCleanupTarget, code: string): WorkflowGitCleanupObservation {
  return Object.freeze({ state: "unknown", ...observationIdentity(target), verifiedClean: false, retainedRefsVerified: false, code });
}
function codeOf(cause: unknown, fallback: string): string { return cause instanceof WorkflowGitError ? cause.code : fallback; }
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new WorkflowGitError("workflow_git_non_utf8_unsupported", { cause }); }
}
