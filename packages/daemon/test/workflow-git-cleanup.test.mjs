import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree,
  withWorkflowGitRepositoryLock } from "../dist/features/workspaces/workflow-git-repository.js";
import { cleanupWorkflowGitWorktree, observeWorkflowGitCleanup } from "../dist/features/workspaces/workflow-git-cleanup.js";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
const text = async (root, ...args) => (await workflowGit(root, args)).stdout.toString().trim();
const registrations = root => text(root, "worktree", "list", "--porcelain", "-z");
const refs = root => text(root, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "ling-workflow-cleanup-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repository"), worktreeRoot = join(base, "worktrees");
  await mkdir(root); await mkdir(worktreeRoot);
  const git = (...args) => text(root, ...args);
  await git("init", "--initial-branch=main", "--template=");
  await writeFile(join(root, "owned.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\ncache/\n");
  await git("add", "--all"); await git("commit", "-m", "fixture base");
  const repository = await inspectWorkflowGitRepository(root);
  const plan = (worktreeId, stepId = "step-one") => planWorkflowGitWorktree({ repository, worktreeRoot,
    roundId: "round-one", stepId, generation: 1, worktreeId });
  const scope = await plan("owned"), creationReceipt = await createWorkflowGitWorktree(scope);
  const tree = await git("rev-parse", `${repository.head}^{tree}`);
  const resultCommit = (await workflowGit(root, ["commit-tree", tree, "-p", repository.head],
    { input: Buffer.from("retained result\n") })).stdout.toString().trim();
  const retainedRefs = [{ ref: "refs/ling/workflow/round-one/result", commit: resultCommit },
    { ref: "refs/ling/workflow/round-one/base", commit: repository.head }];
  for (const retained of retainedRefs) await git("update-ref", retained.ref, retained.commit);
  const target = { scope, creationReceipt, retainedRefs }, intents = [], receipts = [];
  const input = (overrides = {}) => ({ ...target, assertCurrentAuthority() {},
    beforeRemove() { intents.push("created"); }, afterRemove(observation) { receipts.push(observation); }, ...overrides });
  return { base, root, repository, worktreeRoot, scope, creationReceipt, resultCommit, retainedRefs, target,
    intents, receipts, input, git, plan };
}

async function assertStillPresent(f) {
  const stat = await lstat(f.scope.executionRoot, { bigint: true });
  assert.equal(String(stat.dev), f.creationReceipt.rootDevice);
  assert.equal(String(stat.ino), f.creationReceipt.rootInode);
  assert.equal((await registrations(f.root)).includes(`worktree ${f.scope.executionRoot}\0`), true);
  assert.equal(await f.git("rev-parse", f.scope.branchRef), f.repository.head);
}

