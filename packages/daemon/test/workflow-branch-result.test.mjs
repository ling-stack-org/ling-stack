import assert from "node:assert/strict";
import { access, chmod, link, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureWorkflowBranchResult, inspectSealedWorkflowBranchResult, WORKFLOW_BRANCH_CAPTURE_POLICY, workflowGitPacketDigest, workflowGitResultRef }
  from "../dist/features/channels/workflow-branch-result.js";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree, withQueuedWorkflowGitRepositoryLock,
  workflowGitRefExists } from "../dist/features/workspaces/workflow-git-repository.js";
import { nativeGit, workflowGitResultsFixture } from "./support/workflow-git-results-fixture.mjs";

test("eight cooperating branches create independent worktrees without treating sibling creation as a foreign lock", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t);
  const created = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => f.branch(`parallel-${index}`)));
  assert.deepEqual(created.filter(result => result.status === "rejected").map(result => result.reason.code), []);
  const branches = created.map(result => result.value);
  assert.equal(new Set(branches.map(branch => branch.scope.executionRoot)).size, 8);
  assert.equal(new Set(branches.map(branch => branch.scope.branchRef)).size, 8);
  for (const branch of branches) assert.equal(await branch.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
});

test("eight simultaneous terminal captures seal every original branch without sibling repository-busy failures", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), branches = [];
  for (let index = 0; index < 8; index++) {
    const branch = await f.branch(`capture-${index}`, ["owned.txt"]);
    await writeFile(join(branch.scope.executionRoot, "owned.txt"), `branch ${index}\n`);
    branches.push(branch);
  }
  const captures = await Promise.allSettled(branches.map(branch => branch.capture()));
  assert.deepEqual(captures.filter(result => result.status === "rejected").map(result => result.reason.code), []);
  assert.equal(new Set(captures.map(result => result.value.resultRef)).size, 8);
  for (const [index, capture] of captures.entries()) {
    const result = capture.value, branch = branches[index];
    assert.equal(await workflowGitResultRef(f.root, result.resultRef), result.commit);
    assert.equal((await f.gitAt(f.root, ["show", `${result.commit}:owned.txt`])).toString(), `branch ${index}\n`);
    assert.deepEqual(branch.journal.receipts.map(receipt => receipt.outcome), ["confirmed"]);
    assert.equal(await branch.git("rev-parse", "HEAD"), f.repository.head);
  }
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
});

test("eight queued repository operations retain FIFO ownership and drain after the first owner fails", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), entered = [], fault = new Error("fixture: first owner failed");
  let announce, release, active = 0;
  const started = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = withQueuedWorkflowGitRepositoryLock(f.repository, async () => {
    assert.equal(active++, 0);
    entered.push(0);
    announce();
    await barrier;
    active--;
    throw fault;
  });
  await started;
  const remaining = Array.from({ length: 7 }, (_, index) => withQueuedWorkflowGitRepositoryLock({ ...f.repository }, async () => {
    assert.equal(active++, 0);
    entered.push(index + 1);
    const head = await f.git("rev-parse", "HEAD");
    active--;
    return head;
  }));
  const completion = Promise.allSettled([first, ...remaining]);
  assert.deepEqual(entered, [0], "queued actors cannot enter the held physical lock");
  release();
  const outcomes = await completion;
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[0].reason, fault);
  assert.deepEqual(outcomes.slice(1), Array.from({ length: 7 }, () => ({ status: "fulfilled", value: f.repository.head })));
  assert.deepEqual(entered, Array.from({ length: 8 }, (_, index) => index));
  assert.equal(active, 0);
  assert.equal(await withQueuedWorkflowGitRepositoryLock(f.repository, async () => "next owner"), "next owner");
  await assert.rejects(access(join(f.repository.commonDir, "ling-workflow-git.lock")), { code: "ENOENT" });
});

