import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Isolate storage before product import. Credential values below are fixtures,
// not process.env or Keychain values; all upstream requests stay on loopback.
const ownedRoot = await mkdtemp(join(tmpdir(), "ling-a20-check-ownership-"));
const home = join(ownedRoot, "user");
const initialWorkspace = join(ownedRoot, "initial-workspace");
await Promise.all([mkdir(home), mkdir(initialWorkspace)]);
const environmentKeys = ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"];
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.LING_STACK_HOME = home;
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = initialWorkspace;
after(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(ownedRoot, { recursive: true, force: true });
});

const { createEnvSecretResolver, createSqliteRunStore } = await import("@ling-stack/core");
const { createDaemonServer } = await import("../dist/index.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, description, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.length) });
  response.end(bytes);
}

/** Delay real HTTP response bytes, never inspect/fetch/Response/Store results. */
async function createOwnedUpstream() {
  const plans = [], requests = [], failures = [], handlers = new Set();
  const server = createServer((request, response) => {
    const handler = handle(request, response).catch(error => {
      failures.push(error);
      if (!response.headersSent) sendJson(response, 500, { error: "owned_fixture_error" });
      else response.destroy();
    });
    handlers.add(handler);
    void handler.then(() => handlers.delete(handler));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function handle(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const path = new URL(request.url, baseUrl).pathname;
    const observation = { method: request.method, path, authorization: request.headers.authorization };
    requests.push(observation);
    assert.equal(request.method, "GET", "a connection check cannot submit or modify remote work");
    assert.equal(Buffer.concat(chunks).byteLength, 0);
    if (path === "/api/jobs") return sendJson(response, 200, { jobs: [] });
    assert.equal(path, "/api/object_info", "only real Comfy inspection endpoints are expected");
    const plan = plans.find(candidate => !candidate.entered);
    assert.ok(plan, "every native inspection must consume an explicit owned response plan");
    plan.entered = true;
    plan.observation = observation;
    if (plan.status === 200) {
      const objectInfo = Object.fromEntries(Array.from({ length: plan.nodeCount }, (_, index) => [`OwnedNode${index}`, {}]));
      const bytes = plan.responseBytes ?? Buffer.from(JSON.stringify(objectInfo));
      response.writeHead(200, { "content-type": "application/json", "content-length": String(bytes.length) });
      response.flushHeaders();
      response.write(bytes.subarray(0, 1));
      plan.arrived.resolve();
      // Native Response.json remains pending until the test releases its body.
      await plan.gate.promise;
      response.end(bytes.subarray(1));
    } else {
      // For error cases hold the native request before headers, otherwise the
      // real client can reject status and cancel its body before PATCH occurs.
      plan.arrived.resolve();
      await plan.gate.promise;
      sendJson(response, plan.status, { error: "a20_owned_inspection_failure" });
    }
  }

  return {
    baseUrl, requests, failures,
    plan({ status = 200, nodeCount = 1, paused = false, responseBytes } = {}) {
      const plan = { status, nodeCount, responseBytes: responseBytes === undefined ? undefined : Buffer.from(responseBytes),
        entered: false, arrived: deferred(), gate: deferred() };
      plans.push(plan);
      if (!paused) plan.gate.resolve();
      return {
        entered: () => bounded(plan.arrived.promise, "actual native object_info request/body wait"),
        release: () => plan.gate.resolve(),
        get observation() { return plan.observation; },
      };
    },
    releaseAll() { for (const plan of plans) plan.gate.resolve(); },
    async close() {
      for (const plan of plans) plan.gate.resolve();
      try { await bounded(Promise.all([...handlers]), "owned upstream handlers settling"); }
      finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    },
  };
}

async function createCase(t) {
  const cwd = await mkdtemp(join(ownedRoot, "workspace-"));
  const credentialEnvironment = { A20_FIRST: "a20-owned-first-value", A20_SECOND: "a20-owned-second-value" };
  const envResolver = createEnvSecretResolver(credentialEnvironment);
  const credentialState = { failResolution: false, resolutions: [] };
  const resolver = {
    status: (ref, purpose) => envResolver.status(ref, purpose),
    resolve(ref, purpose) {
      credentialState.resolutions.push(ref);
      if (credentialState.failResolution) throw new Error("owned external credential read failure");
      return envResolver.resolve(ref, purpose);
    },
  };
  const upstreams = [], pending = new Set();
  let daemon, store, database, runnerCalls = 0, secretStoreCalls = 0;
  // Register before listener/store/daemon construction so partial setup owns cleanup.
  t.after(async () => {
    for (const upstream of upstreams) upstream.releaseAll();
    try {
      const settlements = await bounded(Promise.allSettled([...pending]), "entered public check requests settling");
      for (const result of settlements) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
      }
    } finally {
      try {
        if (database) database.close();
        if (daemon) await daemon.stop();
        else if (store) store.close();
      } finally {
        for (const upstream of upstreams) await upstream.close();
      }
    }
    assert.equal(runnerCalls, 0, "connection checks must not execute an Agent/model");
    assert.equal(secretStoreCalls, 0, "these env-only cases must not read or mutate Keychain");
    for (const upstream of upstreams) assert.deepEqual(upstream.failures, []);
  });
  async function addUpstream() {
    const upstream = await createOwnedUpstream();
    upstreams.push(upstream);
    return upstream;
  }
  const upstream = await addUpstream();
  store = createSqliteRunStore(cwd);
  const forbidSecretStore = () => { secretStoreCalls++; throw new Error("A20 cannot access external secret storage"); };
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    secretResolver: resolver,
    externalSecretStore: { status: forbidSecretStore, resolve: forbidSecretStore,
      setSecret: forbidSecretStore, deleteSecret: forbidSecretStore },
    runner: { async runTask() { runnerCalls++; throw new Error("A20 must not call an LLM runner"); } },
  });
  await daemon.start();
  database = new DatabaseSync(store.paths.databasePath, { readOnly: true });
  const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
  async function api(method, path, body) {
    const response = await fetch(`${baseUrl}${path}?cwd=${encodeURIComponent(cwd)}`, {
      method, signal: AbortSignal.timeout(12_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  function row(id) {
    return database.prepare("SELECT * FROM media_workflow_connections WHERE id = ?").get(id);
  }
  function authority(id) {
    return database.prepare("SELECT * FROM media_workflow_connection_check_authorities WHERE connection_id=?").get(id);
  }
  async function current(id) {
    const result = await api("GET", `/media-workflow-connections/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.connection;
  }
  return {
    api, row, authority, current, upstream, addUpstream, credentialEnvironment, credentialState,
    openWriter: () => new DatabaseSync(store.paths.databasePath),
    async create(overrides = {}) {
      const result = await api("POST", "/media-workflow-connections", {
        name: "A20 owned connection", baseUrl: upstream.baseUrl, authMode: "none",
        networkPolicy: "trusted_private_network", protocolVariant: "prompt_legacy", ...overrides,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.connection.status, "unchecked");
      assert.equal(result.body.connection.health, undefined);
      return result.body.connection;
    },
    check(id) {
      const promise = api("POST", `/media-workflow-connections/${id}/check`, {});
      pending.add(promise);
      // Observe settlement without replacing the original request Promise or its rejection.
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    },
    async patch(id, changes) {
      const result = await api("PATCH", `/media-workflow-connections/${id}`, changes);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.connection.status, "unchecked");
      assert.equal(result.body.connection.health, undefined);
      return result.body.connection;
    },
    assertNoWork() {
      for (const table of ["media_jobs", "work_units", "artifacts"]) {
        assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
      }
    },
  };
}

async function snapshot(fixture, id) {
  return { connection: await fixture.current(id), row: fixture.row(id), authority: fixture.authority(id) };
}

async function assertUnchanged(fixture, id, before) {
  // Compare the full persisted row, including any future config/check revision.
  // Do not rely on wall-clock milliseconds, a sleep, or content equality as a version.
  assert.deepEqual(fixture.row(id), before.row, "late check must not publish into the current persisted row");
  assert.deepEqual(fixture.authority(id), before.authority, "discarding a late result must not consume or change current authority");
  assert.deepEqual(await fixture.current(id), before.connection,
    "public GET must retain the successor configuration/health observation");
  fixture.assertNoWork();
}

function assertStale(result, reason, currentConnection) {
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, "media_workflow_check_result_stale");
  assert.equal(result.body.reason, reason);
  assert.deepEqual(result.body.connection, currentConnection, "stale response contains only a current row, never the admitted fallback");
}

function assertChecked(result, outcome, nodeCount = 1, protocolVariant = "prompt_legacy") {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.connection.status, outcome === "success" ? "ready" : "error");
  assert.equal(result.body.connection.health.ok, outcome === "success");
  if (outcome === "success") {
    assert.equal(result.body.connection.health.nodeCount, nodeCount);
    assert.equal(result.body.connection.health.protocolVariant, protocolVariant);
  } else {
    assert.match(result.body.connection.health.message, /HTTP 500/u);
  }
}

for (const protocolVariant of ["prompt_legacy", "jobs_v1", "auto"]) {
  test(`A20 current ${protocolVariant} check uses real native inspection and persists health`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create({ protocolVariant });
    f.upstream.plan({ nodeCount: 2 });
    const result = await f.check(connection.id);
    assertChecked(result, "success", 2, protocolVariant === "auto" ? "jobs_v1" : protocolVariant);
    assert.deepEqual(await f.current(connection.id), result.body.connection);
    assert.equal(JSON.parse(f.row(connection.id).health_json).nodeCount, 2);
    assert.deepEqual(f.upstream.requests.map(request => request.path),
      protocolVariant === "auto" ? ["/api/object_info", "/api/jobs"] : ["/api/object_info"]);
    f.assertNoWork();
  });
}

test("A20 current native inspection failure really persists error health", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create();
  f.upstream.plan({ status: 500 });
  const result = await f.check(connection.id);
  assertChecked(result, "error");
  assert.deepEqual(await f.current(connection.id), result.body.connection);
  assert.equal(JSON.parse(f.row(connection.id).health_json).ok, false);
  assert.equal(f.upstream.requests.length, 1);
  f.assertNoWork();
});

test("A20 malformed JSON error health never publishes the effective bearer credential", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  // A short non-JSON token reaches the native Response.json parser, whose
  // diagnostic can quote these exact bytes. It intentionally matches neither
  // the sk- nor Bearer redaction pattern, and is only an owned random fixture.
  const credential = `q${randomBytes(6).toString("hex")}`;
  f.credentialEnvironment.A20_FIRST = credential;
  const connection = await f.create({ authMode: "bearer", secretRef: "env:A20_FIRST" });
  const plan = f.upstream.plan({ responseBytes: Buffer.from(credential) });
  const result = await f.check(connection.id);
  assert.equal(result.status, 200, "a current native parse failure must publish error health, not become stale");
  assert.equal(result.body.connection.status, "error");
  assert.equal(result.body.connection.health.ok, false);
  assert.ok(result.body.connection.health.message.length > 0);
  assert.equal(plan.observation.authorization, `Bearer ${credential}`);
  assert.deepEqual(f.upstream.requests.map(request => request.path), ["/api/object_info"]);
  assert.deepEqual(f.credentialState.resolutions, ["env:A20_FIRST", "env:A20_FIRST"]);
  const current = await f.current(connection.id);
  const row = f.row(connection.id);
  const authority = f.authority(connection.id);
  assert.deepEqual(current, result.body.connection);
  assert.deepEqual(JSON.parse(row.health_json), result.body.connection.health);
  assert.ok(authority.request_revision > 0);
  assert.equal(authority.published_revision, authority.request_revision,
    "the real error candidate must consume its admitted authority");
  for (const [surface, value] of [["POST response", result.body], ["GET response", current],
    ["persisted connection row", row], ["persisted authority row", authority]]) {
    assert.equal(JSON.stringify(value).includes(credential), false,
      `${surface} must not contain the effective bearer credential quoted by the native JSON error`);
  }
  f.assertNoWork();
});

for (const [variant, authMode, randomByteCount] of [
  ["repeated arbitrary key", "bearer", 4],
  ["long key native excerpt", "bearer", 48],
  ["unauthenticated response", "none", 4],
]) {
  test(`A20 malformed JSON ${variant} retains a useful body-free diagnostic`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const credential = `q${randomBytes(randomByteCount).toString("hex")}`;
    f.credentialEnvironment.A20_FIRST = credential;
    const connection = await f.create({ authMode, secretRef: "env:A20_FIRST" });
    const plan = f.upstream.plan({ responseBytes: Buffer.from(`${credential} ${credential}`) });
    const result = await f.check(connection.id);
    assert.equal(result.status, 200);
    assert.equal(result.body.connection.status, "error");
    assert.deepEqual(result.body.connection.health, {
      ok: false, message: "ComfyUI 返回的 JSON 格式无效。", checkedAt: result.body.connection.health.checkedAt,
    });
    assert.ok(Number.isFinite(Date.parse(result.body.connection.health.checkedAt)));
    assert.equal(plan.observation.authorization, authMode === "bearer" ? `Bearer ${credential}` : undefined);
    assert.deepEqual(f.credentialState.resolutions, authMode === "bearer" ? ["env:A20_FIRST", "env:A20_FIRST"] : []);
    assert.deepEqual(f.upstream.requests.map(request => request.path), ["/api/object_info"]);
    assert.deepEqual(await f.current(connection.id), result.body.connection);
    assert.deepEqual(JSON.parse(f.row(connection.id).health_json), result.body.connection.health);
    assert.equal(f.authority(connection.id).published_revision, f.authority(connection.id).request_revision);
    f.assertNoWork();
  });
}

test("A20 fresh public_only check rechecks real sender policy before any loopback request", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create({ networkPolicy: "public_only" });
  const denied = await f.check(connection.id);
  assert.equal(denied.status, 200);
  assert.equal(denied.body.connection.status, "error");
  assert.equal(denied.body.connection.health.ok, false);
  assert.match(denied.body.connection.health.message, /可信自托管连接/u);
  assert.equal(f.upstream.requests.length, 0, "guarded sender must reject before connecting to owned loopback");
  await f.patch(connection.id, { networkPolicy: "trusted_private_network" });
  f.upstream.plan({ nodeCount: 2 });
  assertChecked(await f.check(connection.id), "success", 2);
  assert.equal(f.upstream.requests.length, 1);
  f.assertNoWork();
});

const changedConfigurations = ["baseUrl", "networkPolicy", "protocolVariant", "authMode", "secretRef", "same-content PATCH", "empty PATCH", "name"];
for (const field of changedConfigurations) {
  for (const lateOutcome of ["success", "error"]) {
    test(`A20 ${field}: late ${lateOutcome} cannot overwrite PATCH unchecked health`, { timeout: 20_000 }, async t => {
      const f = await createCase(t);
      const connection = await f.create(field === "secretRef" ? { authMode: "bearer", secretRef: "env:A20_FIRST" } : {});
      const plan = f.upstream.plan({ paused: true, nodeCount: 3, status: lateOutcome === "success" ? 200 : 500 });
      const oldCheck = f.check(connection.id);
      await plan.entered();
      const admittedAuthority = f.authority(connection.id);
      assert.equal(plan.observation.authorization,
        field === "secretRef" ? `Bearer ${f.credentialEnvironment.A20_FIRST}` : undefined);
      let changes;
      if (field === "baseUrl") changes = { baseUrl: (await f.addUpstream()).baseUrl };
      if (field === "networkPolicy") changes = { networkPolicy: "public_only" };
      if (field === "protocolVariant") changes = { protocolVariant: "jobs_v1" };
      if (field === "authMode") changes = { authMode: "bearer", secretRef: "env:A20_SECOND" };
      if (field === "secretRef") changes = { secretRef: "env:A20_SECOND" };
      if (field === "same-content PATCH") changes = { protocolVariant: connection.protocolVariant };
      if (field === "empty PATCH") changes = {};
      if (field === "name") changes = { name: "A20 renamed connection" };
      const patched = await f.patch(connection.id, changes);
      for (const [key, value] of Object.entries(changes)) assert.equal(patched[key], value);
      const successor = await snapshot(f, connection.id);
      assert.equal(successor.row.status, "unchecked");
      assert.equal(successor.row.health_json, null);
      assert.equal(successor.authority.config_revision, admittedAuthority.config_revision + 1,
        "every accepted PATCH has a persistent version even when its content/time is equal");
      assert.equal(successor.authority.request_revision, admittedAuthority.request_revision);
      // Even identical configuration PATCH is a real accepted mutation. Capture
      // its durable row without assuming updated_at has a distinct millisecond.
      plan.release();
      const late = await oldCheck;
      assertStale(late, "config_changed", successor.connection);
      await assertUnchanged(f, connection.id, successor);
      assert.equal(f.upstream.requests.length, 1, "stale completion must not start a replacement inspection");
      assert.equal(f.credentialState.resolutions.length, field === "secretRef" ? 1 : 0,
        "a revoked configuration must not resolve its retired credential again");
    });
  }
}

for (const oldOutcome of ["success", "error"]) {
  test(`A20 same-config double check: older ${oldOutcome} finishing last cannot replace newer health`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create();
    const older = f.upstream.plan({ paused: true, status: oldOutcome === "success" ? 200 : 500, nodeCount: 3 });
    const first = f.check(connection.id);
    await older.entered();
    const newerOutcome = oldOutcome === "success" ? "error" : "success";
    f.upstream.plan({ status: newerOutcome === "success" ? 200 : 500, nodeCount: 7 });
    const second = await f.check(connection.id);
    assertChecked(second, newerOutcome, 7);
    const successor = await snapshot(f, connection.id);
    older.release();
    assertStale(await first, "superseded", successor.connection);
    await assertUnchanged(f, connection.id, successor);
    assert.equal(f.upstream.requests.length, 2, "both real checks execute once without retries");
  });
}

for (const oldOutcome of ["success", "error"]) {
  test(`A20 newer check admission alone supersedes older ${oldOutcome} while still pending`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create();
    const older = f.upstream.plan({ paused: true, status: oldOutcome === "success" ? 200 : 500 });
    const first = f.check(connection.id);
    await older.entered();
    const newer = f.upstream.plan({ paused: true, nodeCount: 6 });
    const second = f.check(connection.id);
    await newer.entered();
    const admitted = await snapshot(f, connection.id);
    assert.equal(admitted.row.status, "unchecked");
    assert.equal(admitted.authority.published_revision, 0);
    older.release();
    assertStale(await first, "superseded", admitted.connection);
    await assertUnchanged(f, connection.id, admitted);
    newer.release();
    assertChecked(await second, "success", 6);
    assert.equal(f.upstream.requests.length, 2);
  });
}

for (const oldOutcome of ["success", "error"]) {
  test(`A20 DELETE/recreate: late ${oldOutcome} cannot resurrect deleted ID or change public successor`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create();
    const older = f.upstream.plan({ paused: true, status: oldOutcome === "success" ? 200 : 500, nodeCount: 3 });
    const first = f.check(connection.id);
    await older.entered();
    const deletion = await f.api("DELETE", `/media-workflow-connections/${connection.id}`);
    assert.equal(deletion.status, 200);
    assert.equal(deletion.body.deleted, true);
    assert.equal(f.row(connection.id), undefined);
    // Public POST and typed Core create both generate UUIDs. Do not invent a
    // same-ID recreate path through direct SQL or a replacement Store method.
    const recreated = await f.create();
    assert.notEqual(recreated.id, connection.id);
    f.upstream.plan({ nodeCount: 7 });
    assertChecked(await f.check(recreated.id), "success", 7);
    const successor = await snapshot(f, recreated.id);
    older.release();
    assertStale(await first, "deleted", undefined);
    assert.equal(f.row(connection.id), undefined);
    const missing = await f.api("GET", `/media-workflow-connections/${connection.id}`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "media_workflow_error");
    await assertUnchanged(f, recreated.id, successor);
    const listed = await f.api("GET", "/media-workflow-connections");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.connections.map(item => item.id), [recreated.id]);
    assert.equal(f.upstream.requests.length, 2);
  });
}

for (const oldOutcome of ["success", "error"]) {
  test(`A20 effective env credential changed: late ${oldOutcome} cannot replace new credential health`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create({ authMode: "bearer", secretRef: "env:A20_FIRST" });
    const older = f.upstream.plan({ paused: true, status: oldOutcome === "success" ? 200 : 500, nodeCount: 3 });
    const first = f.check(connection.id);
    await older.entered();
    const oldValue = f.credentialEnvironment.A20_FIRST;
    assert.equal(older.observation.authorization, `Bearer ${oldValue}`);
    // Use the real env resolver over an owned in-memory env record. No PATCH,
    // no config change and no real process environment/Keychain is consulted.
    f.credentialEnvironment.A20_FIRST = "a20-owned-rotated-value";
    const newer = f.upstream.plan({ nodeCount: 7 });
    assertChecked(await f.check(connection.id), "success", 7);
    assert.equal(newer.observation.authorization, `Bearer ${f.credentialEnvironment.A20_FIRST}`);
    assert.notEqual(newer.observation.authorization, older.observation.authorization);
    const successor = await snapshot(f, connection.id);
    assert.equal(successor.connection.secretRef, connection.secretRef);
    older.release();
    assertStale(await first, "superseded", successor.connection);
    await assertUnchanged(f, connection.id, successor);
    assert.equal(f.upstream.requests.length, 2);
  });
}

for (const lateOutcome of ["success", "error"]) {
  for (const change of ["rotated", "removed", "unavailable"]) {
    test(`A20 effective credential ${change}: sole pending ${lateOutcome} cannot publish`, { timeout: 20_000 }, async t => {
      const f = await createCase(t);
      const connection = await f.create({ authMode: "bearer", secretRef: "env:A20_FIRST" });
      const plan = f.upstream.plan({ paused: true, status: lateOutcome === "success" ? 200 : 500 });
      const pending = f.check(connection.id);
      await plan.entered();
      assert.equal(plan.observation.authorization, `Bearer ${f.credentialEnvironment.A20_FIRST}`);
      if (change === "rotated") f.credentialEnvironment.A20_FIRST = "a20-sole-request-new-value";
      if (change === "removed") delete f.credentialEnvironment.A20_FIRST;
      if (change === "unavailable") f.credentialState.failResolution = true;
      const before = await snapshot(f, connection.id);
      plan.release();
      const result = await pending;
      assertStale(result, change === "unavailable" ? "credential_unavailable" : "credential_changed", before.connection);
      await assertUnchanged(f, connection.id, before);
      assert.equal(f.upstream.requests.length, 1);
      assert.equal(f.credentialState.resolutions.length, 2,
        "the admitted and current effective credential are really observed without a newer check masking this test");
      for (const value of ["a20-owned-first-value", "a20-sole-request-new-value"]) {
        assert.equal(JSON.stringify(result.body).includes(value), false);
        assert.equal(JSON.stringify(f.row(connection.id)).includes(value), false);
        assert.equal(JSON.stringify(f.authority(connection.id)).includes(value), false);
      }
      assert.equal(Object.keys(f.authority(connection.id)).some(key => /secret|proof|credential/u.test(key)), false);
    });
  }
}

test("A20 unchanged bearer credential publishes while none mode never resolves any credential", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const authenticated = await f.create({ authMode: "bearer", secretRef: "env:A20_FIRST" });
  const bearerPlan = f.upstream.plan({ nodeCount: 4 });
  const checked = await f.check(authenticated.id);
  assertChecked(checked, "success", 4);
  assert.equal(bearerPlan.observation.authorization, `Bearer ${f.credentialEnvironment.A20_FIRST}`);
  assert.deepEqual(f.credentialState.resolutions, ["env:A20_FIRST", "env:A20_FIRST"]);
  assert.equal(JSON.stringify(checked.body).includes(f.credentialEnvironment.A20_FIRST), false);
  const unauthenticated = await f.create({ authMode: "none", secretRef: "env:A20_SECOND" });
  f.credentialState.failResolution = true;
  const nonePlan = f.upstream.plan();
  assertChecked(await f.check(unauthenticated.id), "success");
  assert.equal(nonePlan.observation.authorization, undefined);
  assert.equal(f.credentialState.resolutions.length, 2, "none auth must not resolve even an existing secretRef");
  f.assertNoWork();
});

test("A20 missing bearer credential is current error health, but unreadable identity remains stale", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create({ authMode: "bearer", secretRef: "env:A20_MISSING" });
  const missing = await f.check(connection.id);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.connection.status, "error");
  assert.equal(missing.body.connection.health.ok, false);
  assert.match(missing.body.connection.health.message, /API Key/u);
  assert.equal(f.upstream.requests.length, 0);
  await f.patch(connection.id, { secretRef: "env:A20_FIRST" });
  const before = await snapshot(f, connection.id);
  f.credentialState.failResolution = true;
  assertStale(await f.check(connection.id), "credential_unavailable", before.connection);
  assert.deepEqual(f.row(connection.id), before.row);
  assert.equal(f.authority(connection.id).request_revision, before.authority.request_revision + 1);
  assert.equal(f.authority(connection.id).published_revision, before.authority.published_revision);
  assert.equal(f.upstream.requests.length, 0);
  f.assertNoWork();
});

for (const candidateOutcome of ["success", "error"]) {
  test(`A20 Store failure after candidate ${candidateOutcome} rolls back health and consumption without retry`, { timeout: 20_000 }, async t => {
    const f = await createCase(t);
    const connection = await f.create();
    const plan = f.upstream.plan({ paused: true, status: candidateOutcome === "success" ? 200 : 500 });
    const pending = f.check(connection.id);
    await plan.entered();
    const before = await snapshot(f, connection.id);
    const writer = f.openWriter();
    try {
      writer.exec(`CREATE TRIGGER a20_owned_fail_consumption BEFORE UPDATE OF published_revision
        ON media_workflow_connection_check_authorities BEGIN SELECT RAISE(ABORT, 'a20_owned_consumption_failure'); END`);
      plan.release();
      const result = await pending;
      assert.equal(result.status, 400);
      assert.equal(result.body.error, "media_workflow_error");
      assert.match(result.body.message, /a20_owned_consumption_failure/u);
      await assertUnchanged(f, connection.id, before);
      assert.equal(f.upstream.requests.length, 1);
      writer.exec("DROP TRIGGER a20_owned_fail_consumption");
      f.upstream.plan({ nodeCount: 5 });
      assertChecked(await f.check(connection.id), "success", 5);
      assert.equal(f.authority(connection.id).published_revision, f.authority(connection.id).request_revision);
      assert.equal(f.upstream.requests.length, 2, "only the explicit successor request may retry inspection");
    } finally { writer.close(); }
  });
}

test("A20 failed admission and missing authority cannot reach native sender or publish error health", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create();
  const before = await snapshot(f, connection.id);
  const writer = f.openWriter();
  try {
    writer.exec(`CREATE TRIGGER a20_owned_fail_admission BEFORE UPDATE OF request_revision
      ON media_workflow_connection_check_authorities BEGIN SELECT RAISE(ABORT, 'a20_owned_admission_failure'); END`);
    const admission = await f.check(connection.id);
    assert.equal(admission.status, 400);
    assert.match(admission.body.message, /a20_owned_admission_failure/u);
    await assertUnchanged(f, connection.id, before);
    writer.exec("DROP TRIGGER a20_owned_fail_admission");
    writer.prepare("DELETE FROM media_workflow_connection_check_authorities WHERE connection_id=?").run(connection.id);
    const missing = await f.check(connection.id);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "media_workflow_error");
    assert.deepEqual(f.row(connection.id), before.row);
    assert.deepEqual(await f.current(connection.id), before.connection);
    assert.equal(f.authority(connection.id), undefined, "missing authority must not be silently recreated");
    assert.equal(f.upstream.requests.length, 0);
    f.assertNoWork();
  } finally { writer.close(); }
});

test("A20 authority read failure after native await is Host failure, not replacement error health", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create();
  const plan = f.upstream.plan({ paused: true });
  const pending = f.check(connection.id);
  await plan.entered();
  const before = await snapshot(f, connection.id);
  const writer = f.openWriter();
  try {
    writer.prepare("DELETE FROM media_workflow_connection_check_authorities WHERE connection_id=?").run(connection.id);
    plan.release();
    const failure = await pending;
    assert.equal(failure.status, 400);
    assert.equal(failure.body.error, "media_workflow_error");
    assert.deepEqual(f.row(connection.id), before.row);
    assert.deepEqual(await f.current(connection.id), before.connection);
    assert.equal(f.authority(connection.id), undefined);
    assert.equal(f.upstream.requests.length, 1);
    f.assertNoWork();
  } finally { writer.close(); }
});

test("A20 revision exhaustion safely rejects admission and configuration mutation", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  const connection = await f.create();
  const writer = f.openWriter();
  try {
    writer.prepare("UPDATE media_workflow_connection_check_authorities SET request_revision=? WHERE connection_id=?")
      .run(Number.MAX_SAFE_INTEGER, connection.id);
    const before = await snapshot(f, connection.id);
    const exhausted = await f.check(connection.id);
    assert.equal(exhausted.status, 400);
    assert.match(exhausted.body.message, /revision exhausted/u);
    await assertUnchanged(f, connection.id, before);
    writer.prepare("UPDATE media_workflow_connection_check_authorities SET config_revision=? WHERE connection_id=?")
      .run(Number.MAX_SAFE_INTEGER, connection.id);
    const configBefore = await snapshot(f, connection.id);
    const update = await f.api("PATCH", `/media-workflow-connections/${connection.id}`, { name: "Must roll back" });
    assert.equal(update.status, 400);
    await assertUnchanged(f, connection.id, configBefore);
    assert.equal(f.upstream.requests.length, 0);
  } finally { writer.close(); }
});

const coreNow = "2026-10-15T08:00:00.000Z";
const coreHealth = { ok: true, message: "A20 owned Core receipt", checkedAt: coreNow,
  protocolVariant: "prompt_legacy", nodeCount: 2 };
async function createOwnedCoreCase(t) {
  const cwd = await mkdtemp(join(ownedRoot, "core-workspace-"));
  let store;
  t.after(() => { store?.close(); });
  store = createSqliteRunStore(cwd);
  return {
    get store() { return store; },
    reopen() { store.close(); store = undefined; store = createSqliteRunStore(cwd); return store; },
    openWriter: () => new DatabaseSync(store.paths.databasePath),
    create() {
      return store.createMediaWorkflowConnection({ name: "A20 owned Core", baseUrl: "http://127.0.0.1:1",
        authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "prompt_legacy" }, coreNow);
    },
  };
}

test("A20 Core persists same-time equal-config mutation, check generations and duplicate consumption over reopen", async t => {
  const f = await createOwnedCoreCase(t);
  const connection = f.create();
  const old = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  assert.ok(old);
  const initial = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  f.store.updateMediaWorkflowConnection(connection.id, { protocolVariant: connection.protocolVariant }, coreNow);
  const changed = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  assert.equal(changed.connection.updatedAt, initial.connection.updatedAt, "timestamps deliberately stay identical");
  assert.equal(changed.configRevision, initial.configRevision + 1);
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(old.ticket, coreHealth, coreNow).reason, "config_changed");
  const first = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  const second = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  assert.equal(second.ticket.requestRevision, first.ticket.requestRevision + 1);
  const published = f.store.commitMediaWorkflowConnectionCheck(second.ticket, coreHealth, coreNow);
  assert.equal(published.status, "published");
  const before = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  assert.equal(before.configRevision, changed.configRevision, "health publication must not advance configuration");
  assert.equal(before.publishedRevision, second.ticket.requestRevision);
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(first.ticket, { ...coreHealth, ok: false }, coreNow).reason, "superseded");
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(second.ticket, { ...coreHealth, ok: false }, coreNow).reason, "already_published");
  assert.deepEqual(f.store.getMediaWorkflowConnectionCheckState(connection.id), before);
  f.reopen();
  assert.deepEqual(f.store.getMediaWorkflowConnectionCheckState(connection.id), before);
  assert.equal(f.store.beginMediaWorkflowConnectionCheck(connection.id).ticket.requestRevision, before.requestRevision + 1);
});

test("A20 Core cross-connection mutation clears health and rejects admitted work; deletion tombstone survives reopen", async t => {
  const f = await createOwnedCoreCase(t);
  const connection = f.create();
  const published = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(published.ticket, coreHealth, coreNow).status, "published");
  const old = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  const writer = f.openWriter();
  try {
    // The trigger covers an actual second SQLite connection, not a mocked Store.
    writer.prepare("UPDATE media_workflow_connections SET protocol_variant=protocol_variant WHERE id=?").run(connection.id);
    const current = f.store.getMediaWorkflowConnectionCheckState(connection.id);
    assert.equal(current.configRevision, old.ticket.configRevision + 1);
    assert.equal(current.connection.status, "unchecked");
    assert.equal(current.connection.health, undefined);
    assert.equal(f.store.commitMediaWorkflowConnectionCheck(old.ticket, coreHealth, coreNow).reason, "config_changed");
    const admitted = f.store.beginMediaWorkflowConnectionCheck(connection.id);
    const beforeDelete = f.store.getMediaWorkflowConnectionCheckState(connection.id);
    assert.equal(f.store.deleteMediaWorkflowConnection(connection.id), true);
    const tombstone = writer.prepare("SELECT * FROM media_workflow_connection_check_authorities WHERE connection_id=?").get(connection.id);
    assert.equal(tombstone.config_revision, beforeDelete.configRevision + 1);
    assert.equal(f.store.commitMediaWorkflowConnectionCheck(admitted.ticket, coreHealth, coreNow).reason, "deleted");
    assert.equal(f.store.getMediaWorkflowConnection(connection.id), undefined);
    writer.close();
    f.reopen();
    const reopened = f.openWriter();
    try {
      assert.deepEqual(reopened.prepare("SELECT * FROM media_workflow_connection_check_authorities WHERE connection_id=?").get(connection.id), tombstone);
    } finally { reopened.close(); }
    const successor = f.create();
    assert.notEqual(successor.id, connection.id, "do not invent public/typed same-ID recreation");
  } finally { if (writer.isOpen) writer.close(); }
});

test("A20 Core malformed health cannot consume a valid ticket or publish adapter extras", async t => {
  const f = await createOwnedCoreCase(t);
  const connection = f.create();
  const admission = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  const before = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  for (const invalid of [null, [], { ...coreHealth, ok: "yes" }, { ...coreHealth, checkedAt: "invalid" },
    { ...coreHealth, nodeCount: -1 }, { ...coreHealth, nodeCount: 1.5 }, { ...coreHealth, protocolVariant: "auto" },
    { ...coreHealth, apiKey: "must-not-persist" }]) {
    assert.throws(() => f.store.commitMediaWorkflowConnectionCheck(admission.ticket, invalid, coreNow), TypeError);
    assert.deepEqual(f.store.getMediaWorkflowConnectionCheckState(connection.id), before);
  }
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(admission.ticket, coreHealth, coreNow).status, "published");
});

test("A20 Core health-only writes keep config revision, but explicit disabling fences pending checks", async t => {
  const f = await createOwnedCoreCase(t);
  const connection = f.create();
  const initial = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  const updated = f.store.updateMediaWorkflowConnection(connection.id, { status: "ready", health: coreHealth }, coreNow);
  assert.equal(updated.status, "ready");
  assert.deepEqual(updated.health, coreHealth);
  assert.equal(f.store.getMediaWorkflowConnectionCheckState(connection.id).configRevision, initial.configRevision);
  const pending = f.store.beginMediaWorkflowConnectionCheck(connection.id);
  const disabled = f.store.updateMediaWorkflowConnection(connection.id, { status: "disabled" }, coreNow);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.health, undefined);
  const state = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  assert.equal(state.configRevision, initial.configRevision + 1);
  assert.equal(f.store.commitMediaWorkflowConnectionCheck(pending.ticket, coreHealth, coreNow).reason, "config_changed");
  assert.deepEqual(f.store.getMediaWorkflowConnectionCheckState(connection.id), state);
});

test("A20 authority migration is idempotent and conflicting owned schema never resets authority", async t => {
  const f = await createOwnedCoreCase(t);
  const connection = f.create();
  f.store.beginMediaWorkflowConnectionCheck(connection.id);
  const before = f.store.getMediaWorkflowConnectionCheckState(connection.id);
  f.reopen();
  assert.deepEqual(f.store.getMediaWorkflowConnectionCheckState(connection.id), before);
  const writer = f.openWriter();
  try {
    assert.deepEqual(writer.prepare("SELECT version,name FROM schema_migrations WHERE version=162").all().map(row => ({ ...row })),
      [{ version: 162, name: "add_media_workflow_connection_check_authority" }]);
    writer.exec("DROP TRIGGER media_workflow_check_delete");
    writer.exec("CREATE TRIGGER media_workflow_check_delete AFTER DELETE ON media_workflow_connections BEGIN SELECT 1; END");
  } finally { writer.close(); }
  assert.throws(() => f.reopen(), /Media workflow check migration conflicts with existing history/u);
});

test("A20 migration record failure rolls back all owned authority schema and seed rows", async () => {
  const { applyMediaWorkflowCheckMigration } = await import("../../core/dist/storage/sqlite/media-workflow-check-migration.js");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT CHECK(name='forbidden-name'));
      CREATE TABLE media_workflow_connections(id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, adapter_kind TEXT,
        base_url TEXT, auth_mode TEXT, secret_ref TEXT, network_policy TEXT, protocol_variant TEXT,
        status TEXT, health_json TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO media_workflow_connections(id) VALUES('a20-owned-existing-row')`);
    assert.throws(() => applyMediaWorkflowCheckMigration({ database, hasMigration: () => false,
      recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(version, name) }),
    /CHECK constraint failed/u);
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'media_workflow_check_%' OR name='media_workflow_connection_check_authorities'").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations").get().count, 0);
    assert.deepEqual(database.prepare("SELECT id FROM media_workflow_connections").all().map(row => ({ ...row })), [{ id: "a20-owned-existing-row" }]);
  } finally { database.close(); }
});
