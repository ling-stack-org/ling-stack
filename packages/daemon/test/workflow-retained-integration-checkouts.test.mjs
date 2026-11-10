import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore,
  toRuntimeAttemptFence, workflowIsolationDigest } from "@ling-stack/core";
import { schedulerFixture } from "./support/workflow-scheduler-fixture.mjs";

const dist = new URL("../dist/", import.meta.url);
if (process.env.LING_WORKFLOW_FENCE_TEST_SOURCE) {
  const modules = ["features/workspaces/workflow-repository-fence", "features/workspaces/workflow-retained-checkouts",
    "features/channels/workflow-isolation-planning"].map(name => [new URL(`${name}.js`, dist).href,
    new URL(`../src/${name}.ts`, import.meta.url).href]);
  const sources = new Map(modules), compiled = new Map(modules.map(([js, ts]) => [ts, js]));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = compiled.get(context.parentURL);
      const target = parent && specifier.startsWith(".") ? new URL(specifier, parent).href : specifier;
      if (sources.has(target)) return { url: sources.get(target), shortCircuit: true };
      const result = nextResolve(target, context);
      return sources.has(result.url) ? { url: sources.get(result.url), shortCircuit: true } : result;
    },
    load(url, context, nextLoad) {
      return compiled.has(url) ? { format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }) }
        : nextLoad(url, context);
    },
  });
}
const { planWorkflowIsolatedRound, readWorkflowIsolationWorktreeScope } = await import(new URL("features/channels/workflow-isolation-planning.js", dist));
const { prepareWorkflowIsolatedExecution } = await import(new URL("features/runs/workflow-isolation-execution.js", dist));
const { createWorkflowStepContextArtifact } = await import(new URL("features/channels/workflow-step-packets.js", dist));
const { captureWorkflowIsolatedResult } = await import(new URL("features/channels/workflow-isolated-result.js", dist));
const { coordinateWorkflowIntegration } = await import(new URL("features/channels/workflow-integration-coordinator.js", dist));
const { finalizeOrchestratedWorkflowStepRun } = await import(new URL("features/channels/orchestrator.js", dist));
const { reconcileWorkflowParallelParentFences } = await import(new URL("features/channels/workflow-isolation-parent-fence.js", dist));
const { WORKFLOW_CANDIDATE_VALIDATORS } = await import(new URL("features/channels/workflow-candidate-validation.js", dist));
const exec = promisify(execFile), native = { skip: !["darwin", "linux"].includes(process.platform) };
const now = () => new Date().toISOString();
const parallelExecution = { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" };

async function retiredIntegrationFixture(t, { cancelled = false } = {}) {
  const drains = [];
  t.after(async () => { for (const drain of drains) await drain(); });
  const f = await schedulerFixture(t, { cap: 2 });
  f.gitAt = async (cwd, ...args) => (await exec("/usr/bin/git", args, { cwd,
    env: { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid", GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  f.git = (...args) => f.gitAt(f.cwd, ...args);
  await f.git("init", "--initial-branch=main");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt");
  await f.git("commit", "-m", "retained integration basis");
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, writeLockScope: "boundPath" } }, now());
  const graph = { schemaVersion: 1, id: "retained-integration", name: "Retained integration", entryNodeId: "left",
    nodes: ["left", "right"].map(id => ({ id, kind: "step", name: id, prompt: "Inspect owned files",
      sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata, workflowGraph: graph,
    workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now());
  f.steps = ["left", "right"].map(title => f.step(title, { sideEffectClass: "workspace_write", requestedRunnerId: "pi",
    requiredTools: ["read", "write"], parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } }));
  const worktreeRoot = join(f.root, "retained-integration-worktrees");
  await mkdir(worktreeRoot);
  f.input = { store: f.store, workflowId: f.workflow.id, roundId: "retained-integration-round", worktreeRoot, parallelExecution,
    validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) };
  f.planned = await planWorkflowIsolatedRound(f.input);
  f.isolation = createSqliteWorkflowIsolationStore(f.store);
  f.coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  f.branches = [];
  for (const plan of f.planned.plans) {
    const step = f.store.getChannelWorkflowStep(plan.workflowStepId);
    const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
      resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.ok(lease);
    const begun = f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id, expected: step, leaseId: lease.id,
      admission: plan.resourcePlan, task: { channelId: f.channel.id, title: step.title, prompt: step.prompt,
        assigneeTeammateId: step.toParticipantId }, now: now() });
    assert.equal(begun.status, "begun", JSON.stringify(begun));
    const taskId = begun.task.id;
    assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "todo", event: "claim", actor: "system", now: now() }).ok, true);
    const task = f.store.getTask(taskId), pin = { planId: plan.planId, planDigest: plan.planDigest };
    const request = { cwd: plan.executionRoot, workflowStepId: step.id, workflowStartOwner: begun.owner, workflowIsolationPlan: pin };
    const run = f.store.createRun({ id: `retained-run-${step.id}`, cwd: plan.executionRoot, taskId, channelId: f.channel.id,
      workflowStepId: step.id, teammateId: step.toParticipantId, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: task, providerSnapshot: {}, requestSnapshot: request, createdAt: now() });
    const unit = f.store.createWorkUnit({ workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task", ownerId: taskId,
      taskId, channelId: f.channel.id, teammateId: step.toParticipantId, runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: `retained-unit-${step.id}`, createdByActor: "system", request, now: now() });
    f.store.linkRunToWorkUnit(run.id, unit.id, now());
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: `host-${step.id}`,
      runnerId: "pi", effectiveRunnerId: "pi", now: now() });
    const fence = toRuntimeAttemptFence(attempt), source = { runId: run.id, ...fence };
    const writer = { bindingId: workflowIsolationDigest(source, "wib_"), ...fence };
    const scope = await readWorkflowIsolationWorktreeScope(f.store, pin);
    await prepareWorkflowIsolatedExecution({ store: f.store, isolation: f.isolation, scope,
      binding: { bindingId: writer.bindingId, ...pin, startOwner: begun.owner, runId: run.id, fence }, now,
      prepareInput: async () => {
        const tools = ["read", "write"], input = { schemaVersion: 1, boundary: "pi-model-context", taskId,
          systemPrompt: "Retained checkout fixture", userPrompt: task.prompt, model: { id: "fixture", provider: "fixture" },
          thinkingLevel: "off", tools: tools.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })) };
        return { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
          input: { cwd: plan.executionRoot, task: { id: taskId, channelId: task.channelId, title: task.title, prompt: task.prompt },
            provider: { provider: "fixture", model: "fixture" }, tools },
          preparedInput: { ...input, fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex") } };
      } });
    assert.equal(f.store.transferChannelWorkflowStepStartAdmission({ workflowStepId: step.id, owner: begun.owner,
      runId: run.id, admission: plan.resourcePlan, ...fence, now: now(), expiresAt: lease.expiresAt }).status, "transferred");
    assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: step.id, owner: begun.owner, runId: run.id, now: now() }).status, "linked");
    const context = createWorkflowStepContextArtifact({ store: f.store, workflow: f.store.getChannelWorkflow(f.workflow.id),
      step: f.store.getChannelWorkflowStep(step.id), run: f.store.getRun(run.id),
      runRequest: { cwd: plan.executionRoot, task, runnerId: "pi" }, now: now() });
    const linked = f.store.getChannelWorkflowStep(step.id);
    f.store.updateChannelWorkflowStep(step.id, { metadata: { ...linked.metadata, contextArtifactId: context.id } }, now());
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
    assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: run.id, now: now() }).ok, true);
    let finish;
    // Actual no-tools Host lifetime; later dirty bytes are user WIP, not claimed SDK writes.
    const completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }), () => true);
    drains.push(async () => { finish(); await completion; });
    finish();
    await completion;
    assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_succeeded", actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded", actor: "runner", endedAt: now(), now: now() }).ok, true);
    const endedAt = now();
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", endedAt, now: endedAt }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "succeeded", transitionedAt: endedAt },
      type: "work_unit_succeeded", actor: "runner", data: { runId: run.id } });
    f.store.releaseHostAttemptResources(source, now());
    assert.equal(f.store.releaseResourceLease(lease.id, "workflow_step", step.id, now()), 1);
    const result = await captureWorkflowIsolatedResult({ store: f.store, isolation: f.isolation, writer, now });
    assert.equal(result.status, "sealed");
    assert.equal(finalizeOrchestratedWorkflowStepRun(f.store, step.id, taskId, f.store.getRun(run.id), now())?.status, "succeeded");
    f.branches.push({ plan, writer, source, result });
  }
  const coordinated = await coordinateWorkflowIntegration({ store: f.store, roundId: f.planned.round.roundId, now });
  assert.equal(coordinated.status, "awaiting_approval", JSON.stringify(coordinated));
  assert.ok(coordinated.round.candidate, "production coordinator creates and verifies a real candidate");
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
    event: cancelled ? "cancel" : "all_steps_succeeded", actor: "system", now: now() }).ok, true);
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  f.round = f.isolation.getIntegrationRound(f.planned.round.roundId);
  assert.equal(f.isolation.reconcileParallelParentFence({ roundId: f.round.roundId, generation: f.round.generation, now: now() }).status, "released");
  f.journal = () => ({ effects: f.coordinator.listEffects(f.round), receipts: f.coordinator.listReceipts(f.round) });
  f.creation = f.journal().effects.find(effect => effect.effectKey === "worktree:create");
  assert.equal(f.creation.kind, "integration_create");
  f.creationReceipt = f.journal().receipts.find(receipt => receipt.intentId === f.creation.intentId && receipt.outcome === "confirmed");
  assert.ok(f.creationReceipt);
  assert.equal(await f.gitAt(f.round.inputs.integration.executionRoot, "rev-parse", "HEAD"), f.round.inputs.baseCommit);
  assert.notEqual(f.round.candidate.commit, f.round.inputs.baseCommit, "merge-tree candidate is not the integration checkout HEAD");
  for (const root of [f.round.inputs.integration.executionRoot, ...f.branches.map(branch => branch.plan.executionRoot)]) {
    await writeFile(join(root, "owned.txt"), `retained dirty bytes at ${root}\n`);
  }
  f.successor = async () => {
    const metadata = f.store.getChannelWorkflow(f.workflow.id).metadata;
    const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Successor", objective: "Keep retired checkouts",
      status: "ready", createdBy: "local-user", metadata }, now());
    for (const step of f.steps) f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: step.title,
      prompt: step.prompt, position: step.position, toParticipantId: step.toParticipantId,
      toParticipantLabel: step.toParticipantLabel, metadata: step.metadata }, now());
    return planWorkflowIsolatedRound({ ...f.input, workflowId: workflow.id, roundId: "retained-integration-successor" });
  };
  f.snapshot = async () => ({ round: f.isolation.getIntegrationRound(f.round.roundId), journal: f.journal(),
    files: await Promise.all([f.cwd, f.round.inputs.integration.executionRoot, ...f.branches.map(branch => branch.plan.executionRoot)]
      .map(async root => ({ root, bytes: await readFile(join(root, "owned.txt")),
        head: await f.gitAt(root, "rev-parse", "HEAD"), status: await f.gitAt(root, "status", "--porcelain") }))),
    refs: await f.git("for-each-ref", "--format=%(refname) %(objectname)"), inventory: await f.git("worktree", "list", "--porcelain") });
  return f;
}

