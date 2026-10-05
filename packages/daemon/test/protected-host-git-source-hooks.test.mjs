import assert from "node:assert/strict";
import test from "node:test";
import { createSourceHookFixture, loadSourceHookModule } from "./support/protected-host-source-hooks-fixture.mjs";
import { observeGitSourceProcesses } from "./support/protected-host-git-source-hooks-fixture.mjs";

// Source import follows the producer observer, because managed Git captures
// promisify(execFile) once. The observer never executes Git or mutates a repository.
test("the three original Git sources gate physical launch without claiming certified Git profiles", async t => {
  const observed = observeGitSourceProcesses(t);
  const managed = await loadSourceHookModule("features/workspaces/managed-worktrees.js");
  const changes = await loadSourceHookModule("features/previews/workspace-changes.js");
  const classifier = await loadSourceHookModule("features/runs/action-classifier.js");
  const { readProtectedHostActorEntry } = await loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
  const entries = [changes.WORKSPACE_CHANGES_GIT_ACTOR_ENTRY, managed.MANAGED_WORKTREES_GIT_ACTOR_ENTRY,
    classifier.ACTION_CLASSIFIER_GIT_ACTOR_ENTRY];
  const nativeOnly = { skip: process.platform !== "darwin" };

  await t.test("exports are original immutable controlled entries, not a complete manifest", () => {
    assert.deepEqual(entries.map(entry => readProtectedHostActorEntry(entry)), [
      { entryId: "workspace_changes_git", kind: "controlled" },
      { entryId: "managed_worktrees_git", kind: "controlled" },
      { entryId: "action_classifier_git", kind: "controlled" },
    ]);
    for (const entry of entries) {
      assert.equal(Object.isFrozen(entry), true);
      assert.throws(() => readProtectedHostActorEntry({ ...entry }), /entry_invalid/u);
      assert.throws(() => { entry.invoke = () => undefined; }, TypeError);
      assert.equal(Object.hasOwn(entry, "registry"), false);
    }
  });

  await t.test("shared managed Git rejects both read and worktree mutation before execFile", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.register(); f.registry.bindOriginalActorEntries([managed.MANAGED_WORKTREES_GIT_ACTOR_ENTRY]);
    for (const args of [["rev-parse", "HEAD"], ["worktree", "add", "/never-created"], ["worktree", "remove", "/never-removed"]]) {
      await assert.rejects(managed.git(f.cwd, args), /protected_host_actor_unbound_with_active_stage/u);
    }
    const resolution = await managed.resolveGitRepoRoot(f.cwd);
    assert.equal(resolution.ok, false); assert.equal(resolution.code, "git_inspection_failed");
    const result = await managed.createManagedGitWorktree({ repoRoot: f.cwd, worktreePath: `${f.cwd}/never-created`, branchName: "fixture" });
    assert.equal(result.ok, false); assert.equal(result.code, "git_inspection_failed");
    assert.equal(observed.calls.length, before);
    assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
  });

  await t.test("workspace changes public inspection reaches the bounded diff source gate before spawn", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.register(); f.registry.bindOriginalActorEntries([changes.WORKSPACE_CHANGES_GIT_ACTOR_ENTRY]);
    await assert.rejects(changes.inspectWorkspaceChanges(f.cwd, "2026-10-05T00:00:00.000Z"), /protected_host_actor_unbound_with_active_stage/u);
    const entered = observed.calls.slice(before);
    assert.equal(entered.some(call => call.kind === "execFile" && call.args[0] === "status"), true);
    assert.equal(entered.some(call => call.kind === "spawn"), false);
  });

  await t.test("commit and push public previews propagate the pre-producer refusal instead of returning facts", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.register(); f.registry.bindOriginalActorEntries([classifier.ACTION_CLASSIFIER_GIT_ACTOR_ENTRY]);
    for (const command of ["git commit -m fixture", "git push origin main"]) {
      assert.throws(() => classifier.buildGitCommandPreview(f.cwd, command), /protected_host_actor_unbound_with_active_stage/u);
    }
    assert.equal(observed.calls.length, before);
  });

  await t.test("upstream fallback cannot turn a later original source refusal into a ready push preview", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.register();
    observed.setSyncHandler(call => {
      assert.deepEqual(call.args, ["rev-parse", "--abbrev-ref", "HEAD"]);
      // An initially unbound original branch read is observed. Install the real
      // registry gate before the next source call, not a replaceable call-site flag.
      f.registry.bindOriginalActorEntries([classifier.ACTION_CLASSIFIER_GIT_ACTOR_ENTRY]);
      return "main\n";
    });
    try {
      assert.throws(() => classifier.buildGitCommandPreview(f.cwd, "git push origin main"), /protected_host_actor_unbound_with_active_stage/u);
      assert.equal(observed.calls.length, before + 1);
      assert.deepEqual(observed.calls.at(-1).args, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } finally { observed.setSyncHandler(); }
  });

  await t.test("a genuine macos prepared actor is not borrowed by any Git physical entry", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.register();
    const original = f.prepared(), actor = f.registry.bindPreparedActor(original.source, original.prepared);
    f.registry.bindOriginalActorEntries(entries);
    assert.throws(() => changes.WORKSPACE_CHANGES_GIT_ACTOR_ENTRY.invoke(actor, f.cwd, ["diff"]), /entry_proof_invalid/u);
    assert.throws(() => managed.MANAGED_WORKTREES_GIT_ACTOR_ENTRY.invoke(actor, f.cwd, ["rev-parse", "HEAD"]), /entry_proof_invalid/u);
    assert.throws(() => classifier.ACTION_CLASSIFIER_GIT_ACTOR_ENTRY.invoke(actor,
      { cwd: f.cwd, args: ["rev-parse", "HEAD"], producerEntered: true, policyVerified: true }), /entry_proof_invalid/u);
    assert.equal(observed.calls.length, before);
  });

  await t.test("ordinary Git producer failures keep the existing unavailable and absent-upstream fallbacks", () => {
    const ordinary = new Error("protected_host_actor_unbound_with_active_stage");
    observed.setSyncHandler(() => { throw ordinary; });
    try {
      const failed = classifier.buildGitCommandPreview("/observed-only", "git commit -m fixture");
      assert.equal(failed.previewStatus, "unavailable"); assert.equal(failed.failClosed, true);
      assert.equal(failed.reason, ordinary.message);
    } finally { observed.setSyncHandler(); }
    observed.setSyncHandler(call => {
      if (call.args.includes("@{u}")) throw ordinary;
      return "main\n";
    });
    try {
      const push = classifier.buildGitCommandPreview("/observed-only", "git push origin fixture");
      assert.equal(push.previewStatus, "ready"); assert.equal(push.upstream, undefined);
      assert.deepEqual(push.commitsToPush, []);
    } finally { observed.setSyncHandler(); }
  });

  await t.test("stage-free original Git calls retain arguments and completed observations cannot retire unknown history", nativeOnly, async t => {
    const f = await createSourceHookFixture(t), before = observed.calls.length;
    f.registry.bindOriginalActorEntries(entries);
    const read = await managed.git(f.cwd, ["rev-parse", "HEAD"]);
    assert.equal(read.stdout, "abc123\n");
    await managed.git(f.cwd, ["worktree", "add", "observed-only", "main"]);
    const commit = classifier.buildGitCommandPreview(f.cwd, "git commit -m fixture");
    assert.equal(commit.previewStatus, "ready"); assert.deepEqual(commit.stagedPaths, ["tracked.txt"]);
    const diff = await changes.inspectWorkspaceChanges(f.cwd, "2026-10-05T00:00:00.000Z");
    assert.equal(diff.files.length, 1); assert.equal(diff.files[0].additions, 1); assert.equal(diff.files[0].deletions, 1);
    const entered = observed.calls.slice(before), asyncCalls = entered.filter(call => call.kind === "execFile");
    assert.equal(asyncCalls.every(call => call.command === "git" && call.options.cwd === f.cwd
      && call.options.timeout === 15000 && call.options.maxBuffer === 1024 * 1024), true);
    const syncCalls = entered.filter(call => call.kind === "execFileSync");
    assert.equal(syncCalls.every(call => call.command === "git" && call.options.cwd === f.cwd
      && call.options.encoding === "utf8" && call.options.timeout === 5000 && call.options.maxBuffer === 256 * 1024), true);
    const spawned = entered.filter(call => call.kind === "spawn");
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--", "tracked.txt"]);
    assert.deepEqual(spawned[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.throws(() => f.register(), /coverage_unknown/u);
  });
});
