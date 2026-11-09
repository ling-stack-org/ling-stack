import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowIsolationScopePlanDigest, workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint,
  workflowStepSafetyPlanDigest } from "@ling-stack/core";
import { workflowIsolationFixture } from "../../core/test/support/workflow-isolation-fixture.mjs";
import { ensureWorkflowIsolationWorktree, prepareWorkflowIsolatedExecution } from "../dist/features/runs/workflow-isolation-execution.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree,
  workflowGitRepositoryBasisDigest } from "../dist/features/workspaces/workflow-git-repository.js";
import { executeWorkflowIsolatedTool } from "../dist/features/runs/workflow-isolated-executor.js";

const exec = promisify(execFile), native = { skip: !["darwin", "linux"].includes(process.platform) };

async function fixture(t) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false });
  f.git = async (...args) => (await exec("/usr/bin/git", args, { cwd: f.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await f.git("init", "--initial-branch=main");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!owned.txt\n!.gitignore\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt"); await f.git("commit", "-m", "initial");
  const repository = await inspectWorkflowGitRepository(f.cwd), worktreeRoot = join(f.root, "step-worktrees");
  await mkdir(worktreeRoot);
  f.scopeGit = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: f.scopeIsolation.step.id, generation: 1, worktreeId: "host-step-one" });
  const integration = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 1, worktreeId: "host-integration-one" });
  f.executionRoot = f.scopeGit.executionRoot;
  const metadata = f.current(f.scopeIsolation).metadata;
  const safety = { ...metadata.safetyPlan, executionRoot: f.executionRoot, writeRoots: [f.executionRoot] };
  safety.digest = workflowStepSafetyPlanDigest(safety);
  f.store.updateChannelWorkflowStep(f.scopeIsolation.step.id, { metadata: { ...metadata, safetyPlan: safety } }, f.at(0));
  f.stepFingerprint = workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation));
  const safetyPins = [{ workflowStepId: f.scopeIsolation.step.id, fingerprint: f.stepFingerprint }];
  const target = { ...f.inputs.target, expectedHead: repository.head, branchRef: repository.branchRef,
    cleanStateDigest: workflowGitRepositoryBasisDigest(repository) };
  f.inputs = { ...f.inputs, repositoryIdentity: { commonDir: repository.commonDir, objectFormat: repository.head.length === 40 ? "sha1" : "sha256" },
    target, baseCommit: repository.head, integration: { executionRoot: integration.executionRoot,
      worktreeId: integration.worktreeId, branchRef: integration.branchRef }, safetyPins,
    safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins) };
  f.plan = { ...f.plan, repositoryIdentity: f.inputs.repositoryIdentity, target, baseCommit: repository.head,
    executionRoot: f.executionRoot, worktreeId: f.scopeGit.worktreeId, branchRef: f.scopeGit.branchRef, safetyFingerprint: f.stepFingerprint };
  f.plan.planDigest = workflowIsolationScopePlanDigest(f.plan);
  f.create(); f.persistPin(); f.prepare();
  const { now: _now, ...binding } = f.bindInput;
  f.input = () => ({ store: f.store, isolation: f.isolation, binding, scope: f.scopeGit, now: () => f.at(10) });
  f.ensure = overrides => ensureWorkflowIsolationWorktree({ ...f.input(), ...overrides });
  f.prepareExecution = overrides => prepareWorkflowIsolatedExecution({ ...f.input(), prepareInput: async () => f.executionPayload(), ...overrides });
  f.intentRows = () => f.store.database.prepare("SELECT * FROM workflow_isolation_intents").all();
  f.receiptRows = () => f.store.database.prepare("SELECT * FROM workflow_isolation_receipts").all();
  return f;
}

function interruptedIsolation(f, method, error, after = false) {
  let interrupted = false;
  return new Proxy(f.isolation, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (key !== method || interrupted) return value.apply(target, args);
      interrupted = true;
      if (after) value.apply(target, args);
      throw error;
    };
  } });
}