test("a successor keeps dirty branch and integration checkouts created by real capture and coordinator", native, async t => {
  const f = await retiredIntegrationFixture(t), before = await f.snapshot();
  assert.equal(f.coordinator.readPublicationBlocker(f.workflow.id), undefined);
  t.mock.method(f.coordinator, "assertAuthority", () => assert.fail("historical checkout ownership cannot restore publication authority"));
  const planned = await f.successor();
  assert.equal(planned.round.roundId, "retained-integration-successor");
  assert.deepEqual(await f.snapshot(), before, "successor planning never mutates retired files, refs, candidate or receipts");
});

for (const reason of ["cancelled", "policyRevoked"]) {
  test(`retained integration ownership survives ${reason} without renewed publication authority`, native, async t => {
    const f = await retiredIntegrationFixture(t, { cancelled: reason === "cancelled" });
    if (reason === "policyRevoked") f.store.updateChannel(f.channel.id, { allowedTools: ["read", "write"] }, now());
    assert.notEqual(f.coordinator.assertAuthority({ roundId: f.round.roundId, generation: f.round.generation, now: now() }).status, "authorized");
    const before = await f.snapshot();
    t.mock.method(f.coordinator, "assertAuthority", () => assert.fail("ownership is stopped-only, even for an old verified candidate"));
    assert.equal((await f.successor()).round.roundId, "retained-integration-successor");
    assert.deepEqual(await f.snapshot(), before);
  });
}