test("a terminal fence revoked while capture is queued cannot publish a result ref", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), branch = await f.branch();
  const following = await f.branch("capture-after-revocation", ["owned.txt"]);
  await writeFile(join(following.scope.executionRoot, "owned.txt"), "healthy follower\n");
  let announce, release, observed, followingObserved, revoked = false;
  const started = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const read = new Promise(resolve => { observed = resolve; });
  const followingRead = new Promise(resolve => { followingObserved = resolve; });
  t.after(() => release());
  const held = withQueuedWorkflowGitRepositoryLock(f.repository, async () => { announce(); await barrier; });
  await started;
  const capture = branch.capture({ assertTerminalQuiescent: async () => {
    if (revoked) throw new Error("fixture: terminal fence revoked");
    observed();
    return branch.terminal;
  } });
  const refused = assert.rejects(capture, { message: "fixture: terminal fence revoked" });
  await read;
  revoked = true;
  const followingCapture = following.capture({ assertTerminalQuiescent: async () => {
    followingObserved();
    return following.terminal;
  } });
  const completion = Promise.all([held, refused, followingCapture]);
  await followingRead;
  release();
  await held;
  await refused;
  const [, , result] = await completion;
  assert.deepEqual(branch.journal.intents, []);
  assert.deepEqual(branch.journal.receipts, []);
  assert.equal(await workflowGitResultRef(f.root,
    `refs/ling/workflow/results/round-one/step-one/1-${branch.scope.worktreeId}`), null);
  assert.equal(await branch.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(result.status, "sealed");
  assert.equal(await workflowGitResultRef(f.root, result.resultRef), result.commit);
  assert.equal((await f.gitAt(f.root, ["show", `${result.commit}:owned.txt`])).toString(), "healthy follower\n");
  assert.deepEqual(following.journal.receipts.map(receipt => receipt.outcome), ["confirmed"]);
  assert.equal(await following.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await withQueuedWorkflowGitRepositoryLock(f.repository, async () => "next owner"), "next owner");
  await assert.rejects(access(join(f.repository.commonDir, "ling-workflow-git.lock")), { code: "ENOENT" });
});

test("a create guard revoked while queued leaves no worktree or ref and lets its healthy follower drain", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t);
  const plan = { repository: f.repository, worktreeRoot: f.worktreeRoot, roundId: "round-one", generation: 1 };
  const scope = await planWorkflowGitWorktree({ ...plan, stepId: "revoked-create" });
  const followingScope = await planWorkflowGitWorktree({ ...plan, stepId: "create-after-revocation" });
  const checked = [], fault = new Error("fixture: create owner revoked");
  let announce, release, observed, followingObserved, revoked = false, queued = 0;
  const started = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { observed = resolve; });
  const followingWaiting = new Promise(resolve => { followingObserved = resolve; });
  t.after(() => release());
  const held = withQueuedWorkflowGitRepositoryLock(f.repository, async () => { announce(); await barrier; });
  await started;
  // Observe admission after asynchronous planning without sleeps or production hooks.
  const originalSet = Map.prototype.set;
  const admission = t.mock.method(Map.prototype, "set", function (key, value) {
    const result = originalSet.call(this, key, value);
    if (key === f.repository.commonDir) {
      if (++queued === 1) observed();
      else if (queued === 2) followingObserved();
    }
    return result;
  });
  const create = createWorkflowGitWorktree(scope, { beforeCreate() {
    checked.push("revoked");
    if (revoked) throw fault;
  } });
  const refused = assert.rejects(create, error => error === fault);
  await waiting;
  revoked = true;
  const followingCreate = createWorkflowGitWorktree(followingScope, { beforeCreate() { checked.push("following"); } });
  const completion = Promise.all([held, refused, followingCreate]);
  await followingWaiting;
  admission.mock.restore();
  assert.deepEqual(checked, [], "neither create guard can run while the physical lock is held");
  release();
  const [, , receipt] = await completion;
  assert.deepEqual(checked, ["revoked", "following"]);
  await assert.rejects(access(scope.executionRoot), { code: "ENOENT" });
  assert.equal(await workflowGitRefExists(f.root, scope.branchRef), false);
  assert.equal(receipt.executionRoot, followingScope.executionRoot);
  assert.equal(receipt.branchRef, followingScope.branchRef);
  await access(followingScope.executionRoot);
  assert.equal(await f.git("rev-parse", followingScope.branchRef), f.repository.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await withQueuedWorkflowGitRepositoryLock(f.repository, async () => "next owner"), "next owner");
  await assert.rejects(access(join(f.repository.commonDir, "ling-workflow-git.lock")), { code: "ENOENT" });
});

