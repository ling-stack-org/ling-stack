import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A30_ACTIVE_WRITER_CASE";
const modes = ["recent-running", "buried-terminal", "many-active", "nested-child", "other-cwd", "terminal",
  "terminal-live", "no-command-buried", "no-command-many", "yielded-no-command", "prepared-yield-rejected"];
const scenarios = ["capture-fence", ...["capture", "restore"].flatMap(kind => modes.map(mode => `${kind}:${mode}`))];
const active = new Set(["queued", "running", "waiting_for_approval"]);
const baselineBody = "A30 baseline workspace bytes\n";
const currentBody = "A30 current workspace bytes\n";

for (const scenario of scenarios) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(`A30 snapshot active-writer barrier: ${scenario}`, { timeout: 40_000 }, t =>
      process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-a30-active-writer-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), outside = join(root, "sibling");
  for (const path of [home, cwd, outside]) await fs.mkdir(path);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, LING_A30_SIBLING_CWD: outside, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A30 child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A30 case entered: ${scenario}`), "the real isolated fixture must enter");
    assert.ok(stdout.includes("A30 barrier observation:"), "fixture setup failure is not the target invariant");
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0, "only actual assertions and orderly owned-process cleanup are GREEN");
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a30-active-writer-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Actual SQLite, current Attempt, Host command journal and finite, owned OS writer. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  const outside = process.env.LING_A30_SIBLING_CWD;
  assert.ok(cwd && home && outside && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A30 case entered: ${scenario}`);
  const homePatch = t.mock.method(os, "homedir", () => home);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A30 snapshot fixture forbids network access"); };
  syncBuiltinESMExports();
  let store, observer, writer, hooks, captureOperation;
  try {
    const core = await import("../../core/dist/index.js");
    const snapshot = await import("../dist/features/runs/workspace-snapshot-restore.js");
    const processModule = await import("../dist/features/runs/unified-exec-process.js");
    store = core.createSqliteRunStore(cwd);
    observer = core.createSqliteRunStore(cwd);
    const nested = join(cwd, "nested");
    await fs.mkdir(nested);
    for (const path of [cwd, nested, outside]) await fs.writeFile(join(path, "project.txt"), baselineBody, { mode: 0o600 });
    const baseline = await snapshot.captureWorkspaceSnapshot(store, cwd);
    for (const path of [cwd, nested, outside]) await fs.writeFile(join(path, "project.txt"), currentBody);
    const anchor = await snapshot.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, baseline.manifest.id);
    const now = new Date().toISOString();
    const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: baseline.manifest.workspaceId,
      anchorId: anchor.id, snapshotId: baseline.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
    const restoreInput = { idempotencyKey: `a30-${scenario}`, anchorId: anchor.id,
      snapshotId: baseline.manifest.id, confirmationId: confirmation.id };
    if (scenario === "capture-fence") {
      hooks = observeSnapshotFs(t, cwd, store.paths.snapshotStagingDir, true);
      syncBuiltinESMExports();
      captureOperation = snapshot.captureWorkspaceSnapshot(store, cwd).then(value => ({ value }), error => ({ error }));
      await within(hooks.entered.promise, "the actual fenced capture scan");
      const fence = observer.getWorkspaceSnapshotFence(baseline.manifest.workspaceId);
      let denied;
      try { seedRun(observer, "a30-rejected-during-fence", cwd, 400); }
      catch (error) { denied = { code: error.code, message: error.message }; }
      const found = observer.getRun("a30-rejected-during-fence");
      console.log(`A30 barrier observation: ${JSON.stringify({ scenario, fence, denied, found: Boolean(found),
        rootScans: hooks.facts().rootScans })}`);
      hooks.release.resolve();
      const result = await within(captureOperation, "capture after releasing the owned scan");
      assert.ok(fence.ownerRequestId, "capture must own the real durable fence at the attempt");
      assert.match(denied?.message ?? "", /Workspace restore fence is active/u);
      assert.equal(found, undefined, "actual Run creation must roll back; a UI warning is insufficient");
      assert.equal(result.error, undefined);
      assert.equal(result.value.manifest.state, "committed");
      assert.equal(observer.getWorkspaceSnapshotFence(baseline.manifest.workspaceId).ownerRequestId, undefined);
      return;
    }
    const [kind, mode] = scenario.split(":");
    const runCwd = mode === "other-cwd" ? outside : mode === "nested-child" ? nested : cwd;
    const noCommand = ["no-command-buried", "no-command-many", "yielded-no-command"].includes(mode);
    writer = noCommand ? createRunWithoutCommand({ core, store, cwd: runCwd })
      : await startWriter({ core, processModule, store, cwd: runCwd });
    if (mode === "terminal") await writer.stop();
    if (mode === "terminal-live") store.markRunCancelled(writer.runId, new Date().toISOString());
    let yieldFact;
    if (mode === "yielded-no-command" || mode === "prepared-yield-rejected") {
      yieldFact = attemptCanonicalYield(store, writer);
      if (mode === "yielded-no-command") {
        assert.equal(yieldFact.error, undefined);
        assert.equal(yieldFact.result.wait.status, "waiting");
        assert.equal(store.getRun(writer.runId).status, "yielded");
        assert.equal(store.getWorkUnit(writer.sourceFence.workUnitId).activeAttemptId, undefined);
        assert.equal(store.getWorkUnitAttempt(writer.sourceFence.attemptId).status, "yielded");
      } else {
        assert.equal(yieldFact.error?.code, "not_quiescent", "a real prepared command vetoes canonical yield");
        assert.equal(yieldFact.result, undefined);
        assert.equal(store.getRun(writer.runId).status, "running");
        assert.equal(store.getUserInputWait(writer.threadId, yieldFact.requestId), undefined);
      }
    }
    const manyActive = mode === "many-active" || mode === "no-command-many";
    if (["buried-terminal", "many-active", "other-cwd", "terminal", "no-command-buried", "no-command-many"].includes(mode)) {
      for (let index = 0; index < 200; index++) {
        const tail = seedRun(store, `a30-tail-${index}`, manyActive ? outside : cwd, index + 1);
        if (!manyActive) {
          store.markRunStarted(tail.id, tail.createdAt);
          store.markRunSucceeded(tail.id, tail.createdAt);
        }
      }
      const recent = observer.listRuns({ limit: 200 });
      assert.equal(recent.length, 200);
      assert.equal(recent.some(run => run.id === writer.runId), false, "the authoritative old writer must really be outside latest-200");
      assert.equal(recent.every(run => manyActive ? run.status === "queued" : run.status === "succeeded"), true);
    }
    const activeCount = observer.database.prepare("SELECT COUNT(*) AS count FROM run_sessions WHERE status IN ('queued','running','waiting_for_approval')").get().count;
    const noActive = ["terminal", "terminal-live", "yielded-no-command"].includes(mode);
    assert.equal(activeCount, noActive ? 0 : manyActive ? 201 : 1);
    const writerBefore = observer.getRun(writer.runId);
    const expectedStatus = mode === "terminal" ? "succeeded" : mode === "terminal-live" ? "cancelled"
      : mode === "yielded-no-command" ? "yielded" : "running";
    assert.equal(writerBefore.status, expectedStatus);
    const overlaps = observer.listHostCommandWriteBlockers(cwd);
    const shouldBlock = !["other-cwd", "terminal", "yielded-no-command"].includes(mode);
    assert.equal(overlaps.some(value => value.executionId === writer.executionId), shouldBlock && !noCommand,
      "the existing Host journal must distinguish nested scope, siblings and real completion");
    if (noCommand) assert.deepEqual(overlaps, [], "the uncapped active query cannot be replaced by command-journal checks");
    const before = await workspaceFacts(cwd);
    const oldManifests = observer.listWorkspaceSnapshotManifests({ workspaceId: baseline.manifest.workspaceId }).map(value => value.id);
    const oldFence = observer.getWorkspaceSnapshotFence(baseline.manifest.workspaceId);
    hooks = observeSnapshotFs(t, cwd, store.paths.snapshotStagingDir);
    syncBuiltinESMExports();
    let value, error;
    try {
      value = kind === "capture" ? await snapshot.captureWorkspaceSnapshot(store, cwd)
        : await snapshot.restoreWorkspaceSnapshot(store, cwd, restoreInput);
    } catch (caught) { error = { code: caught.code, statusCode: caught.statusCode, message: caught.message }; }
    const after = await workspaceFacts(cwd), effects = hooks.facts();
    const request = observer.getSnapshotRestoreRequestByIdempotency(baseline.manifest.workspaceId, restoreInput.idempotencyKey);
    const afterFence = observer.getWorkspaceSnapshotFence(baseline.manifest.workspaceId);
    const afterManifests = observer.listWorkspaceSnapshotManifests({ workspaceId: baseline.manifest.workspaceId }).map(entry => entry.id);
    // The still-live process executes another real write only after snapshot
    // observations are frozen. This proves snapshot fencing did not stop it.
    if (!noCommand && mode !== "terminal") await writer.probe();
    console.log(`A30 barrier observation: ${JSON.stringify({ scenario, activeCount, writerBefore: writerBefore.status,
      sourceCurrent: active.has(writerBefore.status), executionId: writer.executionId, overlaps, yieldError: yieldFact?.error,
      realWriterWrites: writer.writes(), error, state: value?.state ?? value?.manifest?.state,
      effects, oldFence, afterFence, requestState: request?.state, workspaceUnchanged: JSON.stringify(after) === JSON.stringify(before) })}`);
    if (shouldBlock) {
      assert.equal(error?.code, "workspace_busy", "a current overlapping writer must be found independently of createdAt/page size");
      assert.equal(error.statusCode, 409);
      assert.equal(value, undefined);
      assert.deepEqual(effects, { rootScans: 0, stagingWrites: 0, restoreRenames: 0 }, "reject before walking/staging or changing managed files");
      assert.deepEqual(after, before);
      assert.deepEqual(afterManifests, oldManifests);
      assert.equal(request, undefined, "pre-existing writer rejection must not expose a started restore");
      assert.deepEqual(afterFence, oldFence, "pre-existing writers should be rejected before claiming the snapshot fence");
      assert.equal(writer.writes(), noCommand ? 0 : 2, "real commands remain executable; command-free active Runs still require the active-set gate");
    } else {
      assert.equal(error, undefined, "a completed or genuinely disjoint command must not block snapshots");
      assert.equal(kind === "capture" ? value.manifest.state : value.state, "committed");
      assert.equal(afterFence.ownerRequestId, undefined);
      assert.ok(effects.rootScans > 0, "the positive control must actually traverse the real producer");
      assert.equal(after.root.body, kind === "restore" ? baselineBody : currentBody);
      assert.equal(after.nested.body, kind === "restore" ? baselineBody : currentBody);
      if (kind === "restore") assert.ok(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: value.id }).length > 0);
    }
    await writer.stop();
    assert.equal(observer.getRun(writer.runId).status, mode === "terminal-live" ? "cancelled"
      : mode === "yielded-no-command" ? "yielded" : "succeeded");
    const remaining = observer.listHostCommandWriteBlockers(cwd);
    if (mode === "terminal-live") {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].executionId, writer.executionId);
      assert.equal(remaining[0].state, "stop_unconfirmed", "late close after terminal Run cannot manufacture completed authority");
    } else assert.deepEqual(remaining, []);
  } finally {
    hooks?.release.resolve();
    try {
      await writer?.dispose();
      if (captureOperation) await within(captureOperation, "fenced capture cleanup before closing SQLite");
    } finally {
      for (const candidate of [observer, store]) if (candidate?.database.isOpen) candidate.close();
      hooks?.restore(); homePatch.mock.restore(); syncBuiltinESMExports();
      globalThis.fetch = originalFetch;
    }
  }
}

