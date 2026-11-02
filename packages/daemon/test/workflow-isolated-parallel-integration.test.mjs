import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore,
  createSqliteWorkflowMergeApplyStore, toRuntimeAttemptFence, workflowIsolationDigest } from "../../core/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../dist/index.js";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../dist/features/channels/workflow-candidate-validation.js";
import { coordinateWorkflowIntegration } from "../dist/features/channels/workflow-integration-coordinator.js";
import { planWorkflowIsolatedRound } from "../dist/features/channels/workflow-isolation-planning.js";
import { waitForWorkflowIsolationIdle } from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const exec = promisify(execFile), now = () => new Date().toISOString();
const branches = [
  { participantId: "teammate_builtin_engineer", name: "Engineer", path: "left.txt", content: "left through parallel Host\n" },
  { participantId: "teammate_builtin_qa", name: "QA", path: "right.txt", content: "right through parallel Host\n" },
];
const parallelExecution = { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" };
const options = { skip: process.platform !== "darwin", timeout: 120_000 };

// The SDK and Host execute real writes; only the provider HTTP transport is scripted locally.
test("explicit isolated siblings both write before either finishes, retain their parent, and apply one fan-in", options, async t => {
  const f = await fixture(t);
  const evidence = await f.start();
  assert.ok(f.release.every(gate => !gate.settled), "neither original Run finished to admit its sibling");
  assert.equal(f.parent().state, "held");
  assert.deepEqual(await f.target(), f.initialTarget);
  const runningView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(runningView.isolation.status, "available");
  assert.equal(runningView.isolation.completion, "blocked");
  assert.equal(runningView.isolation.rounds[0].maxConcurrentSteps, 2);
  assert.deepEqual(runningView.isolation.rounds[0].participants.map(item => item.workflowStepId), f.steps.map(step => step.id));
  assert.equal(runningView.isolation.rounds[0].application.status, "not_started");
  assert.equal((await coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId })).status, "waiting");
  assert.equal(f.round().candidate, undefined);
  for (const key of ["id", "cwd"]) assert.notEqual(evidence[0].run[key], evidence[1].run[key]);
  for (const key of ["workUnitId", "attemptId"]) assert.notEqual(evidence[0].fence[key], evidence[1].fence[key]);
  assert.notDeepEqual(evidence[0].fence, evidence[1].fence);
  assert.notEqual(evidence[0].binding.bindingId, evidence[1].binding.bindingId);
  assert.equal(new Set(evidence.flatMap(item => item.slots.map(slot => slot.id))).size, 12);

  // Finish in reverse order, leaving one free slot while the first original Run is still writing-owned.
  f.release[1].resolve();
  await f.finished(evidence[1]);
  assert.equal(f.store.getRun(evidence[0].run.id).status, "running");
  assert.deepEqual(f.slots(evidence[0]).map(slot => slot.id).sort(), evidence[0].slots.map(slot => slot.id).sort());
  assert.equal(f.parent().state, "held");
  assert.equal(f.reconcileParent().status, "retained");
  await f.rejectOrdinaryWriter();
  assert.equal((await coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId })).status, "waiting");
  assert.equal(f.round().candidate, undefined, "one sealed sibling cannot supply an early candidate");
  assert.deepEqual(await f.target(), f.initialTarget);

  f.release[0].resolve();
  await f.finished(evidence[0]);
  await f.wait(() => f.pending().some(approval => approval.actionType === "workflow_merge"), "real merge approval");
  await waitForWorkflowIsolationIdle(f.store, f.workflow.id);
  const candidate = f.round().candidate, approval = f.pending().find(value => value.actionType === "workflow_merge");
  const packet = evidence.flatMap(item => f.store.listArtifacts(item.run.id)).map(artifact => artifact.sealedPayload)
    .find(payload => payload?.kind === "workflow_integration_candidate" && payload.commit === candidate.commit);
  assert.ok(packet);
  assert.deepEqual(packet.includedStepIds, f.steps.map(step => step.id));
  assert.deepEqual(packet.merges.map(merge => merge.workflowStepId), f.round().inputs.mergeOrder,
    "completion order cannot replace the frozen merge order");
  for (const branch of branches) assert.equal(await f.git("show", `${candidate.commit}:${branch.path}`), branch.content.trim());
  assert.equal(f.parent().state, "held", "terminal and drained branches still need exact target consent");
  assert.equal(f.reconcileParent().status, "retained");
  assert.deepEqual(await f.target(), f.initialTarget);

  const pendingView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(pendingView.isolation.rounds[0].mode, "apply_to_target");
  assert.equal(pendingView.isolation.rounds[0].approval.status, "pending");
  assert.equal(pendingView.isolation.rounds[0].application.status, "not_started");
  assert.equal(pendingView.isolation.completion, "blocked");

  await f.api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
  await f.wait(() => f.parent().state === "released", "production completion releases the parent fence");
  assert.equal(f.round().phase, "applied");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
  const delivered = await f.target();
  assert.equal(delivered.head, candidate.commit);
  assert.equal(delivered.status, "");
  assert.deepEqual(delivered.files, branches.map(branch => branch.content));
  const appliedView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(appliedView.isolation.rounds[0].phase, "applied");
  assert.equal(appliedView.isolation.rounds[0].approval.status, "approved");
  assert.equal(appliedView.isolation.rounds[0].application.status, "applied");
  assert.equal(appliedView.isolation.gitEffects, "confirmed");
  assert.equal(appliedView.isolation.completion, "ready");
  const apply = createSqliteWorkflowMergeApplyStore(f.store), permit = apply.getPermit(f.roundId, 1);
  assert.equal(permit.approvalId, approval.id);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM workflow_merge_apply_permits").get().n, 1);
  assert.equal(f.store.database.prepare("SELECT status FROM resource_leases WHERE id=?").get(permit.leaseId).status, "released");
  const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store), scope = { roundId: f.roundId, generation: 1 };
  const effects = coordinator.listEffects(scope), receipts = coordinator.listReceipts(scope);
  assert.equal(effects.filter(effect => effect.kind === "target_apply").length, 1);
  assert.equal(receipts.filter(receipt => receipt.intentId === permit.intentId && receipt.outcome === "confirmed").length, 1);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }), []);
  for (const item of evidence) {
    assert.equal(f.store.listRuns({ workflowStepId: item.run.workflowStepId, limit: 10 }).length, 1);
    assert.deepEqual(f.store.listResourceLeases({ ownerType: "workflow_step", ownerId: item.run.workflowStepId, status: "active" }), []);
  }
  const parent = f.parent(), refs = await f.git("for-each-ref", "--format=%(refname) %(objectname)");
  assert.equal((await f.api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" }, "POST", 400)).error,
    "approval_not_pending");
  assert.equal((await f.api(`/workflows/${f.workflow.id}/orchestrate`, {})).status, "completed");
  assert.deepEqual(f.parent(), parent);
  assert.deepEqual(await f.target(), delivered);
  assert.equal(await f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.deepEqual(coordinator.listEffects(scope), effects);
  assert.deepEqual(coordinator.listReceipts(scope), receipts);
  assert.equal(f.executions.size, 2);
});

