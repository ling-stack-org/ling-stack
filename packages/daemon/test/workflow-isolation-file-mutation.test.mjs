import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { resolveSessionRunPolicy, workflowIsolationScopePlanDigest, workflowIsolationSafetyFingerprint,
  workflowIsolationStepSafetyFingerprint } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { workflowIsolationFixture } from "../../core/test/support/workflow-isolation-fixture.mjs";
import { executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { reconcileHarnessToolExecutionsAtStartup } from "../dist/features/harness/tool-execution/recovery.js";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { capturePreparedRunnerInput, readPreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { assertWorkflowIsolatedExecutionAuthority, requiresWorkflowIsolationFileMutation } from "../dist/features/runs/workflow-isolation-file-authority.js";
import { executeWorkflowIsolatedTool } from "../dist/features/runs/workflow-isolated-executor.js";
import { prepareWorkflowIsolatedExecution } from "../dist/features/runs/workflow-isolation-execution.js";
import { createWorkflowSafetyPlan, workflowSafetySnapshot } from "../dist/features/runs/workflow-safety.js";
import { inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest } from "../dist/features/workspaces/workflow-git-repository.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";

const exec = promisify(execFile), native = { skip: process.platform !== "darwin" };
const narrowTools = ["read", "write", "edit"];

/** Real admission transfer, Git creation evidence, SDK preparation and Host operation journal. */
async function fixture(t, { decision = "allow", mode = "enforce", start = true } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false });
  f.git = async (...args) => (await exec("/usr/bin/git", args, { cwd: f.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await f.git("init", "--initial-branch=main");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!owned.txt\n!.gitignore\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt");
  await f.git("commit", "-m", "initial");
  const repository = await inspectWorkflowGitRepository(f.cwd), worktreeRoot = join(f.root, "file-worktrees");
  await mkdir(worktreeRoot);
  const scope = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: f.scopeIsolation.step.id, generation: 1, worktreeId: "host-file-step" });
  const integration = await planWorkflowGitWorktree({ repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 1, worktreeId: "host-file-integration" });
  f.executionRoot = scope.executionRoot;
  const step = f.current(f.scopeIsolation);
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, requiredTools: narrowTools } }, f.at(0));
  const safety = createWorkflowSafetyPlan({ store: f.store, step: f.current(f.scopeIsolation),
    workspaceCwd: f.cwd, executionCwd: f.executionRoot, runnerId: "pi", isolatedScope: scope });
  assert.equal(safety.profile, "pi_host_isolated_files_v1");
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...f.current(f.scopeIsolation).metadata, safetyPlan: safety } }, f.at(0));
  f.stepFingerprint = workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation));
  const safetyPins = [{ workflowStepId: step.id, fingerprint: f.stepFingerprint }];
  const target = { ...f.inputs.target, expectedHead: repository.head, branchRef: repository.branchRef,
    cleanStateDigest: workflowGitRepositoryBasisDigest(repository) };
  f.inputs = { ...f.inputs, repositoryIdentity: { commonDir: repository.commonDir, objectFormat: repository.head.length === 40 ? "sha1" : "sha256" },
    target, baseCommit: repository.head, integration: { executionRoot: integration.executionRoot,
      worktreeId: integration.worktreeId, branchRef: integration.branchRef }, safetyPins,
    safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins) };
  f.plan = { ...f.plan, repositoryIdentity: f.inputs.repositoryIdentity, target, baseCommit: repository.head,
    executionRoot: f.executionRoot, worktreeId: scope.worktreeId, branchRef: scope.branchRef, safetyFingerprint: f.stepFingerprint };
  f.plan.planDigest = workflowIsolationScopePlanDigest(f.plan);
  f.create(); f.persistPin(); f.prepare();
  const run = f.store.getRun(f.prepared.run.id), storedTask = run.taskSnapshot;
  f.task = { id: storedTask.id, title: storedTask.title, prompt: storedTask.prompt, channelId: storedTask.channelId };
  f.policy = f.store.updateApprovalPolicy({ toolDecisions: { write: decision, edit: decision },
    allowedWritePaths: [f.executionRoot] }, f.at(4));
  f.effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: f.policy,
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const snapshot = { ...run.requestSnapshot, task: f.task, workspaceCwd: f.cwd, runnerId: "pi", teammateId: run.teammateId,
    workflowStepId: run.workflowStepId, workflowSafetySnapshot: workflowSafetySnapshot(safety),
    harnessFeatureSnapshot: { toolBroker: mode }, effectivePolicySnapshot: f.effectivePolicySnapshot };
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), run.id);
  f.store.database.prepare("UPDATE work_units SET request_json=? WHERE id=?").run(JSON.stringify({ task: f.task, cwd: f.executionRoot }), f.prepared.unit.id);
  const { now: _now, ...binding } = f.bindInput;
  f.execution = await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation, binding, scope, now: () => f.at(10),
    prepareInput: async () => {
      const options = { cwd: f.executionRoot, agentDir: join(f.root, "agent"), task: f.task, tools: narrowTools,
        provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
        isolatedToolsProfile: "host_isolated_files_v1", onToolBefore: () => ({ allowed: true }),
        onIsolatedToolCall: () => assert.fail("SDK preparation must not execute a tool"),
        onApprovalRequired: () => assert.fail("SDK preparation must not ask for approval"),
        runtimeToolFeatures: { requestPermissions: false, unifiedExec: false, shellSnapshot: false },
        initialToolSurface: { mediaGeneration: false, toolHydration: false, nativeFileCreate: false, userInput: false, delegation: false } };
      const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
      return capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
    } });
  f.link();
  f.sourceFence = f.prepared.fence;
  if (start) {
    assert.equal(f.store.transitionWorkUnitStatus({ ...f.sourceFence, expectedStatus: "queued", event: "claim", actor: "system", now: f.at(11) }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...f.sourceFence, status: "started", startedAt: f.at(11), now: f.at(11) }));
    assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner",
      startedAt: f.at(11), now: f.at(11) }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...f.sourceFence, expectedStatus: "claimed", event: "runner_started", actor: "runner",
      startedAt: f.at(11), now: f.at(11) }).ok, true);
    assert.equal(f.store.transitionTaskStatus({ taskId: f.task.id, expectedStatus: "claimed", event: "start_run", actor: "system",
      currentRunId: run.id, now: f.at(11) }).ok, true);
  }
  f.run = f.store.getRun(run.id);
  f.source = { runId: f.run.id, ...f.sourceFence };
  f.tracker = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  f.controller = new AbortController();
  t.after(() => f.controller.abort());
  f.authority = overrides => assertWorkflowIsolatedExecutionAuthority({ store: f.store, run: f.run,
    sourceFence: f.sourceFence, bindingId: f.writer.bindingId, ...overrides });
  f.request = (input = { path: "owned.txt", content: "isolated\n" }, toolCallId = "isolated-write", toolName = "write") =>
    ({ toolName, toolCallId, cwd: f.executionRoot, task: f.task, input });
  f.options = { store: f.store, run: f.run, sourceFence: f.sourceFence, workflowIsolationBindingId: f.writer.bindingId,
    workUnitId: f.run.workUnitId, attemptId: f.sourceFence.attemptId, hostOperationTracker: f.tracker,
    approvalPolicy: f.policy, effectivePolicySnapshot: f.effectivePolicySnapshot, signal: f.controller.signal,
    appendAndMaybeStream(type, data) {
      const event = f.store.appendExecutionEvent(f.run.id, f.sourceFence, type, data);
      if (type === "approval_requested") f.onApproval?.(data.approvalId);
      return event;
    }, streamEnvelope() {} };
  f.handler = createRunApprovalHandler(f.options);
  f.record = (index = 0) => f.store.getHostOperation(f.tracker.executorGroup.getSnapshot().operations[index].ticket.id);
  f.content = () => readFile(join(f.executionRoot, "owned.txt"), "utf8");
  f.targetContent = () => readFile(join(f.cwd, "owned.txt"), "utf8");
  f.context = (request = f.request(), overrides = {}) => ({ mode, store: f.store, run: f.run, sourceFence: f.sourceFence,
    workflowIsolationBindingId: f.writer.bindingId, request,
    draft: createFileMutationActionDraft({ request, allowedWritePaths: [f.executionRoot] }), allowedWritePaths: [f.executionRoot],
    effectivePolicySnapshot: f.effectivePolicySnapshot, appendAndMaybeStream: f.options.appendAndMaybeStream,
    hostOperation: { assertMayPrepare() {}, bindHarnessExecution() {}, effectGuard: {
      launch(effect) { return effect(); }, cleanup() { assert.fail("isolated writer must never roll back"); } } }, ...overrides });
  return f;
}