function seedRun(store, id, cwd, offset, extra = {}) {
  const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + offset * 1000).toISOString();
  return store.createRun({ id, cwd, taskId: `task-${id}`, providerName: "isolated-fixture", providerModel: "no-model",
    taskSnapshot: { id: `task-${id}`, title: "Read-only queue fixture", prompt: "No model or tool dispatch" },
    providerSnapshot: {}, requestSnapshot: { tools: ["read"], workspaceAccessMode: "read_only" }, createdAt, ...extra });
}

/** Current source with real canonical Turn lineage; no tool journal is manufactured. */
function createCurrentSource({ core, store, cwd }, command) {
  const runId = "a30-old-running-writer", now = "2026-01-01T00:00:00.000Z";
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "A30 current source", objective: "Snapshot admission must use actual source/effect state" }, now);
  const accepted = store.appendConversationUserTurn({ threadId: thread.id, teammateId: "ling_agent",
    title: "A30 current source", userInstruction: "Keep the current task until its real boundary",
    idempotencyKey: "a30-canonical-user-turn", payload: { body: "Keep the current task until its real boundary",
      format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: core.DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: "a30-current-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "a30-owned-runtime",
    runnerId: "pi", status: "started", now });
  const run = seedRun(store, runId, cwd, 0, { workUnitId: unit.id, threadId: thread.id, turnId: accepted.turnId,
    teammateId: "ling_agent", requestSnapshot: { tools: command ? ["bash"] : ["read"],
      workspaceAccessMode: command ? "workspace_write" : "read_only" } });
  store.linkRunToWorkUnit(runId, unit.id, now); store.markRunStarted(runId, now);
  const sourceFence = core.toRuntimeAttemptFence(attempt);
  return { runId, run, sourceFence, threadId: thread.id, sourceItemId: accepted.item.id, runnerId: attempt.runnerId };
}

