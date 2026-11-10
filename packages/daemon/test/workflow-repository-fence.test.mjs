import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, createSqliteWorkflowIsolationStore, normalizeWorkflowIntegrationRoundInputs,
  resolveStoragePaths, toRuntimeAttemptFence, workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint } from "@ling-stack/core";
import { schedulerFixture } from "./support/workflow-scheduler-fixture.mjs";

const exec = promisify(execFile), native = { skip: !["darwin", "linux"].includes(process.platform) };
const dist = process.env.LING_WORKFLOW_FENCE_TEST_DIST ? pathToFileURL(`${resolve(process.env.LING_WORKFLOW_FENCE_TEST_DIST)}/`)
  : new URL("../dist/", import.meta.url);
const sourceModules = ["features/workspaces/workflow-repository-fence", "features/workspaces/workflow-retained-checkouts",
  "features/channels/workflow-isolation-planning"]
  .map(name => [new URL(`${name}.js`, dist).href, new URL(`../src/${name}.ts`, import.meta.url).href]);

// Optional source-only verification while another test lane owns the shared dist tree.
function installSourceHooks(modules) {
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
if (process.env.LING_WORKFLOW_FENCE_TEST_SOURCE) installSourceHooks(sourceModules);
const { planWorkflowIsolatedRound, readWorkflowIsolationWorktreeScope } = await import(new URL("features/channels/workflow-isolation-planning.js", dist));
const { reconcileWorkflowParallelParentFences } = await import(new URL("features/channels/workflow-isolation-parent-fence.js", dist));
const { prepareRunConcurrency } = await import(new URL("features/runs/concurrency.js", dist));
const { releaseWorkflowRepositoryFence } = await import(new URL("features/workspaces/workflow-repository-fence.js", dist));
const { inspectWorkflowGitRepository, workflowGitRepositoryBasisDigest } = await import(new URL("features/workspaces/workflow-git-repository.js", dist));
const { ensureWorkflowIsolationWorktree } = await import(new URL("features/runs/workflow-isolation-execution.js", dist));
const parallelExecution = { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" };
const now = () => new Date().toISOString();

async function fixture(t) {
  const f = await schedulerFixture(t, { cap: 2 });
  f.gitAt = async (cwd, args) => (await exec("/usr/bin/git", args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: f.root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  f.git = (...args) => f.gitAt(f.cwd, args);
  await f.git("init", "--initial-branch=main");
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await f.git("add", "--", ".gitignore", "owned.txt");
  await f.git("commit", "-m", "initial");
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, writeLockScope: "boundPath" } }, now());
  const graph = { schemaVersion: 1, id: "repository-fence", name: "Repository fence", entryNodeId: "left",
    nodes: ["left", "right"].map(id => ({ id, kind: "step", name: id, prompt: "Write an owned file",
      sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata, workflowGraph: graph,
    workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now());
  f.steps = ["left", "right"].map(title => f.step(title, { sideEffectClass: "workspace_write", requestedRunnerId: "pi",
    requiredTools: ["read", "write"], parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } }));
  f.worktreeRoot = join(f.root, "isolated-worktrees");
  await mkdir(f.worktreeRoot);
  f.input = { store: f.store, workflowId: f.workflow.id, roundId: "repository-round", worktreeRoot: f.worktreeRoot,
    validationRequirements: [{ id: "static", fingerprint: "fixture-v1" }], parallelExecution };
  f.checkout = async () => {
    const cwd = join(f.root, "other-checkout");
    await f.git("worktree", "add", "-b", "other", "--", cwd);
    const paths = resolveStoragePaths(cwd, { homeDir: join(f.root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
    const store = createSqliteRunStore(cwd, paths);
    t.after(() => store.close());
    return { cwd, paths, store };
  };
  let sequence = 0;
  f.ordinary = (scope = f) => {
    sequence++;
    const workUnit = scope.store.createWorkUnit({ kind: "task_run", workspaceId: f.channel.workspaceId, ownerType: "task",
      ownerId: "ordinary-task", taskId: "ordinary-task", runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: `ordinary-repository-run-${sequence}`, createdByActor: "local-user", request: {}, now: now() });
    const attempt = scope.store.createWorkUnitAttempt({ workUnitId: workUnit.id, attemptNumber: 1,
      runtimeInstanceId: "repository-fixture", runnerId: "pi", effectiveRunnerId: "pi", now: now() });
    return { store: scope.store, runRequest: { cwd: scope.cwd, tools: ["write"], task: { id: "ordinary-task", title: "Write", prompt: "Write" } },
      runId: `ordinary-${workUnit.id}`, workUnit, attempt, now: now() };
  };
  return f;
}

async function roundInputs(f) {
  const repository = await inspectWorkflowGitRepository(f.cwd, { hostStateRoot: f.paths.rootDir });
  const safetyPins = f.steps.map(step => ({ workflowStepId: step.id, fingerprint: workflowIsolationStepSafetyFingerprint(step) }));
  const inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: f.workflow.id,
    canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: repository.root,
    repositoryIdentity: { commonDir: repository.commonDir, objectFormat: repository.head.length === 40 ? "sha1" : "sha256" },
    target: { executionRoot: repository.root, worktreeId: "target", branchRef: repository.branchRef, expectedHead: repository.head,
      cleanStateDigest: workflowGitRepositoryBasisDigest(repository), inputMode: "clean_checkout" }, baseCommit: repository.head,
    integration: { executionRoot: join(f.worktreeRoot, "integration"), worktreeId: "integration", branchRef: "refs/heads/ling/integration" },
    graphFingerprint: f.store.getChannelWorkflow(f.workflow.id).metadata.workflowGraphFingerprint,
    safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), templatePins: [],
    participants: f.steps.map(step => ({ workflowStepId: step.id, position: step.position, required: true })),
    mergeOrder: f.steps.map(step => step.id), optionalFailurePolicy: "require_success",
    validationRequirements: f.input.validationRequirements, mode: "candidate_only", parallelExecution });
  assert.ok(inputs);
  return inputs;
}

function fenceSnapshot(f) {
  const database = new DatabaseSync(join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite"), { readOnly: true });
  try { return { fence: database.prepare("SELECT owner_json,state FROM repository_fence").get(),
    stores: database.prepare("SELECT database_path,identity_json FROM repository_stores ORDER BY database_path").all() }; }
  finally { database.close(); }
}

async function retiredCheckoutFixture(t, { outcome = "failed" } = {}) {
  assert.ok(["failed", "cancelled"].includes(outcome));
  const cancelled = outcome === "cancelled";
  let finish = () => {}, completion = Promise.resolve();
  t.after(async () => { finish(); await completion; });
  const f = await fixture(t), planned = await planWorkflowIsolatedRound(f.input);
  const isolation = createSqliteWorkflowIsolationStore(f.store), plan = planned.plans[0];
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
  const run = f.store.createRun({ id: "retained-run", cwd: plan.executionRoot, taskId, channelId: f.channel.id,
    workflowStepId: step.id, teammateId: step.toParticipantId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: request, createdAt: now() });
  const unit = f.store.createWorkUnit({ id: "retained-unit", workspaceId: f.channel.workspaceId, kind: "task_run",
    ownerType: "task", ownerId: taskId, taskId, channelId: f.channel.id, teammateId: step.toParticipantId,
    runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: "retained-unit", createdByActor: "system", request, now: now() });
  f.store.linkRunToWorkUnit(run.id, unit.id, now());
  const attempt = f.store.createWorkUnitAttempt({ id: "retained-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "retained-host", runnerId: "pi", effectiveRunnerId: "pi", now: now() });
  const fence = toRuntimeAttemptFence(attempt), source = { runId: run.id, ...fence };
  const writer = { bindingId: "retained-binding", ...fence };
  const scope = await readWorkflowIsolationWorktreeScope(f.store, pin);
  const execution = await ensureWorkflowIsolationWorktree({ store: f.store, isolation, scope,
    binding: { bindingId: writer.bindingId, ...pin, startOwner: begun.owner, runId: run.id, fence }, now });
  assert.equal(f.store.transferChannelWorkflowStepStartAdmission({ workflowStepId: step.id, owner: begun.owner,
    runId: run.id, admission: plan.resourcePlan, ...fence, now: now(), expiresAt: lease.expiresAt }).status, "transferred");
  assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: step.id, owner: begun.owner,
    runId: run.id, now: now() }).status, "linked");
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "claimed", event: "start_run", actor: "system",
    currentRunId: run.id, now: now() }).ok, true);
  // An actual original Host lifetime with no SDK tools; dirty bytes below are retained user WIP.
  completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }), () => true);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: cancelled ? "cancel" : "runner_failed",
    actor: "runner", endedAt: now(), now: now() }).ok, true);
  if (cancelled) assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "cancel",
    actor: "system", now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: cancelled ? "cancelling" : "running", event: `runner_${outcome}`,
    actor: "runner", endedAt: now(), now: now() }).ok, true);
  const endedAt = now();
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt,
    ...(cancelled ? { abortRequestedAt: endedAt } : {}), now: endedAt }));
  f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: endedAt },
    type: `work_unit_${outcome}`, actor: "runner", data: { runId: run.id } });
  finish();
  await completion;
  assert.equal(f.store.getHostAttemptCompletion(source).effectCoverage, "pi_no_tools_v1");
  f.store.releaseHostAttemptResources(source, now());
  assert.equal(f.store.releaseResourceLease(lease.id, "workflow_step", step.id, now()), 1);
  assert.equal(f.store.transitionTaskStatus({ taskId, expectedStatus: "running", event: `run_${outcome}`, actor: "system", now: now() }).ok, true);
  assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus: "running",
    event: cancelled ? "cancel" : "fail", actor: "system", now: now() }).ok, true);
  for (const sibling of f.steps.slice(1)) assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: sibling.id,
    expectedStatus: "queued", event: cancelled ? "cancel" : "skip", actor: "system", now: now() }).ok, true);
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
    event: cancelled ? "cancel" : "step_failed", actor: "system", now: now() }).ok, true);
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  assert.equal(fenceSnapshot(f).fence.state, "released");
  assert.equal(isolation.reconcileParallelParentFence({ roundId: planned.round.roundId, generation: 1, now: now() }).status, "released");
  await writeFile(join(plan.executionRoot, "owned.txt"), "retained dirty user result\n");
  f.successorInput = name => {
    const metadata = f.store.getChannelWorkflow(f.workflow.id).metadata;
    const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: name, objective: "Successor ownership",
      status: "ready", createdBy: "local-user", metadata }, now());
    for (const original of f.steps) f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: original.title,
      prompt: original.prompt, position: original.position, toParticipantId: original.toParticipantId,
      toParticipantLabel: original.toParticipantLabel, metadata: original.metadata }, now());
    return { ...f.input, workflowId: workflow.id, roundId: name };
  };
  return { ...f, isolation, planned, plan, execution, run, unit, attempt, writer, source, lease };
}