test("shared authority works before dispatch without issuing an OS or approval capability", async t => {
  const f = await fixture(t, { start: false }), facts = f.authority();
  assert.equal(facts.root, f.executionRoot);
  assert.equal(facts.binding.status, "ready");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 0);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
  assert.equal(await f.content(), "base\n");
});

test("full durable Task uses its SDK semantic projection without weakening the strict prepared reader", native, async t => {
  const f = await fixture(t), task = f.store.getTask(f.task.id);
  assert.ok(Object.keys(task).some(key => !["id", "title", "prompt", "channelId"].includes(key)));
  const snapshot = { ...f.run.requestSnapshot, task };
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.run.id);
  f.run = f.store.getRun(f.run.id);
  assert.throws(() => readPreparedRunnerInput(snapshot.runnerExecutionInput, { cwd: f.executionRoot, task }),
    /Invalid prepared execution payload/);
  for (const key of ["id", "title", "prompt", "channelId"]) {
    const changed = { ...snapshot, task: { ...task, [key]: "changed-semantic-field" } };
    f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(changed), f.run.id);
    const rejection = key === "id" ? /workflow_isolation_file_source_changed/
      : key === "channelId" ? /workflow_safety_mismatch:/ : /Invalid prepared execution payload/;
    assert.throws(() => f.authority(), rejection, key);
  }
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.run.id);
  assert.equal(f.authority().root, f.executionRoot);
  const handler = createRunApprovalHandler({ ...f.options, run: f.run });
  const result = await handler({ ...f.request(), task });
  assert.equal(result.handledResult.isError, undefined, JSON.stringify(result));
  assert.equal(await f.content(), "isolated\n");
});

