import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { inspectWorkflowGitRepository, withWorkflowGitRepositoryLock, workflowGitRepositoryBasisDigest }
  from "../dist/features/workspaces/workflow-git-repository.js";
import { applyWorkflowGitFastForward, observeWorkflowGitApply } from "../dist/features/workspaces/workflow-git-apply.js";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
const exec = promisify(execFile);

async function fixture(t, files = { "owned.txt": "base\n" }) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "ling-workflow-apply-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repository");
  await mkdir(root);
  // Even fixture plumbing uses the existing protected, environment-scrubbed Git actor.
  const git = async (...args) => (await workflowGit(root, args)).stdout.toString().trim();
  await git("init", "--initial-branch=main", "--template=");
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await git("add", "--all");
  await git("commit", "-m", "fixture base");
  const repository = await inspectWorkflowGitRepository(root);
  let sequence = 0;
  const makeCandidate = async (files = { "owned.txt": "candidate\n" }, parents = [repository.head]) => {
    const tree = await makeTree(root, files);
    const commit = (await workflowGit(root, ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])],
      { input: Buffer.from(`candidate ${++sequence}\n`) })).stdout.toString().trim();
    return { candidateCommit: commit, candidateTree: tree };
  };
  const candidate = await makeCandidate(), intents = [], receipts = [];
  const target = { expectedRepository: repository, expectedHead: repository.head, ...candidate };
  const input = (overrides = {}) => ({ ...target, assertCurrentAuthority() {},
    beforeApply(intent) { intents.push(intent); }, afterApply(receipt) { receipts.push(receipt); }, ...overrides });
  return { base, root, repository, target, intents, receipts, input, git, makeCandidate };
}

async function makeTree(root, files) {
  const tree = new Map();
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    let parent = tree;
    for (const directory of parts.slice(0, -1)) {
      if (!parent.has(directory)) parent.set(directory, new Map());
      parent = parent.get(directory);
    }
    parent.set(parts.at(-1), value);
  }
  const encode = async entries => {
    const records = [];
    for (const [name, value] of entries) {
      if (value instanceof Map) records.push(`040000 tree ${await encode(value)}\t${name}\0`);
      else {
        const file = value && typeof value === "object" && !Buffer.isBuffer(value) ? value : { bytes: value };
        const id = (await workflowGit(root, ["hash-object", "-w", "--stdin"], { input: Buffer.from(file.bytes) })).stdout.toString().trim();
        records.push(`${file.mode ?? "100644"} blob ${id}\t${name}\0`);
      }
    }
    return (await workflowGit(root, ["mktree", "-z"], { input: Buffer.from(records.join("")) })).stdout.toString().trim();
  };
  return encode(tree);
}