test("cancelled siblings retain the parent until both original Host invocations fully drain", options, async t => {
  const f = await fixture(t, { holdReturn: true });
  const evidence = await f.start(), cancelled = evidence[0];
  const response = await f.api(`/runs/${cancelled.run.id}/cancel`, {});
  assert.equal(response.cancelled, true);
  assert.equal(f.store.getRun(cancelled.run.id).status, "cancelled");
  assert.equal(f.executions.get(0).options.signal.aborted, true);
  assert.equal(f.executions.get(0).returned, false, "the original SDK/Host invocation has not returned");
  assert.equal(f.completion(cancelled).drainedAt, undefined);
  assert.deepEqual(f.slots(cancelled).map(slot => slot.id).sort(), cancelled.slots.map(slot => slot.id).sort());
  assert.equal(f.parent().state, "held");
  assert.equal(f.reconcileParent().status, "retained");

  const cancellation = await f.api(`/workflows/${f.workflow.id}/cancel`, {});
  assert.equal(cancellation.workflow.status, "cancelled");
  assert.deepEqual(cancellation.cancelledRunIds, [evidence[1].run.id]);
  assert.ok(cancellation.workflowSteps.every(step => step.status === "cancelled"));
  for (const [index, item] of evidence.entries()) {
    assert.equal(f.store.getRun(item.run.id).status, "cancelled");
    assert.equal(f.executions.get(index).options.signal.aborted, true);
    assert.equal(f.executions.get(index).returned, false);
    assert.equal(f.completion(item).drainedAt, undefined);
    assert.deepEqual(f.slots(item).map(slot => slot.id).sort(), item.slots.map(slot => slot.id).sort());
  }
  assert.equal(f.parent().state, "held", "business cancellation is not a physical stop receipt");
  const cancellingView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(cancellingView.workflow.status, "cancelled");
  assert.equal(cancellingView.isolation.completion, "blocked");
  assert.notEqual(cancellingView.isolation.rounds[0].application.status, "applied");

  f.returnRelease[1].resolve(); f.release[1].resolve();
  await f.wait(() => f.completion(evidence[1])?.drainedAt && f.slots(evidence[1]).length === 0,
    "one cancelled original SDK/Host invocation drains independently");
  assert.equal(f.completion(evidence[1]).effectCoverage, "pi_tracked_tools_v1");
  assert.equal(f.completion(cancelled).drainedAt, undefined);
  assert.deepEqual(f.slots(cancelled).map(slot => slot.id).sort(), cancelled.slots.map(slot => slot.id).sort());
  assert.equal(f.reconcileParent().status, "retained");
  assert.equal(f.parent().state, "held");
  assert.equal(f.round().candidate, undefined);
  await f.rejectOrdinaryWriter();
  assert.deepEqual(await f.target(), f.initialTarget);

  f.returnRelease[0].resolve(); f.release[0].resolve();
  await f.wait(() => evidence.every(item => f.completion(item)?.drainedAt && f.slots(item).length === 0),
    "both cancelled original SDK/Host invocations drain and release their own capacity");
  // Re-enter the production cancellation reconciler, never manufacture stop evidence or release rows.
  const drained = await f.api(`/workflows/${f.workflow.id}/cancel`, {});
  assert.deepEqual(drained.cancelledRunIds, []);
  assert.equal(drained.workflow.status, "cancelled");
  assert.equal(f.parent().state, "released");
  assert.ok(f.parent().released_at);
  const cancelledView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(cancelledView.workflow.status, "cancelled");
  assert.equal(cancelledView.isolation.completion, "blocked");
  assert.equal(cancelledView.isolation.rounds[0].application.status, "not_started");
  for (const [index, item] of evidence.entries()) {
    assert.equal(f.executions.get(index).returned, true);
    assert.equal(f.completion(item).effectCoverage, "pi_tracked_tools_v1");
    assert.equal(f.store.getWorkUnit(item.fence.workUnitId).status, "cancelled");
    assert.equal(f.store.getWorkUnitAttempt(item.fence.attemptId).status, "cancelled");
    assert.deepEqual(f.store.listResourceLeases({ ownerType: "workflow_step", ownerId: item.run.workflowStepId, status: "active" }), []);
    assert.equal(f.store.listRuns({ workflowStepId: item.run.workflowStepId, limit: 10 }).length, 1);
  }
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }), []);
  assert.deepEqual(f.pending(), []);
  assert.equal(f.round().candidate, undefined);
  assert.equal(createSqliteWorkflowMergeApplyStore(f.store).getPermit(f.roundId, 1), undefined);
  const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store), scope = { roundId: f.roundId, generation: 1 };
  const effects = coordinator.listEffects(scope), receipts = coordinator.listReceipts(scope);
  assert.equal(effects.filter(effect => effect.kind === "target_apply").length, 0);
  const parent = f.parent(), completions = evidence.map(f.completion), refs = await f.git("for-each-ref", "--format=%(refname) %(objectname)");
  await f.api(`/workflows/${f.workflow.id}/cancel`, {});
  assert.deepEqual(f.parent(), parent);
  assert.equal(f.reconcileParent().status, "released");
  assert.deepEqual(evidence.map(f.completion), completions);
  assert.deepEqual(coordinator.listEffects(scope), effects);
  assert.deepEqual(coordinator.listReceipts(scope), receipts);
  assert.equal(await f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.deepEqual(await f.target(), f.initialTarget);
  assert.equal(f.executions.size, 2);
});