test("Host seals tracked edits, authorized new text, deletions and executable modes without touching Runner index or HEAD", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "owned.txt"), "changed\r\n");
  await writeFile(join(b.scope.executionRoot, "new.txt"), "new content\n");
  await unlink(join(b.scope.executionRoot, "delete.txt"));
  await chmod(join(b.scope.executionRoot, "mode.sh"), 0o755);
  await b.git("add", "--", "new.txt");
  const source = await inspectWorkflowGitRepository(b.scope.executionRoot, { allowDirtyCandidate: true });
  const indexBefore = await readFile(join(source.gitDir, "index"));
  const result = await b.capture();
  assert.equal(result.status, "sealed");
  assert.equal(result.packetDigest, workflowGitPacketDigest(result.packet));
  assert.equal(result.packet.context.scope.executionRoot, b.scope.executionRoot);
  assert.deepEqual(result.packet.context.lineage, b.lineage);
  assert.deepEqual(result.packet.changedPaths.map(change => [change.path, change.change]),
    [["delete.txt", "delete"], ["mode.sh", "modify"], ["new.txt", "add"], ["owned.txt", "modify"]]);
  assert.equal(result.packet.changedPaths.find(change => change.path === "mode.sh").after.mode, "100755");
  assert.match(result.packet.patch, /new content/u);
  assert.deepEqual(result.packet.discovery.newPaths, ["new.txt"]);
  assert.deepEqual(result.packet.discovery.ignoredResidue, []);
  assert.equal(await b.git("rev-parse", "HEAD"), b.scope.baseCommit);
  assert.equal(await b.git("symbolic-ref", "HEAD"), b.scope.branchRef);
  assert.deepEqual(await readFile(join(source.gitDir, "index")), indexBefore);
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await workflowGitResultRef(f.root, result.resultRef), result.commit);
  assert.equal(await f.git("rev-parse", `${result.commit}^`), b.scope.baseCommit);
  assert.deepEqual(await f.gitAt(f.root, ["show", `${result.commit}:owned.txt`]), Buffer.from("changed\r\n"));
  assert.equal(b.journal.intents.length, 1);
  assert.equal(b.journal.intents[0].packetDigest, result.packetDigest);
  assert.equal(b.journal.intents[0].beforeCommit, null);
  assert.deepEqual(b.journal.receipts.map(receipt => receipt.outcome), ["confirmed"]);
  assert.equal(Object.isFrozen(result.packet.context.lineage), true);
  await assert.rejects(b.capture(), { code: "workflow_branch_result_ref_exists" });
});

test("capture requires Host terminal/quiescence authority and never accepts status-only or mismatched evidence", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await assert.rejects(captureWorkflowBranchResult({ ...b, assertTerminalQuiescent: undefined, journal: b.journal }),
    { code: "workflow_branch_terminal_authority_required" });
  await assert.rejects(b.capture({ assertTerminalQuiescent: async () => ({ status: "succeeded" }) }));
  for (const change of [
    { lineage: { ...b.lineage, attemptId: "old-attempt" } }, { unknownEffects: ["unconfirmed child"] },
    { terminalArtifactRef: "" }, { quiescenceArtifactRef: "" }, { toolCompletionArtifactRef: "" },
  ]) await assert.rejects(b.capture({ assertTerminalQuiescent: async () => ({ ...b.terminal, ...change }) }),
    { code: "workflow_branch_terminal_evidence_invalid" });
  assert.deepEqual(b.journal.intents, []);
  assert.equal(await b.git("rev-parse", "HEAD"), b.scope.baseCommit);
});

test("terminal lineage is revalidated after discovery and immediately before the named ref effect", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "owned.txt"), "changed\n");
  let calls = 0;
  await assert.rejects(b.capture({ assertTerminalQuiescent: async context => {
    assert.equal(Object.isFrozen(context.allowedPaths), true);
    if (++calls === 3) throw new Error("fence revoked");
    return b.terminal;
  } }), error => error.code === "workflow_result_seal_blocked" && error.cause.message === "fence revoked");
  assert.equal(calls, 3);
  assert.deepEqual(b.journal.receipts.map(receipt => receipt.outcome), ["blocked"]);
  assert.equal(await workflowGitResultRef(f.root, b.journal.intents[0].ref), null);
});

for (const kind of ["untracked", "tracked", "deleted", "empty-directory"]) {
  test(`an unauthorized ${kind} path blocks the complete snapshot rather than silently excluding it`, nativeGit, async t => {
    const f = await workflowGitResultsFixture(t), b = await f.branch("step-one", ["new.txt"]);
    if (kind === "untracked") await writeFile(join(b.scope.executionRoot, "other.txt"), "unowned\n");
    if (kind === "tracked") await writeFile(join(b.scope.executionRoot, "owned.txt"), "unowned\n");
    if (kind === "deleted") await unlink(join(b.scope.executionRoot, "owned.txt"));
    if (kind === "empty-directory") await mkdir(join(b.scope.executionRoot, "unknown"));
    await assert.rejects(b.capture(), { code: "workflow_branch_unauthorized_path" });
    assert.deepEqual(b.journal.intents, []);
    assert.equal(await b.git("rev-parse", "HEAD"), b.scope.baseCommit);
  });
}