async function assertUnchanged(f) {
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal(await f.git("symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal((await f.git("reflog", "show", "--format=%H", "refs/heads/main")).split("\n").length, 1);
}

test("clean fast-forward persists intent before effects and receipt after full observation; hooks and inherited ENV are inert", native, async t => {
  const f = await fixture(t, { "owned.txt": "base\n", "removed.txt": "remove me\n" });
  const candidate = await f.makeCandidate({ "owned.txt": "candidate\n", "src/new.txt": "new text\n" });
  const hooks = join(f.base, "hooks"), marker = join(f.base, "hook-ran");
  await mkdir(hooks);
  for (const name of ["post-merge", "pre-merge-commit", "post-checkout", "reference-transaction"]) {
    const path = join(hooks, name);
    await writeFile(path, `#!/bin/sh\nprintf hook > '${marker}'\n`);
    await chmod(path, 0o700);
  }
  await f.git("config", "core.hooksPath", hooks);
  // A normal Git setting requests autostash, but the only apply command explicitly disables it.
  await f.git("config", "merge.autoStash", "true");
  const expectedRepository = await inspectWorkflowGitRepository(f.root);
  const events = [], intentPath = join(f.base, "intent.json"), receiptPath = join(f.base, "receipt.json");
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const prior = keys.map(key => process.env[key]);
  let result;
  try {
    Object.assign(process.env, { GIT_DIR: "/not-the-repository", GIT_WORK_TREE: "/not-the-worktree", GIT_INDEX_FILE: "/not-the-index",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks });
    result = await applyWorkflowGitFastForward(f.input({ expectedRepository, ...candidate,
      async beforeApply(intent) {
        assert.equal(Object.isFrozen(intent), true);
        assert.equal(Object.isFrozen(intent.expectedRepository), true);
        assert.equal(intent.expectedBasisDigest, workflowGitRepositoryBasisDigest(expectedRepository));
        assert.equal(await f.git("rev-parse", "HEAD"), expectedRepository.head);
        await access(join(expectedRepository.commonDir, "ling-workflow-git.lock", "owner.json"));
        await writeFile(intentPath, JSON.stringify(intent));
        events.push("intent");
      },
      async afterApply(receipt) {
        assert.equal(events.at(-1), "intent");
        assert.equal(await f.git("rev-parse", "HEAD"), candidate.candidateCommit);
        assert.equal(await readFile(join(f.root, "src/new.txt"), "utf8"), "new text\n");
        await writeFile(receiptPath, JSON.stringify(receipt));
        events.push("receipt");
      },
    }));
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
  }
  assert.equal(result.status, "applied");
  assert.deepEqual(events, ["intent", "receipt"]);
  assert.equal(result.receipt.head, candidate.candidateCommit);
  assert.equal(result.receipt.tree, candidate.candidateTree);
  assert.equal(result.receipt.basisDigest, workflowGitRepositoryBasisDigest(await inspectWorkflowGitRepository(f.root)));
  assert.equal(JSON.parse(await readFile(intentPath, "utf8")).candidateCommit, candidate.candidateCommit);
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).head, candidate.candidateCommit);
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "candidate\n");
  await assert.rejects(access(join(f.root, "removed.txt")), { code: "ENOENT" });
  await assert.rejects(access(marker), { code: "ENOENT" });
  await assert.rejects(access(join(expectedRepository.commonDir, "ling-workflow-git.lock")), { code: "ENOENT" });
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "refs/heads/main"), candidate.candidateCommit);
});

test("repeated apply never repeats a physical effect or treats a candidate observation as authorization", native, async t => {
  const f = await fixture(t);
  const observed = await observeWorkflowGitApply(f.target);
  assert.equal(observed.state, "expected");
  assert.equal(observed.verifiedClean, true);
  assert.equal(observed.basisDigest, workflowGitRepositoryBasisDigest(f.repository));
  assert.equal((await applyWorkflowGitFastForward(f.input())).status, "applied");
  const reflog = await f.git("reflog", "show", "--format=%H", "refs/heads/main");
  const repeated = await applyWorkflowGitFastForward(f.input());
  assert.equal(repeated.status, "unknown");
  assert.equal(repeated.code, "workflow_git_apply_requires_reconciliation");
  assert.equal(repeated.observation.state, "candidate");
  assert.equal(f.intents.length, 1);
  assert.equal(f.receipts.length, 1);
  const candidate = await observeWorkflowGitApply(f.target);
  assert.equal(candidate.state, "candidate");
  assert.equal(candidate.verifiedClean, true);
  assert.equal(Object.hasOwn(candidate, "applied"), false);
  assert.equal(await f.git("reflog", "show", "--format=%H", "refs/heads/main"), reflog);
});

test("lost durable receipt leaves the actual fast-forward intact and unknown, with no replay or rollback", native, async t => {
  const f = await fixture(t), intentPath = join(f.base, "intent.json");
  const result = await applyWorkflowGitFastForward(f.input({
    async beforeApply(intent) { await writeFile(intentPath, JSON.stringify(intent)); },
    afterApply() { throw new Error("fixture SQLite receipt failed"); },
  }));
  assert.equal(result.status, "unknown");
  assert.equal(result.code, "workflow_git_apply_receipt_failed");
  assert.equal(result.observation.head, f.target.candidateCommit);
  assert.equal(result.observation.tree, f.target.candidateTree);
  assert.equal(result.observation.verifiedClean, true);
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "candidate\n");
  const reflog = await f.git("reflog", "show", "--format=%H", "refs/heads/main");
  const again = await applyWorkflowGitFastForward(f.input({ beforeApply() { assert.fail("must not replay intent/effect"); } }));
  assert.equal(again.status, "unknown");
  assert.equal(again.code, "workflow_git_apply_requires_reconciliation");
  assert.equal(await f.git("reflog", "show", "--format=%H", "refs/heads/main"), reflog);
  assert.equal(JSON.parse(await readFile(intentPath, "utf8")).candidateCommit, f.target.candidateCommit);
});

