import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

// Parse and execute only exact fixture/helper bytes. No product import, Store,
// filesystem mutation, real environment mutation, server, or network is used.
async function fixtureSource(filename) {
  const source = await readFile(new URL(filename, import.meta.url), "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  return {
    helper(name) {
      const node = ast.body.find(node => node.type === "FunctionDeclaration" && node.id.name === name);
      assert.ok(node, `missing fixture helper ${name}`);
      return source.slice(node.start, node.end);
    },
    cases: ast.body.filter(node => node.type === "ExpressionStatement" && node.expression.type === "CallExpression"
      && node.expression.callee.name === "test").map(node => ({
      name: node.expression.arguments[0].value,
      source: source.slice(node.expression.arguments[1].start, node.expression.arguments[1].end),
    })),
  };
}
const governance = await fixtureSource("./governance-notifications-api.test.mjs");
const restart = await fixtureSource("./notification-restart.test.mjs");
const api = await fixtureSource("./notifications-api.test.mjs");
const marketplace = await fixtureSource("./skills-marketplace.test.mjs");

function virtualFixture(extra = {}) {
  const created = [], removed = [], after = [];
  const environment = { LING_STACK_HOME: "original-home", LING_NOTIFICATIONS_POLL_WAIT_MS: "original-poll" };
  const sandbox = {
    assert, join, resolve, tmpdir: () => "/virtual-notification-fixture", process: { env: environment },
    mkdtemp: async prefix => { const path = `${prefix}${created.length}`; created.push(path); return path; },
    rm: async path => { removed.push(path); },
    ...extra,
  };
  return { sandbox, created, removed, after, environment,
    t: { after(callback) { after.push(callback); } },
    async run(source) {
      let error;
      try { await vm.runInNewContext(`(${source})`, sandbox)(this.t); }
      catch (caught) { error = caught; }
      const teardownErrors = [];
      for (const callback of after) { try { await callback(); } catch (caught) { teardownErrors.push(caught); } }
      return { error, teardownErrors };
    },
  };
}

for (const item of governance.cases.filter(item => item.source.includes("startDaemonForTest(cwd)"))) {
  for (const mode of ["start", "close"]) test(`fixture VM governance: ${item.name} cleans cwd on ${mode} failure`, async () => {
    const failure = new Error(`owned ${mode} failure`);
    const f = virtualFixture({
      teammateId: "fixture", lingAgentId: "fixture", quietWindowMs: 1,
      startDaemonForTest: async () => {
        if (mode === "start") throw failure;
        return { url: "http://no-network.fixture", close: async () => { throw failure; } };
      },
      postJson: async () => { throw new Error("owned body failure before cleanup"); },
      getJson: async () => { throw new Error("owned body failure before cleanup"); },
    });
    const result = await f.run(item.source);
    assert.equal(result.error, failure);
    assert.deepEqual(result.teardownErrors, []);
    assert.deepEqual(f.removed, f.created, "owned cwd must be registered before start and survive close rejection");
  });
}

for (const mode of ["construct", "close"]) test(`fixture VM governance direct Store: ${mode} failure still cleans cwd`, async () => {
  const item = governance.cases.find(item => item.source.includes("createSqliteRunStore(cwd)"));
  assert.ok(item);
  const failure = new Error(`owned store ${mode} failure`);
  const f = virtualFixture({
    teammateId: "fixture", quietWindowMs: 1,
    createSqliteRunStore() {
      if (mode === "construct") throw failure;
      return { getOrCreateTeammateDirectThread() { throw new Error("owned body failure"); }, close() { throw failure; } };
    },
  });
  const result = await f.run(item.source);
  assert.equal(result.error, failure);
  assert.deepEqual(f.removed, f.created);
});

