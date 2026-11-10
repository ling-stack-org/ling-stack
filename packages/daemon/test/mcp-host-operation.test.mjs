import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDefaultMcpBroker } from "../dist/features/mcp/broker.js";
import { reserveHostMcpOperation } from "../dist/features/mcp/host-operation.js";
import { createMcpToolCallHandler } from "../dist/features/runs/mcp.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { scopeUserInputLocalWriters } from "../dist/features/runs/user-input-local-writer-scope.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { createChromeBrowserGenerationBroker } from "../dist/features/plugins/chrome-browser-generation-broker.js";
import { createOfficeDocumentsGenerationBroker } from "../dist/features/plugins/office-documents-generation-broker.js";
import { createCuaDriverGenerationBroker } from "../dist/features/plugins/cua-driver-generation-broker.js";
import { CHROME_BROWSER_MCP_SERVER_ID, OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { CUA_DRIVER_MCP_SERVER_ID } from "../dist/features/plugins/presets.js";

const required = { kind: "user_input_required", requestId: "mcp-pause", requestVersion: 1 };
const customBroker = callTool => ({
  async checkServer() { throw new Error("unused"); },
  async listTools() { throw new Error("unused"); },
  callTool,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-mcp-host-operation-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "mcp-task", title: "Tracked MCP", prompt: "Isolated HTTP MCP" };
  const f = createUnifiedExecFixture(t, cwd, task, "mcp-run");
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const group = tracker.executorGroup;
  let requests = 0, toolCalls = 0, initializations = 0, sseConnections = 0;
  const http = createServer(async (request, response) => {
    requests++;
    if (request.method === "GET" && options.sse) {
      sseConnections++;
      await options.onSse?.({ store: f.store, source, group });
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end(
        'event: message\nid: reconnect-fixture\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/fixture"}\n\n',
      );
      return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      initializations++;
      options.onInitialize?.({ store: f.store, source, group });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
      }));
      return;
    }
    if (message.method === "tools/call") {
      toolCalls++;
      await options.onTool?.({ store: f.store, source, group });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { content: [{ type: "text", text: "actual HTTP result" }], ...(options.isError ? { isError: true } : {}) },
      }));
      return;
    }
    response.writeHead(202).end();
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const now = new Date().toISOString();
  const serverId = options.serverId ?? "mcp-fixture";
  const transport = options.transport ?? {
    type: "streamable-http", url: `http://127.0.0.1:${http.address().port}/mcp`, headers: {}, secretHeaderRefs: {},
  };
  f.store.createMcpServer({ id: serverId, displayName: "Fixture MCP", transport,
    enabled: true, required: false, startupTimeoutSec: 1, toolTimeoutSec: 1 }, now);
  f.store.replaceMcpServerTools(serverId, [{ rawName: "read_fixture", displayName: "Read fixture",
    inputSchema: { type: "object" }, callableNamespace: "fixture", callableName: "read_fixture",
    sideEffectLevel: "read", defaultApproval: "allow", enabled: true }], now);
  const definition = { registeredName: "mcp_fixture_read", serverId, rawName: "read_fixture",
    displayName: "Read fixture", inputSchema: { type: "object" }, sideEffectLevel: "read", defaultApproval: "allow" };
  const request = signal => ({ toolCallId: "mcp-call", registeredName: definition.registeredName,
    serverId: definition.serverId, rawName: definition.rawName, input: {}, task, cwd, defaultApproval: "allow", signal });
  const secretResolver = options.secretResolver ?? { resolve: () => ({ configured: false }) };
  function handler(broker = createDefaultMcpBroker(), extra = {}) {
    return createMcpToolCallHandler(f.store, secretResolver, broker, [definition], {
      runId: f.run.id, hostOperationTracker: tracker, ...extra,
    });
  }
  const rows = () => group.getSnapshot().operations.map(row => f.store.getHostOperation(row.ticket.id));
  return { ...f, cwd, source, tracker, group, handler, request, rows,
    get requests() { return requests; }, get toolCalls() { return toolCalls; }, get initializations() { return initializations; },
    get sseConnections() { return sseConnections; } };
}