const workerSource = `
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
const input = JSON.parse(process.argv[1]);
if (input.source) (${installSourceHooks.toString()})(input.sourceModules);
const originalExec = DatabaseSync.prototype.exec;
let reservationCommitted = false;
DatabaseSync.prototype.exec = function (sql) {
  const file = this.prepare("PRAGMA database_list").get().file;
  const result = originalExec.call(this, sql);
  if (file === input.fencePath && sql === "COMMIT") reservationCommitted = true;
  return result;
};
const actual = childProcess.execFile;
let inventoryCalls = 0, paused = false;
function execFile(...args) {
  const callback = args.pop();
  return actual(...args, (error, stdout, stderr) => {
    if (!args[1].includes("worktree") || !args[1].includes("--porcelain") || !reservationCommitted) {
      return callback(error, stdout, stderr);
    }
    inventoryCalls++;
    if (!input.barrier || paused) return callback(error, stdout, stderr);
    paused = true;
    process.once("message", action => callback(action.fail ? Object.assign(new Error("inventory barrier failed"),
      { code: "fixture_inventory_failed" }) : error, stdout, stderr));
    process.send({ type: "inventory", stdout: stdout.toString("utf8"), inventoryCalls });
  });
}
execFile[promisify.custom] = (...args) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  promise.child = child;
  return promise;
};
childProcess.execFile = execFile;
syncBuiltinESMExports();
const { createSqliteRunStore } = await import(input.core);
const fence = await import(input.fence);
const store = createSqliteRunStore(input.cwd, input.paths);
try {
  let token;
  if (input.action === "release") fence.releaseWorkflowRepositoryFence(store, input.roundId, 1, input.inputs, undefined, input.token);
  else if (input.action === "plan") {
    const { planWorkflowIsolatedRound } = await import(input.planner);
    const result = await planWorkflowIsolatedRound({ ...input.planInput, store });
    token = result.round.roundId;
  } else token = await fence.reserveWorkflowRepositoryFence(store, input.roundId, input.inputs);
  process.send({ type: "result", token: token ?? null, inventoryCalls });
} catch (error) { process.send({ type: "error", code: error.code, message: error.message, inventoryCalls }); }
finally { store.close(); process.disconnect(); }
`;