function createRunWithoutCommand(input) {
  const source = createCurrentSource(input, false);
  const stop = async () => {
    if (input.store.getRun(source.runId).status === "running") input.store.markRunSucceeded(source.runId, new Date().toISOString());
  };
  return { ...source, writes: () => 0, stop, dispose: stop };
}

/** Use the actual atomic yield gate; an unsafe prepared command must reject it. */
function attemptCanonicalYield(store, source) {
  const requestedAt = new Date().toISOString();
  const request = store.createUserInputRequest({ sourceRunId: source.runId, sourceItemId: source.sourceItemId,
    sourceFence: source.sourceFence, toolCallId: "a30-required-question", idempotencyKey: "a30-required-question",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "continue", prompt: "Choose whether to continue", required: true, allowFreeText: true, options: [] },
    ] } }, requestedAt).request;
  const stoppedAt = new Date().toISOString();
  const sequence = store.database.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=?").get(source.runId).seq;
  try {
    const result = store.commitUserInputYield({ threadId: source.threadId, requestId: request.requestId,
      expectedRequestVersion: request.requestVersion, sourceFence: source.sourceFence,
      quiescence: { kind: "runner_quiesced", runnerId: source.runnerId, stoppedAt, lastRunEventSeq: sequence } },
    new Date().toISOString());
    return { requestId: request.requestId, result };
  } catch (error) { return { requestId: request.requestId, error: { code: error.code, message: error.message } }; }
}