/** The same actual factory nesting as Daemon index, with never-called owned dependencies. */
function productionFacade(f, baseBroker = createDefaultMcpBroker(), bundledEnabled = true) {
  let generationEffects = 0;
  const forbidden = () => { generationEffects++; throw new Error("owned generation must not dispatch"); };
  const cua = createCuaDriverGenerationBroker({ baseBroker, bundledEnabled, workspaceCwd: f.cwd,
    leaseRegistry: { getCurrent: forbidden }, clientPool: { acquire: forbidden } });
  const office = createOfficeDocumentsGenerationBroker({ baseBroker: cua, workspaceCwd: f.cwd,
    controller: { execute: forbidden, snapshot: forbidden }, artifacts: { inspect: forbidden } });
  const broker = createChromeBrowserGenerationBroker({ baseBroker: office, workspaceCwd: f.cwd,
    controller: { execute: forbidden, snapshot: forbidden } });
  return { broker, get generationEffects() { return generationEffects; } };
}

test("original MCP connection cleanup remains available after required admission closes", async t => {
  const f = await fixture(t), operation = reserveHostMcpOperation(f.tracker, "cleanup-after-closure");
  let effects = 0;
  operation.launchConnectionEffect(() => { effects++; });
  f.group.closeAdmission(required);
  assert.throws(() => operation.launchConnectionEffect(() => { effects++; }), /closed/);
  operation.cleanupConnectionEffect(() => { effects++; });
  assert.equal(effects, 2);
  assert.ok(f.rows().some(row => row.phase === "launched"));
  operation.finish();
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  assert.equal((await f.group.drain()).status, "blocked", "cleanup does not prove whole-operation safety");
});

test("original MCP connection cleanup cannot cross an owner replacement", async t => {
  const f = await fixture(t), operation = reserveHostMcpOperation(f.tracker, "cleanup-stale-source");
  let effects = 0;
  operation.launchConnectionEffect(() => { effects++; });
  f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: new Date().toISOString() });
  const successor = f.store.getWorkUnit(f.run.workUnitId);
  assert.throws(() => operation.cleanupConnectionEffect(() => { effects++; }), /stale/);
  assert.equal(effects, 1);
  assert.deepEqual(f.store.getWorkUnit(f.run.workUnitId), successor);
});

