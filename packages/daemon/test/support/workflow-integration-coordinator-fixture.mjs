import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { workflowIsolationDigest, workflowIsolationSafetyFingerprint, workflowIsolationScopePlanDigest,
  workflowIsolationStepSafetyFingerprint, workflowStepSafetyPlanDigest } from "@ling-stack/core";
import { workflowIsolationFixture } from "../../../core/test/support/workflow-isolation-fixture.mjs";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../../dist/features/channels/workflow-candidate-validation.js";
import { captureWorkflowIsolatedResult } from "../../dist/features/channels/workflow-isolated-result.js";
import { createWorkflowStepContextArtifact } from "../../dist/features/channels/workflow-step-packets.js";
import { prepareWorkflowIsolatedExecution } from "../../dist/features/runs/workflow-isolation-execution.js";
import { inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest }
  from "../../dist/features/workspaces/workflow-git-repository.js";

const exec = promisify(execFile);
export const nativeGit = { skip: !["darwin", "linux"].includes(process.platform) };
export const now = () => new Date().toISOString();

/** One real isolated branch, Host completion and sealed result; no forged coordinator authority. */
export async function workflowIntegrationCoordinatorFixture(t, { stage = "succeeded", mode = "candidate_only" } = {}) {
  assert.ok(["running", "terminal", "captured", "succeeded"].includes(stage));
  let drain;
  t.after(async () => { await drain?.(); });
  const f = await workflowIsolationFixture(t, { create: false, pin: false });
  f.gitAt = async (cwd, args, input) => {
    const command = exec("/usr/bin/git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
        GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } });
    command.child?.stdin?.end(input);
    return (await command).stdout;
  };
  f.git = async (...args) => (await f.gitAt(f.cwd, args)).toString().trim();
  await f.git("init", "--initial-branch=main");
  await f.git("config", "core.logAllRefUpdates", "always");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt");
  await f.git("commit", "-m", "initial");
  f.repository = await inspectWorkflowGitRepository(f.cwd);
  const worktreeRoot = join(f.root, "coordinator-worktrees");
  await mkdir(worktreeRoot);
  f.scopeGit = await planWorkflowGitWorktree({ repository: f.repository, worktreeRoot, roundId: f.roundId,
    stepId: f.scopeIsolation.step.id, generation: 1, worktreeId: "coordinator-branch" });
  f.integrationScope = await planWorkflowGitWorktree({ repository: f.repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 1, worktreeId: "coordinator-integration" });
  f.executionRoot = f.scopeGit.executionRoot;
  const metadata = f.current(f.scopeIsolation).metadata;
  const safety = { ...metadata.safetyPlan, executionRoot: f.executionRoot, writeRoots: [f.executionRoot] };
  safety.digest = workflowStepSafetyPlanDigest(safety);
  f.store.updateChannelWorkflowStep(f.scopeIsolation.step.id, { metadata: { ...metadata, safetyPlan: safety } }, f.at(0));
  f.stepFingerprint = workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation));
  const safetyPins = [{ workflowStepId: f.scopeIsolation.step.id, fingerprint: f.stepFingerprint }];
  const target = { ...f.inputs.target, branchRef: f.repository.branchRef, expectedHead: f.repository.head,
    cleanStateDigest: workflowGitRepositoryBasisDigest(f.repository) };
  const { executionRoot, worktreeId, branchRef } = f.integrationScope;
  // These fixed Host pins must enter the immutable inputs before the round is created.
  f.inputs = { ...f.inputs, mode, repositoryIdentity: { commonDir: f.repository.commonDir,
    objectFormat: f.repository.head.length === 40 ? "sha1" : "sha256" }, target, baseCommit: f.repository.head,
    integration: { executionRoot, worktreeId, branchRef }, safetyPins,
    safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins),
    validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) };
  f.plan = { ...f.plan, repositoryIdentity: f.inputs.repositoryIdentity, target, baseCommit: f.repository.head,
    executionRoot: f.executionRoot, worktreeId: f.scopeGit.worktreeId, branchRef: f.scopeGit.branchRef,
    safetyFingerprint: f.stepFingerprint };
  f.plan.planDigest = workflowIsolationScopePlanDigest(f.plan);
  f.create();
  f.persistPin();
  f.prepare();
  const bindingId = workflowIsolationDigest({ runId: f.prepared.run.id, ...f.prepared.fence }, "wib_");
  f.writer = { bindingId, ...f.prepared.fence };
  f.bindInput = { ...f.bindInput, bindingId };
  f.binding = () => f.isolation.getExecutionBinding(bindingId);
  const { now: _now, ...binding } = f.bindInput;
  f.execution = await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation,
    binding, scope: f.scopeGit, now: () => f.at(10), prepareInput: async () => f.executionPayload() });
  f.link();
  f.runId = f.prepared.run.id;
  f.workflowId = f.plan.workflowId;
  f.step = () => f.current(f.scopeIsolation);
  f.workflow = () => f.store.getChannelWorkflow(f.workflowId);
  f.run = () => f.store.getRun(f.runId);
  f.contextArtifact = createWorkflowStepContextArtifact({ store: f.store, workflow: f.workflow(), step: f.step(),
    run: f.run(), runRequest: { cwd: f.executionRoot, task: f.store.getTask(f.generation.task.id), runnerId: "pi" }, now: f.at(12) });
  f.store.updateChannelWorkflowStep(f.plan.workflowStepId,
    { metadata: { ...f.step().metadata, contextArtifactId: f.contextArtifact.id } }, f.at(12));
  f.branchGit = async (...args) => (await f.gitAt(f.executionRoot, args)).toString().trim();
  f.gitDir = await f.git("rev-parse", "--absolute-git-dir");
  f.branchGitDir = await f.branchGit("rev-parse", "--absolute-git-dir");
  f.resultRef = `refs/ling/workflow/results/${f.roundId}/${f.plan.workflowStepId}/1-${f.scopeGit.worktreeId}`;
  f.ref = async ref => {
    try { return await f.git("rev-parse", "--verify", "--quiet", ref ?? f.resultRef); }
    catch (error) { if (error.code === 1) return null; throw error; }
  };
  f.capture = async () => f.result = await captureWorkflowIsolatedResult({ store: f.store,
    writer: f.writer, isolation: f.isolation, now });
  f.intent = () => f.isolation.getTerminalResultIntent(f.writer.bindingId);
  f.finalize = async () => {
    const { finalizeOrchestratedWorkflowStepRun } = await import("../../dist/features/channels/orchestrator.js");
    return finalizeOrchestratedWorkflowStepRun(f.store, f.plan.workflowStepId, f.generation.task.id, f.run(), now());
  };
  f.orchestrate = async () => {
    const { orchestrateChannelWorkflow } = await import("../../dist/features/channels/orchestrator.js");
    return orchestrateChannelWorkflow({ store: f.store, cwd: f.cwd, workflowId: f.workflowId,
      validateRunRequest() { assert.fail("integration must not prepare another Run"); },
      async startRun() { assert.fail("integration must not dispatch a Runner"); } });
  };
  f.coordinate = async () => {
    const { coordinateWorkflowIntegration } = await import("../../dist/features/channels/workflow-integration-coordinator.js");
    return coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId, now });
  };
  f.journal = async () => {
    const { createSqliteWorkflowIntegrationCoordinatorStore } = await import("@ling-stack/core");
    assert.equal(typeof createSqliteWorkflowIntegrationCoordinatorStore, "function", "use the real Core terminal-round journal");
    const port = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
    const scope = { roundId: f.roundId, generation: f.round().generation };
    return { effects: port.listEffects(scope), receipts: port.listReceipts(scope) };
  };
  f.targetSnapshot = async () => ({ head: await f.git("rev-parse", "HEAD"), branch: await f.git("symbolic-ref", "HEAD"),
    status: await f.git("status", "--porcelain=v1", "--untracked-files=all"),
    index: await readFile(join(f.gitDir, "index")), content: await readFile(join(f.cwd, "owned.txt")) });
  f.gitSnapshot = async () => ({ target: await f.targetSnapshot(), branchHead: await f.branchGit("rev-parse", "HEAD"),
    branchIndex: await readFile(join(f.branchGitDir, "index")),
    refs: await f.git("for-each-ref", "--format=%(refname) %(objectname)"),
    reflogs: await f.git("reflog", "show", "--all", "--format=%H %gD"),
    objects: await f.git("count-objects", "-v"), worktrees: await f.git("worktree", "list", "--porcelain") });
  f.integrationSnapshot = async () => ({ git: await f.gitSnapshot(), rows: f.snapshotIsolation(),
    intent: f.intent(), artifacts: f.store.listArtifacts(f.runId) });
  f.executionSnapshot = () => ({ run: f.run(), attempt: f.store.getWorkUnitAttempt(f.writer.attemptId), binding: f.binding(),
    runs: f.store.database.prepare("SELECT id FROM run_sessions ORDER BY id").all(),
    attempts: f.store.database.prepare("SELECT id FROM work_unit_attempts ORDER BY id").all() });

  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  const fence = f.prepared.fence, source = { runId: f.runId, ...fence };
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId: f.runId, expectedStatus: "queued", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: f.runId, now: now() }).ok, true);
  let finish;
  const completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }), () => true);
  completion.catch(() => undefined);
  drain = async () => { finish(); await completion; };
  f.complete = async () => {
    finish();
    await completion;
    assert.equal(f.store.transitionRunStatus({ runId: f.runId, expectedStatus: "running", event: "runner_succeeded",
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded",
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", endedAt: now(), now: now() }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "succeeded", transitionedAt: now() },
      type: "work_unit_succeeded", actor: "runner", data: { runId: f.runId } });
    f.store.releaseHostAttemptResources(source, now());
    assert.equal(f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()), 1);
  };
  if (stage !== "running") await f.complete();
  if (stage === "captured" || stage === "succeeded") await f.capture();
  if (stage === "succeeded") assert.equal((await f.finalize())?.status, "succeeded");
  return f;
}