/** Launch authority and settlement stay real; only the command's finite input is fixture-owned. */
async function startWriter(input) {
  const { processModule, store, cwd } = input;
  const current = createCurrentSource(input, true);
  const { runId, run, sourceFence } = current;
  const source = `const fs=require('node:fs'); const file=process.argv[1],body=process.argv[2];
    let n=0,pending=''; const write=()=>{fs.writeFileSync(file,body);process.stdout.write('A30_WROTE:'+ ++n +'\\n');};
    write(); process.stdout.write('A30_READY\\n'); process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{pending+=chunk; let p; while((p=pending.indexOf('\\n'))>=0){
      const line=pending.slice(0,p);pending=pending.slice(p+1);if(line==='probe')write();if(line==='stop')process.exit(0);}});
    process.stdin.on('end',()=>process.exit(0)); setTimeout(()=>process.exit(81),18000).unref();`;
  const argv = [process.execPath, "-e", source, join(cwd, "project.txt"), currentBody];
  const ticket = store.prepareHostCommandExecution({ runId, sourceFence, toolCallId: "a30-real-held-command", cwd,
    command: { kind: "argv", argv } });
  let child;
  store.launchHostCommandExecution(ticket, () => {
    child = spawn(process.execPath, argv.slice(1), { cwd, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    return child;
  });
  let stdout = "", stderr = "", stopping, settled = false;
  const waiters = new Set(), controller = new AbortController();
  const observation = processModule.observeCommandProcess({ child, signal: controller.signal, timeoutMs: 20_000,
    onOutput(stream, chunk) {
      if (stream === "stdout") { stdout += chunk.toString("utf8"); for (const waiter of waiters) waiter(); }
      else stderr += chunk.toString("utf8");
    } });
  const waitFor = async marker => {
    if (stdout.includes(marker)) return;
    let wake;
    const ready = new Promise(done => { wake = () => { if (stdout.includes(marker)) done(); }; waiters.add(wake); });
    try { await within(ready, `owned command marker ${marker}; stderr=${stderr}`); }
    finally { waiters.delete(wake); }
  };
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end("stop\n");
    const result = await within(observation, "owned command orderly exit");
    const fact = store.settleHostCommandExecution(ticket, { kind: "observed", observation: result.observation });
    settled = true;
    assert.equal(result.exitCode, 0, stderr);
    assert.equal(result.observation.settledBy, "close");
    assert.equal(result.observation.leaderExited, true);
    assert.equal(result.observation.stdioClosed, true);
    const currentStatus = store.getRun(runId).status;
    assert.equal(fact.data.outcome, currentStatus === "running" ? "completed" : "stop_unconfirmed");
    if (currentStatus === "running") store.markRunSucceeded(runId, new Date().toISOString());
  })();
  try {
    assert.ok(child?.pid, "the original Host launch must return an actual owned process");
    await waitFor("A30_READY\n");
    assert.equal(await fs.readFile(join(cwd, "project.txt"), "utf8"), currentBody);
    assert.equal(store.getRun(run.id).status, "running");
    return { ...current, executionId: ticket.executionId, writes: () => (stdout.match(/A30_WROTE:/gu) ?? []).length,
      async probe() { child.stdin.write("probe\n"); await waitFor("A30_WROTE:2\n"); }, stop,
      async dispose() {
        if (settled) return;
        try { await stop(); }
        catch (error) { controller.abort(); await observation; throw error; }
      } };
  } catch (error) {
    controller.abort(); await observation;
    throw error;
  }
}