for (const mode of ["construct", "start", "stop"]) test(`fixture VM governance startDaemonForTest: ${mode} restores owned home`, async () => {
  const failure = new Error(`owned governance ${mode} failure`);
  const f = virtualFixture();
  let stopCalls = 0;
  f.sandbox.createDaemonServer = options => {
    assert.equal(options.defaultWorkspaceCwd, "/virtual-caller-cwd");
    assert.equal(f.environment.LING_STACK_HOME, f.created[0], "home must be isolated before constructor entry");
    if (mode === "construct") throw failure;
    return { server: { address: () => ({ port: 1 }) },
      async start() { if (mode === "start") throw failure; },
      async stop() { stopCalls++; if (mode === "stop") throw failure; } };
  };
  const startDaemonForTest = vm.runInNewContext(`${governance.helper("startDaemonForTest")}; startDaemonForTest`, f.sandbox);
  let error;
  try { const daemon = await startDaemonForTest("/virtual-caller-cwd"); await daemon.close(); }
  catch (caught) { error = caught; }
  assert.equal(error, failure);
  assert.equal(stopCalls, mode === "construct" ? 0 : 1);
  assert.deepEqual(f.removed, f.created);
  assert.deepEqual(f.environment, { LING_STACK_HOME: "original-home", LING_NOTIFICATIONS_POLL_WAIT_MS: "original-poll" });
});

for (const mode of ["initialize", "listen", "close"]) test(`fixture VM preferences: ${mode} failure preserves cause and cleans dir`, async () => {
  const item = restart.cases.find(item => item.name.startsWith("first preferences GET"));
  assert.ok(item);
  const failure = new Error(`owned preferences ${mode} failure`);
  let closeCalls = 0, listener;
  const server = {
    listening: false,
    once(event, callback) { if (event === "error") listener = callback; return this; },
    listen(_port, _host, callback) {
      if (mode === "listen") { listener(failure); return; }
      this.listening = true; callback();
    },
    address: () => ({ port: 1 }),
    closeAllConnections() {},
    close(callback) {
      closeCalls++;
      if (!this.listening) callback(Object.assign(new Error("not listening"), { code: "ERR_SERVER_NOT_RUNNING" }));
      else callback(mode === "close" ? failure : undefined);
    },
  };
  const f = virtualFixture({
    NotificationHub: class {
      constructor() { if (mode === "initialize") throw failure; }
      async updatePreferences() { return { fixture: true }; }
    },
    createServer: () => server,
    fetch: async () => ({ status: 200, json: async () => ({ preferences: { fixture: true } }) }),
  });
  const result = await f.run(item.source);
  assert.equal(result.error, failure, "listen failure must not be masked by ERR_SERVER_NOT_RUNNING");
  assert.deepEqual(result.teardownErrors, []);
  assert.deepEqual(f.removed, f.created);
  assert.equal(closeCalls, mode === "close" ? 1 : 0);
});

for (const mode of ["home", "construct", "start", "body", "stop", "remove-cwd"]) {
  test(`fixture VM withDaemon: ${mode} failure restores both environment variables and attempts all cleanup`, async () => {
    const failure = new Error(`owned API ${mode} failure`);
    let stopCalls = 0;
    const f = virtualFixture();
    const originalMkdtemp = f.sandbox.mkdtemp;
    f.sandbox.mkdtemp = async prefix => {
      if (mode === "home" && f.created.length === 1) throw failure;
      return originalMkdtemp(prefix);
    };
    f.sandbox.rm = async path => {
      f.removed.push(path);
      if (mode === "remove-cwd" && path === f.created[0]) throw failure;
    };
    f.sandbox.createDaemonServer = () => {
      if (mode === "construct") throw failure;
      return { server: { address: () => ({ port: 1 }) },
        async start() { if (mode === "start") throw failure; },
        async stop() { stopCalls++; if (mode === "stop") throw failure; } };
    };
    const withDaemon = vm.runInNewContext(`${api.helper("withDaemon")}; withDaemon`, f.sandbox);
    let error;
    try { await withDaemon(async () => { if (mode === "body") throw failure; }); }
    catch (caught) { error = caught; }
    assert.ok(error === failure || error?.errors?.includes(failure), "the original failure must remain visible");
    assert.deepEqual(f.environment, { LING_STACK_HOME: "original-home", LING_NOTIFICATIONS_POLL_WAIT_MS: "original-poll" });
    assert.deepEqual(f.removed, f.created, "failure in one cleanup must not skip the other owned path");
    assert.equal(stopCalls, mode === "home" || mode === "construct" ? 0 : 1);
  });
}