test("clean owned removal journals once, preserves all refs and leaves target/sibling WIP intact", native, async t => {
  const f = await fixture(t), sibling = await f.plan("sibling", "step-two");
  await createWorkflowGitWorktree(sibling);
  await f.git("commit", "--allow-empty", "-m", "target already applied");
  for (const root of [f.root, sibling.executionRoot]) {
    await writeFile(join(root, "owned.txt"), `tracked WIP at ${root}\n`);
    await writeFile(join(root, "untracked.txt"), "untracked WIP\n");
    await writeFile(join(root, "ignored.txt"), "ignored WIP\n");
  }
  const snapshot = async root => ({ head: await text(root, "rev-parse", "HEAD"),
    branch: await text(root, "symbolic-ref", "HEAD"),
    status: await text(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"),
    files: await Promise.all(["owned.txt", "untracked.txt", "ignored.txt"].map(name => readFile(join(root, name), "utf8"))) });
  const targetBefore = await snapshot(f.root), siblingBefore = await snapshot(sibling.executionRoot), refsBefore = await refs(f.root);
  const present = await observeWorkflowGitCleanup(f.target);
  assert.equal(present.state, "present");
  assert.equal(present.verifiedClean, true);
  assert.equal(present.retainedRefsVerified, true);
  assert.deepEqual(present.worktree, f.creationReceipt);
  const events = [], lock = join(f.repository.commonDir, "ling-workflow-git.lock");
  const result = await cleanupWorkflowGitWorktree(f.input({ assertCurrentAuthority() { events.push("authority"); },
    async beforeRemove() {
      events.push("intent");
      await access(join(lock, "owner.json"));
      await assertStillPresent(f);
      await writeFile(join(f.base, "intent.json"), JSON.stringify(f.target));
    }, async afterRemove(observation) {
      assert.equal(observation.state, "removed");
      assert.equal(observation.pathPresent, false);
      assert.equal(observation.registered, false);
      assert.equal(observation.retainedRefsVerified, true);
      assert.equal(Object.isFrozen(observation), true);
      assert.equal(Object.isFrozen(observation.retainedRefs[0]), true);
      await access(join(lock, "owner.json"));
      await assert.rejects(access(f.scope.executionRoot), { code: "ENOENT" });
      assert.equal((await registrations(f.root)).includes(`worktree ${f.scope.executionRoot}\0`), false);
      assert.equal(await refs(f.root), refsBefore);
      await writeFile(join(f.base, "receipt.json"), JSON.stringify(observation));
      events.push("receipt");
    } }));
  assert.equal(result.status, "removed", JSON.stringify(result));
  assert.deepEqual(events, ["authority", "intent", "authority", "authority", "receipt"]);
  for (const key of ["executionRoot", "worktreeId", "branchRef"]) assert.equal(result.observation[key], f.scope[key]);
  assert.equal(result.observation.commonDir, f.repository.commonDir);
  assert.deepEqual(result.observation.retainedRefs, f.retainedRefs);
  assert.deepEqual(await snapshot(f.root), targetBefore);
  assert.deepEqual(await snapshot(sibling.executionRoot), siblingBefore);
  assert.equal(await refs(f.root), refsBefore);
  assert.equal(JSON.parse(await readFile(join(f.base, "receipt.json"), "utf8")).state, "removed");
  await assert.rejects(access(lock), { code: "ENOENT" });
});

test("dirty tracked, untracked and ignored files all block before a cleanup intent", native, async t => {
  for (const kind of ["tracked", "untracked", "ignored", "ignored-directory"]) await t.test(kind, async t => {
    const f = await fixture(t), path = kind === "tracked" ? "owned.txt" : kind === "untracked" ? "new.txt"
      : kind === "ignored" ? "ignored.txt" : "cache/private.txt";
    await mkdir(join(f.scope.executionRoot, path, ".."), { recursive: true });
    await writeFile(join(f.scope.executionRoot, path), "preserve this work\n");
    const before = await refs(f.root), observed = await observeWorkflowGitCleanup(f.target);
    assert.equal(observed.state, "unknown");
    assert.equal(observed.verifiedClean, false);
    const result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(f.intents, []); assert.deepEqual(f.receipts, []);
    assert.equal(await readFile(join(f.scope.executionRoot, path), "utf8"), "preserve this work\n");
    assert.equal(await refs(f.root), before);
    await assertStillPresent(f);
  });
});

test("index flags cannot conceal dirty tracked contents", native, async t => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) await t.test(flag, async t => {
    const f = await fixture(t);
    await workflowGit(f.scope.executionRoot, ["update-index", flag, "--", "owned.txt"]);
    await writeFile(join(f.scope.executionRoot, "owned.txt"), "hidden WIP\n");
    assert.equal(await text(f.scope.executionRoot, "status", "--porcelain"), "");
    const result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, "workflow_git_cleanup_index_flags_unsupported");
    assert.equal(f.intents.length, 0);
    assert.equal(await readFile(join(f.scope.executionRoot, "owned.txt"), "utf8"), "hidden WIP\n");
    await assertStillPresent(f);
  });
});

test("complete callbacks, creation receipt, derived scope and nonempty exact recovery refs are required", native, async t => {
  const f = await fixture(t);
  const cases = [
    { creationReceipt: undefined },
    { creationReceipt: { ...f.creationReceipt, worktreeId: "foreign" } },
    { creationReceipt: { ...f.creationReceipt, rootInode: "0" } },
    { scope: { ...f.scope, executionRoot: f.root } },
    { scope: { ...f.scope, branchRef: "refs/heads/main" } },
    { scope: { ...f.scope, baseCommit: f.resultCommit } },
    { creationReceipt: { ...f.creationReceipt, commonDir: f.base } },
    { retainedRefs: [] },
    { retainedRefs: [{ ref: f.scope.branchRef, commit: f.repository.head }] },
    { retainedRefs: [f.retainedRefs[0], f.retainedRefs[0]] },
    { retainedRefs: [{ ref: "refs/invalid..ref", commit: f.resultCommit }] },
    ...["assertCurrentAuthority", "beforeRemove", "afterRemove"].map(key => ({ [key]: undefined })),
    { assertCurrentAuthority: () => true },
    { assertCurrentAuthority: () => false },
    { assertCurrentAuthority: async () => {} },
    { assertCurrentAuthority: () => Promise.reject(new Error("not synchronous authority")) },
    { assertCurrentAuthority() { throw new Error("owner revoked"); } },
  ];
  for (const overrides of cases) {
    const result = await cleanupWorkflowGitWorktree(f.input(overrides));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(f.intents.length, 0); assert.equal(f.receipts.length, 0);
  }
  await assertStillPresent(f);
});

