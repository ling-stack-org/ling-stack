import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

// Authored by A31's source reviewer, not by its product implementer. These are
// separate entry-chain regressions; the original six process tests stay frozen.
const executeFile = promisify(execFile);
const rootPrefix = "ling-a31-registry-admission-";
const participantId = "teammate_builtin_engineer";
const observationPrefix = "A31_REGISTRY_OBSERVATION=";
const childProgram = String.raw`
  import childProcess from "node:child_process";
  import http from "node:http";
  import { syncBuiltinESMExports } from "node:module";
  const input = JSON.parse(process.argv[1]);
  const calls = { recoverRuns: 0, recoverWorkflows: 0, factory: 0, close: 0,
    listen: 0, externalProcess: 0, fetch: 0, runner: 0 };
  for (const name of ["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync"]) {
    childProcess[name] = () => { calls.externalProcess += 1; throw new Error("a31_registry_external_process_forbidden"); };
  }
  http.Server.prototype.listen = function() { calls.listen += 1; throw new Error("a31_registry_listener_forbidden"); };
  globalThis.fetch = async () => { calls.fetch += 1; throw new Error("a31_registry_fetch_forbidden"); };
  syncBuiltinESMExports();
  const core = await import(input.coreUrl);
  const { RunStoreRegistry } = await import(input.registryUrl);
  const { createDaemonServer } = await import(input.daemonUrl);
  const originalGet = RunStoreRegistry.prototype.getStore;
  let registry;
  RunStoreRegistry.prototype.getStore = function(...args) {
    registry = this;
    return originalGet.apply(this, args);
  };
  for (const [method, key] of [["recoverStaleRuns", "recoverRuns"], ["recoverStaleChannelWorkflows", "recoverWorkflows"], ["close", "close"]]) {
    const original = core.SqliteRunStore.prototype[method];
    core.SqliteRunStore.prototype[method] = function(...args) {
      if (this.paths.cwd === input.cwd) calls[key] += 1;
      return original.apply(this, args);
    };
  }
  const failure = error => ({ code: error?.code, message: String(error?.message ?? error) });
  const dependencies = {
    secretResolver: core.createCompositeSecretResolver({ env: {} }),
    chromeBrowserNativeMessagingEnabled: false,
    runner: { async runTask() { calls.runner += 1; throw new Error("a31_registry_runner_forbidden"); } },
    ...(input.mode === "custom" ? { storeFactory(cwd) {
      calls.factory += 1;
      return core.createSqliteRunStore(cwd, core.resolveStoragePaths(cwd).workspace);
    } } : {}),
  };
  let daemon;
  let initialError;
  try {
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: input.cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, dependencies);
  } catch (error) { initialError = failure(error); }
  const first = { error: initialError, cached: registry?.getInitializedStore(input.cwd) !== undefined, calls: { ...calls } };
  let retryError;
  if (input.mode === "custom" && registry) {
    try { registry.getStore(input.cwd); }
    catch (error) { retryError = failure(error); }
  }
  const observation = { constructed: Boolean(daemon), first, retryError,
    retryCached: registry?.getInitializedStore(input.cwd) !== undefined, calls };
  // No start(), listener or native/API operation. Exiting only this owned child
  // closes its test-only objects even when the old constructor leaked them.
  process.stdout.write(input.observationPrefix + JSON.stringify(observation) + "\n", () => process.exit(0));
`;

