import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, createSqliteWorkflowIsolationStore, normalizeWorkflowIntegrationRoundInputs,
  resolveStoragePaths, workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint } from "@ling-stack/core";
import { schedulerFixture } from "./support/workflow-scheduler-fixture.mjs";

const exec = promisify(execFile), native = { skip: !["darwin", "linux"].includes(process.platform) };
const dist = process.env.LING_WORKFLOW_FENCE_TEST_DIST ? pathToFileURL(`${resolve(process.env.LING_WORKFLOW_FENCE_TEST_DIST)}/`)
  : new URL("../dist/", import.meta.url);
const sourceModules = ["features/workspaces/workflow-repository-fence", "features/channels/workflow-isolation-planning"]
  .map(name => [new URL(`${name}.js`, dist).href, new URL(`../src/${name}.ts`, import.meta.url).href]);

// Optional source-only verification while another test lane owns the shared dist tree.
function installSourceHooks(modules) {
  const sources = new Map(modules), compiled = new Map(modules.map(([js, ts]) => [ts, js]));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = compiled.get(context.parentURL);
      const target = parent && specifier.startsWith(".") ? new URL(specifier, parent).href : specifier;
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
const { planWorkflowIsolatedRound } = await import(new URL("features/channels/workflow-isolation-planning.js", dist));
const { reconcileWorkflowParallelParentFences } = await import(new URL("features/channels/workflow-isolation-parent-fence.js", dist));
const { prepareRunConcurrency } = await import(new URL("features/runs/concurrency.js", dist));
const { releaseWorkflowRepositoryFence } = await import(new URL("features/workspaces/workflow-repository-fence.js", dist));
const { inspectWorkflowGitRepository, workflowGitRepositoryBasisDigest } = await import(new URL("features/workspaces/workflow-git-repository.js", dist));
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

const workerSource = `
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const input = JSON.parse(process.argv[1]);
if (input.source) (${installSourceHooks.toString()})(input.sourceModules);
const actual = childProcess.execFile;
let inventoryCalls = 0;
function execFile(...args) {
  const callback = args.pop();
  return actual(...args, (error, stdout, stderr) => {
    if (!args[1].includes("worktree") || !args[1].includes("--porcelain")) return callback(error, stdout, stderr);
    inventoryCalls++;
    if (!input.barrier) return callback(error, stdout, stderr);
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

test("first BEGIN SQLITE_BUSY leaves an empty sidecar that the next ordinary Run initializes", native, async t => {
  const f = await fixture(t), input = f.ordinary(), path = join(f.cwd, ".git", "ling-workflow-repository-fence.sqlite");
  const original = DatabaseSync.prototype.exec;
  let blocker, intercepted = false;
  const patch = t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
    if (sql === "BEGIN IMMEDIATE" && !intercepted) {
      intercepted = true;
      blocker = new DatabaseSync(path);
      original.call(blocker, "BEGIN IMMEDIATE");
    }
    return original.call(this, sql);
  });
  try {
    assert.throws(() => prepareRunConcurrency(input), error => error.code === "workflow_repository_fence_unknown"
      && error.cause?.code === "ERR_SQLITE_ERROR" && error.cause.errcode === 5);
    assert.equal(intercepted, true);
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