test("symlink paths and replaced clean directory inodes never inherit the creation receipt", native, async t => {
  for (const kind of ["symlink", "replaced"]) await t.test(kind, async t => {
    const f = await fixture(t), retained = join(f.base, "preserved-original");
    await rename(f.scope.executionRoot, retained);
    if (kind === "symlink") await symlink(retained, f.scope.executionRoot);
    else await cp(retained, f.scope.executionRoot, { recursive: true });
    const result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, kind === "symlink" ? "workflow_git_cleanup_worktree_not_canonical"
      : "workflow_git_cleanup_worktree_identity_changed");
    assert.equal(f.intents.length, 0); assert.equal(f.receipts.length, 0);
    assert.equal(await readFile(join(retained, "owned.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(f.scope.executionRoot, "owned.txt"), "utf8"), "base\n");
  });
});

test("ref drift, missing refs and symbolic aliases fail closed without removing any other ref", native, async t => {
  for (const kind of ["drift", "missing", "symbolic", "worktree-branch"]) await t.test(kind, async t => {
    const f = await fixture(t), ref = f.retainedRefs[0].ref;
    if (kind === "drift") await f.git("update-ref", ref, f.repository.head);
    if (kind === "missing") await f.git("update-ref", "-d", ref);
    if (kind === "symbolic") await f.git("symbolic-ref", ref, "refs/heads/main");
    if (kind === "worktree-branch") await f.git("update-ref", f.scope.branchRef, f.resultCommit);
    const before = await refs(f.root), result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, "workflow_git_cleanup_retained_ref_changed");
    assert.equal(result.observation.state, "unknown");
    assert.equal(result.observation.retainedRefsVerified, false);
    assert.equal(f.intents.length, 0); assert.equal(f.receipts.length, 0);
    assert.equal(await refs(f.root), before);
    if (kind === "worktree-branch") {
      await access(f.scope.executionRoot);
      assert.equal(await f.git("rev-parse", f.scope.branchRef), f.resultCommit);
    } else await assertStillPresent(f);
  });
});

test("locked, foreign and relocated registrations cannot be adopted or reported removed", native, async t => {
  for (const kind of ["locked", "foreign-branch", "foreign-gitdir", "relocated", "missing-directory"]) await t.test(kind, async t => {
    const f = await fixture(t), moved = join(f.worktreeRoot, "moved");
    if (kind === "locked") await f.git("worktree", "lock", "--reason", "another owner", "--", f.scope.executionRoot);
    if (kind === "foreign-branch") {
      await f.git("branch", "foreign", f.repository.head);
      await workflowGit(f.scope.executionRoot, ["symbolic-ref", "HEAD", "refs/heads/foreign"]);
    }
    if (kind === "foreign-gitdir") {
      const sibling = await f.plan("foreign", "step-two");
      await createWorkflowGitWorktree(sibling);
      await writeFile(join(f.scope.executionRoot, ".git"), await readFile(join(sibling.executionRoot, ".git")));
    }
    if (kind === "relocated") await f.git("worktree", "move", "--", f.scope.executionRoot, moved);
    if (kind === "missing-directory") await rename(f.scope.executionRoot, moved);
    const before = await registrations(f.root), refsBefore = await refs(f.root);
    const observation = await observeWorkflowGitCleanup(f.target);
    assert.equal(observation.state, "unknown", JSON.stringify(observation));
    assert.equal(observation.verifiedClean, false);
    const result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, ["relocated", "missing-directory"].includes(kind) ? "unknown" : "blocked", JSON.stringify(result));
    assert.notEqual(result.observation.state, "removed");
    assert.equal(f.intents.length, 0); assert.equal(f.receipts.length, 0);
    assert.equal(await registrations(f.root), before);
    assert.equal(await refs(f.root), refsBefore);
    assert.equal(await readFile(join(["relocated", "missing-directory"].includes(kind) ? moved : f.scope.executionRoot, "owned.txt"), "utf8"), "base\n");
  });
});