function fenceWorker(t, f, options) {
  const { store: _, ...planInput } = f.input;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource, JSON.stringify({
    cwd: f.cwd, paths: f.paths, roundId: f.input.roundId, planInput,
    fencePath: join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite"),
    core: import.meta.resolve("@ling-stack/core"), fence: new URL("features/workspaces/workflow-repository-fence.js", dist).href,
    planner: new URL("features/channels/workflow-isolation-planning.js", dist).href,
    source: !!process.env.LING_WORKFLOW_FENCE_TEST_SOURCE, sourceModules, ...options,
  })], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [], waiters = [];
  let stderr = "", ended;
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  child.on("message", message => waiters.length ? waiters.shift().resolve(message) : messages.push(message));
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    ended = new Error(`Fence worker exited (${code ?? signal}): ${stderr}`);
    for (const waiter of waiters.splice(0)) waiter.reject(ended);
    resolve({ code, signal });
  }));
  child.on("error", error => { ended = error; for (const waiter of waiters.splice(0)) waiter.reject(error); });
  t.after(async () => { if (!ended) child.kill(); await exited; });
  return { next() {
    if (messages.length) return Promise.resolve(messages.shift());
    if (ended) return Promise.reject(ended);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }, resume(fail = false) { child.send({ fail }); }, async done() {
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  } };
}