for (const empty of [false, true]) {
  test(`ignored ${empty ? "empty directory" : "authorized file"} residue blocks capture`, nativeGit, async t => {
    const f = await workflowGitResultsFixture(t, { files: { ".gitignore": "cache/\nignored.txt\n" } });
    const b = await f.branch("step-one", ["ignored.txt"]);
    if (empty) await mkdir(join(b.scope.executionRoot, "cache"));
    else await writeFile(join(b.scope.executionRoot, "ignored.txt"), "not silently collected\n");
    await assert.rejects(b.capture(), { code: "workflow_branch_ignored_residue" });
    assert.deepEqual(b.journal.intents, []);
  });
}

test("authorized pathspec-looking file names are captured literally", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t, { files: { ".gitignore": "other.txt\n" } });
  const paths = ["*.txt", ":(glob)*.txt", "-leading.txt", "with space.txt", "bracket[1].txt"];
  const b = await f.branch("step-one", paths);
  for (const path of paths) await writeFile(join(b.scope.executionRoot, path), `literal ${path}\n`);
  const result = await b.capture();
  assert.deepEqual(result.packet.changedPaths.map(change => change.path), paths.slice().sort());
  for (const path of paths) assert.equal((await f.gitAt(f.root, ["show", `${result.commit}:${path}`])).toString(), `literal ${path}\n`);
});

test("force-staged ignored files remain residue rather than inheriting the Runner index authorization", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t, { files: { ".gitignore": "ignored.txt\n" } });
  const b = await f.branch("step-one", ["ignored.txt"]);
  await writeFile(join(b.scope.executionRoot, "ignored.txt"), "ignored even when staged\n");
  await b.git("add", "--force", "--", "ignored.txt");
  await assert.rejects(b.capture(), { code: "workflow_branch_ignored_residue" });
  assert.deepEqual(b.journal.intents, []);
});

for (const kind of ["symlink", "hardlink", "binary", "non-utf8", "oversize", "nested-git"]) {
  test(`unsupported ${kind} input is rejected without publishing a result`, nativeGit, async t => {
    const f = await workflowGitResultsFixture(t), b = await f.branch();
    const path = join(b.scope.executionRoot, "new.txt");
    if (kind === "symlink") await symlink("owned.txt", path);
    if (kind === "hardlink") await link(join(b.scope.executionRoot, "owned.txt"), path);
    if (kind === "binary") await writeFile(path, Buffer.from([0, 1, 2, 3]));
    if (kind === "non-utf8") await writeFile(path, Buffer.from([0xff, 0xfe]));
    if (kind === "oversize") await writeFile(path, Buffer.alloc(WORKFLOW_BRANCH_CAPTURE_POLICY.maxFileBytes + 1, 65));
    if (kind === "nested-git") { await mkdir(join(b.scope.executionRoot, "nested")); await mkdir(join(b.scope.executionRoot, "nested", ".git")); }
    const codes = { symlink: "workflow_branch_special_file_unsupported", hardlink: "workflow_branch_special_file_unsupported",
      binary: "workflow_branch_binary_unsupported", "non-utf8": "workflow_branch_non_utf8_unsupported",
      oversize: "workflow_branch_file_budget_exceeded", "nested-git": "workflow_branch_path_unsupported" };
    await assert.rejects(b.capture(), { code: codes[kind] });
    assert.deepEqual(b.journal.intents, []);
  });
}

test("changed text and patch budgets are fixed Host policy, not caller overrides", nativeGit, async t => {
  for (const [count, code] of [[7, "workflow_branch_changed_budget_exceeded"], [4, "workflow_branch_patch_budget_exceeded"]]) {
    await t.test(code, async t => {
      const f = await workflowGitResultsFixture(t), paths = Array.from({ length: count }, (_, i) => `new-${i}.txt`);
      const b = await f.branch("step-one", paths);
      for (const path of paths) await writeFile(join(b.scope.executionRoot, path), Buffer.alloc(WORKFLOW_BRANCH_CAPTURE_POLICY.maxFileBytes, 65));
      await assert.rejects(b.capture({ policy: { maxChangedBytes: Number.MAX_SAFE_INTEGER } }), { code });
      assert.deepEqual(b.journal.intents, []);
    });
  }
});