for (const decision of ["allow", "ask"]) {
  test(`${decision} approval uses exactly one bounded write and sealed Broker evidence`, native, async t => {
    const f = await fixture(t, { decision });
    let launches = 0;
    const launch = f.store.launchHostOperation.bind(f.store);
    t.mock.method(f.store, "launchHostOperation", (ticket, effect) => launch(ticket, () => { launches++; return effect(); }));
    let created;
    const approval = new Promise(resolve => { f.onApproval = resolve; });
    const pending = f.handler(f.request());
    pending.catch(() => undefined);
    if (decision === "ask") {
      created = await Promise.race([approval, pending.then(() => assert.fail("expected approval wait"))]);
      assert.equal(f.record().phase, "admitted");
      assert.equal(await f.content(), "base\n");
      const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
      assert.equal(execution.state, "approval_pending");
      assert.equal(f.store.getArtifact(execution.policySnapshotArtifactId).sealedPayload.fileMutationRecovery, undefined);
      f.store.approveApprovalRequest(created, { reason: "Isolated file fixture" }, new Date().toISOString());
    }
    const result = await pending;
    assert.equal(result.approved, true, JSON.stringify(result));
    assert.equal(result.handledResult.isError, undefined, JSON.stringify(result));
    assert.equal(launches, 1);
    assert.equal(await f.content(), "isolated\n");
    assert.equal(await f.targetContent(), "base\n");
    assert.equal(await f.git("rev-parse", "HEAD"), f.plan.baseCommit);
    const record = f.record(), execution = f.store.getHarnessToolExecution(record.evidenceRef.id);
    assert.equal(record.settlementKind, "file_completed");
    assert.equal(execution.state, "succeeded");
    assert.equal(execution.approvalId, created);
    assert.equal(f.store.getArtifact(execution.policySnapshotArtifactId).sealedPayload.fileMutationRecovery, undefined);
    const artifact = execution.evidenceArtifactIds.map(id => f.store.getArtifact(id))
      .find(value => value?.sealedPayload?.kind === "workflow_isolation_file_mutation");
    assert.equal(artifact.sealedPayload.kind, "workflow_isolation_file_mutation");
    assert.equal(artifact.sealedPayload.bindingId, f.writer.bindingId);
    assert.equal(artifact.sealedPayload.executorResult.details.profile, "host_isolated_files_v1");
    assert.equal(artifact.contentSha256, createHash("sha256").update(JSON.stringify(artifact.sealedPayload)).digest("hex"));
    assert.ok(execution.evidenceArtifactIds.includes(artifact.sealedPayload.creationArtifactId));
    assert.equal(artifact.sealedPayload.previewArtifactIds.length > 0, decision === "ask");
  });
}

test("SDK edits array routes to the same approved bounded writer", native, async t => {
  const f = await fixture(t);
  const result = await f.handler(f.request({ path: "owned.txt", edits: [{ oldText: "base", newText: "changed" }] }, "isolated-edit", "edit"));
  assert.equal(result.handledResult.isError, undefined, JSON.stringify(result));
  assert.equal(await f.content(), "changed\n");
  assert.equal(await f.targetContent(), "base\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.toolName, "edit");
  assert.equal(execution.executorKind, "write");
  assert.equal(f.record().settlementKind, "file_completed");
});

for (const missing of ["binding", "fence", "operation", "off", "shadow"]) {
  test(`isolated ${missing} cannot fall back to an untracked or raw file write`, async t => {
    const f = await fixture(t);
    const changes = missing === "binding" ? { workflowIsolationBindingId: undefined }
      : missing === "fence" ? { sourceFence: undefined } : missing === "operation" ? { hostOperation: undefined } : { mode: missing };
    const result = await executeHarnessedFileMutationTool(f.context(undefined, changes));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /workflow_isolation_file_denied/);
    assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
    assert.equal(await f.content(), "base\n");
  });
}