test("real SQLite lineage prepares a real Git worktree before SDK capture and seals both requests", native, async t => {
  const f = await fixture(t);
  const result = await f.prepareExecution({ prepareInput: async execution => {
    assert.equal(execution.binding.status, "ready");
    assert.equal(await readFile(join(execution.receipt.executionRoot, "owned.txt"), "utf8"), "base\n");
    assert.equal(f.receiptRows().length, 1);
    assert.equal(f.store.getRun(f.prepared.run.id).requestSnapshot.runnerExecutionInput, undefined);
    return f.executionPayload();
  } });
  assert.equal(result.binding.status, "ready");
  assert.equal(f.admission(f.scopeIsolation, f.generation).status, "preparing");
  assert.equal(f.intentRows()[0].status, "confirmed");
  assert.deepEqual(f.store.getRun(f.prepared.run.id).requestSnapshot.runnerExecutionInput, result.runnerExecutionInput);
  assert.deepEqual(f.store.getWorkUnit(f.prepared.unit.id).request.runnerExecutionInput, result.runnerExecutionInput);
  assert.equal(await f.git("rev-parse", "HEAD"), f.scopeGit.baseCommit);
  assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "base\n");
  f.link();
  assert.equal(f.isolation.assertExecutionBinding({ writer: result.writer, now: f.at(11) }).status, "current");
});

test("identical pre-dispatch retry survives reopen without a second effect, artifact or request update", native, async t => {
  const f = await fixture(t), first = await f.prepareExecution(), before = f.snapshotIsolation();
  const artifacts = f.store.listArtifacts(f.prepared.run.id);
  f.reopenIsolation();
  const again = await f.prepareExecution();
  assert.deepEqual(again, first);
  assert.deepEqual(f.snapshotIsolation(), before);
  assert.deepEqual(f.store.listArtifacts(f.prepared.run.id), artifacts);
});

for (const phase of ["intent", "physical", "receipt"]) {
  test(`recovery after ${phase} interruption observes the original intent and never replaces a worktree`, native, async t => {
    const f = await fixture(t), fault = new Error(`interrupted-${phase}`);
    const method = phase === "intent" ? "recordIntent" : phase === "physical" ? "recordReceipt" : "markExecutionReady";
    await assert.rejects(f.ensure({ isolation: interruptedIsolation(f, method, fault, phase === "intent") }), error => error === fault);
    assert.equal(f.intentRows().length, 1);
    assert.equal(f.intentRows()[0].status, phase === "receipt" ? "confirmed" : "pending");
    if (phase === "intent") await assert.rejects(access(f.executionRoot), { code: "ENOENT" });
    else assert.equal(await readFile(join(f.executionRoot, "owned.txt"), "utf8"), "base\n");
    f.reopenIsolation();
    const result = await f.prepareExecution();
    assert.equal(result.binding.status, "ready");
    assert.equal(f.intentRows().length, 1);
    assert.equal(f.receiptRows().length, 1);
    assert.equal(f.store.listArtifacts(f.prepared.run.id).length, 1);
    assert.equal((await f.git("worktree", "list", "--porcelain")).split("worktree ").length - 1, 2);
  });
}