function observeSnapshotFs(t, root, stagingDir, pause = false) {
  const actual = { readdir: fs.readdir, rename: fs.rename, createWriteStream: nativeFs.createWriteStream };
  const entered = deferred(), release = deferred();
  let rootScans = 0, stagingWrites = 0, restoreRenames = 0;
  const patches = [t.mock.method(fs, "readdir", async function (path, options) {
    const result = await actual.readdir.call(this, path, options);
    if (path === root && options?.withFileTypes === true) {
      rootScans++; if (pause) { entered.resolve(); await release.promise; }
    }
    return result;
  }), t.mock.method(fs, "rename", function (source, destination, ...args) {
    if (typeof source === "string" && typeof destination === "string" && source.startsWith(`${destination}.ling-restore-`)) restoreRenames++;
    return actual.rename.call(this, source, destination, ...args);
  }), t.mock.method(nativeFs, "createWriteStream", function (path, ...args) {
    if (typeof path === "string" && path.startsWith(`${stagingDir}/blob-`)) stagingWrites++;
    return actual.createWriteStream.call(this, path, ...args);
  })];
  return { entered, release, facts: () => ({ rootScans, stagingWrites, restoreRenames }),
    restore() { for (const patch of patches) patch.mock.restore(); } };
}

async function workspaceFacts(cwd) {
  const fact = async path => ({ body: await fs.readFile(path, "utf8"), mode: (await fs.lstat(path)).mode & 0o777 });
  return { root: await fact(join(cwd, "project.txt")), nested: await fact(join(cwd, "nested", "project.txt")) };
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`A30 timeout: ${description}`)), 6_000);
  })]); } finally { clearTimeout(timer); }
}