test("receipt failure with new user edits preserves both the candidate HEAD and user files", native, async t => {
  const f = await fixture(t);
  const result = await applyWorkflowGitFastForward(f.input({ async afterApply() {
    await writeFile(join(f.root, "owned.txt"), "user work after merge\n");
    throw new Error("receipt unavailable");
  } }));
  assert.equal(result.status, "unknown");
  assert.equal(result.observation.head, f.target.candidateCommit);
  assert.equal(result.observation.verifiedClean, false);
  assert.equal(await f.git("rev-parse", "HEAD"), f.target.candidateCommit);
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "user work after merge\n");
});

test("persistence callbacks must explicitly succeed with void, not false or another result", native, async t => {
  for (const phase of ["intent", "receipt"]) {
    await t.test(phase, async t => {
      const f = await fixture(t);
      const result = await applyWorkflowGitFastForward(f.input(phase === "intent"
        ? { beforeApply() { return false; } } : { async afterApply() { return false; } }));
      assert.equal(result.status, phase === "intent" ? "blocked" : "unknown");
      assert.equal(result.code, phase === "intent" ? "workflow_git_apply_intent_failed" : "workflow_git_apply_receipt_failed");
      assert.equal(await f.git("rev-parse", "HEAD"), phase === "intent" ? f.repository.head : f.target.candidateCommit);
    });
  }
});

test("lock-release uncertainty cannot downgrade an observed candidate into a pre-effect blocked result", native, async t => {
  const f = await fixture(t);
  assert.equal((await applyWorkflowGitFastForward(f.input())).status, "applied");
  const reflog = await f.git("reflog", "show", "--format=%H", "refs/heads/main");
  const result = await applyWorkflowGitFastForward(f.input({ assertCurrentAuthority() {
    writeFileSync(join(f.repository.commonDir, "ling-workflow-git.lock", "owner.json"), '{"token":"foreign","pid":0}');
  } }));
  assert.equal(result.status, "unknown");
  assert.equal(result.code, "workflow_git_lock_release_uncertain");
  assert.equal(result.observation.state, "candidate");
  assert.equal(await f.git("reflog", "show", "--format=%H", "refs/heads/main"), reflog);
  assert.equal(f.intents.length, 1);
  assert.equal(f.receipts.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.repository.commonDir, "ling-workflow-git.lock", "owner.json"), "utf8")).token, "foreign");
});

test("target worktree/index/untracked/ignored dirt is rejected before durable intent or Git apply", native, async t => {
  for (const kind of ["tracked", "index", "untracked", "ignored", "empty-directory", "executable-mode"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (["tracked", "index"].includes(kind)) await writeFile(join(f.root, "owned.txt"), "user work\n");
      if (kind === "index") await f.git("add", "--", "owned.txt");
      if (kind === "untracked") await writeFile(join(f.root, "untracked.txt"), "preserve\n");
      if (kind === "ignored") {
        await mkdir(join(f.repository.commonDir, "info"), { recursive: true });
        await writeFile(join(f.repository.commonDir, "info/exclude"), "ignored.txt\n");
        await writeFile(join(f.root, "ignored.txt"), "ignored user work\n");
        assert.equal(await f.git("status", "--porcelain"), "");
      }
      if (kind === "empty-directory") await mkdir(join(f.root, "empty-user-directory"));
      if (kind === "executable-mode") await chmod(join(f.root, "owned.txt"), 0o755);
      const before = await f.git("status", "--porcelain=v1", "--ignored", "--untracked-files=all");
      const result = await applyWorkflowGitFastForward(f.input());
      assert.equal(result.status, "blocked");
      assert.equal(f.intents.length, 0);
      assert.equal(f.receipts.length, 0);
      assert.equal(await f.git("status", "--porcelain=v1", "--ignored", "--untracked-files=all"), before);
      await assertUnchanged(f);
    });
  }
});

test("skip-worktree and assume-unchanged cannot hide a modified tracked file from apply", native, async t => {
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
    for (const dirty of [false, true]) {
      await t.test(`${flag} dirty=${dirty}`, async t => {
        const f = await fixture(t);
        await f.git("update-index", flag, "--", "owned.txt");
        if (dirty) await writeFile(join(f.root, "owned.txt"), "hidden user work\n");
        assert.equal(await f.git("status", "--porcelain"), "");
        const result = await applyWorkflowGitFastForward(f.input());
        assert.equal(result.status, "blocked");
        assert.equal(result.code, "workflow_git_apply_index_flags_unsupported");
        assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), dirty ? "hidden user work\n" : "base\n");
        assert.equal(f.intents.length, 0);
        await assertUnchanged(f);
      });
    }
  }
});