test("public explicit selection plans and executes two real Host writers without granting target application", options, async t => {
  const f = await fixture(t, { publicSelection: true });
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getSelection(f.workflow.id), undefined);
  const evidence = await f.start();
  const selected = createSqliteWorkflowIsolationStore(f.store).getSelection(f.workflow.id);
  assert.equal(selected.phase, "ready");
  assert.equal(selected.roundId, f.roundId);
  assert.equal(f.round().inputs.mode, "candidate_only");
  assert.equal(f.round().inputs.optionalFailurePolicy, "require_success");
  assert.equal(f.parent().state, "held");
  for (const gate of f.release) gate.resolve();
  for (const item of evidence) await f.finished(item);
  await f.wait(() => f.round().phase === "awaiting_approval" && f.store.getChannelWorkflow(f.workflow.id).status === "succeeded"
    && f.parent().state === "released", "public selection produces a verified candidate and releases the drained parent");
  const candidate = f.round().candidate;
  assert.ok(candidate);
  for (const branch of branches) assert.equal(await f.git("show", `${candidate.commit}:${branch.path}`), branch.content.trim());
  assert.equal(f.pending().some(approval => approval.actionType === "workflow_merge"), false);
  assert.equal(createSqliteWorkflowMergeApplyStore(f.store).getPermit(f.roundId, 1), undefined);
  assert.deepEqual(await f.target(), f.initialTarget);
  assert.equal((await f.api(`/workflows/${f.workflow.id}/orchestrate`, { executionProfile: "pi_host_isolated_files_v1" })).status, "completed");
  assert.deepEqual(createSqliteWorkflowIsolationStore(f.store).getSelection(f.workflow.id), selected);
  assert.equal(f.executions.size, 2);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM workflow_integration_rounds WHERE workflow_id=?").get(f.workflow.id).n, 1);
  const view = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(view.isolation.rounds[0].mode, "candidate_only");
  assert.equal(view.isolation.rounds[0].application.status, "not_started");
  assert.equal(view.isolation.completion, "ready");

  await f.restartWithIsolationDisabled();
  const retained = executionState(f);
  assert.equal((await f.api(`/workflows/${f.workflow.id}/orchestrate`, {})).status, "completed",
    "feature shutdown cannot prevent observation or completion of the retained round");
  const reopenedView = await f.api(`/workflows/${f.workflow.id}/evidence`, undefined, "GET");
  assert.equal(reopenedView.isolation.completion, "ready");
  assert.equal(reopenedView.isolation.rounds[0].candidate.commit, candidate.commit);
  assert.equal((await f.api(`/workflows/${f.workflow.id}/orchestrate`, { executionProfile: "pi_host_isolated_files_v1" }, "POST", 409)).error,
    "workflow_isolation_disabled", "disabled Hosts still reject explicit execution selection");
  assert.deepEqual(executionState(f), retained);
  assert.equal(f.executions.size, 2, "reopening and observing cannot redispatch either original Run");
  assert.deepEqual(await f.target(), f.initialTarget);
  const ordinary = await f.startOrdinaryWriter();
  assert.equal(ordinary.run.cwd, f.store.paths.cwd);
  assert.equal(ordinary.run.requestSnapshot.workflowIsolationPlan, undefined);
  assert.ok(ordinary.leases.some(lease => lease.resourceType === "bound_path" && lease.resourceKey === f.store.paths.cwd));
  assert.ok(ordinary.slots.some(slot => slot.resourceType === "provider"));
  assert.ok(ordinary.slots.some(slot => slot.resourceType === "runner"));
  for (const resource of [...ordinary.leases, ...ordinary.slots]) {
    for (const [key, value] of Object.entries(ordinary.fence)) assert.equal(resource[key], value);
  }
  assert.equal(f.parent().state, "released");
  assert.equal(f.round().candidate.commit, candidate.commit);
  assert.equal(f.executions.size, 2, "the successor is an ordinary Run, never a replay of an isolated sibling");
  assert.deepEqual(await f.target(), f.initialTarget, "admission does not apply the retained candidate");
});