for (const drift of ["binding", "fence", "pin", "snapshot", "prepared", "slots", "ready", "receipt", "artifact", "artifact-hash", "root"]) {
  test(`shared read/write authority rejects ${drift} drift`, async t => {
    const f = await fixture(t), facts = f.authority();
    let overrides;
    if (drift === "binding") overrides = { bindingId: "foreign" };
    if (drift === "fence") overrides = { sourceFence: { ...f.sourceFence, fencingToken: "999" } };
    if (["pin", "snapshot", "prepared"].includes(drift)) {
      const snapshot = structuredClone(f.run.requestSnapshot);
      if (drift === "pin") delete snapshot.workflowIsolationPlan;
      if (drift === "snapshot") delete snapshot.workflowSafetySnapshot;
      if (drift === "prepared") delete snapshot.runnerExecutionInput.input.isolatedToolsProfile;
      f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.run.id);
    }
    if (drift === "slots") f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.sourceFence, f.at(12), "revoked");
    if (drift === "ready") f.store.database.prepare("UPDATE workflow_isolation_bindings SET status='blocked',revision=revision+1 WHERE binding_id=?").run(f.writer.bindingId);
    if (drift === "receipt") t.mock.method(f.isolation, "getReceipt", () => undefined);
    if (drift === "artifact") t.mock.method(f.store, "getArtifact", () => undefined);
    if (drift === "artifact-hash") {
      const getArtifact = f.store.getArtifact.bind(f.store);
      t.mock.method(f.store, "getArtifact", id => { const value = getArtifact(id); return value && { ...value, contentSha256: "0".repeat(64) }; });
    }
    if (drift === "root") { await rename(f.executionRoot, f.executionRoot + "-original"); await mkdir(f.executionRoot); }
    assert.throws(() => f.authority(overrides), /workflow_isolation|workflow_safety/);
    await assert.rejects(executeWorkflowIsolatedTool({ root: facts.root, request: { ...f.request({ path: "owned.txt" }), toolName: "read" },
      assertCurrent: () => { f.authority(overrides); } }), /workflow_isolation|workflow_safety/);
    assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
    assert.equal(await f.targetContent(), "base\n");
  });
}

test("persisted markers still require isolation when no caller supplies a binding", async t => {
  const f = await fixture(t);
  assert.equal(requiresWorkflowIsolationFileMutation({ store: f.store, run: f.run }), true);
  const result = await createRunApprovalHandler({ ...f.options, workflowIsolationBindingId: undefined })(f.request());
  assert.equal(result.approved, false);
  assert.match(result.reason, /binding_required/);
  assert.equal(f.record().settlementKind, "known_no_start");
  assert.equal(await f.content(), "base\n");
});

test("preview old and new hashes cannot authorize changed content", native, async t => {
  const f = await fixture(t), context = f.context();
  await writeFile(join(f.executionRoot, "owned.txt"), "intervening\n");
  const old = await executeHarnessedFileMutationTool(context);
  assert.equal(old.isError, true);
  assert.equal(old.details.code, "workflow_isolated_approval_changed");
  assert.equal(await f.content(), "intervening\n");
  const next = f.context(f.request(undefined, "new-hash"));
  next.draft.plan.operations[0].newSha256 = "0".repeat(64);
  const changed = await executeHarnessedFileMutationTool(next);
  assert.equal(changed.isError, true);
  assert.equal(changed.details.code, "workflow_isolated_approval_changed");
  assert.equal(await f.content(), "intervening\n");
});

for (const invalid of ["legacy-edit", "patch", "private", "parent"]) {
  test(`isolated ${invalid} never invokes the raw executor or creates directories`, native, async t => {
    const f = await fixture(t);
    const request = invalid === "legacy-edit" ? f.request({ path: "owned.txt", oldText: "base", newText: "bad" }, invalid, "edit")
      : invalid === "patch" ? f.request({ patchText: "*** Begin Patch\n*** Update File: owned.txt\n@@\n-base\n+bad\n*** End Patch" }, invalid, "edit")
        : f.request({ path: invalid === "private" ? ".env" : "missing/child.txt", content: "MUST NOT WRITE" }, invalid);
    const result = await f.handler(request).catch(error => ({ failure: error }));
    assert.ok(result.failure || result.handledResult?.isError, JSON.stringify(result));
    assert.equal(await f.content(), "base\n");
    await assert.rejects(readFile(join(f.executionRoot, invalid === "private" ? ".env" : "missing/child.txt")), { code: "ENOENT" });
  });
}

