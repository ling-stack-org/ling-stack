import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { digestHarnessToolValue, workflowIsolationDigest, workflowIsolationScopePlanDigest,
  workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint, workflowStepSafetyPlanDigest } from "@ling-stack/core";
import { workflowIsolationFixture } from "../../../core/test/support/workflow-isolation-fixture.mjs";
import { captureWorkflowIsolatedResult, workflowIsolatedResultBlocker } from "../../dist/features/channels/workflow-isolated-result.js";
import { createWorkflowStepContextArtifact } from "../../dist/features/channels/workflow-step-packets.js";
import { prepareWorkflowIsolatedExecution } from "../../dist/features/runs/workflow-isolation-execution.js";
import { inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest }
  from "../../dist/features/workspaces/workflow-git-repository.js";

const exec = promisify(execFile);
export const nativeGit = { skip: !["darwin", "linux"].includes(process.platform) };
export const now = () => new Date().toISOString();
export const sha256 = content => createHash("sha256").update(content).digest("hex");

/** Real Git preparation and SQLite terminal authority; no Provider, SDK or fake terminal-reader port. */
export async function workflowIsolatedResultFixture(t, { mutations = [], terminal = true, drained = true,
  audit = true, context = true, outcome = "succeeded", release = true } = {}) {
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
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n!new.txt\n!unexpected.txt\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt");
  await f.git("commit", "-m", "initial");
  const repository = await inspectWorkflowGitRepository(f.cwd), worktreeRoot = join(f.root, "result-worktrees");
  await mkdir(worktreeRoot);
  f.scopeGit = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: f.scopeIsolation.step.id, generation: 1, worktreeId: "isolated-result-step" });
  const integration = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 1, worktreeId: "isolated-result-integration" });
  f.executionRoot = f.scopeGit.executionRoot;
  const metadata = f.current(f.scopeIsolation).metadata;
  const safety = { ...metadata.safetyPlan, executionRoot: f.executionRoot, writeRoots: [f.executionRoot] };
  safety.digest = workflowStepSafetyPlanDigest(safety);
  f.store.updateChannelWorkflowStep(f.scopeIsolation.step.id, { metadata: { ...metadata, safetyPlan: safety } }, f.at(0));
  f.stepFingerprint = workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation));
  const safetyPins = [{ workflowStepId: f.scopeIsolation.step.id, fingerprint: f.stepFingerprint }];
  const target = { ...f.inputs.target, expectedHead: repository.head, branchRef: repository.branchRef,
    cleanStateDigest: workflowGitRepositoryBasisDigest(repository) };
  f.inputs = { ...f.inputs, repositoryIdentity: { commonDir: repository.commonDir,
    objectFormat: repository.head.length === 40 ? "sha1" : "sha256" }, target, baseCommit: repository.head,
    integration: { executionRoot: integration.executionRoot, worktreeId: integration.worktreeId, branchRef: integration.branchRef },
    safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins) };
  f.plan = { ...f.plan, repositoryIdentity: f.inputs.repositoryIdentity, target, baseCommit: repository.head,
    executionRoot: f.executionRoot, worktreeId: f.scopeGit.worktreeId, branchRef: f.scopeGit.branchRef,
    safetyFingerprint: f.stepFingerprint };
  f.plan.planDigest = workflowIsolationScopePlanDigest(f.plan);
  f.create(); f.persistPin(); f.prepare();
  const bindingId = workflowIsolationDigest({ runId: f.prepared.run.id, ...f.prepared.fence }, "wib_");
  f.writer = { bindingId, ...f.prepared.fence };
  f.bindInput = { ...f.bindInput, bindingId };
  f.binding = () => f.isolation.getExecutionBinding(bindingId);
  const { now: _now, ...binding } = f.bindInput;
  f.execution = await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation,
    binding, scope: f.scopeGit, now: () => f.at(10), prepareInput: async () => f.executionPayload() });
  f.link();
  f.runId = f.prepared.run.id;
  if (context) {
    const artifact = createWorkflowStepContextArtifact({ store: f.store,
      workflow: f.store.getChannelWorkflow(f.plan.workflowId), step: f.current(f.scopeIsolation),
      run: f.store.getRun(f.runId), runRequest: { cwd: f.executionRoot, task: f.store.getTask(f.generation.task.id), runnerId: "pi" }, now: f.at(12) });
    f.store.updateChannelWorkflowStep(f.plan.workflowStepId,
      { metadata: { ...f.current(f.scopeIsolation).metadata, contextArtifactId: artifact.id } }, f.at(12));
    f.contextArtifact = artifact;
  }
  f.branchGit = async (...args) => (await f.gitAt(f.executionRoot, args)).toString().trim();
  f.gitDir = await f.branchGit("rev-parse", "--absolute-git-dir");
  f.originalIndex = await readFile(join(f.gitDir, "index"));
  f.source = { runId: f.runId, ...f.prepared.fence };
  f.run = () => f.store.getRun(f.runId);
  f.resultRef = `refs/ling/workflow/results/${f.roundId}/${f.plan.workflowStepId}/1-${f.scopeGit.worktreeId}`;
  f.ref = async () => {
    try { return await f.git("rev-parse", "--verify", "--quiet", f.resultRef); }
    catch (error) { if (error.code === 1) return null; throw error; }
  };
  f.capture = overrides => captureWorkflowIsolatedResult({ store: f.store, writer: f.writer,
    isolation: f.isolation, now, ...overrides });
  f.blocker = () => workflowIsolatedResultBlocker(f.store, f.run(), now());
  f.intent = () => f.isolation.getTerminalResultIntent(f.writer.bindingId);
  f.receiptArtifacts = () => f.store.listArtifacts(f.runId)
    .filter(artifact => artifact.sealedPayload?.kind === "workflow_isolation_result_ref_receipt");
  f.gitSnapshot = async () => ({ head: await f.git("rev-parse", "HEAD"), branchHead: await f.branchGit("rev-parse", "HEAD"),
    refs: await f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/ling/workflow/results/"),
    objects: await f.git("count-objects", "-v"),
    reflog: await f.ref() === null ? "" : await f.git("reflog", "show", "--format=%H %gD", f.resultRef),
    index: await readFile(join(f.gitDir, "index")) });
  f.resultSnapshot = async () => ({ git: await f.gitSnapshot(), rows: f.snapshotIsolation(),
    artifacts: f.store.listArtifacts(f.runId), intent: f.intent(),
    journal: Object.fromEntries(["workflow_isolation_result_intents", "workflow_isolation_result_receipts"].map(table =>
      [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) });

  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  const fence = f.prepared.fence;
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId: f.runId, expectedStatus: "queued", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: f.runId, now: now() }).ok, true);
  const toolCallIds = [];
  let finish;
  const completion = f.store.trackHostAttemptCompletion(f.source, new Promise(resolve => { finish = resolve; }),
    () => toolCallIds.length ? { schemaVersion: 1, toolCallIds, settledBuiltinReads: [] } : true);
  completion.catch(() => undefined);
  f.finish = async () => { finish(); return completion; };

  // A real dedicated domain row/receipt permits cross-platform capture tests without claiming Pi/Broker execution.
  f.mutate = ({ path = "owned.txt", content = "changed\n", toolName = "write", toolCallId = `write-${toolCallIds.length + 1}` } = {}) => {
    let before;
    try { before = readFileSync(join(f.executionRoot, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const requestDigest = sha256(JSON.stringify({ path, content })), sideEffectFingerprint = sha256(`effect:${toolCallId}`);
    f.store.appendEvent(f.runId, "tool_start", { attemptId: fence.attemptId, toolCallId, toolName, input: { path, content } }, now());
    const ticket = f.store.admitHostOperation({ operationId: `result-${toolCallId}`, source: f.source, kind: "file_mutation", toolCallId });
    const policy = f.store.createArtifact({ runId: f.runId, type: "json", path: `harness/${toolCallId}/policy.json`, createdAt: now(),
      sealedPayload: { schemaVersion: 1, runId: f.runId, attemptId: fence.attemptId, toolCallId,
        executorKind: "write", requestDigest, sideEffectFingerprint, effectivePolicySnapshot: {} } });
    const prepared = f.store.prepareHarnessToolExecution({ runId: f.runId, workUnitId: fence.workUnitId, sourceFence: fence,
      toolCallId, toolName, executorKind: "write", requestDigest, sideEffectFingerprint, policySnapshotArtifactId: policy.id,
      approvalState: "allowed", sandboxProfileId: "host_isolated_files_v1", now: now() }).execution;
    f.store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: prepared.id });
    const claim = f.store.claimHarnessToolExecution({ executionId: prepared.id, expectedRevision: prepared.revision, sourceFence: fence,
      claimOwner: "result-fixture", claimToken: toolCallId, claimExpiresAt: f.at(200), now: now() });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const started = f.store.startHarnessToolExecution({ executionId: prepared.id, expectedRevision: claim.value.revision,
      sourceFence: fence, claimOwner: "result-fixture", claimToken: toolCallId, now: now() });
    assert.equal(started.ok, true, JSON.stringify(started));
    f.store.launchHostOperation(ticket, () => writeFileSync(join(f.executionRoot, path), content));
    const executorResult = { content: [{ type: "text", text: "File written." }],
      details: { profile: "host_isolated_files_v1", path, bytesWritten: Buffer.byteLength(content) } };
    const creationArtifactId = f.isolation.getReceipt(f.binding().creationReceiptId).artifactId;
    const result = f.store.createArtifact({ runId: f.runId, type: "json", path: `harness/${toolCallId}/result.json`, createdAt: now(),
      sealedPayload: { schemaVersion: 1, kind: "workflow_isolation_file_mutation", status: "applied", outcome: "applied",
        format: "ling-apply-patch-v1", touchedPaths: [path], bindingId, planId: f.plan.planId, planDigest: f.plan.planDigest,
        sourceFence: fence, creationReceiptId: f.binding().creationReceiptId, creationArtifactId, rawPatchSha256: sha256(content),
        expectedMutation: { ...(before ? { oldSha256: sha256(before) } : {}), newSha256: sha256(content) }, executorResult, previewArtifactIds: [] } });
    const evidenceArtifactIds = [creationArtifactId, result.id];
    const summary = { status: "applied", outcome: "applied", touchedPaths: [path], artifactCount: evidenceArtifactIds.length, cancelled: false };
    const finished = f.store.finishHarnessToolExecution({ executionId: prepared.id, expectedRevision: started.value.revision,
      sourceFence: fence, claimOwner: "result-fixture", claimToken: toolCallId, nextState: "succeeded",
      resultDigest: digestHarnessToolValue(summary), resultSummary: summary, evidenceArtifactIds, now: now() });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(f.store.settleHostOperation(ticket, { kind: "file_completed", settledAt: now() }).phase, "safe");
    f.store.appendEvent(f.runId, "tool_end", { attemptId: fence.attemptId, toolCallId, toolName, isError: false, result: executorResult }, now());
    toolCallIds.push(toolCallId);
    t.mock.timers.tick(1);
    return { artifact: result, execution: finished.value };
  };
  f.mutations = mutations.map(f.mutate);
  f.complete = async () => {
    if (drained) await f.finish();
    const event = outcome === "succeeded" ? "runner_succeeded" : "runner_failed";
    assert.equal(f.store.transitionRunStatus({ runId: f.runId, expectedStatus: "running", event,
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event,
      actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt: now(), now: now() }));
    if (audit) f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: now() },
      type: outcome === "succeeded" ? "work_unit_succeeded" : "work_unit_failed", actor: "runner", data: { runId: f.runId } });
    if (release && drained) {
      f.store.releaseHostAttemptResources(f.source, now());
      assert.equal(f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()), 1);
    }
  };
  if (terminal) await f.complete();
  return f;
}

/** Simulate a crash at one durable boundary while retaining the real SQLite implementation everywhere else. */
export function interruptedResultIsolation(f, method, fault, { after = false, once = false } = {}) {
  let interrupted = false;
  return new Proxy(f.isolation, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => {
      if (key !== method || once && interrupted) return value.apply(target, args);
      interrupted = true;
      if (after) value.apply(target, args);
      throw fault;
    };
  } });
}