test("HEAD/branch/configuration and repository identity drift never reach the effect", native, async t => {
  for (const kind of ["head", "branch", "configuration", "root-inode", "common-inode", "detached"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      let expectedRepository = f.repository;
      if (kind === "head") await f.git("commit", "--allow-empty", "-m", "unrelated later HEAD");
      if (kind === "branch") await f.git("switch", "-c", "other-target");
      if (kind === "configuration") await f.git("config", "ling.fixtureChanged", "true");
      if (kind === "root-inode") expectedRepository = { ...expectedRepository, rootInode: "0" };
      if (kind === "common-inode") expectedRepository = { ...expectedRepository, commonInode: "0" };
      if (kind === "detached") await f.git("switch", "--detach");
      const head = await f.git("rev-parse", "HEAD"), branch = await f.git("rev-parse", "--symbolic-full-name", "HEAD");
      const result = await applyWorkflowGitFastForward(f.input({ expectedRepository }));
      assert.equal(result.status, "blocked");
      assert.equal(f.intents.length, 0);
      assert.equal(await f.git("rev-parse", "HEAD"), head);
      assert.equal(await f.git("rev-parse", "--symbolic-full-name", "HEAD"), branch);
    });
  }
});

test("baseline merge options and external verification/diff configuration are conservatively unsupported", native, async t => {
  for (const [key, value] of [["branch.main.mergeOptions", "--squash"], ["merge.verifySignatures", "true"], ["diff.external", "/usr/bin/false"]]) {
    await t.test(key, async t => {
      const f = await fixture(t);
      await f.git("config", key, value);
      const expectedRepository = await inspectWorkflowGitRepository(f.root);
      const result = await applyWorkflowGitFastForward(f.input({ expectedRepository }));
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "workflow_git_apply_configuration_unsupported");
      assert.equal(f.intents.length, 0);
      await assertUnchanged(f);
    });
  }
});

test("non-descendant, commit/tree mismatch and no-op candidate are refused", native, async t => {
  for (const kind of ["non-descendant", "tree-mismatch", "same-head"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const candidate = kind === "non-descendant" ? await f.makeCandidate(undefined, [])
        : kind === "tree-mismatch" ? { ...f.target, candidateTree: await f.git("rev-parse", "HEAD^{tree}") }
          : { candidateCommit: f.repository.head, candidateTree: await f.git("rev-parse", "HEAD^{tree}") };
      const result = await applyWorkflowGitFastForward(f.input(candidate));
      assert.equal(result.status, "blocked");
      assert.equal(result.code, { "non-descendant": "workflow_git_apply_candidate_not_descendant", "tree-mismatch": "workflow_git_apply_candidate_mismatch",
        "same-head": "workflow_git_apply_candidate_not_successor" }[kind]);
      assert.equal(f.intents.length, 0);
      await assertUnchanged(f);
    });
  }
});

test("leaf, directory-prefix, normalization aliases and case-only renames are rejected without checkout", native, async t => {
  const cases = [
    { "owned.txt": "candidate\n", "Name.txt": "a\n", "name.txt": "b\n" },
    { "owned.txt": "candidate\n", "Module/a.txt": "a\n", "module/b.txt": "b\n" },
    { "owned.txt": "candidate\n", "caf\u00e9.txt": "a\n", "cafe\u0301.txt": "b\n" },
    { "Owned.txt": "candidate\n" },
  ];
  for (let index = 0; index < cases.length; index++) {
    await t.test(`case ${index}`, async t => {
      const f = await fixture(t), candidate = await f.makeCandidate(cases[index]);
      const result = await applyWorkflowGitFastForward(f.input(candidate));
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "workflow_git_ambiguous_case_path");
      assert.equal(f.intents.length, 0);
      await assertUnchanged(f);
    });
  }
});

test("authority is rechecked synchronously after intent persistence, including late revocation", native, async t => {
  for (const kind of ["initial", "after-intent", "final-check"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      let allowed = kind !== "initial", checks = 0;
      const result = await applyWorkflowGitFastForward(f.input({
        assertCurrentAuthority() {
          checks++;
          if (!allowed || kind === "final-check" && checks === 3) throw new Error("fixture owner/approval revoked");
        },
        beforeApply(intent) { f.intents.push(intent); if (kind === "after-intent") allowed = false; },
      }));
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "workflow_git_apply_authority_rejected");
      assert.equal(f.receipts.length, 0);
      assert.equal(f.intents.length, kind === "initial" ? 0 : 1);
      await assertUnchanged(f);
    });
  }
});