test("native temp Git inventory accepts one canonical checkout, then rejects a second channel checkout", native, async t => {
  const f = await fixture(t);
  const canonicalTemp = await realpath(tmpdir());
  assert.ok(f.root.startsWith(`${canonicalTemp}/`));
  const roots = async () => (await f.git("worktree", "list", "--porcelain", "-z"))
    .split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
  assert.deepEqual(await roots(), [f.cwd], "native Git reports the exact canonical temp path");
  const planned = await planWorkflowIsolatedRound(f.input);
  for (const step of f.steps) f.store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now());
  f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, now());
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  assert.equal(fenceSnapshot(f).fence.state, "released");
  const checkout = join(f.paths.worktreesDir, "channels", f.channel.id);
  await f.git("worktree", "add", "-b", "channel-linked", "--", checkout);
  assert.deepEqual(await roots(), [f.cwd, checkout]);
  const worker = fenceWorker(t, f, { inputs: planned.round.inputs, roundId: "native-after-linked" });
  assert.deepEqual(await worker.next(), { type: "error", code: "workflow_repository_checkouts_unsupported",
    message: "This isolated parallel profile requires a repository without other checkouts.", inventoryCalls: 1 });
  await worker.done();
  assert.equal(fenceSnapshot(f).fence.state, "released", "rejecting a real second checkout releases the unused reservation");
});

test("a successor parallel plan preserves a drained same-Store owned dirty checkout", native, async t => {
  const f = await retiredCheckoutFixture(t), before = await readFile(join(f.plan.executionRoot, "owned.txt"));
  const creation = f.isolation.getReceipt(f.execution.binding.creationReceiptId);
  const successor = await planWorkflowIsolatedRound(f.successorInput("retained-successor"));
  assert.equal(successor.round.roundId, "retained-successor");
  assert.deepEqual(await readFile(join(f.plan.executionRoot, "owned.txt")), before);
  assert.equal(await f.gitAt(f.plan.executionRoot, ["status", "--porcelain"]), "M owned.txt");
  assert.deepEqual(f.isolation.getReceipt(creation.receiptId), creation, "planning never rewrites the old creation journal");
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId), undefined, "retirement does not require publishing a failed result");
});

for (const reason of ["cancelled", "policyRevoked"]) {
  test(`a successor parallel plan preserves dirty checkout bytes after ${reason}`, native, async t => {
    const f = await retiredCheckoutFixture(t, { outcome: reason === "cancelled" ? "cancelled" : "failed" });
    if (reason === "policyRevoked") f.store.updateChannel(f.channel.id, { allowedTools: ["read", "write"] }, now());
    const before = await readFile(join(f.plan.executionRoot, "owned.txt")), binding = f.isolation.getExecutionBinding(f.writer.bindingId);
    const creation = f.isolation.getReceipt(binding.creationReceiptId);
    assert.notEqual(f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: binding.revision, now: now() }).status,
      "authorized", "stopped ownership does not restore result publication authority");
    assert.equal(f.isolation.inspectStoppedExecution({ writer: f.writer, expectedRevision: binding.revision, now: now() }).status, "stopped");
    const successor = await planWorkflowIsolatedRound(f.successorInput(`retained-${reason}`));
    assert.equal(successor.round.roundId, `retained-${reason}`);
    assert.deepEqual(await readFile(join(f.plan.executionRoot, "owned.txt")), before);
    assert.equal(await f.gitAt(f.plan.executionRoot, ["status", "--porcelain"]), "M owned.txt");
    assert.deepEqual(f.isolation.getReceipt(creation.receiptId), creation);
    assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId), undefined);
  });
}

function rewriteRetainedArtifact(f, mutate) {
  const creation = f.isolation.getReceipt(f.execution.binding.creationReceiptId);
  const payload = structuredClone(f.store.getArtifact(creation.artifactId).sealedPayload);
  mutate(payload);
  const json = JSON.stringify(payload), hash = createHash("sha256").update(json).digest("hex");
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
    .run(json, hash, creation.artifactId);
}