test("original MCP connection cleanup refuses unentered and finished capabilities", async t => {
  const f = await fixture(t), operation = reserveHostMcpOperation(f.tracker, "cleanup-no-start");
  let effects = 0;
  assert.throws(() => operation.cleanupConnectionEffect(() => { effects++; }), /not_entered/);
  operation.finish();
  assert.throws(() => operation.cleanupConnectionEffect(() => { effects++; }), /finished/);
  assert.equal(effects, 0);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("original MCP connection cleanup rejects async effects before invoking them", async t => {
  const f = await fixture(t), operation = reserveHostMcpOperation(f.tracker, "cleanup-async");
  operation.launchConnectionEffect(() => {});
  let effects = 0;
  assert.throws(() => operation.cleanupConnectionEffect(async () => { effects++; }), /synchronous/);
  assert.equal(effects, 0);
  operation.finish();
});

test("tracked custom broker is rejected before an ignored guard can perform an effect", async t => {
  const f = await fixture(t);
  let effects = 0;
  const broker = customBroker(async () => { await Promise.resolve(); effects++; return { content: [] }; });
  broker.supportsHostOperation = true; // Caller assertions cannot mint Host capability.
  await assert.rejects(f.handler(broker)(f.request()), /mcp_host_admission_unsupported/);
  assert.equal(effects, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).status, "settled");
});

test("cloning a registered default broker does not carry its opaque admission capability", async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler({ ...createDefaultMcpBroker() })(f.request()), /mcp_host_admission_unsupported/);
  assert.equal(f.requests, 0);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("already aborted tracked stdio preserves genuine no-start without spawning", async t => {
  const f = await fixture(t);
  const target = join(f.cwd, "must-not-spawn");
  f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(target)},'wrong')`], env: {}, secretEnvRefs: {} } }, new Date().toISOString());
  await assert.rejects(f.handler()(f.request(AbortSignal.abort())), { name: "AbortError" });
  assert.equal(existsSync(target), false);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

for (const resolution of [{ configured: false }, { configured: true }, { configured: true, value: "" }]) {
  test(`declared stdio secret without optional diagnostic still requires a value: ${JSON.stringify(resolution)}`, async t => {
    const ref = "env:LING_REQUIRED_STDIO_TEST_TOKEN";
    const f = await fixture(t, { secretResolver: {
      status: () => ({ ref, kind: "env", configured: false, errorCode: "secret_missing" }),
      resolve: () => ({ ref, ...resolution }),
    } });
    const target = join(f.cwd, "missing-secret-must-not-spawn");
    f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'spawned')`], env: {},
      secretEnvRefs: { REQUIRED_TOKEN: ref }, cwd: f.cwd } }, new Date().toISOString());
    let projected = 0;
    await assert.rejects(f.handler(undefined, { onResult() { projected++; } })(f.request()), error => {
      assert.equal(error.name, "McpSecretResolutionError");
      assert.equal(error.statuses[0].ref, ref);
      assert.equal(error.statuses[0].configured, false);
      assert.equal(error.statuses[0].errorCode, "secret_missing");
      return true;
    });
    assert.equal(existsSync(target), false);
    assert.equal(projected, 0);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
    f.group.closeAdmission(required);
    assert.equal((await f.group.drain()).status, "settled");
  });
}

for (const composed of [false, true]) {
  test(`actual captured stdio dispatch and local close: ${composed ? "production facade" : "default broker"}`, { timeout: 5000 }, async t => {
    const f = await fixture(t), journal = join(f.cwd, "stdio-native-events.jsonl");
    const script = [
      "const fs = require('node:fs'), readline = require('node:readline');",
      "const path = process.argv[1], log = value => fs.appendFileSync(path, JSON.stringify(value) + '\\n');",
      "log({ phase: 'spawn', pid: process.pid });",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', line => { const message = JSON.parse(line); log({ method: message.method });",
      "if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'native-fixture', version: '1' } } }) + '\\n');",
      "else if (message.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'actual stdio result' }] } }) + '\\n'); });",
      "process.stdin.on('end', () => { log({ phase: 'stdin_eof' }); process.exit(0); });",
    ].join("\n");
    f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
      args: ["-e", script, journal], env: {}, secretEnvRefs: {}, cwd: f.cwd } }, new Date().toISOString());
    const facade = composed ? productionFacade(f) : undefined;
    let projected = 0;
    const result = await f.handler(facade?.broker, { onResult() { projected++; } })(f.request());
    assert.equal(result.content[0].text, "actual stdio result");
    assert.equal(projected, 1);
    assert.equal(facade?.generationEffects ?? 0, 0);
    const nativeEvents = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(nativeEvents.filter(event => event.phase === "spawn").length, 1);
    assert.deepEqual(nativeEvents.filter(event => event.method).map(event => event.method),
      ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(nativeEvents.at(-1).phase, "stdin_eof", "the outer handler must await real local cleanup before returning");
    assert.equal(f.requests, 0, "stdio must not fall back to a separate HTTP transport");
    const rows = f.rows();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.phase === "unknown_outcome"));
    assert.equal(rows.find(row => row.parentOperationId).producerId, "mcp-transport-connection");
    const reopened = createSqliteRunStore(f.cwd);
    try {
      for (const row of rows) assert.equal(reopened.getHostOperation(row.operationId).phase, "unknown_outcome");
    } finally { reopened.close(); }
    f.group.closeAdmission(required);
    assert.equal((await f.group.drain()).status, "blocked", "closed stdio does not prove descendants or remote effects stopped");
  });
}

