import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A26_PATCH_SCOPE_CASE";
const caseName = "partial-body-scope";
const now = "2026-10-15T08:00:00.000Z";

test("A26 PATCH rechecks ownership after a real partial body and same-id replacement", { timeout: 60_000 }, async t => {
  if (process.env[caseEnv]) {
    assert.equal(process.env[caseEnv], caseName);
    return exercisePartialBody(t);
  }
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryRoot, "ling-a26-patch-scope-")));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: caseName },
      stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    console.log(`A26 PATCH child exit: ${JSON.stringify(exit)}`);
    assert.ok(stdout.includes("A26 PATCH real partial body entered"));
    assert.equal(exit.signal, null, "the HTTP fixture must drain and settle rather than be killed");
    assert.equal(exit.code, 0, "the actual PATCH route must reject the replacement row's different owning thread");
  } finally {
    assert.equal(dirname(root), temporaryRoot);
    assert.ok(basename(root).startsWith("ling-a26-patch-scope-"));
    await rm(root, { recursive: true, force: true });
  }
});

/** Keep the real route, body parser, Store and SQLite writes; observe without replacing their values. */
async function exercisePartialBody(t) {
  const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
  for (const path of [home, cwd]) {
    assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
    assert.equal((await stat(path)).isDirectory(), true);
  }
  assert.equal(dirname(home), dirname(cwd));
  assert.ok(basename(dirname(cwd)).startsWith("ling-a26-patch-scope-"));
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  const homeHook = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  let origin, daemon, store, reopened, activeRequest, scopeObserver, modelCalls = 0, blockedFetches = 0;
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!origin || url.origin !== origin) {
      blockedFetches++;
      throw new Error("A26 PATCH forbids non-owned HTTP requests");
    }
    return originalFetch.call(this, input, init);
  };
  try {
    const core = await import("../../core/dist/index.js");
    const { createDaemonServer } = await import("../dist/index.js");
    const secrets = core.createCompositeSecretResolver({ env: {} });
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, {
      secretResolver: secrets,
      externalSecretStore: { ...secrets,
        setSecret() { throw new Error("A26 PATCH forbids secret writes"); },
        deleteSecret() { throw new Error("A26 PATCH forbids secret deletes"); } },
      chromeBrowserNativeMessagingEnabled: false,
      runner: { async runTask() { modelCalls++; throw new Error("A26 PATCH forbids model execution"); } },
      storeFactory(storeCwd) {
        assert.equal(resolve(storeCwd), cwd);
        assert.equal(store, undefined, "the fixture owns exactly one live Store");
        store = core.createSqliteRunStore(storeCwd);
        return store;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
    assert.ok(store);
    const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
    assert.equal(store.paths.databasePath, databasePath);
    const channel = store.createChannel({ name: "A26 PATCH ownership", boundPath: cwd, allowedTools: ["read"] }, now);
    const sourceThread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
      title: "Original owner", objective: "Pause an actual partial PATCH body", status: "open" }, now);
    const otherThread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
      title: "Replacement owner", objective: "Never accept another thread's PATCH", status: "open" }, now);
    const planId = "proposed_plan_a26_patch_reused_id";
    const path = `/threads/${encodeURIComponent(sourceThread.id)}/proposed-plans/${planId}?cwd=${encodeURIComponent(cwd)}`;
    const initialResponse = await fetch(`${origin}${path}`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original proposal", bodyMarkdown: "ORIGINAL_SCOPE", version: 1 }) });
    const initialBody = await initialResponse.json();
    assert.equal(initialResponse.status, 201, JSON.stringify(initialBody));
    const initial = initialBody.plan;
    assert.equal(initial.revision, 1);

    let phase = "request-incomplete";
    const observations = [];
    const originalGet = store.getProposedPlanArtifact;
    scopeObserver = t.mock.method(store, "getProposedPlanArtifact", function (...args) {
      const result = Reflect.apply(originalGet, this, args);
      if (args[0] === planId) observations.push({ phase, threadId: result?.threadId, revision: result?.revision });
      return result;
    });
    const barrier = deferred();
    let observedRequests = 0;
    // The transparent wrapper delegates every iterator operation. The barrier
    // fires only after the real parser asks for and receives an actual chunk.
    const observeRequest = request => {
      if (request.method !== "PATCH" || request.url !== path) return;
      observedRequests++;
      const originalIterator = request[Symbol.asyncIterator];
      request[Symbol.asyncIterator] = function (...args) {
        const iterator = Reflect.apply(originalIterator, this, args);
        let first = true;
        return {
          async next(...nextArgs) {
            const result = await Reflect.apply(iterator.next, iterator, nextArgs);
            if (first && !result.done) {
              first = false;
              barrier.resolve({ requestComplete: request.complete, chunkBytes: result.value.byteLength,
                priorScopeReads: observations.filter(item => item.phase === "request-incomplete") });
            }
            return result;
          },
          return: (...returnArgs) => Reflect.apply(iterator.return, iterator, returnArgs),
          throw: (...throwArgs) => Reflect.apply(iterator.throw, iterator, throwArgs),
          [Symbol.asyncIterator]() { return this; },
        };
      };
    };
    daemon.server.prependListener("request", observeRequest);
    const body = Buffer.from(JSON.stringify({ title: "CROSS_THREAD_OVERWRITE", bodyMarkdown: "MUST_NOT_REACH_REPLACEMENT",
      expectedRevision: initial.revision }));
    const split = Math.floor(body.length / 2);
    assert.ok(split > 0 && split < body.length);
    const pending = partialPatch(`${origin}${path}`, body.length);
    activeRequest = pending.request;
    activeRequest.write(body.subarray(0, split));
    const observed = await within(barrier.promise, "the actual PATCH body reader never consumed the first partial chunk");
    assert.equal(observedRequests, 1);
    assert.equal(observed.requestComplete, false, "the ownership swap must happen before the body is complete");
    assert.ok(observed.chunkBytes > 0 && observed.chunkBytes < body.length);
    for (const read of observed.priorScopeReads) {
      assert.equal(read.threadId, sourceThread.id);
      assert.equal(read.revision, initial.revision);
    }
    console.log(`A26 PATCH real partial body entered: ${JSON.stringify(observed)}`);

    phase = "owned-replacement";
    withDatabase(databasePath, database => {
      const removed = database.prepare("DELETE FROM ling_thread_proposed_plans WHERE workspace_id=? AND id=? AND thread_id=?")
        .run(initial.workspaceId, planId, sourceThread.id);
      assert.equal(removed.changes, 1);
    });
    const replacement = store.upsertProposedPlanArtifact({ id: planId, threadId: otherThread.id,
      title: "Untouched replacement", bodyMarkdown: "OTHER_THREAD_EXACT_BYTES\n\n```ts\nconst n = 2;\n```", version: 1 }, now);
    assert.equal(replacement.id, initial.id);
    assert.equal(replacement.revision, initial.revision, "same revision rules out a revision-only accidental rejection");
    assert.notEqual(replacement.threadId, sourceThread.id);
    const baseline = databaseFacts(databasePath);
    phase = "body-complete";
    activeRequest.end(body.subarray(split));
    const response = await within(pending.response, "the actual PATCH response did not drain");
    activeRequest = undefined;
    daemon.server.removeListener("request", observeRequest);
    const afterResponse = databaseFacts(databasePath);
    scopeObserver.mock.restore();
    scopeObserver = undefined;
    await daemon.stop();
    daemon = undefined;
    reopened = core.createSqliteRunStore(cwd);
    const afterReopen = databaseFacts(databasePath);
    const canonical = reopened.getProposedPlanArtifact(planId);
    console.log(`A26 PATCH ownership evidence: ${JSON.stringify({ observed, observations, response,
      baseline, afterResponse, afterReopen, canonical, modelCalls, blockedFetches })}`);

    assert.equal(response.status, 404, JSON.stringify(response));
    assert.equal(response.body.error, "proposed_plan_not_found");
    assert.deepEqual(afterResponse, baseline, "a rejected cross-thread PATCH must leave every replacement-row column unchanged");
    assert.deepEqual(afterReopen, baseline, "the unchanged replacement must survive actual daemon drain and Store reopen");
    assert.deepEqual(canonical, replacement);
    assert.equal(modelCalls, 0);
    assert.equal(blockedFetches, 0);
    assert.equal(afterReopen.runs.length, 0);

    // The HTTP fix must also preserve the Store boundary: a same-revision
    // wrong owner is not permission to edit, nor to return a foreign no-op row.
    for (const patch of [{ title: "DIRECT_WRONG_THREAD_WRITE" }, {}]) {
      assert.throws(() => reopened.updateProposedPlanArtifact(planId, {
        ...patch, expectedRevision: canonical.revision, expectedThreadId: sourceThread.id,
      }, now), error => {
        assert.ok(error instanceof core.ProposedPlanMutationError);
        assert.equal(error.statusCode, 404);
        assert.equal(error.code, "proposed_plan_not_found");
        return true;
      });
      assert.deepEqual(databaseFacts(databasePath), baseline, "wrong-scope Core mutation and no-op must leave every row unchanged");
    }
    const correctlyScoped = reopened.updateProposedPlanArtifact(planId, {
      title: "Correct owner CAS succeeds", expectedRevision: canonical.revision, expectedThreadId: otherThread.id,
    }, now);
    assert.ok(correctlyScoped);
    assert.equal(correctlyScoped.revision, canonical.revision + 1);
    assert.deepEqual(correctlyScoped, { ...canonical, title: "Correct owner CAS succeeds", revision: canonical.revision + 1 });
    const afterCore = databaseFacts(databasePath);
    for (const table of ["tasks", "workflows", "steps", "runs"]) assert.deepEqual(afterCore[table], baseline[table]);
    assert.equal(afterCore.plans.length, 1);
    assert.deepEqual(afterCore.plans[0], { ...baseline.plans[0], title: "Correct owner CAS succeeds", revision: canonical.revision + 1 });
    reopened.close();
    reopened = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual(reopened.getProposedPlanArtifact(planId), correctlyScoped);
    assert.deepEqual(databaseFacts(databasePath), afterCore);
    console.log(`A26 PATCH direct Core scope evidence: ${JSON.stringify({ originalRevision: canonical.revision,
      wrongScopeRejected: ["mutation", "no-op"], correctlyScoped, afterCore, reopened: true })}`);
    assert.equal(modelCalls, 0);
    assert.equal(blockedFetches, 0);
  } finally {
    activeRequest?.destroy();
    scopeObserver?.mock.restore();
    try { await daemon?.stop(); }
    finally {
      reopened?.close();
      globalThis.fetch = originalFetch;
      homeHook.mock.restore();
      syncBuiltinESMExports();
    }
  }
}

/** Send a real incomplete Content-Length request and fully drain its eventual response. */
function partialPatch(url, contentLength) {
  let request;
  const response = new Promise((done, reject) => {
    request = httpRequest(url, { method: "PATCH", headers: { "content-type": "application/json",
      "content-length": contentLength, connection: "close" } }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("aborted", () => reject(new Error("PATCH response was aborted")));
      incoming.once("end", () => {
        try { done({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
  });
  // A barrier assertion can fail before the response is awaited. Preserve its
  // rejection for the await while preventing cleanup from making it unhandled.
  void response.catch(() => {});
  return { request, response };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 8_000); })]);
  } finally { clearTimeout(timer); }
}

function withDatabase(path, callback) {
  const database = new DatabaseSync(path);
  try { return callback(database); }
  finally { database.close(); }
}

function databaseFacts(path) {
  return withDatabase(path, database => {
    const rows = table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row }));
    return { plans: rows("ling_thread_proposed_plans"), tasks: rows("tasks"), workflows: rows("channel_workflows"),
      steps: rows("channel_workflow_steps"), runs: rows("run_sessions") };
  });
}