const retiredFaults = {
  workflowStillRunning: f => f.store.updateChannelWorkflow(f.workflow.id, { status: "running" }, now()),
  stepStillRunning: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { status: "running" }, now()),
  newStartOwner: f => {
    const step = f.store.getChannelWorkflowStep(f.plan.workflowStepId);
    f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata,
      startOwner: { ...step.metadata.startOwner, taskId: "different-start-task" } } }, now());
  },
  newAttempt: f => f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-host", runnerId: "pi", effectiveRunnerId: "pi", now: now() }),
  newStartLease: f => assert.ok(f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
    resourceKey: f.plan.workflowStepId, ownerType: "workflow_step", ownerId: f.plan.workflowStepId,
    acquiredAt: now(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
  expiredButUnreleasedLease: f => f.store.database.prepare("UPDATE resource_leases SET status='active',released_at=NULL,expires_at=? WHERE id=?")
    .run(new Date(Date.now() - 1000).toISOString(), f.lease.id),
  undrainedHost: f => {
    f.store.database.exec("DROP TRIGGER host_attempt_completion_immutable_terminal");
    f.store.database.prepare("UPDATE host_attempt_completions SET drained_at=NULL WHERE attempt_id=?").run(f.attempt.id);
  },
  missingEffectCoverage: f => {
    f.store.database.exec("DROP TRIGGER host_attempt_completion_immutable_terminal");
    f.store.database.prepare("UPDATE host_attempt_completions SET effect_coverage='unverified' WHERE attempt_id=?").run(f.attempt.id);
  },
  pendingGitIntent: f => {
    f.store.database.exec("DROP TRIGGER trg_workflow_isolation_intent_immutable");
    f.store.database.prepare("UPDATE workflow_isolation_intents SET status='pending' WHERE writer_binding_id=?").run(f.writer.bindingId);
  },
  unknownGitIntent: f => {
    f.store.database.exec("DROP TRIGGER trg_workflow_isolation_intent_immutable");
    f.store.database.prepare("UPDATE workflow_isolation_intents SET status='effect_unknown' WHERE writer_binding_id=?").run(f.writer.bindingId);
  },
  unverifiedCleanupJournal: f => {
    const creation = f.isolation.getReceipt(f.execution.binding.creationReceiptId), artifact = f.store.getArtifact(creation.artifactId);
    f.store.database.prepare(`INSERT INTO workflow_worktree_cleanup_intents(cleanup_id,round_id,generation,workflow_id,
      worktree_id,owner_token,plan_artifact_id,plan_content_sha256,plan_digest,retained_artifacts_json,intent_digest,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("unverified-cleanup", f.planned.round.roundId, 1, f.workflow.id,
        f.plan.worktreeId, "unverified-cleanup-owner", artifact.id, artifact.contentSha256,
        "unverified-cleanup-plan", "[]", "unverified-cleanup-intent", now());
  },
  incompleteCreationReceipt: f => {
    f.store.database.exec("DROP TRIGGER trg_workflow_isolation_receipts_immutable");
    f.store.database.prepare("UPDATE workflow_isolation_receipts SET outcome='effect_unknown' WHERE receipt_id=?")
      .run(f.execution.binding.creationReceiptId);
  },
  missingRetainedCreationBody: f => {
    const receipt = f.isolation.getReceipt(f.execution.binding.creationReceiptId);
    f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=NULL WHERE id=?").run(receipt.artifactId);
  },
  receiptIdentityChanged: f => rewriteRetainedArtifact(f, payload => { payload.receipt.rootInode = "0"; }),
  scopePathChanged: f => rewriteRetainedArtifact(f, payload => { payload.scope.executionRoot = `${f.plan.executionRoot}-foreign`; }),
  runPinChanged: f => f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json='{}' WHERE id=?").run(f.run.id),
  sourcePlanChanged: f => {
    const step = f.store.getChannelWorkflowStep(f.plan.workflowStepId);
    f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata,
      isolationScopePlan: { planId: "foreign-plan", planDigest: f.plan.planDigest } } }, now());
  },
  refHeadChanged: async f => {
    const tree = await f.git("rev-parse", "HEAD^{tree}");
    const commit = await f.git("commit-tree", tree, "-p", f.plan.baseCommit, "-m", "foreign checkout head");
    await f.git("update-ref", f.plan.branchRef, commit);
  },
  branchChanged: async f => {
    await f.git("branch", "foreign-retained", f.plan.baseCommit);
    await f.gitAt(f.plan.executionRoot, ["symbolic-ref", "HEAD", "refs/heads/foreign-retained"]);
  },
  backlinkChanged: async f => {
    const gitDir = await f.gitAt(f.plan.executionRoot, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(join(gitDir, "gitdir"), `${f.plan.executionRoot}-foreign/.git\n`);
  },
  lockedCheckout: f => f.git("worktree", "lock", "--reason", "retain for inspection", f.plan.executionRoot),
  foreignAlongsideOwned: async f => { await f.checkout(); },
  retainedIntegrationCheckout: f => f.git("worktree", "add", "-b", "retained-integration", "--", f.planned.round.inputs.integration.executionRoot),
};
for (const [name, mutate] of Object.entries(retiredFaults)) {
  test(`a retired owned checkout remains fail-closed after ${name}`, native, async t => {
    const f = await retiredCheckoutFixture(t), bytes = await readFile(join(f.plan.executionRoot, "owned.txt"));
    await mutate(f);
    const input = f.successorInput(`reject-${name}`);
    // The Core release fact is intentionally still present: it must not hide later evidence drift.
    assert.equal(f.isolation.reconcileParallelParentFence({ roundId: f.planned.round.roundId, generation: 1, now: now() }).status, "released");
    await assert.rejects(planWorkflowIsolatedRound(input), { code: "workflow_repository_checkouts_unsupported" });
    assert.equal(f.isolation.getIntegrationRound(input.roundId), undefined);
    assert.equal(fenceSnapshot(f).fence.state, "released", "only this call's unused reservation is compensated");
    assert.deepEqual(await readFile(join(f.plan.executionRoot, "owned.txt")), bytes, "failed checkout bytes are never cleaned or rewritten");
  });
}

test("a same-path replacement cannot adopt a retired checkout's creation receipt", native, async t => {
  const f = await retiredCheckoutFixture(t), moved = `${f.plan.executionRoot}-kept`, bytes = await readFile(join(f.plan.executionRoot, "owned.txt"));
  await rename(f.plan.executionRoot, moved);
  await mkdir(f.plan.executionRoot);
  await assert.rejects(planWorkflowIsolatedRound(f.successorInput("replaced-root")), { code: "workflow_repository_checkouts_unsupported" });
  assert.deepEqual(await readFile(join(moved, "owned.txt")), bytes);
});

test("first BEGIN SQLITE_BUSY leaves an empty sidecar that the next ordinary Run initializes", native, async t => {
  const f = await fixture(t), input = f.ordinary(), path = join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite");
  const original = DatabaseSync.prototype.exec;
  let blocker, sqliteError, intercepted = false;
  const patch = t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
    if (sql === "BEGIN IMMEDIATE" && !intercepted) {
      intercepted = true;
      blocker = new DatabaseSync(path);
      original.call(blocker, "BEGIN IMMEDIATE");
    }
    try { return original.call(this, sql); }
    catch (error) { sqliteError = error; throw error; }
  });
  try {
    assert.throws(() => prepareRunConcurrency(input), { code: "workflow_repository_busy", statusCode: 409 });
    assert.equal(intercepted, true);
    assert.equal(sqliteError?.code, "ERR_SQLITE_ERROR");
    assert.equal(sqliteError.errcode, 5);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  } finally { patch.mock.restore(); if (blocker) { blocker.exec("ROLLBACK"); blocker.close(); } }
  const empty = new DatabaseSync(path);
  try {
    assert.equal(empty.prepare("PRAGMA user_version").get().user_version, 0);
    assert.deepEqual(empty.prepare("SELECT * FROM sqlite_schema").all(), []);
  } finally { empty.close(); }
  assert.equal(prepareRunConcurrency(input).leases.length, 1);
  assert.equal(fenceSnapshot(f).stores.length, 1);
});

for (const kind of ["table", "view", "application id"]) {
  test(`unknown version-zero sidecar with ${kind} is never initialized`, native, async t => {
    const f = await fixture(t), input = f.ordinary();
    const database = new DatabaseSync(join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite"));
    try {
      database.exec(kind === "table" ? "CREATE TABLE unrelated(marker TEXT); INSERT INTO unrelated VALUES('retain');"
        : kind === "view" ? "CREATE VIEW unrelated AS SELECT 'retain' AS marker;" : "PRAGMA application_id=73;");
      const schema = database.prepare("SELECT * FROM sqlite_schema").all();
      assert.throws(() => prepareRunConcurrency(input), { code: "workflow_repository_fence_unknown" });
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
      assert.deepEqual(database.prepare("SELECT * FROM sqlite_schema").all(), schema);
      if (kind === "application id") assert.equal(database.prepare("PRAGMA application_id").get().application_id, 73);
      else assert.equal(database.prepare("SELECT marker FROM unrelated").get().marker, "retain");
      assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
    } finally { database.close(); }
  });
}

test("cross-process same-round reservations and stale compensation cannot release the winner", native, async t => {
  const f = await fixture(t), inputs = await roundInputs(f);
  const first = fenceWorker(t, f, { inputs, barrier: true });
  assert.equal((await first.next()).type, "inventory");
  const prior = fenceSnapshot(f), oldToken = JSON.parse(prior.fence.owner_json).reservationToken;
  assert.equal(typeof oldToken, "string");
  const duplicate = fenceWorker(t, f, { inputs, barrier: true });
  assert.deepEqual(await duplicate.next(), { type: "error", code: "workflow_repository_busy",
    message: "This repository is reserved by an isolated workflow round.", inventoryCalls: 0 });
  await duplicate.done();
  assert.deepEqual(fenceSnapshot(f), prior, "same owner does not gain another in-flight compensation authority");

  const foreignPaths = resolveStoragePaths(f.cwd, { homeDir: join(f.root, "foreign-reservation-home"), env: {},
    workspaceStateLocation: "user-data-dir" }).workspace;
  const foreign = createSqliteRunStore(f.cwd, foreignPaths);
  foreign.close();
  const otherDb = fenceWorker(t, f, { inputs, paths: foreignPaths, barrier: true });
  assert.equal((await otherDb.next()).code, "workflow_repository_busy");
  await otherDb.done();
  assert.deepEqual(fenceSnapshot(f), prior, "rejected foreign DB cannot pollute the Store registry");
  first.resume(true);
  assert.equal((await first.next()).code, "fixture_inventory_failed");
  await first.done();
  assert.equal(fenceSnapshot(f).fence.state, "released");

  const winner = fenceWorker(t, f, { inputs, barrier: true });
  assert.equal((await winner.next()).type, "inventory");
  const held = fenceSnapshot(f), token = JSON.parse(held.fence.owner_json).reservationToken;
  assert.notEqual(token, oldToken);
  for (const staleToken of [oldToken, undefined]) {
    const stale = fenceWorker(t, f, { action: "release", inputs, token: staleToken });
    assert.equal((await stale.next()).type, "result");
    await stale.done();
    assert.deepEqual(fenceSnapshot(f), held);
    assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_busy" });
  }
  winner.resume();
  assert.deepEqual(await winner.next(), { type: "result", token, inventoryCalls: 1 });
  await winner.done();
  releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, inputs, undefined, token);
  assert.equal(fenceSnapshot(f).fence.state, "released");
  assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1);
});

test("a rejected concurrent planner cannot compensate another process's pending same round", native, async t => {
  const f = await fixture(t), first = fenceWorker(t, f, { action: "plan", barrier: true });
  assert.equal((await first.next()).type, "inventory");
  const held = fenceSnapshot(f);
  assert.equal(held.fence.state, "held");
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  const duplicate = fenceWorker(t, f, { action: "plan", barrier: true });
  assert.equal((await duplicate.next()).code, "workflow_repository_busy");
  await duplicate.done();
  assert.deepEqual(fenceSnapshot(f), held);
  assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_busy" });
  first.resume();
  assert.equal((await first.next()).token, f.input.roundId);
  await first.done();
  const isolation = createSqliteWorkflowIsolationStore(f.store), round = isolation.getIntegrationRound(f.input.roundId);
  assert.ok(round);
  assert.deepEqual(fenceSnapshot(f), held);
  const recovered = fenceWorker(t, f, { inputs: round.inputs, barrier: true });
  assert.deepEqual(await recovered.next(), { type: "result", token: null, inventoryCalls: 0 });
  await recovered.done();
  releaseWorkflowRepositoryFence(f.store, round.roundId, 1, round.inputs);
  assert.deepEqual(fenceSnapshot(f), held, "Core retains active durable rounds even for tokenless reconciliation");
});

test("durable legacy rounds recover without a token but still validate the registered database identity", native, async t => {
  const f = await fixture(t), planned = await planWorkflowIsolatedRound(f.input);
  const path = join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite"), snapshot = fenceSnapshot(f);
  const owner = JSON.parse(snapshot.fence.owner_json);
  delete owner.reservationToken;
  const database = new DatabaseSync(path);
  try { database.prepare("UPDATE repository_fence SET owner_json=?").run(JSON.stringify(owner)); }
  finally { database.close(); }
  const legacy = fenceSnapshot(f);
  const recovered = fenceWorker(t, f, { inputs: planned.round.inputs, barrier: true });
  assert.deepEqual(await recovered.next(), { type: "result", token: null, inventoryCalls: 0 });
  await recovered.done();
  assert.deepEqual(fenceSnapshot(f), legacy);
  const originalIdentity = legacy.stores[0].identity_json, replacedIdentity = JSON.parse(originalIdentity);
  replacedIdentity.databaseInode = String(BigInt(replacedIdentity.databaseInode) + 1n);
  const altered = new DatabaseSync(path);
  try { altered.prepare("UPDATE repository_stores SET identity_json=?").run(JSON.stringify(replacedIdentity)); }
  finally { altered.close(); }
  const invalid = fenceSnapshot(f), refused = fenceWorker(t, f, { inputs: planned.round.inputs, barrier: true });
  assert.equal((await refused.next()).code, "workflow_repository_fence_unknown");
  await refused.done();
  assert.deepEqual(fenceSnapshot(f), invalid, "durable duplicates cannot bypass Store inode validation");
  const restored = new DatabaseSync(path);
  try { restored.prepare("UPDATE repository_stores SET identity_json=?").run(originalIdentity); }
  finally { restored.close(); }
  for (const step of f.steps) f.store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now());
  f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, now());
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  assert.equal(fenceSnapshot(f).fence.state, "released");
  assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1);
});

test("parallel planning refuses an existing linked checkout with an independent active Store", native, async t => {
  const f = await fixture(t), sibling = await f.checkout();
  const input = f.ordinary(sibling), prepared = prepareRunConcurrency(input);
  assert.equal(prepared.leases.length, 1);
  await assert.rejects(planWorkflowIsolatedRound(f.input), { code: "workflow_repository_stores_unsupported" });
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  assert.equal(sibling.store.listResourceLeases({ status: "active" }).length, 1, "the sibling's original resource is untouched");
});

test("parallel planning refuses a linked checkout even before it starts a Run", native, async t => {
  const f = await fixture(t);
  await f.checkout();
  await assert.rejects(planWorkflowIsolatedRound(f.input), { code: "workflow_repository_checkouts_unsupported" });
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1, "failed planning releases only its unused reservation");
});

test("a checkout created after planning cannot start a Run through its independent Store", native, async t => {
  const f = await fixture(t);
  await planWorkflowIsolatedRound(f.input);
  const sibling = await f.checkout(), input = f.ordinary(sibling);
  assert.throws(() => prepareRunConcurrency(input), { code: "workflow_repository_busy" });
  assert.equal(sibling.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(sibling.store.listRuns().length, 0);
});

test("a different database on the same checkout cannot hide a prior Run from planning", native, async t => {
  const f = await fixture(t);
  const paths = resolveStoragePaths(f.cwd, { homeDir: join(f.root, "foreign-home"), env: {},
    workspaceStateLocation: "user-data-dir" }).workspace;
  const store = createSqliteRunStore(f.cwd, paths);
  t.after(() => store.close());
  const prepared = prepareRunConcurrency(f.ordinary({ store, cwd: f.cwd }));
  assert.equal(prepared.leases.length, 1);
  await assert.rejects(planWorkflowIsolatedRound(f.input), { code: "workflow_repository_stores_unsupported" });
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  assert.equal(store.listResourceLeases({ status: "active" }).length, 1);
});

test("ordinary Runs may use separate Stores when no isolated round owns the repository", native, async t => {
  const f = await fixture(t), sibling = await f.checkout();
  assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1);
  assert.equal(prepareRunConcurrency(f.ordinary(sibling)).leases.length, 1);
});

test("eight concurrent planners freeze exactly one repository parent", native, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    planWorkflowIsolatedRound({ ...f.input, roundId: `repository-round-${index}` })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 7);
  const winner = results.find(result => result.status === "fulfilled").value;
  for (const plan of winner.plans) assert.equal(f.store.getChannelWorkflowStep(plan.workflowStepId).metadata.isolationScopePlan.planId, plan.planId);
  assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_busy" });
});

test("a cancelled workflow does not release a parent while an actual resource remains active", native, async t => {
  const f = await fixture(t), planned = await planWorkflowIsolatedRound(f.input);
  for (const step of f.steps) f.store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now());
  f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, now());
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "task", resourceKey: "undrained",
    ownerType: "system", ownerId: "undrained", acquiredAt: now(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  assert.equal(createSqliteWorkflowIsolationStore(f.store).reconcileParallelParentFence({ roundId: planned.round.roundId,
    generation: 1, now: now() }).status, "retained");
  assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_busy" });
});

test("corrupt repository coordination metadata cannot authorize another Run", native, async t => {
  const f = await fixture(t), planned = await planWorkflowIsolatedRound(f.input);
  const database = new DatabaseSync(join(planned.round.inputs.repositoryIdentity.commonDir, "ling-workflow-repository-fence.sqlite"));
  try { database.exec("PRAGMA user_version=999"); } finally { database.close(); }
  assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_fence_unknown" });
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
});

for (const kind of ["step metadata", "channel policy", "added participant"]) {
  test(`planning revalidates ${kind} after reserving the repository`, native, async t => {
    const f = await fixture(t), isolation = createSqliteWorkflowIsolationStore(f.store);
    const original = isolation.getIntegrationRound;
    let intercepted = false;
    // Force the concurrent edit at the reserve/inventory boundary, after the earlier snapshot check.
    isolation.getIntegrationRound = function (...args) {
      if (!intercepted) {
        intercepted = true;
        if (kind === "step metadata") f.store.updateChannelWorkflowStep(f.steps[0].id,
          { metadata: { ...f.steps[0].metadata, requiredTools: ["bash"] } }, now());
        else if (kind === "channel policy") f.store.updateChannel(f.channel.id,
          { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 1 } }, now());
        else f.step("new participant", { sideEffectClass: "workspace_write", requestedRunnerId: "pi", requiredTools: ["write"] });
      }
      return original.apply(this, args);
    };
    t.after(() => { isolation.getIntegrationRound = original; });
    await assert.rejects(planWorkflowIsolatedRound(f.input), { code: "workflow_isolation_plan_unavailable" });
    assert.equal(intercepted, true);
    assert.equal(original.call(isolation, f.input.roundId), undefined);
    for (const step of f.steps) assert.equal(f.store.getChannelWorkflowStep(step.id).metadata.isolationScopePlan, undefined);
    if (kind === "step metadata") assert.deepEqual(f.store.getChannelWorkflowStep(f.steps[0].id).metadata.requiredTools, ["bash"]);
    assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1, "a rejected snapshot releases its unused reservation");
  });
}

test("reopening the same DB preserves the repository fence until cancellation is proven safe", native, async t => {
  const f = await fixture(t);
  const planned = await planWorkflowIsolatedRound(f.input);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd, f.paths);
  t.after(() => f.store.close());
  assert.throws(() => prepareRunConcurrency(f.ordinary()), { code: "workflow_repository_busy" });
  for (const step of f.steps) f.store.updateChannelWorkflowStep(step.id, { status: "cancelled" }, now());
  f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, now());
  reconcileWorkflowParallelParentFences(f.store, f.workflow.id);
  assert.equal(createSqliteWorkflowIsolationStore(f.store).reconcileParallelParentFence({ roundId: planned.round.roundId,
    generation: 1, now: now() }).status, "released");
  assert.equal(prepareRunConcurrency(f.ordinary()).leases.length, 1);
});