test("tracked stdio shutdown retains its local writer until actual original process close", { timeout: 6000 }, async t => {
  const f = await fixture(t), journal = join(f.cwd, "stdio-shutdown-events.jsonl");
  const script = [
    "const fs = require('node:fs'); const readline = require('node:readline');",
    "const log = value => fs.appendFileSync(process.argv[1], JSON.stringify(value) + '\\n');",
    "log({ phase: 'spawn' });",
    "readline.createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); log({ method: message.method });",
    "if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'shutdown-fixture', version: '1' } } }) + '\\n'); });",
    "process.stdin.on('end', () => { log({ phase: 'stdin_eof_received' }); setTimeout(() => { log({ phase: 'native_tail_ended' }); process.exit(0); }, 120); });",
  ].join("\n");
  f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
    args: ["-e", script, journal], env: {}, secretEnvRefs: {}, cwd: f.cwd } }, new Date().toISOString());
  const writers = new AttemptLocalWriterGroup(f.source), active = new ActiveRunRegistry();
  const abortController = new AbortController();
  active.add(f.run.id, { ...f.source, abortController, streamEnvelope() {} });
  let projections = 0, retired = 0;
  const scoped = scopeUserInputLocalWriters({ onMcpToolCall: f.handler(undefined, { onResult() { projections++; } }) }, writers);
  const pending = scoped.onMcpToolCall(f.request(abortController.signal)).catch(error => error);
  t.after(async () => { abortController.abort(); await pending; });
  const events = async () => {
    try { return (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const waitEvent = async match => {
    const deadline = Date.now() + 2000;
    while (!(await events()).some(match)) {
      assert.ok(Date.now() < deadline, "actual stdio shutdown boundary did not occur");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitEvent(event => event.method === "tools/call");
  f.group.closeAdmission(required);
  active.suspendAll("daemon_restart");
  active.retainBlockedAttempt(f.run.id, writers, () => { retired++; });
  await waitEvent(event => event.phase === "stdin_eof_received");
  assert.deepEqual(writers.getSnapshot(), { closed: true, writers: ["mcp"] });
  await assert.rejects(active.waitForIdle(0), /cleanup is still pending/);
  assert.equal(retired, 0, "abort intent and stdin EOF are not local callback completion");
  assert.ok(await pending instanceof Error);
  await active.waitForIdle(1000);
  assert.equal((await events()).at(-1).phase, "native_tail_ended");
  assert.equal(retired, 1);
  assert.equal(projections, 0);
  assert.equal(active.getRetainedAttempt(f.run.id, f.source.attemptId).localDrainStatus, "drained");
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  assert.equal((await f.group.drain()).status, "blocked");
  const rows = f.rows(), reopened = createSqliteRunStore(f.cwd);
  try {
    for (const row of rows) assert.equal(reopened.getHostOperation(row.operationId).phase, "unknown_outcome");
  } finally { reopened.close(); }
  const before = { rows: f.rows(), events: f.store.listEvents(f.run.id) };
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual({ rows: f.rows(), events: f.store.listEvents(f.run.id) }, before,
    "closed original process cannot project a late result or erase durable blockers");
});

for (const timing of ["rollback", "post_commit"]) {
  test(`production stdio parent ${timing} failure seals queued tools/call before native write`, { timeout: 5000 }, async t => {
    const f = await fixture(t), journal = join(f.cwd, "stdio-parent-fault-events.jsonl");
    const script = [
      "const fs = require('node:fs'); const readline = require('node:readline');",
      "const log = value => fs.appendFileSync(process.argv[1], JSON.stringify(value) + '\\n');",
      "log({ phase: 'spawn' });",
      "readline.createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); log({ method: message.method });",
      "if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'parent-fault-fixture', version: '1' } } }) + '\\n');",
      "else if (message.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'must not execute' }] } }) + '\\n'); });",
      "process.stdin.on('end', () => { log({ phase: 'stdin_eof' }); process.exit(0); });",
    ].join("\n");
    f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
      args: ["-e", script, journal], env: {}, secretEnvRefs: {}, cwd: f.cwd } }, new Date().toISOString());
    const original = f.store.launchHostOperation.bind(f.store), exec = f.store.database.exec;
    const fault = new Error(`production_stdio_parent_${timing}`);
    let injected = false, projected = 0;
    f.store.launchHostOperation = (ticket, effect) => {
      if (injected || f.store.getHostOperation(ticket.operationId).parentOperationId) return original(ticket, effect);
      injected = true;
      if (timing === "rollback") f.store.database.exec = function(sql) {
        if (/^COMMIT;?$/u.test(sql.trim())) throw fault;
        return exec.call(this, sql);
      };
      try { const result = original(ticket, effect); if (timing === "post_commit") throw fault; return result; }
      finally { f.store.database.exec = exec; }
    };
    try {
      await assert.rejects(f.handler(productionFacade(f).broker, { onResult() { projected++; } })(f.request()), error => error === fault);
    } finally { f.store.launchHostOperation = original; f.store.database.exec = exec; }
    const nativeEvents = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(injected, true);
    assert.equal(nativeEvents.filter(event => event.phase === "spawn").length, 1);
    assert.equal(projected, 0);
    assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
    assert.equal(f.rows().length, 2);
    assert.equal(nativeEvents.at(-1).phase, "stdin_eof");
    assert.equal(nativeEvents.filter(event => event.method === "tools/call").length, 0,
      "async broker finally must not leave a gap before its queued physical write");
  });
}