test("authority revocation inside Host launch is rechecked before the OS spawn", native, async t => {
  const f = await fixture(t), context = f.context();
  let launched = false;
  context.hostOperation.effectGuard.launch = effect => {
    f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.sourceFence, f.at(12), "revoked at launch");
    launched = true;
    return effect();
  };
  await assert.rejects(executeHarnessedFileMutationTool(context), /admission_slots_changed/);
  assert.equal(launched, true);
  assert.equal(await f.content(), "base\n");
});

test("terminal toolCall cannot repeat a physical write", native, async t => {
  const f = await fixture(t), context = f.context();
  let launches = 0;
  context.hostOperation.effectGuard.launch = effect => { launches++; return effect(); };
  assert.equal((await executeHarnessedFileMutationTool(context)).isError, undefined);
  const duplicate = await executeHarnessedFileMutationTool(context);
  assert.equal(duplicate.isError, true);
  assert.equal(launches, 1);
  assert.equal(await f.content(), "isolated\n");
});

test("a real write followed by result-evidence failure remains unknown with no rollback or replay", native, async t => {
  const f = await fixture(t), createArtifact = f.store.createArtifact.bind(f.store), retryContext = f.context();
  t.mock.method(f.store, "createArtifact", input => {
    if (input.sealedPayload?.kind === "workflow_isolation_file_mutation") throw new Error("isolated evidence storage failed");
    return createArtifact(input);
  });
  await assert.rejects(f.handler(f.request()), /isolated evidence storage failed|execution.*unconfirmed/);
  assert.equal(await f.content(), "isolated\n");
  assert.equal(await f.targetContent(), "base\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "unknown_outcome");
  assert.equal(execution.failureCode, "tool.unknown_side_effect_outcome");
  assert.equal(f.record().phase, "unknown_outcome");
  assert.equal(f.tracker.executorGroup.getSnapshot().operations[0].state, "blocked");
  const retry = await executeHarnessedFileMutationTool(retryContext);
  assert.equal(retry.isError, true);
  assert.equal(f.store.getHarnessToolExecution(execution.id).state, "unknown_outcome");
  assert.equal(await f.content(), "isolated\n");
});

test("expired isolated effects without a durable receipt stay unknown instead of hash recovery", native, async t => {
  const f = await fixture(t), retryContext = f.context();
  const finish = t.mock.method(f.store, "finishHarnessToolExecution", () => { throw new Error("receipt storage unavailable"); });
  await assert.rejects(f.handler(f.request()), /receipt storage unavailable|execution.*unconfirmed/);
  assert.equal(await f.content(), "isolated\n");
  assert.equal(await f.targetContent(), "base\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  assert.equal(execution.state, "executing");
  assert.equal(f.record().phase, "unknown_outcome");
  finish.mock.restore();
  const recoveryInput = { cwd: f.executionRoot, store: f.store,
    now: new Date(Date.parse(execution.claimExpiresAt) + 1).toISOString() };
  assert.equal(reconcileHarnessToolExecutionsAtStartup(recoveryInput).updated, 1);
  const recovered = f.store.getHarnessToolExecution(execution.id);
  assert.equal(recovered.state, "unknown_outcome");
  assert.equal(recovered.failureCode, "tool.unknown_side_effect_outcome");
  assert.equal(recovered.resultSummary.reason, "claim_expired_after_possible_side_effect");
  assert.equal(reconcileHarnessToolExecutionsAtStartup(recoveryInput).updated, 0);
  assert.deepEqual(f.store.getHarnessToolExecution(execution.id), recovered);
  assert.equal((await executeHarnessedFileMutationTool(retryContext)).isError, true);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 1);
  assert.equal(await f.content(), "isolated\n");
});

test("persisted Broker mode drift is rejected even if the dispatch caller still passes enforce", async t => {
  const f = await fixture(t), context = f.context(), snapshot = structuredClone(f.run.requestSnapshot);
  snapshot.harnessFeatureSnapshot.toolBroker = "off";
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.run.id);
  const result = await executeHarnessedFileMutationTool(context);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /enforce_required/);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
  assert.equal(await f.content(), "base\n");
});