test("a failed or pre-existing durable intent never authorizes the physical effect", native, async t => {
  const f = await fixture(t), before = await registrations(f.root), refsBefore = await refs(f.root);
  for (const beforeRemove of [() => { throw new Error("journal write failed"); },
    () => { throw new Error("intent already exists; reconcile only"); }, () => true]) {
    const result = await cleanupWorkflowGitWorktree(f.input({ beforeRemove }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.code, "workflow_git_cleanup_intent_failed");
    assert.equal(f.receipts.length, 0);
    await assertStillPresent(f);
  }
  assert.equal(await registrations(f.root), before);
  assert.equal(await refs(f.root), refsBefore);
});

test("the full physical preflight and current authority are rechecked after intent persistence", native, async t => {
  for (const kind of ["ignored", "inode", "ref", "locked", "authority"]) await t.test(kind, async t => {
    const f = await fixture(t);
    let current = true;
    const result = await cleanupWorkflowGitWorktree(f.input({ assertCurrentAuthority() {
      if (!current) throw new Error("owner fenced after intent");
    }, async beforeRemove() {
      f.intents.push("created");
      if (kind === "ignored") await writeFile(join(f.scope.executionRoot, "ignored.txt"), "new ignored WIP\n");
      if (kind === "inode") {
        const original = join(f.base, "preserved-original");
        await rename(f.scope.executionRoot, original);
        await cp(original, f.scope.executionRoot, { recursive: true });
      }
      if (kind === "ref") await f.git("update-ref", f.retainedRefs[0].ref, f.repository.head);
      if (kind === "locked") await f.git("worktree", "lock", "--", f.scope.executionRoot);
      if (kind === "authority") current = false;
    } }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(f.intents.length, 1); assert.equal(f.receipts.length, 0);
    assert.equal(await readFile(join(f.scope.executionRoot, "owned.txt"), "utf8"), "base\n");
    assert.equal((await registrations(f.root)).includes(`worktree ${f.scope.executionRoot}\0`), true);
  });
});

test("receipt journal failure or stale post-effect authority returns fresh physical evidence without rollback", native, async t => {
  for (const kind of ["journal", "invalid-return", "authority"]) await t.test(kind, async t => {
    const f = await fixture(t), refsBefore = await refs(f.root);
    let checks = 0, receipts = 0;
    const result = await cleanupWorkflowGitWorktree(f.input({ assertCurrentAuthority() {
      if (++checks === 3 && kind === "authority") throw new Error("owner fenced after removal");
    }, afterRemove() {
      receipts++;
      if (kind === "invalid-return") return true;
      throw new Error("receipt write failed");
    } }));
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.code, kind === "authority" ? "workflow_git_cleanup_authority_rejected" : "workflow_git_cleanup_receipt_failed");
    assert.equal(result.observation.state, "removed");
    assert.equal(result.observation.pathPresent, false); assert.equal(result.observation.registered, false);
    assert.equal(result.observation.retainedRefsVerified, true);
    assert.equal(receipts, kind === "authority" ? 0 : 1);
    assert.equal(await refs(f.root), refsBefore);
    await assert.rejects(access(f.scope.executionRoot), { code: "ENOENT" });
    const repeated = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(repeated.status, "unknown");
    assert.equal(repeated.code, "workflow_git_cleanup_requires_reconciliation");
    assert.equal(f.intents.length, 1); assert.equal(f.receipts.length, 0);
  });
});

test("a late untracked mutation from the final authority callback is retained before removal", native, async t => {
  const f = await fixture(t);
  let checks = 0;
  const result = await cleanupWorkflowGitWorktree(f.input({ assertCurrentAuthority() {
    if (++checks === 2) writeFileSync(join(f.scope.executionRoot, "late-untracked.txt"), "preserve late user work\n");
  } }));
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.code, "workflow_git_target_dirty");
  assert.equal(result.observation.state, "unknown");
  assert.equal(result.observation.pathPresent, true); assert.equal(result.observation.registered, true);
  assert.equal(result.observation.verifiedClean, false);
  assert.equal(f.intents.length, 1); assert.equal(f.receipts.length, 0);
  assert.equal(await readFile(join(f.scope.executionRoot, "late-untracked.txt"), "utf8"), "preserve late user work\n");
  await assertStillPresent(f);
});

test("an ignored file introduced by the final authority callback is retained before removal", native, async t => {
  const f = await fixture(t);
  let checks = 0;
  const result = await cleanupWorkflowGitWorktree(f.input({ assertCurrentAuthority() {
    if (++checks === 2) writeFileSync(join(f.scope.executionRoot, "ignored.txt"), "preserve late ignored work\n");
  } }));
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.code, "workflow_git_cleanup_worktree_dirty");
  assert.equal(f.intents.length, 1); assert.equal(f.receipts.length, 0);
  assert.equal(await readFile(join(f.scope.executionRoot, "ignored.txt"), "utf8"), "preserve late ignored work\n");
  await assertStillPresent(f);
});