for (const replacement of [false, true]) {
  test(`production stdio after connect rechecks ${replacement ? "replacement owner" : "required closure"} before tools/call`, { timeout: 5000 }, async t => {
    const f = await fixture(t), journal = join(f.cwd, "stdio-connect-gap.jsonl");
    const script = [
      "const fs = require('node:fs'); const readline = require('node:readline');",
      "const log = value => fs.appendFileSync(process.argv[1], JSON.stringify(value) + '\\n');",
      "log({ phase: 'spawn' });",
      "readline.createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); log({ method: message.method });",
      "if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'gap-fixture', version: '1' } } }) + '\\n'); });",
      "process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.exit(0), 1800);",
    ].join("\n");
    f.store.updateMcpServer("mcp-fixture", { transport: { type: "stdio", command: process.execPath,
      args: ["-e", script, journal], env: {}, secretEnvRefs: {}, cwd: f.cwd } }, new Date().toISOString());
    const original = f.store.launchHostOperation.bind(f.store);
    let rechecked = false, projected = 0, successor;
    f.store.launchHostOperation = (ticket, effect) => {
      if (!f.store.getHostOperation(ticket.operationId).parentOperationId) {
        rechecked = true;
        if (replacement) {
          f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
            runtimeInstanceId: "stdio-gap-successor", runnerId: "pi", status: "started", now: new Date().toISOString() });
          successor = f.store.getWorkUnit(f.run.workUnitId);
        } else f.group.closeAdmission(required);
      }
      return original(ticket, effect);
    };
    try { await assert.rejects(f.handler(undefined, { onResult() { projected++; } })(f.request())); }
    finally { f.store.launchHostOperation = original; }
    const nativeEvents = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rechecked, true, "the real SDK completed initialize before entering tool dispatch");
    assert.equal(nativeEvents.filter(event => event.phase === "spawn").length, 1);
    assert.equal(nativeEvents.filter(event => event.method === "initialize").length, 1);
    assert.equal(nativeEvents.filter(event => event.method === "tools/call").length, 0);
    assert.equal(projected, 0);
    assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
    if (replacement) assert.deepEqual(f.store.getWorkUnit(f.run.workUnitId), successor);
    else assert.equal((await f.group.drain()).status, "blocked");
  });
}

test("already cancelled MCP reserves and safely settles its genuine no-start facts", async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler()(f.request(AbortSignal.abort())), { name: "AbortError" });
  assert.equal(f.requests, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("required input before transport dispatch yields zero requests and exact durable no-start", async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler(undefined, { onStart() { f.group.closeAdmission(required); } })(f.request()), /closed/);
  assert.equal(f.requests, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  assert.equal((await f.group.drain()).status, "settled");
});

