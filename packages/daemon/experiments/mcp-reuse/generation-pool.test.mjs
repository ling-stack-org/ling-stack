import assert from "node:assert/strict";
import test from "node:test";
import { ExperimentalGenerationPool } from "./generation-pool.mjs";

const scope = { workspaceId: "workspace", serverId: "server", configRevision: "1", credentialGeneration: "1", activationEpoch: "1" };
const guards = { admit() {}, assertCurrent() {} };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("research pool is disabled unless explicitly enabled", () => {
  assert.throws(() => new ExperimentalGenerationPool(), /disabled/);
});

test("concurrent cold callers share one handshake but perform independent admission/result checks", async () => {
  let connections = 0, closes = 0, admissions = 0, checks = 0;
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async () => { connections++; return { close: async () => { closes++; } }; } });
  const perCall = { admit() { admissions++; }, assertCurrent() { checks++; } };
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => pool.run(scope, perCall, async () => "ok"))), ["ok", "ok", "ok", "ok", "ok"]);
    assert.equal(connections, 1);
    assert.equal(admissions, 5);
    assert.equal(checks, 15);
  } finally { assert.equal((await pool.shutdown()).drained, true); }
  assert.equal(closes, 1);
});

test("configuration replacement drains the old caller and rejects its late result", async () => {
  const started = deferred(), finish = deferred();
  const closed = [];
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async version => ({ close: async () => { closed.push(version.configRevision); } }) });
  const old = pool.run(scope, guards, async () => { started.resolve(); await finish.promise; return "old"; });
  const rejected = assert.rejects(old, /stale/);
  await started.promise;
  try {
    assert.equal(await pool.run({ ...scope, configRevision: "2" }, guards, async () => "new"), "new");
    assert.deepEqual(closed, []);
    finish.resolve();
    await rejected;
  } finally { await pool.shutdown(); }
  assert.deepEqual(closed.sort(), ["1", "2"]);
});

test("an invalidated pending handshake cannot publish into a new activation", async () => {
  const ready = deferred();
  let connections = 0, closes = 0, dispatched = 0;
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async () => { if (++connections === 1) await ready.promise; return { close: async () => { closes++; } }; } });
  const old = pool.run(scope, guards, async () => { dispatched++; });
  const rejected = assert.rejects(old, /stale/);
  pool.invalidate(scope.workspaceId, scope.serverId);
  await pool.run({ ...scope, activationEpoch: "2" }, guards, async () => { dispatched++; });
  ready.resolve();
  await rejected;
  assert.equal(dispatched, 1);
  await pool.shutdown();
  assert.equal(closes, 2);
});

test("one cancelled request leaves the shared connection available to its sibling", async () => {
  const started = deferred(), finish = deferred();
  const controller = new AbortController();
  let closes = 0;
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async () => ({ close: async () => { closes++; } }) });
  const cancelled = pool.run(scope, { ...guards, signal: controller.signal }, async () => { started.resolve(); await finish.promise; return "cancelled"; });
  const rejected = assert.rejects(cancelled, /cancelled/);
  await started.promise;
  controller.abort(new Error("cancelled"));
  assert.equal(await pool.run(scope, guards, async () => "sibling"), "sibling");
  assert.equal(closes, 0);
  finish.resolve();
  await rejected;
  await pool.shutdown();
  assert.equal(closes, 1);
});

test("workspace, credentials and disable transitions cannot reuse another connection", async () => {
  let connects = 0;
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async () => { connects++; return { close: async () => {} }; } });
  try {
    for (const version of [scope, { ...scope, workspaceId: "other" }, { ...scope, credentialGeneration: "2" }]) await pool.run(version, guards, async () => {});
    pool.invalidate(scope.workspaceId, scope.serverId);
    await pool.run({ ...scope, activationEpoch: "3" }, guards, async () => {});
    assert.equal(connects, 4);
  } finally { await pool.shutdown(); }
});

test("failed handshakes can retry and capacity bounds pending generations", async () => {
  let attempts = 0;
  const pool = new ExperimentalGenerationPool({ enabled: true, maxConnections: 1, connect: async () => {
    if (++attempts === 1) throw new Error("unavailable");
    return { close: async () => {} };
  } });
  await assert.rejects(pool.run(scope, guards, async () => {}), /unavailable/);
  await pool.run(scope, guards, async () => {});
  await assert.rejects(pool.run({ ...scope, workspaceId: "other" }, guards, async () => {}), /capacity/);
  assert.equal((await pool.shutdown()).drained, true);
});

test("shutdown does not claim physical drainage while a callback remains active", async () => {
  const started = deferred(), finish = deferred();
  const pool = new ExperimentalGenerationPool({ enabled: true, connect: async () => ({ close: async () => {} }) });
  const call = pool.run(scope, guards, async () => { started.resolve(); await finish.promise; });
  const rejected = assert.rejects(call, /stale/);
  await started.promise;
  const stopped = await pool.shutdown({ drainMs: 0 });
  assert.equal(stopped.drained, false);
  assert.equal(stopped.forced, 1);
  finish.resolve();
  await rejected;
  await assert.rejects(pool.run(scope, guards, async () => {}), /shutting_down/);
});