test("async or non-void authority callbacks are refused, including rejected promises and thenables", native, async t => {
  const callbacks = [async () => {}, async () => { throw new Error("async owner rejected"); },
    () => ({ then(_resolve, reject) { reject(new Error("thenable rejected")); } }), () => true];
  for (let index = 0; index < callbacks.length; index++) {
    await t.test(`callback ${index}`, async t => {
      const f = await fixture(t);
      const result = await applyWorkflowGitFastForward(f.input({ assertCurrentAuthority: callbacks[index] }));
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "workflow_git_apply_authority_must_be_synchronous");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.intents.length, 0);
      await assertUnchanged(f);
    });
  }
});

test("intent failure and mutations while awaiting persistence cannot cause an apply", native, async t => {
  for (const kind of ["intent-fails", "dirty", "ignored", "head", "branch", "configuration", "operation", "index-flags"]) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      let afterIntentHead = f.repository.head;
      const result = await applyWorkflowGitFastForward(f.input({ async beforeApply() {
        await Promise.resolve();
        if (kind === "intent-fails") throw new Error("intent transaction rejected");
        if (kind === "dirty") await writeFile(join(f.root, "owned.txt"), "new user work\n");
        if (kind === "ignored") {
          await mkdir(join(f.repository.commonDir, "info"), { recursive: true });
          await writeFile(join(f.repository.commonDir, "info/exclude"), "late-ignored\n");
          await writeFile(join(f.root, "late-ignored"), "do not overwrite\n");
        }
        if (kind === "head") {
          await f.git("commit", "--allow-empty", "-m", "late head");
          afterIntentHead = await f.git("rev-parse", "HEAD");
        }
        if (kind === "branch") await f.git("switch", "-c", "late-target");
        if (kind === "configuration") await f.git("config", "ling.changedDuringIntent", "true");
        if (kind === "operation") await writeFile(join(f.repository.gitDir, "CHERRY_PICK_HEAD"), f.repository.head);
        if (kind === "index-flags") await f.git("update-index", "--skip-worktree", "--", "owned.txt");
      } }));
      assert.equal(result.status, "blocked");
      assert.equal(await f.git("rev-parse", "HEAD"), afterIntentHead);
      assert.equal(f.receipts.length, 0);
      if (kind === "intent-fails") assert.equal(result.code, "workflow_git_apply_intent_failed");
      if (kind === "dirty") assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "new user work\n");
    });
  }
});

test("a candidate reached during persistence is unknown and must be matched to durable intent, never replayed", native, async t => {
  const f = await fixture(t);
  const result = await applyWorkflowGitFastForward(f.input({ async beforeApply() {
    await f.git("merge", "--ff-only", "--no-edit", "--no-autostash", f.target.candidateCommit);
  } }));
  assert.equal(result.status, "unknown");
  assert.equal(result.code, "workflow_git_apply_requires_reconciliation");
  assert.equal(f.receipts.length, 0);
  assert.equal((await f.git("reflog", "show", "--format=%H", "refs/heads/main")).split("\n").length, 2);
});

test("authority revoked after the Git effect cannot write a receipt or roll back the worktree", native, async t => {
  const f = await fixture(t);
  let checks = 0;
  const result = await applyWorkflowGitFastForward(f.input({ assertCurrentAuthority() {
    if (++checks === 4) throw new Error("new generation owns receipt");
  } }));
  assert.equal(result.status, "unknown");
  assert.equal(result.code, "workflow_git_apply_authority_rejected");
  assert.equal(f.receipts.length, 0);
  assert.equal(result.observation.head, f.target.candidateCommit);
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "candidate\n");
});

test("a failed invoked merge remains unknown even if the observed HEAD is still the expected one", native, async t => {
  const f = await fixture(t);
  let checks = 0;
  const lockPath = join(f.repository.gitDir, "index.lock");
  const result = await applyWorkflowGitFastForward(f.input({ async beforeApply(intent) { f.intents.push(intent); },
    assertCurrentAuthority() {
      // Simulate a non-cooperating writer after the last scan and before Git acquires its index lock.
      if (++checks === 3) writeFileSync(lockPath, "other writer", { flag: "wx" });
    },
  }));
  assert.equal(result.status, "unknown");
  assert.equal(result.code, "workflow_git_apply_effect_uncertain");
  assert.equal(result.observation.head, f.repository.head);
  assert.equal(f.intents.length, 1);
  assert.equal(f.receipts.length, 0);
  await assertUnchanged(f);
  assert.equal(await readFile(lockPath, "utf8"), "other writer");
});