test("observe takes the repository lock; repeated/reopened absence is evidence only, never an intent replay", native, async t => {
  const f = await fixture(t);
  await withWorkflowGitRepositoryLock(f.repository, async () => {
    const observed = await observeWorkflowGitCleanup(f.target);
    assert.equal(observed.state, "unknown");
    assert.equal(observed.code, "workflow_git_repository_busy");
    const result = await cleanupWorkflowGitWorktree(f.input());
    assert.equal(result.status, "blocked"); assert.equal(result.code, "workflow_git_repository_busy");
    assert.equal(f.intents.length, 0); assert.equal(f.receipts.length, 0);
  });
  assert.equal((await cleanupWorkflowGitWorktree(f.input())).status, "removed");
  const before = await registrations(f.root), refsBefore = await refs(f.root);
  const reopened = await import("../dist/features/workspaces/workflow-git-cleanup.js?reopen-cleanup");
  const target = JSON.parse(JSON.stringify(f.target));
  assert.equal((await reopened.observeWorkflowGitCleanup(target)).state, "removed");
  const repeated = await reopened.cleanupWorkflowGitWorktree({ ...target, assertCurrentAuthority() { assert.fail("no new authority"); },
    beforeRemove() { assert.fail("no intent replay"); }, afterRemove() { assert.fail("no receipt replay"); } });
  assert.equal(repeated.status, "unknown"); assert.equal(repeated.code, "workflow_git_cleanup_requires_reconciliation");
  assert.equal(repeated.observation.state, "removed");
  assert.equal(f.intents.length, 1); assert.equal(f.receipts.length, 1);
  assert.equal(await registrations(f.root), before); assert.equal(await refs(f.root), refsBefore);
  await f.git("update-ref", f.retainedRefs[0].ref, f.repository.head);
  assert.equal((await observeWorkflowGitCleanup(f.target)).state, "unknown", "absence alone is not a removed proof");
});

test("cleanup releases one physical creation slot at the 16-registration budget without deleting the old branch", native, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 14; index++) await f.git("worktree", "add", "--detach", "--",
    join(f.worktreeRoot, `budget-${index}`), f.repository.head);
  const count = async () => (await registrations(f.root)).split("\0").filter(record => record.startsWith("worktree ")).length;
  assert.equal(await count(), 16);
  const next = await f.plan("replacement", "step-next");
  await assert.rejects(createWorkflowGitWorktree(next), { code: "workflow_git_worktree_budget_exceeded" });
  await assert.rejects(access(next.executionRoot), { code: "ENOENT" });
  await assert.rejects(f.git("show-ref", "--verify", next.branchRef));
  const refsBefore = await refs(f.root);
  assert.equal((await cleanupWorkflowGitWorktree(f.input())).status, "removed");
  assert.equal(await count(), 15); assert.equal(await refs(f.root), refsBefore);
  const created = await createWorkflowGitWorktree(next);
  assert.equal(created.worktreeId, next.worktreeId); assert.equal(await count(), 16);
  assert.equal(await f.git("rev-parse", f.scope.branchRef), f.repository.head);
  for (const retained of f.retainedRefs) assert.equal(await f.git("rev-parse", retained.ref), retained.commit);
  assert.equal(await readFile(join(created.executionRoot, "owned.txt"), "utf8"), "base\n");
});