test("file drift after the persisted intent prevents sealing and preserves changed source bytes", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "owned.txt"), "first\n");
  const original = b.journal.recordIntent;
  b.journal.recordIntent = async effect => {
    const id = await original(effect);
    await writeFile(join(b.scope.executionRoot, "owned.txt"), "concurrent change\n");
    return id;
  };
  await assert.rejects(b.capture(), error => error.code === "workflow_result_seal_blocked" && error.cause.code === "workflow_branch_source_changed");
  assert.equal(await readFile(join(b.scope.executionRoot, "owned.txt"), "utf8"), "concurrent change\n");
  assert.equal(await workflowGitResultRef(f.root, b.journal.intents[0].ref), null);
  assert.deepEqual(b.journal.receipts.map(receipt => receipt.outcome), ["blocked"]);
});

test("ref CAS never replaces an existing result and reports uncertain effects for reconciliation", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  const original = b.journal.recordIntent;
  b.journal.recordIntent = async effect => {
    const id = await original(effect);
    await workflowGit(f.root, ["update-ref", effect.ref, f.repository.head]);
    return id;
  };
  await assert.rejects(b.capture(), { code: "workflow_result_effect_unknown" });
  assert.equal(await workflowGitResultRef(f.root, b.journal.intents[0].ref), f.repository.head);
  assert.deepEqual(b.journal.receipts.map(receipt => receipt.outcome), ["effect_unknown"]);
});

test("an unconfirmed receipt retains the exact published ref and recoverable intent instead of reporting sealed", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "owned.txt"), "preserved evidence\n");
  b.journal.recordReceipt = async () => { throw new Error("receipt unavailable"); };
  await assert.rejects(b.capture(), { code: "workflow_result_receipt_unconfirmed" });
  const [intent] = b.journal.intents;
  assert.equal(await workflowGitResultRef(f.root, intent.ref), intent.afterCommit);
  assert.equal(await b.git("rev-parse", "HEAD"), b.scope.baseCommit);
  assert.equal(await readFile(join(b.scope.executionRoot, "owned.txt"), "utf8"), "preserved evidence\n");
  assert.equal(JSON.parse(intent.packetJson).tree, intent.tree);
});

test("missing create identity and changed source branch/HEAD cannot be captured as the approved lineage", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await assert.rejects(b.capture({ receipt: { ...b.receipt, rootInode: "0" } }), { code: "workflow_branch_source_identity_changed" });
  await b.git("commit", "--allow-empty", "-m", "unexpected runner commit");
  await assert.rejects(b.capture(), { code: "workflow_branch_source_identity_changed" });
  assert.deepEqual(b.journal.intents, []);
});

test("capture uses the original safe Host Git actor and cannot run hooks or new conversion attributes", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t, { configure: async ({ base, git }) => {
    const hooks = join(base, "hooks"); await mkdir(hooks);
    for (const hook of ["post-commit", "post-index-change", "reference-transaction"]) {
      const path = join(hooks, hook);
      await writeFile(path, `#!/bin/sh\nprintf hook > '${join(base, "hook-ran")}'\n`); await chmod(path, 0o700);
    }
    await git("config", "core.hooksPath", hooks);
  } });
  const b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "owned.txt"), "safe\n");
  await b.capture();
  await assert.rejects(access(join(f.base, "hook-ran")), { code: "ENOENT" });
  const unsupported = await f.branch("step-two", [".gitattributes"]);
  await writeFile(join(unsupported.scope.executionRoot, ".gitattributes"), "*.txt filter=unapproved\n");
  await assert.rejects(unsupported.capture(), { code: "workflow_git_custom_attributes_unsupported" });
  assert.deepEqual(unsupported.journal.intents, []);
});

test("sealed evidence is reopened against the actual ref, commit parent, tree, changed paths and patch", nativeGit, async t => {
  const f = await workflowGitResultsFixture(t), b = await f.branch();
  await writeFile(join(b.scope.executionRoot, "new.txt"), "sealed evidence\n");
  const result = await b.capture();
  await inspectSealedWorkflowBranchResult(f.root, result);
  for (const mutate of [
    packet => { packet.changedPaths[0].after.sha256 = "0".repeat(64); },
    packet => { packet.patch = "a forged patch"; },
    packet => { packet.discovery.newPaths = []; },
    packet => { packet.context.allowedPaths = ["owned.txt"]; },
    packet => { packet.policy.maxChangedBytes *= 2; },
  ]) {
    const packet = structuredClone(result.packet); mutate(packet);
    await assert.rejects(inspectSealedWorkflowBranchResult(f.root, { ...result, packet, packetDigest: workflowGitPacketDigest(packet) }));
  }
  await workflowGit(f.root, ["update-ref", result.resultRef, f.repository.head, result.commit]);
  await assert.rejects(inspectSealedWorkflowBranchResult(f.root, result), { code: "workflow_branch_sealed_ref_changed" });
});