test("public isolation rejects unavailable Host authority before selection, approval, Task or dispatch", options, async t => {
  for (const [name, config, code] of [
    ["disabled", { featureEnabled: false }, "workflow_isolation_disabled"],
    ["broker", { brokerMode: "shadow" }, "workflow_isolation_broker_required"],
    ["unverified-runner", { unverifiedRunner: true }, "workflow_isolation_runner_unavailable"],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { publicSelection: true, ...config }), before = executionState(f);
    const response = await f.api(`/workflows/${f.workflow.id}/orchestrate`, { executionProfile: "pi_host_isolated_files_v1" }, "POST", 409);
    assert.equal(response.error, code);
    assert.deepEqual(executionState(f), before);
    assert.equal(f.executions.size, 0);
    assert.deepEqual(await f.target(), f.initialTarget);
  });
});

test("unfinished isolation planning blocks ordinary orchestration, manual starts and retry without side effects", options, async t => {
  const f = await fixture(t, { publicSelection: true }), isolation = createSqliteWorkflowIsolationStore(f.store);
  assert.equal(isolation.beginSelection({ workflowId: f.workflow.id, roundId: "unfinished-selection", now: now() }).status, "created");
  const step = f.steps[0];
  f.store.updateChannelWorkflowStep(step.id, { status: "blocked", blocker: "Planning not complete" }, now());
  const before = executionState(f);
  for (const [path, body] of [
    [`/workflows/${f.workflow.id}/orchestrate`, {}],
    [`/workflow-steps/${step.id}/start`, { mode: "create_task" }],
    [`/workflow-steps/${step.id}/start`, { mode: "create_and_run_task" }],
    [`/workflow-steps/${step.id}/retry`, {}],
  ]) {
    const response = await f.api(path, body, "POST", 409);
    assert.equal(response.error, "workflow_isolation_planning");
    assert.deepEqual(executionState(f), before);
  }
  assert.equal(f.executions.size, 0);
  assert.deepEqual(await f.target(), f.initialTarget);
});

test("public orchestration cannot supply target application, commands or a parallel limit", options, async t => {
  const f = await fixture(t, { publicSelection: true }), before = executionState(f);
  for (const body of [null, [], { executionProfile: "unknown" }, { executionProfile: "pi_host_isolated_files_v1", mode: "apply_to_target" },
    { executionProfile: "pi_host_isolated_files_v1", maxConcurrentSteps: 4 }, { command: "git merge" }]) {
    assert.equal((await f.api(`/workflows/${f.workflow.id}/orchestrate`, body, "POST", 400)).error, "bad_request");
    assert.deepEqual(executionState(f), before);
  }
  assert.equal(f.executions.size, 0);
});

