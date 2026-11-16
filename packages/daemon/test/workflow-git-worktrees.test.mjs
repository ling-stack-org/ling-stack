import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, inspectWorkflowGitTree, planWorkflowGitWorktree,
  reconcileWorkflowGitWorktree, safeWorkflowGitPath, withWorkflowGitRepositoryLock } from "../dist/features/workspaces/workflow-git-repository.js";
import { workflowGitRepositoryBasisDigest } from "../dist/features/workspaces/workflow-git-repository.js";

const exec = promisify(execFile);
const native = { skip: !["darwin", "linux"].includes(process.platform) };
async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "ling-workflow-git-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repository"), worktreeRoot = join(base, "worktrees");
  await mkdir(root); await mkdir(worktreeRoot);
  const git = async (...args) => (await exec("/usr/bin/git", args, { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: base,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await git("init", "--initial-branch=main");
  await writeFile(join(root, "owned.txt"), "base\n");
  await git("add", "--", "owned.txt"); await git("commit", "-m", "initial");
  const repository = await inspectWorkflowGitRepository(root);
  const plan = (stepId = "step-one", worktreeId) => planWorkflowGitWorktree({ repository, worktreeRoot,
    roundId: "round-one", stepId, generation: 1, worktreeId });
  return { base, root, worktreeRoot, repository, plan, git };
}

test("Host creates two independent no-clobber step worktrees at one frozen base", native, async t => {
  const f = await fixture(t), left = await f.plan(), right = await f.plan("step-two");
  const first = await createWorkflowGitWorktree(left), second = await createWorkflowGitWorktree(right);
  assert.notEqual(first.executionRoot, second.executionRoot);
  assert.notEqual(first.branchRef, second.branchRef);
  assert.equal(first.baseCommit, f.repository.head);
  assert.deepEqual(await reconcileWorkflowGitWorktree(left), first);
  await writeFile(join(first.executionRoot, "owned.txt"), "left only\n");
  assert.equal(await readFile(join(second.executionRoot, "owned.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "base\n");
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  assert.equal((await f.git("status", "--porcelain")).length, 0);
  await assert.rejects(reconcileWorkflowGitWorktree(left), { code: "workflow_git_target_dirty" });
});

test("target basis digest binds checkout identity, configuration, commit and cleanliness", native, async t => {
  const f = await fixture(t), digest = workflowGitRepositoryBasisDigest(f.repository);
  assert.equal(workflowGitRepositoryBasisDigest({ ...f.repository }), digest);
  assert.match(digest, /^wgr1_[a-f0-9]{64}$/u);
  for (const key of ["root", "commonDir", "gitDir", "head", "branchRef", "configurationDigest",
    "rootDevice", "rootInode", "commonDevice", "commonInode", "dirty"]) {
    assert.notEqual(workflowGitRepositoryBasisDigest({ ...f.repository,
      [key]: key === "dirty" ? !f.repository.dirty : `${f.repository[key]}-changed` }), digest, key);
  }
});

test("existing path or branch is never reset or adopted without a create receipt", native, async t => {
  const f = await fixture(t), pathScope = await f.plan("step-one", "existing-path");
  await mkdir(pathScope.executionRoot); await writeFile(join(pathScope.executionRoot, "wip"), "preserve");
  await assert.rejects(createWorkflowGitWorktree(pathScope), { code: "workflow_git_worktree_identity_exists" });
  assert.equal(await readFile(join(pathScope.executionRoot, "wip"), "utf8"), "preserve");
  const refScope = await f.plan("step-one", "existing-ref");
  await f.git("update-ref", refScope.branchRef, f.repository.head);
  await assert.rejects(createWorkflowGitWorktree(refScope), { code: "workflow_git_worktree_identity_exists" });
  assert.equal(await f.git("rev-parse", refScope.branchRef), f.repository.head);
  await assert.rejects(access(refScope.executionRoot), { code: "ENOENT" });
});

test("the final synchronous owner guard can refuse creation without a path or ref effect", native, async t => {
  const f = await fixture(t), scope = await f.plan();
  let checked = 0;
  await assert.rejects(createWorkflowGitWorktree(scope, { beforeCreate() {
    checked++;
    throw new Error("original_attempt_cancelled");
  } }), { message: "original_attempt_cancelled" });
  assert.equal(checked, 1);
  await assert.rejects(access(scope.executionRoot), { code: "ENOENT" });
  await assert.rejects(f.git("show-ref", "--verify", scope.branchRef));
  await assert.rejects(createWorkflowGitWorktree(scope, { beforeCreate: () => Promise.resolve() }),
    { code: "workflow_git_create_guard_invalid" });
  await assert.rejects(access(scope.executionRoot), { code: "ENOENT" });
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
});

test("source HEAD, branch, configuration and execution-path drift reject before worktree creation", native, async t => {
  for (const change of ["head", "branch", "configuration", "path"]) {
    await t.test(change, async t => {
      const f = await fixture(t), scope = await f.plan();
      if (change === "head") await f.git("commit", "--allow-empty", "-m", "new base");
      if (change === "branch") await f.git("switch", "-c", "new-target");
      if (change === "configuration") await f.git("config", "ling.changed", "true");
      const request = change === "path" ? { ...scope, executionRoot: f.root } : scope;
      await assert.rejects(createWorkflowGitWorktree(request), error => error.code === (change === "path"
        ? "workflow_git_scope_invalid" : "workflow_git_repository_basis_changed"));
      await assert.rejects(access(scope.executionRoot), { code: "ENOENT" });
    });
  }
});

test("dirty or detached target is blocked; explicit candidate mode never copies target WIP", native, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "owned.txt"), "user work\n");
  await writeFile(join(f.root, "untracked.txt"), "new user work\n");
  await assert.rejects(inspectWorkflowGitRepository(f.root), { code: "workflow_git_target_dirty" });
  const repository = await inspectWorkflowGitRepository(f.root, { allowDirtyCandidate: true });
  const scope = await planWorkflowGitWorktree({ repository, worktreeRoot: f.worktreeRoot, roundId: "candidate",
    stepId: "step", generation: 1 });
  const receipt = await createWorkflowGitWorktree(scope);
  assert.equal(await readFile(join(receipt.executionRoot, "owned.txt"), "utf8"), "base\n");
  await assert.rejects(access(join(receipt.executionRoot, "untracked.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "owned.txt"), "utf8"), "user work\n");
  await f.git("switch", "--detach");
  await assert.rejects(inspectWorkflowGitRepository(f.root, { allowDirtyCandidate: true }), { code: "workflow_git_target_detached" });
});

test("repository lock serializes sibling checkouts and is never stolen on expiry", native, async t => {
  const f = await fixture(t), receipt = await createWorkflowGitWorktree(await f.plan());
  const sibling = await inspectWorkflowGitRepository(receipt.executionRoot);
  await withWorkflowGitRepositoryLock(f.repository, async () => {
    await assert.rejects(withWorkflowGitRepositoryLock(sibling, async () => assert.fail("must not enter")),
      { code: "workflow_git_repository_busy" });
    const module = new URL("../dist/features/workspaces/workflow-git-repository.js", import.meta.url).href;
    const script = `const {withWorkflowGitRepositoryLock}=await import(${JSON.stringify(module)});try{await withWorkflowGitRepositoryLock(${JSON.stringify(sibling)},async()=>console.log('entered'))}catch(e){console.log(e.code)}`;
    const sourceArgs = process.execArgv.filter(arg => arg === "--experimental-transform-types" || arg.includes("workflow-scheduler-source-loader"));
    const { stdout } = await exec(process.execPath, [...sourceArgs, "--input-type=module", "-e", script]);
    assert.equal(stdout.trim(), "workflow_git_repository_busy");
  });
  const path = join(f.repository.commonDir, "ling-workflow-git.lock");
  await assert.rejects(access(path), { code: "ENOENT" });
  await mkdir(path); await writeFile(join(path, "owner.json"), '{"token":"abandoned","pid":0}');
  await assert.rejects(withWorkflowGitRepositoryLock(f.repository, async () => assert.fail("must not steal")),
    { code: "workflow_git_repository_busy" });
  assert.equal((await lstat(path)).isDirectory(), true);
});

test("Git hooks are disabled and inherited Git environment cannot redirect the Host actor", native, async t => {
  const f = await fixture(t), marker = join(f.base, "hook-ran"), hooks = join(f.base, "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\nprintf hook > '${marker}'\n`);
  await chmod(join(hooks, "post-checkout"), 0o700); await f.git("config", "core.hooksPath", hooks);
  const repository = await inspectWorkflowGitRepository(f.root);
  const scope = await planWorkflowGitWorktree({ repository, worktreeRoot: f.worktreeRoot, roundId: "hooks", stepId: "step", generation: 1 });
  const keys = ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"], prior = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { GIT_DIR: "/unavailable-repository", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ling.injected", GIT_CONFIG_VALUE_0: "secret" });
    const receipt = await createWorkflowGitWorktree(scope);
    assert.equal(receipt.baseCommit, f.repository.head);
    await assert.rejects(workflowGit(f.root, ["config", "--get", "ling.injected"]));
    assert.equal((await workflowGit(f.root, ["hash-object", "--stdin"], { input: Buffer.from("verified input") })).stdout.toString().trim().length, 40);
  } finally { keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; }); }
  await assert.rejects(access(marker), { code: "ENOENT" });
});

for (const kind of ["custom-filter", "custom-attributes", "encoding", "ident", "crlf", "include", "symlink", "in-progress"]) {
  test(`unsupported ${kind} is blocked before a new step worktree`, native, async t => {
    const f = await fixture(t);
    if (kind === "custom-filter") await f.git("config", "filter.fixture.smudge", "unsupported-command");
    if (kind === "include") await f.git("config", "include.path", join(f.base, "other-config"));
    if (["custom-attributes", "encoding", "ident", "crlf"].includes(kind)) {
      const attributes = { "custom-attributes": "filter=fixture", encoding: "working-tree-encoding=UTF-16LE", ident: "ident", crlf: "eol=crlf" };
      await writeFile(join(f.root, ".gitattributes"), `*.txt ${attributes[kind]}\n`);
      await f.git("add", "--", ".gitattributes"); await f.git("commit", "-m", "attributes");
    }
    if (kind === "symlink") {
      await symlink("owned.txt", join(f.root, "linked")); await f.git("add", "--", "linked"); await f.git("commit", "-m", "symlink");
    }
    if (kind === "in-progress") await writeFile(join(f.repository.gitDir, "MERGE_HEAD"), f.repository.head);
    await assert.rejects(inspectWorkflowGitRepository(f.root), error => error.code?.startsWith("workflow_git_"));
    assert.equal((await f.git("worktree", "list", "--porcelain")).split("worktree ").length - 1, 1);
  });
}

test("only literal normal Git paths can enter branch capture", () => {
  for (const path of ["src/module.ts", "new file.txt", ".github/workflows/ci.yml"]) assert.equal(safeWorkflowGitPath(path), true, path);
  for (const path of ["", "../escape", "/absolute", "src/../escape", ".git/config", "src/.Git/config", "src\\escape", "bad\nname", "src/trailing "])
    assert.equal(safeWorkflowGitPath(path), false, path);
});

test("directory-prefix case aliases in a tree are rejected without checking out that tree", native, async t => {
  const f = await fixture(t);
  const blob = (await workflowGit(f.root, ["hash-object", "-w", "--stdin"], { input: Buffer.from("content\n") })).stdout.toString().trim();
  const subtree = (await workflowGit(f.root, ["mktree", "-z"], { input: Buffer.from(`100644 blob ${blob}\tfile.txt\0`) })).stdout.toString().trim();
  const treeInput = Buffer.from(`040000 tree ${subtree}\tModule\0` + `040000 tree ${subtree}\tmodule\0`);
  const tree = (await workflowGit(f.root, ["mktree", "-z"], { input: treeInput })).stdout.toString().trim();
  const commit = (await workflowGit(f.root, ["commit-tree", tree, "-p", f.repository.head], { input: Buffer.from("ambiguous fixture\n") })).stdout.toString().trim();
  await assert.rejects(inspectWorkflowGitTree(f.root, commit), { code: "workflow_git_ambiguous_case_path" });
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
});