function replaceArtifact(f, id, mutate) {
  const row = f.store.database.prepare("SELECT sealed_payload_json,content_sha256 FROM artifacts WHERE id=?").get(id);
  const payload = JSON.parse(row.sealed_payload_json);
  mutate(payload);
  const json = JSON.stringify(payload);
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
    .run(json, createHash("sha256").update(json).digest("hex"), id);
  return () => f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
    .run(row.sealed_payload_json, row.content_sha256, id);
}

test("retired integration ownership rechecks immutable evidence, original drain and exact physical identity", native, async t => {
  const f = await retiredIntegrationFixture(t), root = f.round.inputs.integration.executionRoot;
  const bytes = await readFile(join(root, "owned.txt"));
  f.store.database.exec("DROP TRIGGER trg_workflow_isolation_intent_immutable");
  f.store.database.exec("DROP TRIGGER trg_workflow_isolation_receipts_immutable");
  f.store.database.exec("DROP TRIGGER host_attempt_completion_immutable_terminal");
  const faults = {
    missingCreationPayload() {
      const row = f.store.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(f.creation.payloadArtifactId);
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=NULL WHERE id=?").run(f.creation.payloadArtifactId);
      return () => f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(row.sealed_payload_json, f.creation.payloadArtifactId);
    },
    changedPayloadWithRehashedArtifact() {
      return replaceArtifact(f, f.creation.payloadArtifactId, payload => { payload.effect.scope.generation++; });
    },
    missingReceiptEvidence() {
      return replaceArtifact(f, f.creationReceipt.artifactId, payload => { delete payload.evidence.receipt; });
    },
    changedReceiptScope() {
      return replaceArtifact(f, f.creationReceipt.artifactId, payload => { payload.evidence.scope.executionRoot += "-foreign"; });
    },
    receiptHashMismatch() {
      const row = f.store.database.prepare("SELECT content_sha256 FROM artifacts WHERE id=?").get(f.creationReceipt.artifactId);
      f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("0".repeat(64), f.creationReceipt.artifactId);
      return () => f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run(row.content_sha256, f.creationReceipt.artifactId);
    },
    unconfirmedCreationReceipt() {
      f.store.database.prepare("UPDATE workflow_isolation_receipts SET outcome='effect_unknown' WHERE receipt_id=?").run(f.creationReceipt.receiptId);
      return () => f.store.database.prepare("UPDATE workflow_isolation_receipts SET outcome='confirmed' WHERE receipt_id=?").run(f.creationReceipt.receiptId);
    },
    unknownCoordinatorEffect() {
      const effect = f.journal().effects.find(effect => effect.effectKey === "candidate:verify");
      f.store.database.prepare("UPDATE workflow_isolation_intents SET status='effect_unknown' WHERE intent_id=?").run(effect.intentId);
      return () => f.store.database.prepare("UPDATE workflow_isolation_intents SET status='confirmed' WHERE intent_id=?").run(effect.intentId);
    },
    originalHostNoLongerDrained() {
      const id = f.branches[1].writer.attemptId;
      const row = f.store.database.prepare("SELECT drained_at FROM host_attempt_completions WHERE attempt_id=?").get(id);
      f.store.database.prepare("UPDATE host_attempt_completions SET drained_at=NULL WHERE attempt_id=?").run(id);
      return () => f.store.database.prepare("UPDATE host_attempt_completions SET drained_at=? WHERE attempt_id=?").run(row.drained_at, id);
    },
    workflowActiveAgain() {
      f.store.updateChannelWorkflow(f.workflow.id, { status: "running" }, now());
      return () => f.store.updateChannelWorkflow(f.workflow.id, { status: "succeeded" }, now());
    },
    async integrationHeadChanged() {
      const tree = await f.git("rev-parse", `${f.round.inputs.baseCommit}^{tree}`);
      const commit = await f.git("commit-tree", tree, "-p", f.round.inputs.baseCommit, "-m", "foreign integration head");
      await f.git("update-ref", f.round.inputs.integration.branchRef, commit);
      return () => f.git("update-ref", f.round.inputs.integration.branchRef, f.round.inputs.baseCommit);
    },
    async integrationBacklinkChanged() {
      const gitDir = await f.gitAt(root, "rev-parse", "--absolute-git-dir"), path = join(gitDir, "gitdir");
      const before = await readFile(path);
      await writeFile(path, `${root}-foreign/.git\n`);
      return () => writeFile(path, before);
    },
    async lockedIntegration() {
      await f.git("worktree", "lock", "--reason", "retained evidence", root);
      return () => f.git("worktree", "unlock", root);
    },
    async foreignAlongsideOwnedIntegration() {
      const path = join(f.root, "foreign-checkout");
      await f.git("worktree", "add", "-b", "foreign-retained", "--", path);
      return () => f.git("worktree", "remove", path);
    },
  };
  for (const [name, mutate] of Object.entries(faults)) {
    await t.test(name, async () => {
      const restore = await mutate();
      try {
        assert.equal(f.isolation.reconcileParallelParentFence({ roundId: f.round.roundId, generation: 1, now: now() }).status, "released",
          "cached retirement must not cover changed journal, drain or physical evidence");
        await assert.rejects(f.successor(), { code: "workflow_repository_checkouts_unsupported" });
        assert.equal(f.isolation.getIntegrationRound("retained-integration-successor"), undefined);
        assert.deepEqual(await readFile(join(root, "owned.txt")), bytes);
      } finally { await restore(); }
    });
  }
  assert.equal((await f.successor()).round.roundId, "retained-integration-successor", "all rejected reservations were compensated without claiming ownership");
  assert.deepEqual(await readFile(join(root, "owned.txt")), bytes);
});

test("a same-path replacement cannot reuse the real coordinator integration receipt", native, async t => {
  const f = await retiredIntegrationFixture(t), root = f.round.inputs.integration.executionRoot, moved = `${root}-preserved`;
  const bytes = await readFile(join(root, "owned.txt"));
  await rename(root, moved);
  await mkdir(root);
  await assert.rejects(f.successor(), { code: "workflow_repository_checkouts_unsupported" });
  assert.deepEqual(await readFile(join(moved, "owned.txt")), bytes);
});