async function fixture(t) {
  const temporaryParent = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryParent, rootPrefix));
  const cwd = join(root, "workspace");
  const userRoot = join(root, "ling-home");
  const isolatedHome = join(root, "home");
  const temporary = join(root, "tmp");
  await Promise.all([mkdir(cwd), mkdir(isolatedHome), mkdir(temporary)]);
  const paths = resolveStoragePaths(cwd, { userRootDir: userRoot, workspaceStateLocation: "repo-local" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  const supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 17_031,
    defaultWorkspaceCwd: cwd, runners: {}, runtimeTools: {}, channels: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } });
  const runtime = supervisor.getRuntime(cwd, store);
  const database = new DatabaseSync(paths.databasePath);
  t.after(async () => {
    try { supervisor.releaseAll(); }
    finally {
      database.close(); store.close();
      assert.equal(dirname(root), temporaryParent);
      assert.ok(basename(root).startsWith(rootPrefix));
      await rm(root, { recursive: true, force: true });
    }
  });
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "A31 live owner", boundPath: cwd }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Live preparation",
    objective: "Preserve the original owner", status: "running", createdBy: "local-user" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Preparing in A",
    prompt: "Read only after the real Run is ready", toParticipantId: participantId, toParticipantLabel: "Engineer" }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id,
    acquiredAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const begun = store.beginChannelWorkflowStepStart({ workflowStepId: step.id, expected: step, leaseId: lease.id,
    task: { channelId: channel.id, title: "A31 preparing Task", prompt: "Read the owned input", assigneeTeammateId: participantId }, now });
  assert.equal(begun.status, "begun");
  const legacyTask = store.createTask({ channelId: channel.id, title: "A31 live legacy Task",
    prompt: "Preserve this active non-Harness Run", assigneeTeammateId: participantId }, now);
  const run = store.createRun({ id: "a31-registry-live-legacy-run", cwd, taskId: legacyTask.id, channelId: channel.id,
    teammateId: participantId, providerName: "a31-local-fixture", providerModel: "a31-local-fixture",
    taskSnapshot: legacyTask, providerSnapshot: {}, requestSnapshot: { cwd }, createdAt: now });
  store.markRunRunning(run.id, now);
  const tables = ["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "run_events",
    "work_units", "work_unit_attempts", "resource_leases", "state_transition_events"];
  return {
    store, step, lease, runtime,
    snapshot() { return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])); },
    lockBytes() { return readFile(join(paths.rootDir, "runtime.lock"), "utf8"); },
    async contender(mode) {
      const input = { cwd, mode, observationPrefix,
        coreUrl: new URL("../../core/dist/index.js", import.meta.url).href,
        registryUrl: new URL("../dist/runtime/store-registry.js", import.meta.url).href,
        daemonUrl: new URL("../dist/index.js", import.meta.url).href };
      const { stdout, stderr } = await executeFile(process.execPath,
        ["--input-type=module", "-e", childProgram, JSON.stringify(input)], {
          cwd, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
          env: { HOME: isolatedHome, USERPROFILE: isolatedHome, LOCALAPPDATA: isolatedHome,
            LING_STACK_HOME: userRoot, LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, TMPDIR: temporary },
        });
      const line = stdout.split("\n").find(entry => entry.startsWith(observationPrefix));
      assert.ok(line, `Owned child must return its actual observations: ${stderr}`);
      return JSON.parse(line.slice(observationPrefix.length));
    },
  };
}

function assertNoExternalEffects(observation) {
  for (const key of ["listen", "externalProcess", "fetch", "runner"]) assert.equal(observation.calls[key], 0, key);
}

test("A31 default daemon construction refuses a live owner before any registry recovery mutates its SQLite facts", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  const lock = await f.lockBytes();
  const observation = await f.contender("default");
  assertNoExternalEffects(observation);
  // Check real facts first: a later 409 alone cannot undo premature recovery.
  assert.deepEqual(f.snapshot(), before, "unowned construction must not fail A's Run or settle A's preparing Step/lease");
  assert.equal(await f.lockBytes(), lock);
  assert.equal(observation.first.error?.code, "runtime_already_running", JSON.stringify(observation));
  assert.equal(observation.constructed, false);
  assert.equal(observation.first.cached, false);
  assert.equal(observation.calls.recoverRuns, 0);
  assert.equal(observation.calls.recoverWorkflows, 0);
});

test("A31 injected factory owner refusal closes each uncached Store and retry cannot reuse failed initialization", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  const lock = await f.lockBytes();
  const observation = await f.contender("custom");
  assertNoExternalEffects(observation);
  assert.deepEqual(f.snapshot(), before, "custom factory must pass the same mandatory owner admission before recovery");
  assert.equal(await f.lockBytes(), lock);
  assert.equal(observation.first.error?.code, "runtime_already_running", JSON.stringify(observation));
  assert.equal(observation.first.cached, false);
  assert.equal(observation.first.calls.factory, 1);
  assert.equal(observation.first.calls.close, 1, "the first rejected, never-cached real Store must close");
  assert.equal(observation.retryError?.code, "runtime_already_running");
  assert.equal(observation.retryCached, false);
  assert.equal(observation.calls.factory, 2, "retry must construct a fresh Store instead of serving the rejected one");
  assert.equal(observation.calls.close, 2, "the retry's unowned Store must close too");
  assert.equal(observation.calls.recoverRuns, 0);
  assert.equal(observation.calls.recoverWorkflows, 0);
});
