import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore, digestHarnessToolValue, normalizeWorkflowIntegrationRoundInputs,
  toRuntimeAttemptFence, workflowIsolationDigest, workflowIsolationSafetyFingerprint, workflowIsolationScopePlanDigest,
  workflowIsolationStepSafetyFingerprint, workflowStepSafetyPlanDigest } from "@ling-stack/core";
import { admissionParticipant, workflowAdmissionFixture } from "../../../core/test/support/workflow-step-admission-fixture.mjs";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../../dist/features/channels/workflow-candidate-validation.js";
import { captureWorkflowIsolatedResult } from "../../dist/features/channels/workflow-isolated-result.js";
import { createWorkflowStepContextArtifact } from "../../dist/features/channels/workflow-step-packets.js";
import { prepareWorkflowIsolatedExecution } from "../../dist/features/runs/workflow-isolation-execution.js";
import { inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest }
  from "../../dist/features/workspaces/workflow-git-repository.js";

const exec = promisify(execFile);
const sha256 = content => createHash("sha256").update(content).digest("hex");
export const nativeGit = { skip: !["darwin", "linux"].includes(process.platform) };
export const now = () => new Date().toISOString();
const files = ["left.txt", "right.txt", "shared.txt"];

/** Two immutable participants, real SQLite/Git evidence, and serial admission. No write-parallel gate is enabled. */
export async function workflowMultibranchIntegrationFixture(t) {
  const drains = [];
  t.after(async () => { for (const drain of drains) await drain(); });
  const f = await workflowAdmissionFixture(t);
  f.roundId = "multibranch-round-1";
  f.completionOrder = [];
  f.gitAt = async (cwd, args) => (await exec("/usr/bin/git", args, { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout;
  f.git = async (...args) => (await f.gitAt(f.cwd, args)).toString().trim();
  await f.git("init", "--initial-branch=main");
  await f.git("config", "core.logAllRefUpdates", "always");
  await writeFile(join(f.cwd, ".gitignore"), `*\n!.gitignore\n${files.map(path => `!${path}\n`).join("")}`);
  for (const path of files) await writeFile(join(f.cwd, path), `base ${path}\n`);
  await f.git("add", "--", ".gitignore", ...files);
  await f.git("commit", "-m", "initial two-branch basis");
  f.repository = await inspectWorkflowGitRepository(f.cwd, { hostStateRoot: f.store.paths.rootDir });
  const worktreeRoot = join(f.root, "multibranch-worktrees");
  await mkdir(worktreeRoot);

  const first = f.scope("multibranch-left");
  const second = { workflow: first.workflow, step: f.store.createChannelWorkflowStep({ workflowId: first.workflow.id,
    title: "Write right branch", prompt: "Write the right branch result", toParticipantId: admissionParticipant,
    toParticipantLabel: "Engineer", metadata: { policy: { ...first.step.metadata.policy } } }, f.at(0)) };
  f.workflowId = first.workflow.id;
  f.branches = [first, second].map((scope, index) => ({ key: index === 0 ? "left" : "right", scope, mutations: [] }));
  const safety = { sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: false, resourceKeys: ["port:17449"] } };
  const graph = { schemaVersion: 1, id: "multibranch-integration", name: "Two isolated results", entryNodeId: "left",
    maxParallelSteps: 1, nodes: f.branches.map(branch => ({ id: branch.key, kind: "step", name: branch.scope.step.title,
      prompt: branch.scope.step.prompt, ...safety })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } };
  const graphFingerprint = workflowGraphFingerprintV1(graph);
  f.store.updateChannelWorkflow(f.workflowId, { metadata: { workflowGraph: graph, workflowGraphFingerprint: graphFingerprint } }, f.at(0));
  for (const branch of f.branches) {
    branch.scope.plan = f.plan({ entries: f.plan().entries.map(entry => ({ ...entry, limit: 1 })),
      resourceKeys: [`workflow:${f.workflowId}`, "workspace:canonical-multibranch", "port:17449"] });
    branch.gitScope = await planWorkflowGitWorktree({ repository: f.repository, worktreeRoot, roundId: f.roundId,
      stepId: branch.scope.step.id, generation: 1, worktreeId: `multibranch-${branch.key}` });
    branch.executionRoot = branch.gitScope.executionRoot;
    branch.step = () => f.current(branch.scope);
    const safetyInput = { schemaVersion: 1, profile: "serial_v1", workflowId: f.workflowId, workflowStepId: branch.scope.step.id,
      workspaceRoot: f.cwd, executionRoot: branch.executionRoot, safety, tools: ["read", "write"], runnerId: "pi",
      networkAccess: false, writeRoots: [branch.executionRoot] };
    f.store.updateChannelWorkflowStep(branch.scope.step.id, { metadata: { ...branch.step().metadata, ...safety,
      requestedRunnerId: "pi", requiredTools: ["read", "write"],
      safetyPlan: { ...safetyInput, digest: workflowStepSafetyPlanDigest(safetyInput) } } }, f.at(0));
    branch.safetyFingerprint = workflowIsolationStepSafetyFingerprint(branch.step());
  }
  f.integrationScope = await planWorkflowGitWorktree({ repository: f.repository, worktreeRoot, roundId: f.roundId,
    stepId: "integration", generation: 1, worktreeId: "multibranch-integration" });
  const target = { executionRoot: f.cwd, worktreeId: "multibranch-target", branchRef: f.repository.branchRef,
    expectedHead: f.repository.head, cleanStateDigest: workflowGitRepositoryBasisDigest(f.repository), inputMode: "clean_checkout" };
  const safetyPins = f.branches.map(branch => ({ workflowStepId: branch.scope.step.id, fingerprint: branch.safetyFingerprint }));
  const { executionRoot, worktreeId, branchRef } = f.integrationScope;
  f.inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: f.workflowId, canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: f.cwd,
    repositoryIdentity: { commonDir: f.repository.commonDir, objectFormat: f.repository.head.length === 40 ? "sha1" : "sha256" },
    target, baseCommit: f.repository.head, integration: { executionRoot, worktreeId, branchRef }, graphFingerprint,
    safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), templatePins: [],
    participants: f.branches.map(branch => ({ workflowStepId: branch.scope.step.id, position: branch.scope.step.position, required: true })),
    mergeOrder: f.branches.map(branch => branch.scope.step.id), optionalFailurePolicy: "require_success",
    validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })), mode: "candidate_only" });
  assert.ok(f.inputs, "the two-participant immutable round must satisfy Core normalization");
  f.isolation = createSqliteWorkflowIsolationStore(f.store);
  f.round = () => f.isolation.getIntegrationRound(f.roundId);
  const round = f.isolation.createIntegrationRound({ roundId: f.roundId, inputs: f.inputs, now: f.at(0) });
  assert.equal(round.status, "created", JSON.stringify(round));
  for (const branch of f.branches) {
    const plan = { schemaVersion: 1, planId: `multibranch-plan-${branch.key}`, workflowId: f.workflowId,
      workflowStepId: branch.scope.step.id, canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: f.cwd,
      repositoryIdentity: f.inputs.repositoryIdentity, target, integrationRoundId: f.roundId, generation: 1, stepGeneration: 1,
      baseCommit: f.inputs.baseCommit, executionRoot: branch.executionRoot, worktreeId: branch.gitScope.worktreeId,
      branchRef: branch.gitScope.branchRef, graphFingerprint, safetyFingerprint: branch.safetyFingerprint,
      templatePins: [], resourcePlan: branch.scope.plan };
    branch.plan = { ...plan, planDigest: workflowIsolationScopePlanDigest(plan) };
    const created = f.isolation.createScopePlan({ plan: branch.plan, now: f.at(0) });
    assert.equal(created.status, "created", JSON.stringify(created));
    f.store.updateChannelWorkflowStep(branch.scope.step.id, { metadata: { ...branch.step().metadata,
      isolationScopePlan: { planId: branch.plan.planId, planDigest: branch.plan.planDigest } } }, f.at(0));
  }

  f.gitDir = await f.git("rev-parse", "--absolute-git-dir");
  f.ref = async ref => {
    try { return await f.git("rev-parse", "--verify", "--quiet", ref); }
    catch (error) { if (error.code === 1) return null; throw error; }
  };
  f.coordinate = async () => {
    const { coordinateWorkflowIntegration } = await import("../../dist/features/channels/workflow-integration-coordinator.js");
    return coordinateWorkflowIntegration({ store: f.store, roundId: f.roundId, now });
  };
  f.journal = () => {
    const port = createSqliteWorkflowIntegrationCoordinatorStore(f.store), scope = { roundId: f.roundId, generation: f.round().generation };
    return { effects: port.listEffects(scope), receipts: port.listReceipts(scope) };
  };
  f.artifacts = () => f.branches.flatMap(branch => branch.runId ? f.store.listArtifacts(branch.runId) : []);
  f.reopenIsolation = () => { f.reopen(); f.isolation = createSqliteWorkflowIsolationStore(f.store); };
  const fileSnapshot = async root => Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(root, path))])));
  f.targetSnapshot = async () => ({ head: await f.git("rev-parse", "HEAD"), branch: await f.git("symbolic-ref", "HEAD"),
    status: await f.git("status", "--porcelain=v1", "--untracked-files=all"),
    index: await readFile(join(f.gitDir, "index")), files: await fileSnapshot(f.cwd) });
  f.sourcesSnapshot = async () => Promise.all(f.branches.filter(branch => branch.runId).map(async branch => ({
    stepId: branch.scope.step.id, head: await branch.git("rev-parse", "HEAD"), branch: await branch.git("symbolic-ref", "HEAD"),
    status: await branch.git("status", "--porcelain=v1", "--untracked-files=all"), index: await readFile(join(branch.gitDir, "index")),
    files: await fileSnapshot(branch.executionRoot), resultRef: await f.ref(branch.resultRef), binding: branch.binding(),
    run: branch.run(), attempt: f.store.getWorkUnitAttempt(branch.fence.attemptId) })));
  f.integrationAbsent = async () => {
    await assert.rejects(access(f.integrationScope.executionRoot), { code: "ENOENT" });
    assert.equal(await f.ref(f.integrationScope.branchRef), null);
    assert.equal(await f.git("for-each-ref", "--format=%(refname)", "refs/ling/workflow/candidates/"), "");
  };
  f.snapshot = async () => ({ round: f.round(), journal: f.journal(), artifacts: f.artifacts(), target: await f.targetSnapshot(),
    sources: await f.sourcesSnapshot(), refs: await f.git("for-each-ref", "--format=%(refname) %(objectname)"),
    reflogs: await f.git("reflog", "show", "--all", "--format=%H %gD"), objects: await f.git("count-objects", "-v"),
    worktrees: await f.git("worktree", "list", "--porcelain") });

  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  for (const branch of f.branches) {
    branch.start = async () => {
      assert.equal(branch.runId, undefined, "a branch has one original Attempt");
      assert.ok(f.branches.every(other => !other.runId || other.step().status === "succeeded"), "writes remain serially admitted");
      branch.generation = f.begin(branch.scope, f.input(branch.scope, f.lease(branch.scope, now()), { now: now() }));
      const taskId = branch.generation.task.id;
      assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "todo", event: "claim", actor: "system", now: now() }).ok, true);
      const task = f.store.getTask(taskId);
      const run = f.store.createRun({ id: `multibranch-run-${branch.key}`, cwd: branch.executionRoot, taskId, channelId: f.channel.id,
        teammateId: admissionParticipant, workflowStepId: branch.scope.step.id, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd: branch.executionRoot, workflowStartOwner: branch.generation.owner,
          workflowIsolationPlan: { planId: branch.plan.planId, planDigest: branch.plan.planDigest } }, createdAt: now() });
      const unit = f.store.createWorkUnit({ id: `multibranch-unit-${branch.key}`, workspaceId: f.channel.workspaceId, kind: "task_run",
        ownerType: "task", ownerId: taskId, taskId, channelId: f.channel.id, teammateId: admissionParticipant, runnerId: "pi",
        effectiveRunnerId: "pi", idempotencyKey: `multibranch-unit-${branch.key}`, createdByActor: "system", request: {}, now: now() });
      f.store.linkRunToWorkUnit(run.id, unit.id, now());
      const attempt = f.store.createWorkUnitAttempt({ id: `multibranch-attempt-${branch.key}`, workUnitId: unit.id, attemptNumber: 1,
        runtimeInstanceId: `multibranch-runtime-${branch.key}`, runnerId: "pi", effectiveRunnerId: "pi", now: now() });
      branch.fence = toRuntimeAttemptFence(attempt);
      branch.runId = run.id;
      branch.run = () => f.store.getRun(run.id);
      branch.writer = { bindingId: workflowIsolationDigest({ runId: run.id, ...branch.fence }, "wib_"), ...branch.fence };
      branch.binding = () => f.isolation.getExecutionBinding(branch.writer.bindingId);
      branch.source = { runId: run.id, ...branch.fence };
      const prepared = { run: branch.run(), unit: f.store.getWorkUnit(unit.id), attempt, fence: branch.fence };
      branch.execution = await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation, scope: branch.gitScope,
        binding: { bindingId: branch.writer.bindingId, planId: branch.plan.planId, planDigest: branch.plan.planDigest,
          startOwner: branch.generation.owner, runId: run.id, fence: branch.fence }, now, prepareInput: async () => {
          const taskInput = { id: task.id, channelId: task.channelId, title: task.title, prompt: task.prompt }, tools = ["read", "write"];
          const input = { schemaVersion: 1, boundary: "pi-model-context", taskId, systemPrompt: "Frozen two-branch fixture",
            userPrompt: task.prompt, model: { id: "fixture", provider: "fixture" }, thinkingLevel: "off",
            tools: tools.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })) };
          return { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
            input: { cwd: branch.executionRoot, task: taskInput, provider: { provider: "fixture", model: "fixture" }, tools },
            preparedInput: { ...input, fingerprint: sha256(JSON.stringify(input)) } };
        } });
      const transferred = f.transfer(branch.scope, branch.generation, prepared, { now: now(), expiresAt: f.at(3_620) });
      assert.equal(transferred.status, "transferred", JSON.stringify(transferred));
      assert.equal(f.ready(branch.scope, branch.generation, prepared, { now: now() }).status, "linked");
      const context = createWorkflowStepContextArtifact({ store: f.store, workflow: f.store.getChannelWorkflow(f.workflowId),
        step: branch.step(), run: branch.run(), runRequest: { cwd: branch.executionRoot, task, runnerId: "pi" }, now: now() });
      f.store.updateChannelWorkflowStep(branch.scope.step.id, { metadata: { ...branch.step().metadata, contextArtifactId: context.id } }, now());
      branch.git = async (...args) => (await f.gitAt(branch.executionRoot, args)).toString().trim();
      branch.gitDir = await branch.git("rev-parse", "--absolute-git-dir");
      branch.resultRef = `refs/ling/workflow/results/${f.roundId}/${branch.scope.step.id}/1-${branch.gitScope.worktreeId}`;
      const fence = branch.fence;
      assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
      assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
      assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
        actor: "runner", startedAt: now(), now: now() }).ok, true);
      assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
        actor: "runner", startedAt: now(), now: now() }).ok, true);
      assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "claimed", event: "start_run", actor: "system",
        currentRunId: run.id, now: now() }).ok, true);
      const toolCallIds = [];
      let finish;
      const completion = f.store.trackHostAttemptCompletion(branch.source, new Promise(resolve => { finish = resolve; }),
        () => ({ schemaVersion: 1, toolCallIds, settledBuiltinReads: [] }));
      completion.catch(() => undefined);
      drains.push(async () => { finish(); await completion; });

      // Match the real file-domain receipt chain, without pretending a Provider or Runner SDK ran.
      branch.mutate = ({ path = `${branch.key}.txt`, content = `${branch.key} result\n` } = {}) => {
        assert.ok(files.includes(path));
        const toolCallId = `multibranch-${branch.key}-write-${toolCallIds.length + 1}`, toolName = "write";
        const before = readFileSync(join(branch.executionRoot, path));
        const requestDigest = sha256(JSON.stringify({ path, content })), sideEffectFingerprint = sha256(`effect:${toolCallId}`);
        f.store.appendEvent(run.id, "tool_start", { attemptId: fence.attemptId, toolCallId, toolName, input: { path, content } }, now());
        const ticket = f.store.admitHostOperation({ operationId: toolCallId, source: branch.source, kind: "file_mutation", toolCallId });
        const policy = f.store.createArtifact({ runId: run.id, type: "json", path: `harness/${toolCallId}/policy.json`, createdAt: now(),
          sealedPayload: { schemaVersion: 1, runId: run.id, attemptId: fence.attemptId, toolCallId, executorKind: "write",
            requestDigest, sideEffectFingerprint, effectivePolicySnapshot: {} } });
        const execution = f.store.prepareHarnessToolExecution({ runId: run.id, workUnitId: fence.workUnitId, sourceFence: fence,
          toolCallId, toolName, executorKind: "write", requestDigest, sideEffectFingerprint, policySnapshotArtifactId: policy.id,
          approvalState: "allowed", sandboxProfileId: "host_isolated_files_v1", now: now() }).execution;
        f.store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: execution.id });
        const claim = f.store.claimHarnessToolExecution({ executionId: execution.id, expectedRevision: execution.revision,
          sourceFence: fence, claimOwner: "multibranch-fixture", claimToken: toolCallId, claimExpiresAt: f.at(200), now: now() });
        assert.equal(claim.ok, true, JSON.stringify(claim));
        const started = f.store.startHarnessToolExecution({ executionId: execution.id, expectedRevision: claim.value.revision,
          sourceFence: fence, claimOwner: "multibranch-fixture", claimToken: toolCallId, now: now() });
        assert.equal(started.ok, true, JSON.stringify(started));
        f.store.launchHostOperation(ticket, () => writeFileSync(join(branch.executionRoot, path), content));
        const executorResult = { content: [{ type: "text", text: "File written." }],
          details: { profile: "host_isolated_files_v1", path, bytesWritten: Buffer.byteLength(content) } };
        const creationReceiptId = branch.binding().creationReceiptId;
        const creationArtifactId = f.isolation.getReceipt(creationReceiptId).artifactId;
        const artifact = f.store.createArtifact({ runId: run.id, type: "json", path: `harness/${toolCallId}/result.json`, createdAt: now(),
          sealedPayload: { schemaVersion: 1, kind: "workflow_isolation_file_mutation", status: "applied", outcome: "applied",
            format: "ling-apply-patch-v1", touchedPaths: [path], bindingId: branch.writer.bindingId,
            planId: branch.plan.planId, planDigest: branch.plan.planDigest, sourceFence: fence,
            creationReceiptId, creationArtifactId, rawPatchSha256: sha256(content),
            expectedMutation: { oldSha256: sha256(before), newSha256: sha256(content) }, executorResult, previewArtifactIds: [] } });
        const evidenceArtifactIds = [creationArtifactId, artifact.id];
        const summary = { status: "applied", outcome: "applied", touchedPaths: [path], artifactCount: evidenceArtifactIds.length, cancelled: false };
        const finished = f.store.finishHarnessToolExecution({ executionId: execution.id, expectedRevision: started.value.revision,
          sourceFence: fence, claimOwner: "multibranch-fixture", claimToken: toolCallId, nextState: "succeeded",
          resultDigest: digestHarnessToolValue(summary), resultSummary: summary, evidenceArtifactIds, now: now() });
        assert.equal(finished.ok, true, JSON.stringify(finished));
        const operation = f.store.settleHostOperation(ticket, { kind: "file_completed", settledAt: now() });
        assert.equal(operation.phase, "safe");
        f.store.appendEvent(run.id, "tool_end", { attemptId: fence.attemptId, toolCallId, toolName, isError: false, result: executorResult }, now());
        toolCallIds.push(toolCallId);
        const mutation = { path, content, artifact, execution: finished.value, operation };
        branch.mutations.push(mutation);
        t.mock.timers.tick(1);
        return mutation;
      };
      branch.complete = async () => {
        assert.ok(branch.mutations.length, "every branch supplies actual Host file mutation evidence");
        finish();
        await completion;
        assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_succeeded",
          actor: "runner", endedAt: now(), now: now() }).ok, true);
        assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded",
          actor: "runner", endedAt: now(), now: now() }).ok, true);
        assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", endedAt: now(), now: now() }));
        f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "succeeded", transitionedAt: now() },
          type: "work_unit_succeeded", actor: "runner", data: { runId: run.id } });
        f.store.releaseHostAttemptResources(branch.source, now());
        assert.equal(f.store.releaseResourceLease(branch.generation.owner.leaseId, "workflow_step", branch.scope.step.id, now()), 1);
      };
    };
    branch.capture = async () => {
      branch.result = await captureWorkflowIsolatedResult({ store: f.store, writer: branch.writer, isolation: f.isolation, now });
      assert.equal(branch.result.status, "sealed");
      return branch.result;
    };
    branch.intent = () => f.isolation.getTerminalResultIntent(branch.writer.bindingId);
    branch.finalize = async () => {
      const { finalizeOrchestratedWorkflowStepRun } = await import("../../dist/features/channels/orchestrator.js");
      const result = finalizeOrchestratedWorkflowStepRun(f.store, branch.scope.step.id, branch.generation.task.id, branch.run(), now());
      assert.equal(result?.status, "succeeded");
      f.completionOrder.push(branch.scope.step.id);
      t.mock.timers.tick(1);
      return result;
    };
  }
  f.finishBranch = async (index, mutation) => {
    const branch = f.branches[index];
    await branch.start();
    branch.mutate(mutation);
    await branch.complete();
    await branch.capture();
    await branch.finalize();
    return branch.result;
  };
  return f;
}
