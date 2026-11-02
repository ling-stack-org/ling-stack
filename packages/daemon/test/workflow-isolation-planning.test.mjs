import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIsolationStore, isWorkflowStepSafetyPlanV1 } from "@ling-stack/core";
import { planWorkflowIsolatedRound, readWorkflowIsolationWorktreeScope } from "../dist/features/channels/workflow-isolation-planning.js";
import { assertWorkflowSafetyRequest, createWorkflowSafetyAdmission, restrictWorkflowSafetyTools,
  workflowSafetySnapshot } from "../dist/features/runs/workflow-safety.js";
import { schedulerFixture } from "./support/workflow-scheduler-fixture.mjs";

const exec = promisify(execFile), native = { skip: !["darwin", "linux"].includes(process.platform) };

async function fixture(t) {
  const f = await schedulerFixture(t);
  f.git = async (...args) => (await exec("/usr/bin/git", args, { cwd: f.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await f.git("init", "--initial-branch=main");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!owned.txt\n!.gitignore\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", "owned.txt", ".gitignore");
  await f.git("commit", "-m", "initial");
  const graph = { schemaVersion: 1, id: "isolation-plan", name: "Isolated files", entryNodeId: "write",
    nodes: [{ id: "write", kind: "step", name: "Write", prompt: "Change the owned file", sideEffectClass: "workspace_write" }],
    edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata, workflowGraph: graph,
    workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, new Date().toISOString());
  f.writing = (name, extra = {}) => f.step(name, { sideEffectClass: "workspace_write", requestedRunnerId: "pi",
    parallelPolicy: { autoParallel: false, maxParallelSiblings: 1, resourceKeys: [] }, requiredTools: ["read", "edit", "write"], ...extra });
  f.worktreeRoot = join(f.root, "host-worktrees");
  await mkdir(f.worktreeRoot);
  f.input = () => ({ store: f.store, workflowId: f.workflow.id, roundId: "host-round-one", worktreeRoot: f.worktreeRoot,
    validationRequirements: [{ id: "tests", fingerprint: "test-command-v1" }] });
  f.request = step => ({ cwd: step.metadata.safetyPlan.executionRoot, workspaceCwd: f.cwd, runnerId: "pi",
    providerPresetId: f.channel.defaultProviderPresetId, teammateId: step.toParticipantId, workflowStepId: step.id,
    workflowIsolationPlan: step.metadata.isolationScopePlan, workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan),
    task: { id: "pending", title: "Write", prompt: "Write", channelId: f.channel.id } });
  return f;
}

test("Host freezes two isolated file scopes before approval without creating Tasks, Runs, worktrees or Git refs", native, async t => {
  const f = await fixture(t), first = f.writing("One"), second = f.writing("Two");
  const result = await planWorkflowIsolatedRound(f.input());
  assert.equal(result.round.inputs.mode, "candidate_only");
  assert.deepEqual(result.round.inputs.mergeOrder, [first.id, second.id]);
  assert.ok(result.round.inputs.participants.every(value => value.required));
  assert.equal(result.plans.length, 2);
  assert.notEqual(result.plans[0].executionRoot, result.plans[1].executionRoot);
  for (const plan of result.plans) {
    const step = f.store.getChannelWorkflowStep(plan.workflowStepId), request = f.request(step);
    assert.equal(step.metadata.safetyPlan.profile, "pi_host_isolated_files_v1");
    assert.equal(isWorkflowStepSafetyPlanV1(step.metadata.safetyPlan), true);
    assert.equal(assertWorkflowSafetyRequest(f.store, request).digest, step.metadata.safetyPlan.digest);
    assert.deepEqual(createWorkflowSafetyAdmission(f.store, step, request), plan.resourcePlan);
    assert.ok(plan.resourcePlan.entries.filter(entry => entry.resourceType === "channel_parallel").every(entry => entry.limit === 1));
    assert.deepEqual(plan.resourcePlan.resourceKeys, [`workflow:${f.workflow.id}`, `workspace:${f.cwd}`].sort());
    assert.equal((await readWorkflowIsolationWorktreeScope(f.store, request.workflowIsolationPlan)).executionRoot, plan.executionRoot);
    await assert.rejects(access(plan.executionRoot), { code: "ENOENT" });
  }
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM run_sessions").get().n, 0);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM approval_requests").get().n, 0);
  assert.equal((await f.git("for-each-ref", "--format=%(refname)", "refs/heads/ling/")).trim(), "");
  assert.deepEqual(await planWorkflowIsolatedRound(f.input()), result, "identical Host planning is idempotent");
});