function executionState(f) {
  return Object.fromEntries(["workflow_isolation_selections", "workflow_integration_rounds", "workflow_isolation_scope_plans",
    "workflow_parallel_parent_fences", "approval_requests", "tasks", "run_sessions", "workflow_step_admissions", "channel_workflow_steps"]
    .map(table => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function fixture(t, { holdReturn = false, publicSelection = false, featureEnabled = publicSelection,
  brokerMode = "enforce", unverifiedRunner = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-isolated-parallel-sdk-")));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "host-home");
  const cwd = join(root, "repository"), worktreeRoot = join(root, "host-worktrees");
  await mkdir(cwd); await mkdir(worktreeRoot);
  const contexts = new AsyncLocalStorage(), executions = new Map(), ordinaryExecutions = [], notices = changes();
  const release = branches.map(() => deferred()), returnRelease = branches.map(() => deferred()), starts = [];
  if (!holdReturn) for (const gate of returnRelease) gate.resolve();
  let store, daemon, ordinaryStep;
  t.after(async () => {
    for (const gate of [...release, ...returnRelease]) gate.resolve();
    try { await daemon?.stop(); } finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  const git = async (...args) => (await exec("/usr/bin/git", args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await git("init", "--initial-branch=main");
  // Repository initialization only; runtime mutations below are exclusively real Host write calls.
  await writeFile(join(cwd, ".gitignore"), "*\n!.gitignore\n!left.txt\n!right.txt\n");
  for (const branch of branches) await writeFile(join(cwd, branch.path), `initial ${branch.path}\n`);
  await git("add", "--", ".gitignore", ...branches.map(branch => branch.path));
  await git("commit", "-m", "initial parallel inputs");
  const target = async () => ({ head: await git("rev-parse", "HEAD"), status: await git("status", "--porcelain=v1", "--untracked-files=all"),
    files: await Promise.all(branches.map(branch => readFile(join(cwd, branch.path), "utf8"))) });
  const initialTarget = await target();

  class ParallelPiRunner extends ToolFreePiRunner {
    async runTask(options) {
      const run = store.getRun(options.runId), index = branches.findIndex(branch => branch.participantId === run.teammateId);
      if (run.workflowStepId === ordinaryStep?.id) {
        assert.equal(options.isolatedToolsProfile, undefined);
        assert.equal(run.cwd, cwd);
        const unit = store.getWorkUnit(run.workUnitId), attempt = store.getWorkUnitAttempt(unit.activeAttemptId);
        const execution = { ordinary: true, run, fence: toRuntimeAttemptFence(attempt),
          leases: store.listResourceLeases({ ownerType: "run", ownerId: run.id, status: "active" }),
          slots: store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 }) };
        ordinaryExecutions.push(execution); notices.notify();
        return contexts.run(execution, () => super.runTask(options, () => "Ordinary successor admitted without applying an isolated candidate."));
      }
      assert.ok(index >= 0 && run.workflowStepId);
      assert.equal(executions.has(index), false, "no replacement Run can satisfy the original parallel barriers");
      assert.equal(options.isolatedToolsProfile, "host_isolated_files_v1");
      assert.deepEqual(options.tools, ["write"]);
      for (const key of ["mcpTools", "hostCapabilityTools", "mediaGenerationTools"]) assert.deepEqual(options[key], []);
      const execution = { runId: run.id, options, requests: [], writes: [], gates: [], reached: false, returned: false };
      executions.set(index, execution);
      try {
        return await contexts.run(execution, () => super.runTask({ ...options,
          onToolBefore: async request => {
            const decision = await options.onToolBefore(request);
            execution.gates.push({ request, decision }); return decision;
          },
          onIsolatedToolCall: async request => {
            const result = await options.onIsolatedToolCall(request);
            execution.writes.push({ request, result }); notices.notify(); return result;
          },
        }));
      } finally {
        // Keep the real invocation pending after cancellation, even if SDK abort settles before fetch returns.
        await returnRelease[index].promise;
        execution.returned = true; notices.notify();
      }
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      if (contexts.getStore()?.ordinary) return;
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
        streamSimple: (model, context, options) => stream(model, context, { ...options, fetch: async (_url, request) => {
          const execution = contexts.getStore(), index = branches.findIndex(branch => branch.participantId === store.getRun(execution.runId).teammateId);
          assert.equal(executions.get(index), execution);
          const branch = branches[index], body = JSON.parse(request.body);
          execution.requests.push(body);
          assert.deepEqual((body.tools ?? []).map(tool => tool.function.name), ["write"]);
          if (execution.requests.length === 1) return sse({ tool_calls: [{ index: 0, id: `parallel-write-${index}`, type: "function",
            function: { name: "write", arguments: JSON.stringify({ path: branch.path, content: branch.content }) } }] }, "tool_calls");
          assert.equal(execution.requests.length, 2);
          assert.equal(execution.writes.length, 1);
          assert.notEqual(execution.writes[0].result.isError, true, JSON.stringify(execution.writes[0]));
          assert.equal(body.messages.filter(message => message.role === "tool").length, 1, "SDK consumes its actual Host result");
          execution.reached = true; notices.notify();
          await release[index].promise;
          options.signal?.throwIfAborted();
          return sse({ content: `${branch.name} finished its isolated Host write.` }, "stop");
        } }),
      });
    }
  }
  const createServer = enabled => createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: brokerMode } },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false,
      workflowIsolatedFiles: enabled },
  }, { runner: unverifiedRunner ? { async runTask() { assert.fail("An unverified adapter must never dispatch"); } } : new ParallelPiRunner(), storeFactory(storeCwd) {
    assert.equal(storeCwd, cwd); store = createSqliteRunStore(storeCwd);
    for (const name of ["appendEvent", "createApprovalRequest", "createArtifact", "transitionRunStatus", "transitionChannelWorkflowStatus", "updateChannelWorkflowStep",
      "transitionChannelWorkflowStepStatus", "transitionWorkUnitStatus", "releaseHostAttemptResources", "beginChannelWorkflowStepStart"]) {
      const original = store[name];
      t.mock.method(store, name, function(...args) {
        const value = original.apply(this, args);
        if (name === "beginChannelWorkflowStepStart") starts.push({ input: args[0], result: value });
        queueMicrotask(notices.notify); return value;
      });
    }
    // Core overlays commit retained rounds and parent release without calling RunStore mutations.
    const originalExec = store.database.exec;
    t.mock.method(store.database, "exec", function(sql) {
      const value = originalExec.call(this, sql);
      if (sql.trim().toUpperCase() === "COMMIT") queueMicrotask(notices.notify);
      return value;
    });
    return store;
  } });
  daemon = createServer(featureEnabled);
  await daemon.start();
  const api = async (path, body, method = "POST", status) => {
    const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}${path}?cwd=${encodeURIComponent(cwd)}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45_000),
    });
    const value = await response.json();
    if (status === undefined) assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    else assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const provider = (await api("/providers", { kind: "glm", displayName: "Local parallel SDK transport", providerId: "parallel-isolated-scripted",
    model: "parallel-isolated-fixture", api: "openai-completions", baseUrl: "https://parallel-fixture.invalid/v1",
    capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, reasoning: false, enabled: true })).provider;
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Scripted local SDK transport", checkedAt: now() });
  await api("/approval-policy", { toolDecisions: { write: "ask" } }, "PATCH");
  for (const branch of branches) await api(`/teammates/${branch.participantId}`, { providerPresetId: provider.id, allowedTools: ["write"] }, "PATCH");
  const channel = (await api("/channels", { name: "Explicit isolated writing siblings", status: "active", boundPath: cwd,
    defaultProviderPresetId: provider.id, allowedTools: ["write"], autoReplyMode: "mentions_only",
    runtimePolicy: { maxConcurrentRuns: 2, schedulingMode: "smart", writeLockScope: "boundPath",
      allowReadOnlyParallel: false, queueOnConflict: true } })).channel;
  assert.equal(channel.workspaceBinding.mode, "managed_worktree");
  // Local handoff retains the auto-created checkout; remove it while it is still managed and clean.
  await api(`/channels/${channel.id}/workspace/cleanup`, {});
  await api(`/channels/${channel.id}/workspace/handoff`, { mode: "local" });
  assert.deepEqual((await git("worktree", "list", "--porcelain", "-z")).split("\0")
    .filter(field => field.startsWith("worktree ")).map(field => field.slice(9)), [cwd]);
  for (const branch of branches) await api(`/teammates/${branch.participantId}/channels`, { memberships: [{ channelId: channel.id }] }, "PUT");
  const graph = { schemaVersion: 1, id: "parallel-isolated", name: "Two independent writing siblings", entryNodeId: "left",
    nodes: branches.map((branch, index) => ({ id: index ? "right" : "left", kind: "step", name: branch.name,
      prompt: `Write ${branch.path}.`, sideEffectClass: "workspace_write" })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Parallel isolated SDK Host writes", objective: "Fan in two owned writes",
    status: "ready", createdBy: "local-user", metadata: { maxParallelSteps: 2, workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now());
  const steps = branches.map((branch, position) => store.createChannelWorkflowStep({ workflowId: workflow.id, title: branch.name,
    prompt: `Write ${branch.path}.`, position, toParticipantId: branch.participantId, toParticipantLabel: branch.name,
    metadata: { autoStart: true, dependsOnStepIds: [], providerPresetId: provider.id, requestedRunnerId: "pi", requiredTools: ["write"],
      sideEffectClass: "workspace_write", maxParallelSiblings: 2,
      parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } } }, now()));
  let roundId = "parallel-isolated-round", planned = publicSelection ? undefined : await planWorkflowIsolatedRound({ store,
    workflowId: workflow.id, roundId, worktreeRoot, mode: "apply_to_target", parallelExecution,
    validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) });
  let isolation = createSqliteWorkflowIsolationStore(store);
  const round = () => isolation.getIntegrationRound(roundId);
  const parent = () => store.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=? AND generation=1").get(roundId);
  const pending = () => store.listApprovalRequests({ status: "pending", limit: 20 });
  const slots = item => store.listRuntimeSemaphoreSlots({ workUnitId: item.fence.workUnitId, status: "active", limit: 100 });
  const completion = item => store.getHostAttemptCompletion({ runId: item.run.id, ...item.fence });
  const describe = () => ({ workflow: store.getChannelWorkflow(workflow.id), executions: [...executions.values()].map(value => ({ runId: value.runId, reached: value.reached,
    requests: value.requests.length, writes: value.writes, returned: value.returned })), parent: parent(), round: round(),
    runs: store.listRuns({ limit: 20 }).map(run => {
      const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
      const fence = attempt ? toRuntimeAttemptFence(attempt) : undefined;
      const binding = fence ? isolation.getExecutionBinding(workflowIsolationDigest({ runId: run.id, ...fence }, "wib_")) : undefined;
      const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
      return { id: run.id, status: run.status, error: run.errorMessage,
        step: step && { id: step.id, status: step.status, blocker: step.blocker, startOwner: step.metadata?.startOwner },
        unit: unit && { id: unit.id, status: unit.status }, attempt, binding,
        completion: fence ? store.getHostAttemptCompletion({ runId: run.id, ...fence }) : undefined,
        terminalIntent: binding ? isolation.getTerminalResultIntent(binding.bindingId) : undefined,
        diagnostics: store.listArtifacts(run.id).filter(artifact => artifact.sealedPayload?.kind === "workflow_isolation_result_capture_blocked")
          .map(artifact => artifact.sealedPayload),
        events: store.listEvents(run.id, { afterSeq: Math.max(0, store.countEvents(run.id) - 8), limit: 20 }) };
    }), approvals: pending() });
  const wait = (predicate, label) => notices.wait(predicate, label, describe);
  const finished = async item => {
    await wait(() => store.getRun(item.run.id).status === "succeeded" && store.getChannelWorkflowStep(item.run.workflowStepId).status === "succeeded"
      && completion(item)?.drainedAt && slots(item).length === 0 && isolation.getTerminalResultIntent(item.binding.bindingId)?.status === "confirmed",
    "original Run terminal, drained and sealed");
  };
  const createOrdinaryWriter = () => {
    const ordinaryGraph = { schemaVersion: 1, id: "ordinary-writer", name: "Ordinary writer", entryNodeId: "ordinary",
      nodes: [{ id: "ordinary", kind: "step", name: "Ordinary", prompt: "Write left.txt in the target.", sideEffectClass: "workspace_write" }],
      edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
    const ordinary = store.createChannelWorkflow({ channelId: channel.id, title: "Unrelated ordinary writer", objective: "Independent ordinary admission",
      status: "ready", createdBy: "local-user", metadata: { maxParallelSteps: 2, workflowGraph: ordinaryGraph,
        workflowGraphFingerprint: workflowGraphFingerprintV1(ordinaryGraph) } }, now());
    const step = store.createChannelWorkflowStep({ workflowId: ordinary.id, title: "Ordinary write", prompt: "Write left.txt in the target.", position: 0,
      toParticipantId: branches[0].participantId, toParticipantLabel: branches[0].name,
      metadata: { autoStart: true, providerPresetId: provider.id, requestedRunnerId: "pi",
        requiredTools: ["write"], sideEffectClass: "workspace_write", dependsOnStepIds: [],
        parallelPolicy: { autoParallel: false, maxParallelSiblings: 2, resourceKeys: [] } } }, now());
    return { ordinary, step };
  };
  return { get store() { return store; }, workflow, steps, get roundId() { return roundId; }, round, parent, pending, api, git, target, initialTarget, executions, release, returnRelease,
    wait, slots, completion, finished, reconcileParent: () => isolation.reconcileParallelParentFence({ roundId, generation: 1, now: now() }),
    async restartWithIsolationDisabled() {
      await daemon.stop();
      daemon = createServer(false);
      await daemon.start();
      isolation = createSqliteWorkflowIsolationStore(store);
    },
    async start() {
      const started = await api(`/workflows/${workflow.id}/orchestrate`, publicSelection ? { executionProfile: "pi_host_isolated_files_v1" } : {});
      if (publicSelection) {
        roundId = isolation.getSelection(workflow.id).roundId;
        planned = { plans: steps.map(step => isolation.getScopePlan(store.getChannelWorkflowStep(step.id).metadata.isolationScopePlan.planId)) };
      }
      assert.deepEqual(round().inputs.parallelExecution, parallelExecution);
      assert.equal(started.status, "started", JSON.stringify(started));
      assert.deepEqual(started.startedSteps.map(item => item.workflowStep.id), steps.map(step => step.id));
      assert.equal(started.schedulingDecision.effectiveMode, "parallel");
      await wait(() => executions.size === 2 && pending().filter(approval => approval.actionType === "write").length === 2
        && [...executions.values()].every(value => store.getRun(value.runId).status === "waiting_for_approval"),
      "both original SDK Runs reach real Host write approvals");
      const writeApprovals = pending().filter(approval => approval.actionType === "write");
      assert.deepEqual(writeApprovals.map(approval => approval.runId).sort(), [...executions.values()].map(value => value.runId).sort());
      assert.deepEqual(await target(), initialTarget);
      for (const [index, plan] of planned.plans.entries()) {
        assert.equal(await readFile(join(plan.executionRoot, branches[index].path), "utf8"), `initial ${branches[index].path}\n`);
      }
      for (const approval of writeApprovals) await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
      await wait(() => executions.size === 2 && [...executions.values()].every(value => value.reached), "both original SDK post-write barriers");
      const evidence = [];
      for (const [index, step] of steps.entries()) {
        const execution = executions.get(index), run = store.getRun(execution.runId), unit = store.getWorkUnit(run.workUnitId);
        const attempt = store.getWorkUnitAttempt(unit.activeAttemptId), fence = toRuntimeAttemptFence(attempt);
        const binding = isolation.getExecutionBinding(workflowIsolationDigest({ runId: run.id, ...fence }, "wib_")), plan = planned.plans[index];
        assert.equal(run.status, "running"); assert.equal(unit.status, "running"); assert.equal(attempt.status, "started");
        assert.equal(run.workflowStepId, step.id); assert.equal(run.cwd, plan.executionRoot);
        assert.equal(binding.status, "ready"); assert.equal(binding.location.executionRoot, plan.executionRoot);
        assert.equal(run.requestSnapshot.workflowSafetySnapshot.plan.profile, "pi_host_isolated_files_v1");
        const item = { run, fence, binding, slots: slots({ fence }) };
        assert.equal(item.slots.length, 6, "five capacity keys and one exclusive worktree slot per Attempt");
        assert.deepEqual(item.slots.map(slot => [slot.resourceType, slot.resourceKey]).sort(), [...plan.resourcePlan.entries,
          ...plan.resourcePlan.resourceKeys.map(resourceKey => ({ resourceType: "workflow_resource", resourceKey }))]
          .map(entry => [entry.resourceType, entry.resourceKey]).sort());
        assert.ok(plan.resourcePlan.entries.filter(entry => entry.resourceType === "channel_parallel").every(entry => entry.limit === 2));
        for (const slot of item.slots) for (const [key, value] of Object.entries(fence)) assert.equal(slot[key], value);
        assert.equal(await readFile(join(plan.executionRoot, branches[index].path), "utf8"), branches[index].content);
        assert.equal(await readFile(join(plan.executionRoot, branches[1 - index].path), "utf8"), `initial ${branches[1 - index].path}\n`);
        const write = execution.writes[0];
        assert.deepEqual(write.request.input, { path: branches[index].path, content: branches[index].content });
        assert.equal(write.request.cwd, plan.executionRoot);
        const gates = execution.gates.filter(gate => gate.request.toolCallId === write.request.toolCallId);
        assert.equal(gates.length, 2); assert.ok(gates.every(gate => gate.decision.allowed));
        const journals = store.listHarnessToolExecutions(run.id);
        assert.equal(journals.length, 1); assert.equal(journals[0].state, "succeeded");
        const artifact = journals[0].evidenceArtifactIds.map(id => store.getArtifact(id))
          .find(value => value?.sealedPayload?.kind === "workflow_isolation_file_mutation");
        assert.ok(artifact?.contentSha256); assert.equal(artifact.runId, run.id);
        assert.equal(artifact.sealedPayload.bindingId, binding.bindingId); assert.deepEqual(artifact.sealedPayload.sourceFence, fence);
        evidence.push(item);
      }
      return evidence;
    },
    async startOrdinaryWriter() {
      const { ordinary, step } = createOrdinaryWriter();
      ordinaryStep = step;
      const started = await api(`/workflows/${ordinary.id}/orchestrate`, {});
      assert.equal(started.status, "started", JSON.stringify(started));
      assert.deepEqual(started.startedSteps.map(item => item.workflowStep.id), [step.id]);
      await wait(() => ordinaryExecutions.length === 1 && store.getRun(ordinaryExecutions[0].run.id).status === "succeeded"
        && completion(ordinaryExecutions[0])?.drainedAt && slots(ordinaryExecutions[0]).length === 0,
      "ordinary successor completes and drains after the isolated parent is released");
      assert.equal(store.getChannelWorkflowStep(step.id).status, "succeeded");
      assert.deepEqual(store.listResourceLeases({ ownerType: "run", ownerId: ordinaryExecutions[0].run.id, status: "active" }), []);
      return ordinaryExecutions[0];
    },
    async rejectOrdinaryWriter() {
      const { ordinary, step } = createOrdinaryWriter();
      const denied = await api(`/workflows/${ordinary.id}/orchestrate`, {}, "POST", 409);
      assert.equal(denied.error, "workflow_parallel_parent_conflict", JSON.stringify(denied));
      assert.equal(starts.find(entry => entry.input.workflowStepId === step.id)?.result.code, "workflow_parallel_parent_conflict");
      assert.equal(store.getChannelWorkflowStep(step.id).runId, undefined);
      assert.equal(store.getChannelWorkflowStep(step.id).taskId, undefined);
      assert.deepEqual(store.listRuns({ workflowStepId: step.id, limit: 10 }), []);
      assert.equal(executions.size, 2);
    },
  };
}

function deferred() {
  let resolve;
  const gate = { settled: false, promise: new Promise(done => { resolve = done; }), resolve: () => { gate.settled = true; resolve(); } };
  return gate;
}

function sse(delta, reason) {
  return new Response([{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] }].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

function changes() {
  const listeners = new Set();
  return { notify: () => { for (const check of [...listeners]) check(); }, wait: (predicate, label, describe) => new Promise((resolve, reject) => {
    // Timers bound failures; store notifications and explicit barriers establish ordering, never elapsed sleeps.
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Waiting for ${label}: ${JSON.stringify(describe())}`)); }, 40_000);
    const check = () => { try { if (!predicate()) return; clearTimeout(timer); listeners.delete(check); resolve(); }
      catch (error) { clearTimeout(timer); listeners.delete(check); reject(error); } };
    listeners.add(check); check();
  }) };
}
