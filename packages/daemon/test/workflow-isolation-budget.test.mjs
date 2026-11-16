import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIsolationStore } from "@ling-stack/core";
import { planWorkflowIsolatedRound, readWorkflowIsolationWorktreeScope } from "../dist/features/channels/workflow-isolation-planning.js";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { createWorkflowGitWorktree } from "../dist/features/workspaces/workflow-git-repository.js";
import { schedulerFixture } from "./support/workflow-scheduler-fixture.mjs";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
const parallelExecution = { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" };
const budgetError = { code: "workflow_git_worktree_budget_exceeded" };

async function fixture(t, writingCount, readonlyCount = 0) {
  const f = await schedulerFixture(t, { cap: 2 });
  f.git = async (...args) => (await workflowGit(f.cwd, args)).stdout.toString().trim();
  await f.git("init", "--initial-branch=main", "--template=");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!owned.txt\n!.gitignore\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", "owned.txt", ".gitignore");
  await f.git("commit", "-m", "budget fixture base");
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy,
    writeLockScope: "boundPath" } }, new Date().toISOString());
  const nodes = Array.from({ length: writingCount + readonlyCount }, (_, index) => ({ id: `step-${index}`,
    kind: "step", name: `Step ${index}`, prompt: "Inspect the owned file",
    sideEffectClass: index < writingCount ? "workspace_write" : "analysis_readonly" }));
  const graph = { schemaVersion: 1, id: "budget-plan", name: "Round worktree budget", entryNodeId: nodes[0].id,
    nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, fromNodeId: nodes[index].id,
      toNodeId: node.id, condition: { kind: "all_succeeded" } })),
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  f.workflow = f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata,
    workflowGraph: graph, workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, new Date().toISOString());
  f.writers = nodes.map(node => f.step(node.name, { sideEffectClass: node.sideEffectClass, requestedRunnerId: "pi",
    parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] },
    requiredTools: node.sideEffectClass === "workspace_write" ? ["read", "edit", "write"] : ["read"] })).slice(0, writingCount);
  f.worktreeRoot = join(f.root, "host-worktrees");
  await mkdir(f.worktreeRoot);
  f.input = { store: f.store, workflowId: f.workflow.id, roundId: "budget-round", worktreeRoot: f.worktreeRoot,
    validationRequirements: [{ id: "tests", fingerprint: "budget-fixture-v1" }] };
  return f;
}

function executionState(f) {
  return Object.fromEntries(["workflow_integration_rounds", "workflow_isolation_scope_plans", "workflow_parallel_parent_fences",
    "tasks", "run_sessions", "approval_requests", "workflow_step_admissions", "channel_workflow_steps"]
    .map(table => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function registrations(f) {
  return (await f.git("worktree", "list", "--porcelain", "-z")).split("\0").filter(value => value.startsWith("worktree ")).length;
}

async function assertNoExecution(f, registeredCount) {
  for (const table of ["tasks", "run_sessions", "approval_requests"]) {
    assert.equal(f.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(await registrations(f), registeredCount);
  assert.deepEqual(await readdir(f.worktreeRoot), []);
  assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/heads/ling/"), "");
  assert.equal(await f.git("status", "--porcelain"), "");
}

for (const parallel of [false, true]) {
  const mode = parallel ? "two concurrent writers" : "serial isolated execution";
  test(`15 writing participants plus integration exceed one target's round budget with ${mode}`, native, async t => {
    const f = await fixture(t, 15), before = executionState(f);
    await assert.rejects(planWorkflowIsolatedRound({ ...f.input, ...(parallel ? { parallelExecution } : {}) }), budgetError);
    assert.deepEqual(executionState(f), before, "reject before freezing a round, scope pins, Tasks or approvals");
    assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
    await assertNoExecution(f, 1);
  });

  test(`14 writing participants and readonly steps leave an integration slot with ${mode}`, native, async t => {
    const f = await fixture(t, 14, 2), input = { ...f.input, ...(parallel ? { parallelExecution } : {}) };
    const planned = await planWorkflowIsolatedRound(input);
    assert.equal(planned.plans.length, 14);
    assert.deepEqual(planned.round.inputs.mergeOrder, f.writers.map(step => step.id));
    assert.equal(new Set([...planned.plans.map(plan => plan.executionRoot), planned.round.inputs.integration.executionRoot]).size, 15);
    assert.deepEqual(await planWorkflowIsolatedRound(input), planned, "boundary planning stays idempotent");
    await assertNoExecution(f, 1);
  });
}

for (const writingCount of [13, 14]) {
  test(`an unrelated registered checkout counts against the ${writingCount}-writer round`, native, async t => {
    const f = await fixture(t, writingCount), foreign = join(f.root, "foreign-checkout");
    await f.git("worktree", "add", "--detach", "--", foreign, "HEAD");
    assert.equal(await registrations(f), 2);
    const before = executionState(f);
    if (writingCount === 14) {
      await assert.rejects(planWorkflowIsolatedRound(f.input), budgetError);
      assert.deepEqual(executionState(f), before);
    } else {
      assert.equal((await planWorkflowIsolatedRound(f.input)).plans.length, 13);
    }
    await access(foreign);
    await assertNoExecution(f, 2);
  });
}

test("registration growth during asynchronous planning is rechecked before freezing any authority", native, async t => {
  const f = await fixture(t, 14), before = executionState(f), original = f.store.getChannelWorkflow.bind(f.store);
  let reads = 0;
  t.mock.method(f.store, "getChannelWorkflow", id => {
    if (++reads === 2) execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--",
      join(f.root, "late-foreign-checkout"), "HEAD"], { cwd: f.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
    return original(id);
  });
  await assert.rejects(planWorkflowIsolatedRound(f.input), budgetError);
  assert.deepEqual(executionState(f), before);
  await assertNoExecution(f, 2);
});

test("the physical create gate still rejects foreign Git competition after a round was planned", native, async t => {
  const f = await fixture(t, 14), planned = await planWorkflowIsolatedRound(f.input);
  const scope = await readWorkflowIsolationWorktreeScope(f.store, {
    planId: planned.plans[0].planId, planDigest: planned.plans[0].planDigest });
  for (let index = 0; index < 15; index++) await f.git("worktree", "add", "--detach", "--",
    join(f.root, `foreign-${index}`), "HEAD");
  assert.equal(await registrations(f), 16);
  const before = executionState(f);
  await assert.rejects(createWorkflowGitWorktree(scope, { beforeCreate() { assert.fail("no physical create after budget rejection"); } }), budgetError);
  assert.deepEqual(executionState(f), before);
  await assert.rejects(access(scope.executionRoot), { code: "ENOENT" });
  await assert.rejects(f.git("show-ref", "--verify", scope.branchRef));
  await assertNoExecution(f, 16);
});