for (const replacement of [false, true]) {
  test(`${replacement ? "owner replacement" : "required input"} during connect blocks later real tool dispatch`, async t => {
    const f = await fixture(t, { onInitialize({ store, group }) {
      if (replacement) store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
        runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: new Date().toISOString() });
      else group.closeAdmission(required);
    } });
    await assert.rejects(f.handler()(f.request()));
    assert.equal(f.initializations, 1);
    assert.equal(f.toolCalls, 0);
    const rows = f.rows();
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => !row.parentOperationId).settlementKind, "unknown_outcome");
    assert.equal(rows.find(row => row.parentOperationId).phase, "unknown_outcome");
  });
}

test("HTTP fetch rechecks after SDK call entered but before its awaited headers dispatch", async t => {
  const f = await fixture(t);
  const launch = f.store.launchHostOperation.bind(f.store);
  f.store.launchHostOperation = (ticket, effect) => launch(ticket, () => {
    const result = effect();
    if (!f.store.getHostOperation(ticket.operationId).parentOperationId) f.group.closeAdmission(required);
    return result;
  });
  await assert.rejects(f.handler()(f.request()));
  assert.equal(f.initializations, 1);
  assert.equal(f.toolCalls, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  assert.equal((await f.group.drain()).status, "blocked");
});

test("parent launch failure after SDK request creation retains unknown without an unhandled pending rejection", async t => {
  const f = await fixture(t);
  const fault = new Error("parent launch COMMIT fault after SDK request creation");
  const launch = f.store.launchHostOperation.bind(f.store);
  f.store.launchHostOperation = (ticket, effect) => launch(ticket, () => {
    const result = effect();
    if (!f.store.getHostOperation(ticket.operationId).parentOperationId) throw fault;
    return result;
  });
  await assert.rejects(f.handler()(f.request()), error => error === fault);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.initializations, 1);
  assert.equal(f.toolCalls, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).status, "blocked");
});

for (const isError of [false, true]) {
  test(`real HTTP ${isError ? "isError result" : "success"} and connection close cannot manufacture whole-operation safety`, async t => {
    const f = await fixture(t, { isError });
    const result = await f.handler()(f.request());
    assert.equal(result.content[0].text, "actual HTTP result");
    assert.equal(f.toolCalls, 1);
    assert.equal(f.rows().length, 2);
    assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
    f.group.closeAdmission(required);
    assert.equal((await f.group.drain()).status, "blocked");
    const reopened = createSqliteRunStore(f.cwd);
    try { assert.equal(reopened.listHostOperationBlockers(f.source).length, 2); }
    finally { reopened.close(); }
  });
}

test("untracked custom brokers retain their existing behavior", async t => {
  const f = await fixture(t);
  let effects = 0;
  const handler = f.handler(customBroker(async () => { effects++; return { content: [] }; }), { hostOperationTracker: undefined });
  await handler(f.request());
  assert.equal(effects, 1);
  assert.equal(f.rows().length, 0);
});

test("actual three-layer production facade delegates ordinary tracked HTTP through its guarded base", async t => {
  const f = await fixture(t);
  const composed = productionFacade(f);
  const result = await f.handler(composed.broker)(f.request());
  assert.equal(result.content[0].text, "actual HTTP result");
  assert.equal(f.toolCalls, 1);
  assert.equal(composed.generationEffects, 0);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
});

for (const serverId of [CHROME_BROWSER_MCP_SERVER_ID, OFFICE_DOCUMENTS_MCP_SERVER_ID, CUA_DRIVER_MCP_SERVER_ID]) {
  test(`production facade refuses owned ${serverId} before controller/lease/remote effects`, async t => {
    const f = await fixture(t, { serverId });
    const composed = productionFacade(f);
    await assert.rejects(f.handler(composed.broker)(f.request()), /mcp_host_admission_unsupported/);
    assert.equal(f.requests, 0);
    assert.equal(composed.generationEffects, 0);
    assert.equal(f.rows().length, 2);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  });
}

