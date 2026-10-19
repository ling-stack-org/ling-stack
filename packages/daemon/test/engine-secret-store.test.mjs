import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createEngineSecretStore, isManagedEngineSecretRef, withEngineSecretResolver } from "../dist/features/execution-engines/engine-secret-store.js";

const ref = `keychain:ling-engine-${randomUUID()}`;

test("engine keyring process keeps values off argv/env, bounds work and never forwards native errors", () => {
  const calls = [];
  const secret = "synthetic-'quoted'-$secret";
  const store = createEngineSecretStore({ platform: "darwin", exec(file, args, options) {
    calls.push({ file, args, options });
    assert.equal(file, process.execPath);
    assert.equal(options.timeout, 1500);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 8192);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
    assert.equal(JSON.stringify(args).includes(secret), false);
    assert.equal(JSON.stringify(options.env).includes(secret), false);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.NODE_PATH, undefined);
    assert.match(args[0], /engine-secret-worker\.js$/);
    if (args[1] === "write") { assert.equal(options.input, secret); return '{"stored":true}'; }
    assert.equal(options.input, "");
    if (args[1] === "status") return '{"configured":true}';
    if (args[1] === "read") return JSON.stringify({ value: secret });
    return '{"absent":true}';
  } });
  store.write(ref, secret);
  assert.equal(store.status(ref).configured, true);
  assert.equal(store.resolve(ref).value, secret);
  store.remove(ref);
  assert.deepEqual(calls.map(c => c.args[1]), ["write", "status", "read", "remove"]);
  assert.equal(JSON.stringify(store).includes(secret), false);
  const failed = createEngineSecretStore({ platform: "darwin", exec() { throw new Error(secret); } });
  assert.throws(() => failed.write(ref, secret), { message: "engine_secret_store_unavailable" });
  assert.equal(JSON.stringify(failed.resolve(ref)).includes(secret), false);
});

test("managed storage never reads or mutates legacy/provider refs and has no unsupported-platform fallback", () => {
  let calls = 0;
  const store = createEngineSecretStore({ platform: "win32", exec() { calls++; return '{"stored":true}'; } });
  for (const other of ["keychain:provider-key", "env:KEY", "keychain:ling-engine-../path", `${ref}\n`]) {
    assert.equal(isManagedEngineSecretRef(other), false);
    assert.equal(store.resolve(other).configured, false);
    assert.throws(() => store.write(other, "value"), { code: "engine_secret_store_unavailable" });
    assert.throws(() => store.remove(other), { code: "engine_secret_store_unavailable" });
  }
  assert.equal(calls, 0);
  const unsupported = createEngineSecretStore({ platform: "linux", exec() { calls++; } });
  assert.throws(() => unsupported.write(ref, "value"), { code: "engine_secret_store_unavailable" });
  assert.equal(calls, 0);
  store.write(ref, "synthetic-value");
  assert.equal(calls, 1, "Windows uses the same non-shell worker path");
});

test("engine secret routing isolates reserved refs and does not borrow a fallback on storage failure", () => {
  const fallback = { resolve: () => ({ configured: true, value: "fallback-value" }), status: () => ({ configured: true }) };
  const managed = createEngineSecretStore({ platform: "darwin", exec() { throw new Error("unavailable"); } });
  const resolver = withEngineSecretResolver(managed, fallback);
  assert.equal(resolver.resolve("env:TEST_ONLY").value, "fallback-value");
  assert.equal(resolver.resolve(ref).configured, false);
  assert.equal(resolver.resolve(ref).value, undefined);
  assert.equal(resolver.status(ref).configured, false);
});