test("merge/rebase/cherry-pick/sequencer and existing index locks are refused", native, async t => {
  for (const name of ["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD", "sequencer", "index.lock"]) {
    await t.test(name, async t => {
      const f = await fixture(t), path = join(f.repository.gitDir, name);
      if (["rebase-merge", "sequencer"].includes(name)) await mkdir(path);
      else await writeFile(path, f.repository.head);
      const result = await applyWorkflowGitFastForward(f.input());
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "workflow_git_operation_in_progress");
      assert.equal(f.intents.length, 0);
      assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
      await access(path);
    });
  }
});

test("symlinks, hardlinks and special worktree files are refused and preserved", native, async t => {
  for (const kind of ["symlink", "hardlink", "fifo"]) {
    await t.test(kind, async t => {
      const f = await fixture(t), path = join(f.root, "owned.txt"), outside = join(f.base, "outside.txt");
      await writeFile(outside, "base\n");
      await rm(path);
      if (kind === "symlink") await symlink(outside, path);
      if (kind === "hardlink") {
        await link(outside, path);
        assert.equal(await f.git("status", "--porcelain"), "");
      }
      if (kind === "fifo") await exec("/usr/bin/mkfifo", [path]);
      const result = await applyWorkflowGitFastForward(f.input());
      assert.equal(result.status, "blocked");
      assert.equal(f.intents.length, 0);
      assert.equal(await readFile(outside, "utf8"), "base\n");
      await access(path);
      await assertUnchanged(f);
    });
  }
});

test("binary base/candidate and candidate symlinks are unsupported before apply", native, async t => {
  for (const kind of ["binary-base", "binary-candidate", "non-utf8", "candidate-symlink"]) {
    await t.test(kind, async t => {
      const f = await fixture(t, kind === "binary-base" ? { "owned.txt": Buffer.from([0, 1, 2]) } : undefined);
      const candidate = kind === "binary-candidate" ? await f.makeCandidate({ "owned.txt": Buffer.from("binary\0payload") })
        : kind === "non-utf8" ? await f.makeCandidate({ "owned.txt": Buffer.from([0xc0, 0xff]) })
          : kind === "candidate-symlink" ? await f.makeCandidate({ "owned.txt": "candidate\n", linked: { mode: "120000", bytes: "owned.txt" } }) : {};
      const result = await applyWorkflowGitFastForward(f.input(candidate));
      assert.equal(result.status, "blocked");
      assert.equal(f.intents.length, 0);
      await assertUnchanged(f);
    });
  }
});

test("common-directory locks also block apply and observation from a sibling checkout", native, async t => {
  const f = await fixture(t), siblingRoot = join(f.base, "sibling");
  await f.git("worktree", "add", "--no-track", "-b", "sibling", "--", siblingRoot, f.repository.head);
  const sibling = await inspectWorkflowGitRepository(siblingRoot);
  await withWorkflowGitRepositoryLock(sibling, async () => {
    const result = await applyWorkflowGitFastForward(f.input());
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "workflow_git_repository_busy");
    const observed = await observeWorkflowGitApply(f.target);
    assert.equal(observed.state, "unavailable");
    assert.equal(observed.verifiedClean, false);
    assert.equal(observed.code, "workflow_git_repository_busy");
  });
  assert.equal(f.intents.length, 0);
  await assertUnchanged(f);
});

test("apply supports a clean linked target without moving or modifying its sibling checkout", native, async t => {
  const f = await fixture(t), targetRoot = join(f.base, "target");
  await f.git("worktree", "add", "--no-track", "-b", "target", "--", targetRoot, f.repository.head);
  const expectedRepository = await inspectWorkflowGitRepository(targetRoot);
  const result = await applyWorkflowGitFastForward(f.input({ expectedRepository }));
  assert.equal(result.status, "applied");
  assert.equal(result.receipt.repository.branchRef, "refs/heads/target");
  assert.equal(await readFile(join(targetRoot, "owned.txt"), "utf8"), "candidate\n");
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "base\n");
  await assertUnchanged(f);
});