test("production facade cannot convert a custom base into a supported tracked broker", async t => {
  const f = await fixture(t);
  let effects = 0;
  const composed = productionFacade(f, customBroker(async () => { effects++; return { content: [] }; }));
  await assert.rejects(f.handler(composed.broker)(f.request()), /mcp_host_admission_unsupported/);
  assert.equal(effects, 0);
  assert.equal(f.requests, 0);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("copying a production facade cannot carry the immutable Host delegation identity", async t => {
  const f = await fixture(t);
  const composed = productionFacade(f);
  await assert.rejects(f.handler({ ...composed.broker })(f.request()), /mcp_host_admission_unsupported/);
  assert.equal(f.requests, 0);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
});

test("untracked production facade continues its previous custom base delegation", async t => {
  const f = await fixture(t);
  let effects = 0;
  const composed = productionFacade(f, customBroker(async () => { effects++; return { content: [] }; }));
  await f.handler(composed.broker, { hostOperationTracker: undefined })(f.request());
  assert.equal(effects, 1);
  assert.equal(composed.generationEffects, 0);
  assert.equal(f.rows().length, 0);
});

test("Cua selector preserves bundled-disabled generic HTTP delegation", async t => {
  const f = await fixture(t, { serverId: CUA_DRIVER_MCP_SERVER_ID });
  const composed = productionFacade(f, undefined, false);
  await f.handler(composed.broker)(f.request());
  assert.equal(f.toolCalls, 1);
  assert.equal(composed.generationEffects, 0);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
});

test("late Host tracker getter is captured only once when the real callback starts", async t => {
  const f = await fixture(t);
  let captures = 0, readyTracker;
  const handler = f.handler(undefined, { hostOperationTracker: undefined,
    getHostOperationTracker() { captures++; return readyTracker; } });
  assert.equal(captures, 0);
  readyTracker = f.tracker;
  await handler(f.request());
  assert.equal(captures, 1);
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
});

test("explicit tracker wins without consulting a replaceable late getter", async t => {
  const f = await fixture(t);
  const handler = f.handler(undefined, { getHostOperationTracker() { throw new Error("must not recapture"); } });
  await handler(f.request());
  assert.equal(f.rows().length, 2);
});

test("source closure during the actual remote call discards later projection/result, but preserves unknown", async t => {
  const f = await fixture(t, { onTool({ group }) { group.closeAdmission(required); } });
  let results = 0;
  await assert.rejects(f.handler(undefined, { onResult() { results++; } })(f.request()), /closed/);
  assert.equal(f.toolCalls, 1);
  assert.equal(results, 0);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
  assert.equal((await f.group.drain()).status, "blocked");
});

test("real SDK SSE reconnect enters the captured guard and sends zero new requests after required input", { timeout: 5000 }, async t => {
  const toolStarted = deferred(), releaseTool = deferred(), rejectedReconnect = deferred();
  t.after(() => { releaseTool.resolve(); toolStarted.resolve(); });
  const f = await fixture(t, { sse: true,
    async onTool() { toolStarted.resolve(); await releaseTool.promise; },
    async onSse({ group }) { await toolStarted.promise; group.closeAdmission(required); },
  });
  const assertMayLaunch = f.group.assertMayLaunch.bind(f.group);
  let rejectedAttempts = 0;
  f.group.assertMayLaunch = ticket => {
    try { return assertMayLaunch(ticket); }
    catch (error) {
      if (ticket.producerId === "mcp-transport-connection") { rejectedAttempts++; rejectedReconnect.resolve(); }
      throw error;
    }
  };
  const execution = f.handler()(f.request());
  const rejectedExecution = assert.rejects(execution, /closed/);
  await rejectedReconnect.promise;
  assert.ok(rejectedAttempts > 0);
  assert.equal(f.sseConnections, 1);
  assert.equal(f.toolCalls, 1);
  releaseTool.resolve();
  await rejectedExecution;
  assert.equal(f.sseConnections, 1);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome"));
});