for (const kind of ["directory", "matching-worktree", "ref"]) {
  test(`a ${kind} predating the durable create intent is never adopted`, native, async t => {
    const f = await fixture(t);
    if (kind === "directory") { await mkdir(f.executionRoot); await writeFile(join(f.executionRoot, "wip"), "preserve"); }
    if (kind === "matching-worktree") await createWorkflowGitWorktree(f.scopeGit);
    if (kind === "ref") await f.git("update-ref", f.scopeGit.branchRef, f.scopeGit.baseCommit);
    await assert.rejects(f.ensure(), { code: "workflow_isolation.execution_identity_exists" });
    assert.equal(f.intentRows().length, 0);
    if (kind === "directory") assert.equal(await readFile(join(f.executionRoot, "wip"), "utf8"), "preserve");
    if (kind === "matching-worktree") assert.equal(await readFile(join(f.executionRoot, "owned.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "base\n");
  });
}

for (const change of ["fence", "owner", "plan", "path", "base", "branch", "target"]) {
  test(`${change} drift rejects preparation without a Git or SDK effect`, native, async t => {
    const f = await fixture(t), input = f.input();
    if (change === "fence") input.binding = { ...input.binding, fence: { ...input.binding.fence, fencingToken: "999" } };
    if (change === "owner") input.binding = { ...input.binding, startOwner: { ...input.binding.startOwner, leaseId: "foreign" } };
    if (change === "plan") input.binding = { ...input.binding, planDigest: "foreign" };
    if (change === "path") input.scope = { ...input.scope, executionRoot: f.cwd };
    if (change === "base") input.scope = { ...input.scope, baseCommit: "9".repeat(40) };
    if (change === "branch") input.scope = { ...input.scope, branchRef: "refs/heads/foreign" };
    if (change === "target") await f.git("commit", "--allow-empty", "-m", "target drift");
    await assert.rejects(prepareWorkflowIsolatedExecution({ ...input, prepareInput: async () => assert.fail("SDK must not prepare") }),
      error => error.code?.startsWith("workflow_isolation."));
    assert.equal(f.intentRows().length, 0);
    await assert.rejects(access(f.executionRoot), { code: "ENOENT" });
  });
}

test("revocation after intent persistence leaves recoverable evidence but never creates a checkout", native, async t => {
  const f = await fixture(t), isolation = new Proxy(f.isolation, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => {
      const result = value.apply(target, args);
      if (key === "recordIntent") f.store.database.prepare("UPDATE resource_leases SET status='released' WHERE id=?").run(f.generation.owner.leaseId);
      return result;
    };
  } });
  await assert.rejects(f.ensure({ isolation }), { code: "workflow_isolation.start_lease_changed" });
  assert.equal(f.intentRows()[0].status, "pending");
  assert.equal(f.receiptRows().length, 0);
  await assert.rejects(access(f.executionRoot), { code: "ENOENT" });
});

test("a dirty crash residue is retained and cannot be marked ready or silently recreated", native, async t => {
  const f = await fixture(t);
  await assert.rejects(f.ensure({ isolation: interruptedIsolation(f, "recordReceipt", new Error("crash")) }), /crash/);
  await writeFile(join(f.executionRoot, "owned.txt"), "preserved unknown work\n");
  await assert.rejects(f.ensure(), { code: "workflow_git_target_dirty" });
  assert.equal(f.binding().status, "planned");
  assert.equal(f.intentRows()[0].status, "pending");
  assert.equal(await readFile(join(f.executionRoot, "owned.txt"), "utf8"), "preserved unknown work\n");
});

test("failed or revoked SDK preparation never leaves partial runner input in either request", native, async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepareExecution({ prepareInput: async () => { throw new Error("SDK preparation failed"); } }), /SDK preparation failed/);
  assert.equal(f.binding().status, "ready");
  assert.equal(f.store.getRun(f.prepared.run.id).requestSnapshot.runnerExecutionInput, undefined);
  assert.equal(f.store.getWorkUnit(f.prepared.unit.id).request.runnerExecutionInput, undefined);
  await assert.rejects(f.prepareExecution({ prepareInput: async () => {
    f.store.database.prepare("UPDATE resource_leases SET status='released' WHERE id=?").run(f.generation.owner.leaseId);
    return f.executionPayload();
  } }), { code: "workflow_isolation.start_lease_changed" });
  assert.equal(f.store.getRun(f.prepared.run.id).requestSnapshot.runnerExecutionInput, undefined);
  assert.equal(f.store.getWorkUnit(f.prepared.unit.id).request.runnerExecutionInput, undefined);
});

test("an already started attempt cannot reacquire the preparation lifecycle", native, async t => {
  const f = await fixture(t); await f.prepareExecution();
  f.store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(f.at(11), f.prepared.attempt.id);
  const before = f.snapshotIsolation();
  await assert.rejects(f.ensure(), { code: "workflow_isolation.preparation_already_started" });
  assert.deepEqual(f.snapshotIsolation(), before);
});

test("ready ownership confines a real sandboxed file write and rejects a released admission", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), execution = await f.prepareExecution(); f.link();
  const request = { toolName: "write", toolCallId: "real-isolated-write", cwd: f.executionRoot,
    input: { path: "owned.txt", content: "isolated branch\n" } };
  const assertCurrent = () => {
    const result = f.isolation.assertExecutionBinding({ writer: execution.writer, now: f.at(12) });
    if (result.status !== "current") throw Object.assign(new Error(result.code), { code: result.code });
  };
  const result = await executeWorkflowIsolatedTool({ root: execution.plan.executionRoot, request, assertCurrent });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(await readFile(join(f.executionRoot, "owned.txt"), "utf8"), "isolated branch\n");
  assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "base\n");
  f.store.releaseRuntimeSemaphoreSlotsForAttempt(execution.writer, f.at(13), "cancelled");
  await assert.rejects(executeWorkflowIsolatedTool({ root: execution.plan.executionRoot,
    request: { ...request, input: { path: "owned.txt", content: "MUST NOT WRITE" } }, assertCurrent }),
  { code: "workflow_isolation.admission_slots_changed" });
  assert.equal(await readFile(join(f.executionRoot, "owned.txt"), "utf8"), "isolated branch\n");
});