for (const kind of ["shell", "foreign runner", "release", "prior approval", "dirty repository"]) {
  test(`Host planning rejects ${kind} before persisting a round or isolation pin`, native, async t => {
    const f = await fixture(t), step = f.writing("One", kind === "shell" ? { requiredTools: ["bash"] }
      : kind === "foreign runner" ? { requestedRunnerId: "codex" } : kind === "release" ? { sideEffectClass: "release" }
        : kind === "prior approval" ? { preStepApprovalId: "already-reviewed" } : {});
    if (kind === "dirty repository") await writeFile(join(f.cwd, "owned.txt"), "keep user WIP\n");
    await assert.rejects(planWorkflowIsolatedRound(f.input()));
    assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound("host-round-one"), undefined);
    assert.equal(f.store.getChannelWorkflowStep(step.id).metadata.isolationScopePlan, undefined);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  });
}

test("scope pin removal, a foreign snapshot or target drift cannot obtain isolated authority", native, async t => {
  const f = await fixture(t), created = f.writing("One");
  await planWorkflowIsolatedRound(f.input());
  const step = f.store.getChannelWorkflowStep(created.id), request = f.request(step);
  assert.throws(() => assertWorkflowSafetyRequest(f.store, { ...request, workflowIsolationPlan: undefined }), { code: "workflow_safety_mismatch" });
  assert.throws(() => assertWorkflowSafetyRequest(f.store, { ...request,
    workflowSafetySnapshot: { ...request.workflowSafetySnapshot, plan: { ...request.workflowSafetySnapshot.plan, executionRoot: f.cwd } } }),
  { code: "workflow_safety_mismatch" });
  await f.git("commit", "--allow-empty", "-m", "target drift");
  await assert.rejects(readWorkflowIsolationWorktreeScope(f.store, request.workflowIsolationPlan), { code: "workflow_isolation_plan_unavailable" });
});

test("isolated profile drops every optional external surface without widening file selection", native, async t => {
  const f = await fixture(t), created = f.writing("One");
  await planWorkflowIsolatedRound(f.input());
  const plan = f.store.getChannelWorkflowStep(created.id).metadata.safetyPlan;
  const options = restrictWorkflowSafetyTools({ tools: ["write"], onMcpToolCall() {}, onPermissionRequired() {},
    onToolHydrationRequest() {}, onDelegationToolCall() {}, onUserInputRequest() {},
    runtimeToolFeatures: { requestPermissions: true, unifiedExec: true, shellSnapshot: true },
    initialToolSurface: { userInput: true, delegation: true, mediaGeneration: true, nativeFileCreate: true, toolHydration: true } }, plan);
  assert.equal(options.isolatedToolsProfile, "host_isolated_files_v1");
  assert.deepEqual(options.tools, ["write"]);
  assert.deepEqual(options.mcpTools, []);
  for (const name of ["onMcpToolCall", "onPermissionRequired", "onToolHydrationRequest", "onDelegationToolCall", "onUserInputRequest"]) {
    assert.equal(options[name], undefined);
  }
  assert.ok(Object.values(options.runtimeToolFeatures).every(value => value === false));
  assert.ok(Object.values(options.initialToolSurface).every(value => value === false));
});