test("fixture VM withDaemon: originally absent environment variables are removed again", async () => {
  const f = virtualFixture({ createDaemonServer: () => ({ server: { address: () => ({ port: 1 }) }, async start() {}, async stop() {} }) });
  delete f.environment.LING_STACK_HOME;
  delete f.environment.LING_NOTIFICATIONS_POLL_WAIT_MS;
  const withDaemon = vm.runInNewContext(`${api.helper("withDaemon")}; withDaemon`, f.sandbox);
  await withDaemon(async () => {});
  assert.deepEqual(f.environment, {});
  assert.deepEqual(f.removed, f.created);
});

test("fixture VM withDaemon: simultaneous body, stop and removal errors remain visible", async () => {
  const primary = new Error("owned primary failure"), stop = new Error("owned stop failure"), removal = new Error("owned removal failure");
  const f = virtualFixture({ createDaemonServer: () => ({ server: { address: () => ({ port: 1 }) },
    async start() {}, async stop() { throw stop; } }) });
  f.sandbox.rm = async path => { f.removed.push(path); if (path === f.created[0]) throw removal; };
  const withDaemon = vm.runInNewContext(`${api.helper("withDaemon")}; withDaemon`, f.sandbox);
  let error;
  try { await withDaemon(async () => { throw primary; }); }
  catch (caught) { error = caught; }
  assert.deepEqual(Array.from(error.errors), [primary, stop, removal]);
  assert.equal(error.cause, primary);
  assert.deepEqual(f.removed, f.created);
  assert.deepEqual(f.environment, { LING_STACK_HOME: "original-home", LING_NOTIFICATIONS_POLL_WAIT_MS: "original-poll" });
});

test("fixture VM marketplace parent: mkdir failure still removes the just-allocated root", async () => {
  const item = marketplace.cases.find(item => item.name.startsWith("marketplace inspect fetches"));
  assert.ok(item);
  const failure = new Error("owned marketplace mkdir failure");
  const f = virtualFixture({ mkdir: async () => { throw failure; } });
  const wrapped = `(${item.source})`;
  const callback = parse(wrapped, { ecmaVersion: "latest", sourceType: "module" }).body[0].expression;
  const branch = callback.body.body.find(node => node.type === "IfStatement").consequent.body;
  const allocation = branch.find(node => node.type === "VariableDeclaration" && node.declarations.some(item => item.id.name === "root"));
  const body = branch.find(node => node.type === "TryStatement");
  assert.ok(allocation && body && allocation.start < body.start);
  // The exact allocation/mkdir prefix excludes the later child import.meta.
  const result = await f.run(`async (t) => { ${wrapped.slice(allocation.start, body.start)} }`);
  assert.equal(result.error, failure);
  assert.deepEqual(f.removed, f.created);
});

for (const mode of ["fixture", "construct"]) test(`fixture VM marketplace child: ${mode} failure still removes owned cwd`, async () => {
  const item = marketplace.cases.find(item => item.name.startsWith("marketplace inspect fetches"));
  assert.ok(item);
  const wrapped = `(${item.source})`;
  const callback = parse(wrapped, { ecmaVersion: "latest", sourceType: "module" }).body[0].expression;
  const declarations = callback.body.body.filter(node => node.type === "VariableDeclaration");
  const allocation = declarations.find(node => node.declarations.some(item => item.id.name === "cwd"));
  const constructed = declarations.find(node => node.declarations.some(item => item.id.name === "daemon"));
  assert.ok(allocation && constructed && allocation.start < constructed.end);
  // Exact child lifecycle statements, wrapped only to supply async/test scope.
  // The preceding dynamic product import is deliberately not executed.
  const prefix = `async (t) => { ${wrapped.slice(allocation.start, constructed.end)} }`;
  const failure = new Error(`owned marketplace ${mode} failure`);
  const f = virtualFixture({
    createA11PublicHttpNetworkFixture: async () => { if (mode === "fixture") throw failure; return {}; },
    createDaemonServer: () => { throw failure; },
  });
  const result = await f.run(prefix);
  assert.equal(result.error, failure);
  assert.deepEqual(f.removed, f.created);
});
